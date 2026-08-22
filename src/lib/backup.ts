// Encrypted local backup — AES-GCM, key derived from deviceId via PBKDF2,
// written to Directory.Documents (shared storage, so it survives uninstall
// and APK updates; restoring means re-pairing to the same device row).
// Ported from Eggsy-Payroll's backup.ts, reshaped for the unified stores.
//
// The server restore (a fresh pair with no cursor pulls everything) is the
// primary recovery path; this is the offline fallback (UNIFIED-02 §9).
// Reading the old apps' backups (niko-payroll/…, eggsy-canteen/…) is a
// separate translation layer and deliberately NOT built.
import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";
import { getAll, getAllKeys, get, put } from "./db";
import type { Event, Person } from "../types";

const BACKUP_DIRECTORY = Directory.Documents;
const BACKUP_FOLDER = "eggsy-amino";

// Android requires this permission on every fresh install — even reinstalling
// the exact same signed build resets it, even though files written to
// Directory.Documents by a previous install are still on disk. Without this,
// reads/writes silently fail and the file looks "inaccessible" even though
// it's really just unreadable until the user re-grants access.
async function ensureStoragePermission(): Promise<boolean> {
  try {
    const status = await Filesystem.checkPermissions();
    if (status.publicStorage === "granted") return true;
    const requested = await Filesystem.requestPermissions();
    return requested.publicStorage === "granted";
  } catch {
    // Web/other platforms without this permission model — nothing to request.
    return true;
  }
}

async function hashDeviceId(deviceId: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(deviceId);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("").substring(0, 16);
}

async function getBackupPath(deviceId: string): Promise<string> {
  const hash = await hashDeviceId(deviceId);
  return `${BACKUP_FOLDER}/backup-${hash}.enc`;
}

// ── AES-GCM Encryption ──────────────────────────────────────────────────────

function buf2hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((x) => ("00" + x.toString(16)).slice(-2))
    .join("");
}

function hex2buf(hexString: string): ArrayBuffer {
  const bytes = new Uint8Array(Math.ceil(hexString.length / 2));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hexString.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes.buffer;
}

async function deriveKey(deviceId: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(deviceId),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: enc.encode("eggsy-amino-backup-salt-v1"),
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptData(deviceId: string, data: string): Promise<{ iv: string; cipher: string }> {
  const key = await deriveKey(deviceId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(data);

  const cipherBuffer = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);

  return {
    iv: buf2hex(iv.buffer),
    cipher: buf2hex(cipherBuffer),
  };
}

async function decryptData(deviceId: string, ivHex: string, cipherHex: string): Promise<string> {
  const key = await deriveKey(deviceId);
  const iv = hex2buf(ivHex);
  const cipherBuffer = hex2buf(cipherHex);

  const decryptedBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(iv) },
    key,
    cipherBuffer,
  );

  return new TextDecoder().decode(decryptedBuffer);
}

// ── File I/O with fallback paths ────────────────────────────────────────────

interface ReadResult {
  data: string;
}

async function tryReadBackupFile(deviceId: string): Promise<ReadResult> {
  const path = await getBackupPath(deviceId);

  // Primary: Directory.Documents
  try {
    const result = await Filesystem.readFile({
      path,
      directory: Directory.Documents,
      encoding: Encoding.UTF8,
    });
    return { data: result.data as string };
  } catch {
    // fall through to fallback
  }

  // Fallback: Directory.ExternalStorage with Documents/ prefix.
  // On some Android versions (especially after a signing-key change),
  // Directory.Documents blocks readFile() even when stat() succeeds.
  // ExternalStorage with the full subpath bypasses that scoped-storage quirk.
  try {
    const result = await Filesystem.readFile({
      path: `Documents/${path}`,
      directory: Directory.ExternalStorage,
      encoding: Encoding.UTF8,
    });
    return { data: result.data as string };
  } catch {
    throw new Error("File does not exist");
  }
}

async function fileExists(deviceId: string): Promise<{ exists: boolean; mtime?: number }> {
  const path = await getBackupPath(deviceId);
  try {
    const stat = await Filesystem.stat({ path, directory: Directory.Documents });
    if (stat.size > 0) return { exists: true, mtime: stat.mtime };
  } catch {
    // stat failed — try ExternalStorage path
  }
  try {
    const stat = await Filesystem.stat({
      path: `Documents/${path}`,
      directory: Directory.ExternalStorage,
    });
    if (stat.size > 0) return { exists: true, mtime: stat.mtime };
  } catch {
    // neither location has it
  }
  return { exists: false };
}

const BACKUP_FILENAME_RE = /^backup-[0-9a-f]{16}\.enc$/;

export interface OrphanBackupInfo {
  /** Any backup-*.enc in the folder that ISN'T this pairing's own file — a
   * leftover from a previous pairing this phone (or a previous install)
   * held, which this pairing can never see or restore (see the module
   * comment: the deviceId IS the decryption key, so a different deviceId
   * means a different, permanently-inaccessible-from-here file). */
  count: number;
  newestAt: number | null;
}

/** Lists backup-*.enc files that don't belong to `excludeDeviceId` — called
 * right after a pairing claim/approval, before applyPairingApproved()
 * commits it, so the person setting up the phone can be warned: "this
 * looks like it was already paired to something else." Best-effort — any
 * failure (no permission, folder never created, web platform) reads as
 * "no orphans", same as the rest of this file errs toward not blocking a
 * real pairing over a diagnostic that couldn't run. */
export async function listOrphanBackups(excludeDeviceId: string | null): Promise<OrphanBackupInfo> {
  const none: OrphanBackupInfo = { count: 0, newestAt: null };
  try {
    await ensureStoragePermission();
    const excludeName = excludeDeviceId ? `backup-${await hashDeviceId(excludeDeviceId)}.enc` : null;

    let files: { name: string; mtime: number }[] = [];
    try {
      const res = await Filesystem.readdir({ path: BACKUP_FOLDER, directory: Directory.Documents });
      files = res.files;
    } catch {
      const res = await Filesystem.readdir({
        path: `Documents/${BACKUP_FOLDER}`,
        directory: Directory.ExternalStorage,
      });
      files = res.files;
    }

    const orphans = files.filter((f) => BACKUP_FILENAME_RE.test(f.name) && f.name !== excludeName);
    if (orphans.length === 0) return none;
    return { count: orphans.length, newestAt: Math.max(...orphans.map((f) => f.mtime)) };
  } catch {
    return none;
  }
}

/** Shared copy for the confirm() both pairing screens show when
 * listOrphanBackups() finds something — kept in one place so the wording
 * can't drift between the direct-pair and pending-approval paths. */
export function describeOrphanBackups(info: OrphanBackupInfo): string {
  const when = info.newestAt ? new Date(info.newestAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "an earlier pairing";
  return (
    `This phone has a saved backup from a different pairing (${when}) that this new pairing will never be able to read or restore.\n\n` +
    `If this phone was already set up as a gate/canteen device before — and this is meant to be that SAME device — cancel now and use ` +
    `"Replace phone" from the office admin instead, so this pairing keeps that history.\n\n` +
    `If this is genuinely a new setup, it's safe to continue — the old backup is simply left behind, unused.\n\n` +
    `Continue with this pairing?`
  );
}

// ── Serialisation: Float32Array survives IndexedDB but not JSON ─────────────

function personToJson(p: Person): any {
  return {
    ...p,
    descriptor: p.descriptor ? Array.from(p.descriptor) : null,
    recentEmbeddings: p.recentEmbeddings.map((d) => Array.from(d)),
    localSamples: (p.localSamples ?? []).map((d) => Array.from(d)),
  };
}

function personFromJson(p: any): Person {
  return {
    ...p,
    descriptor: Array.isArray(p.descriptor) ? Float32Array.from(p.descriptor) : null,
    recentEmbeddings: Array.isArray(p.recentEmbeddings)
      ? p.recentEmbeddings.map((d: number[]) => Float32Array.from(d))
      : [],
    // Absent in backups taken before local samples existed — restore must
    // not turn that into `undefined` inside a Float32Array[] field.
    localSamples: Array.isArray(p.localSamples)
      ? p.localSamples.filter(Array.isArray).map((d: number[]) => Float32Array.from(d))
      : [],
  };
}

// ────────────────────────────────────────────────────────────────────────────

export interface BackupMetadata {
  exists: boolean;
  readable: boolean;
  savedAt?: number;
  people?: number;
  events?: number;
  thumbs?: number;
  metaKeys?: number;
}

export async function checkBackup(deviceId: string): Promise<BackupMetadata> {
  if (!deviceId) return { exists: false, readable: false };

  await ensureStoragePermission();

  const f = await fileExists(deviceId);
  if (!f.exists) return { exists: false, readable: false };

  const meta: BackupMetadata = { exists: true, readable: false, savedAt: f.mtime };

  try {
    const result = await tryReadBackupFile(deviceId);
    const fileData = JSON.parse(result.data);
    if (fileData.iv && fileData.cipher) {
      const decryptedStr = await decryptData(deviceId, fileData.iv, fileData.cipher);
      const data = JSON.parse(decryptedStr);
      meta.readable = true;
      meta.people = Array.isArray(data.people) ? data.people.length : 0;
      meta.events = Array.isArray(data.events) ? data.events.length : 0;
      meta.thumbs = Array.isArray(data.thumbs) ? data.thumbs.length : 0;
      meta.metaKeys = Array.isArray(data.metaEntries) ? data.metaEntries.length : 0;
    }
  } catch {
    // can't read/decode — exists on disk but inaccessible
  }

  return meta;
}

// A backup is the most expensive thing this app does: every row in every
// store serialised into one string, then PBKDF2 at 100,000 iterations, then
// AES-GCM, then a file write. It used to run on every sync tick — which
// during a rush window is every 10 seconds, on a 3GB phone, while people are
// punching. Two gates now stand in front of it: a minimum interval, and a
// cheap check for whether anything was actually added since last time. Both
// are skippable with { force: true } for a deliberate, user-initiated backup.
const BACKUP_MIN_INTERVAL_MS = 10 * 60_000;

/** What the last backup covered. The fingerprint is row COUNTS per store,
 * read via getAllKeys so it never loads a single photo or face descriptor.
 * Counts catch what a backup exists to protect — events and people that
 * would otherwise be lost with the phone. They deliberately miss in-place
 * edits to existing rows (a syncedAt stamp, say); those are not worth
 * 100,000 rounds of PBKDF2, and the next real change picks them up anyway. */
interface BackupStateMeta {
  key: "backup-state";
  at: number;
  fingerprint: string;
}

async function backupFingerprint(): Promise<string> {
  const counts = await Promise.all(
    ["people", "events", "thumbs"].map(async (store) => (await getAllKeys(store)).length),
  );
  return counts.join("|");
}

let backupInFlight: Promise<void> | null = null;

export function saveBackup(deviceId: string, opts?: { force?: boolean }): Promise<void> {
  if (!deviceId) return Promise.resolve();
  // Coalescing returns the in-flight promise, which covers a snapshot taken
  // BEFORE this call. Fine for the scheduler; a forced backup waits its turn
  // instead, so a user who asks for one gets their own data in it.
  if (backupInFlight && !opts?.force) return backupInFlight;
  const run = async () => {
    if (backupInFlight) await backupInFlight.catch(() => {});
    if (!(await backupIsDue(opts?.force))) return;
    await doSaveBackup(deviceId);
  };
  // Clear the slot only if it is still ours: a forced backup queued behind an
  // earlier one means the earlier promise settles while this one is the live
  // entry, and an unconditional reset there would blank the guard and let a
  // third caller run concurrently with this one.
  const pending: Promise<void> = run().finally(() => {
    if (backupInFlight === pending) backupInFlight = null;
  });
  backupInFlight = pending;
  return pending;
}

async function backupIsDue(force?: boolean): Promise<boolean> {
  if (force) return true;
  try {
    const state = await get<BackupStateMeta>("meta", "backup-state");
    if (state && Date.now() - state.at < BACKUP_MIN_INTERVAL_MS) return false;
    if (state && (await backupFingerprint()) === state.fingerprint) return false;
    return true;
  } catch {
    return true; // can't tell — err towards backing up
  }
}

async function doSaveBackup(deviceId: string): Promise<void> {
  try {
    await ensureStoragePermission();

    const [people, events, thumbs, metaEntries] = await Promise.all([
      getAll<Person>("people"),
      getAll<Event>("events"),
      getAll<{ id: string; dataUrl: string }>("thumbs"),
      getAll<any>("meta"),
    ]);

    const rawData = JSON.stringify({
      formatVersion: "0.1.0",
      savedAt: Date.now(),
      people: people.map(personToJson),
      events,
      thumbs,
      metaEntries,
    });

    const encrypted = await encryptData(deviceId, rawData);
    const fileContent = JSON.stringify(encrypted);

    const path = await getBackupPath(deviceId);

    try {
      await Filesystem.mkdir({
        path: BACKUP_FOLDER,
        directory: BACKUP_DIRECTORY,
        recursive: true,
      });
    } catch {
      // Might already exist
    }

    await Filesystem.writeFile({
      path,
      data: fileContent,
      directory: BACKUP_DIRECTORY,
      encoding: Encoding.UTF8,
    });
    console.log(`Encrypted backup saved to ${path}`);

    // Only after the file is actually on disk — a failed write must not look
    // like a recent backup, or the gates above would suppress the retry.
    await put<BackupStateMeta>("meta", {
      key: "backup-state",
      at: Date.now(),
      fingerprint: await backupFingerprint(),
    });
  } catch (e) {
    console.error("Failed to save encrypted backup:", e);
  }
}

export interface RestoreResult {
  people: number;
  events: number;
  thumbs: number;
  metaKeys: number;
}

export async function restoreFromBackup(deviceId: string): Promise<RestoreResult> {
  if (!deviceId) throw new Error("No device ID provided");

  await ensureStoragePermission();

  const result = await tryReadBackupFile(deviceId);

  const fileData = JSON.parse(result.data);
  if (!fileData.iv || !fileData.cipher) {
    throw new Error("Invalid encrypted backup format");
  }

  let data;
  try {
    const decryptedStr = await decryptData(deviceId, fileData.iv, fileData.cipher);
    data = JSON.parse(decryptedStr);
  } catch {
    throw new Error("Failed to decrypt backup. The file may be corrupt or belongs to a different device.");
  }

  const backupPeople: any[] = data.people || [];
  const backupEvents: Event[] = data.events || [];
  const backupThumbs: { id: string; dataUrl: string }[] = data.thumbs || [];
  const backupMetaEntries: Record<string, any>[] = data.metaEntries || [];

  function mergeList<T extends { id?: string; syncedAt?: number }>(
    localById: Map<string, T>,
    backup: T[],
    idFn: (item: T) => string,
  ): T[] {
    return backup.filter((b) => {
      const local = localById.get(idFn(b));
      return !local || local.syncedAt;
    });
  }

  const localPeople = new Map((await getAll<Person>("people")).map((p) => [p.id, p]));
  const localEvents = new Map((await getAll<Event>("events")).map((e) => [e.id, e]));
  const localThumbs = new Map((await getAll<{ id: string }>("thumbs")).map((t) => [t.id, t]));

  const toWritePeople = mergeList(localPeople, backupPeople, (p) => p.id).map(personFromJson);
  const toWriteEvents = mergeList(localEvents, backupEvents, (e) => e.id);
  const toWriteThumbs = mergeList(localThumbs, backupThumbs, (t) => t.id);

  let restoredMeta = 0;
  const metaOps: Promise<void>[] = [];
  for (const entry of backupMetaEntries) {
    if (!entry.key) continue;
    metaOps.push(put("meta", entry));
    restoredMeta++;
  }

  await Promise.all([
    ...toWritePeople.map((p) => put("people", p)),
    ...toWriteEvents.map((e) => put("events", e)),
    ...toWriteThumbs.map((t) => put("thumbs", t)),
    ...metaOps,
  ]);

  return {
    people: toWritePeople.length,
    events: toWriteEvents.length,
    thumbs: toWriteThumbs.length,
    metaKeys: restoredMeta,
  };
}
