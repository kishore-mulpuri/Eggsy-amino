// Opportunistic sync to the central Amino Farms server — delta only. Two
// pull channels at two rates (UNIFIED-00 §5 / UNIFIED-02 §6):
//
//   state    — /api/device/pull/state?since=  — every tick, a few KB
//   identity — /api/device/pull/people?since= — rarely, usually zero rows
//   config   — /api/device/config             — every few minutes
//   push     — /api/device/events             — outbox, batches of 200
//
// The device records a truthful event, not a correct label — the server
// owns reconciliation (corrected/duplicates/rejected on the push response).
//
// Memory rules (UNIFIED-02 §8) are requirements here, not suggestions:
// no base64 photos in any pull; descriptors as Float32Array; hard 20s
// timeout on every fetch; bail out when navigator.onLine is false; and the
// scheduler never pulls while the camera screen is live (setCameraLive).
import { getAll, getAllKeys, get, getByIndex, forEachByIndex, put, del, clear } from "./db";
import { getAppVersion } from "./device";
import { setPins } from "./pin";
import { saveBackup } from "./backup";
import type {
  Event, EventType, ExtraPlateKind, Meal, MealWindow, PinEntry, Person,
  ReasonCode, Role, SyncConfig, SyncIntervals, SyncStatus,
} from "../types";

export const DEFAULT_SERVER_URL = "https://aminofarms.replit.app";

// In dev (npm run dev), route through Vite's own /api proxy (see
// vite.config.ts) instead of hitting the server directly from the browser.
// The Amino Farms server rejects any request carrying a browser Origin
// header, so a direct browser fetch always fails with "Failed to fetch"
// even with a valid token — going through the proxy keeps the request
// same-origin in the browser, and the proxy strips Origin before
// forwarding server-side. Production builds still call serverUrl directly.
export function apiBase(serverUrl: string): string {
  return import.meta.env.DEV ? "" : serverUrl;
}

/** Any 401 from an authenticated device endpoint — the token this phone is
 * holding no longer matches any device row, whether because it was
 * explicitly revoked (`code: "device_revoked"`) or because "Replace phone"
 * overwrote this device's token with a new one for a different handset
 * (server sets no code for that case, just a plain 401 — the server can't
 * tell "never valid" from "used to be valid," so the client doesn't try to
 * either; either way the ONLY fix is re-pairing). Distinct from a network
 * error: fetchWithTimeout throws before a Response even exists on a
 * flaky/offline connection, so an HTTP 401 is always a genuine, deliberate
 * rejection from the server — never a symptom of bad signal. */
export class DeviceRevokedError extends Error {
  constructor() {
    super("Device revoked");
    this.name = "DeviceRevokedError";
  }
}

/** Dispatched on the window when the device has been revoked mid-sync, so the
 * app can drop to the pairing state while keeping every local store. */
export const DEVICE_REVOKED_EVENT = "device-revoked";

// No request may run unbounded. On a slow/flaky connection an un-timed-out
// fetch sits open holding memory (worse under CapacitorHttp, which marshals
// the whole response across the JS<->native bridge as one string) for as
// long as the connection stays alive but stalled. That memory, stacked on
// top of the face-recognition engine already running on the Camera screen,
// is what was pushing the old apps over Android's per-process memory limit
// and getting them OOM-killed — which shows up as a plain force-quit, not a
// crash dialog. A hard timeout turns a multi-minute stall into a normal,
// recoverable "sync failed, try again" instead.
const FETCH_TIMEOUT_MS = 20_000;

/** This app is offline most of the time by design, and during a rush window
 * the scheduler ticks every 10 seconds — so without this check a phone with
 * no signal spends the whole shift opening requests that cannot succeed,
 * each one able to hold memory for the full FETCH_TIMEOUT_MS above on a
 * connection that is present but not working (weak signal, captive wifi).
 * Bailing out costs nothing and writes nothing: events are already saved
 * locally, the Camera screen has its own offline indicator, and the "online"
 * listener in startAutoSync re-runs everything the moment signal returns. */
const OFFLINE_ERROR = "Offline — events are saved locally";

function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/** fetch() with a hard timeout — the timeout fires an AbortError, which
 * callers see as a normal network failure (same shape as offline/DNS
 * failure), not a distinct error type to handle. */
export async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // A caller's own signal (the Cancel button on the first-sync overlay) is
  // chained into ours rather than replacing it: the request must still die
  // on the timeout even when nobody presses Cancel, and die immediately when
  // somebody does.
  const external = init?.signal ?? null;
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", onExternalAbort);
  }
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (external) external.removeEventListener("abort", onExternalAbort);
  }
}

/** fetch() wrapper for authenticated endpoints: passes the request through
 * unchanged (with a timeout — see fetchWithTimeout) except that any 401 is
 * surfaced as a DeviceRevokedError (see the class comment for why every 401
 * qualifies). Callers still check `!res.ok` for everything else. */
async function authedFetch(
  serverUrl: string,
  token: string,
  path: string,
  init?: RequestInit,
  timeoutMs?: number,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${apiBase(serverUrl)}${path}`,
      {
        ...init,
        // Every authenticated request made during the pairing first sync is
        // cancellable. Outside that window firstSyncSignal() is null and this
        // is exactly the request it always was.
        signal: init?.signal ?? firstSyncSignal() ?? undefined,
        headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` },
      },
      timeoutMs,
    );
  } catch (err) {
    // An abort raised while the operator is cancelling is a cancellation,
    // not a network failure — the difference decides whether the phone
    // shows "Stopped" or a red error it never earned.
    if (firstSyncCancelled) throw new SyncCancelledError();
    throw err;
  }
  if (res.status === 401) throw new DeviceRevokedError();
  return res;
}

// ── Device config (token) ───────────────────────────────────────────────────

export async function getDeviceConfig(): Promise<{
  serverUrl: string;
  token: string;
  deviceId?: string;
  deviceName?: string;
} | null> {
  const cfg = await get<SyncConfig>("meta", "sync-config");
  if (!cfg?.token) return null;
  return { serverUrl: cfg.serverUrl || DEFAULT_SERVER_URL, token: cfg.token, deviceId: cfg.deviceId, deviceName: cfg.deviceName };
}

export async function setDeviceConfig(serverUrl: string, token: string, deviceId?: string, deviceName?: string): Promise<void> {
  await put<SyncConfig>("meta", { key: "sync-config", serverUrl: serverUrl || DEFAULT_SERVER_URL, token, deviceId, deviceName });
}

export async function clearDeviceConfig(): Promise<void> {
  await put<SyncConfig>("meta", { key: "sync-config", serverUrl: DEFAULT_SERVER_URL, token: "", deviceId: undefined, deviceName: undefined });
}

/** The server URL to use even before a token exists (pairing, waiting). */
export async function getServerUrl(): Promise<string> {
  const cfg = await get<SyncConfig>("meta", "sync-config");
  return cfg?.serverUrl || DEFAULT_SERVER_URL;
}

export async function getSyncStatus(): Promise<SyncStatus> {
  const s = await get<SyncStatus>("meta", "sync-status");
  return s ?? { key: "sync-status", lastAttemptAt: null, lastSuccessAt: null, lastError: null, lastStatePullAt: null };
}

async function setSyncStatus(patch: Partial<SyncStatus>): Promise<void> {
  const current = await getSyncStatus();
  await put<SyncStatus>("meta", { ...current, ...patch, key: "sync-status" });
}

// ── Device identity (role) ──────────────────────────────────────────────────

interface DeviceInfoMeta {
  key: "device-info";
  deviceId: string;
  name: string;
  role: Role;
  siteCode: string;
  canteenId: string | null;
  canteenName: string | null;
  fetchedAt: number;
}

/** The role assigned by the server to this token, as last fetched from
 * /api/device/info. Null before the first successful fetch. */
export async function getDeviceIdentity(): Promise<DeviceInfoMeta | null> {
  return (await get<DeviceInfoMeta>("meta", "device-info")) ?? null;
}

async function pullDeviceInfo(serverUrl: string, token: string): Promise<void> {
  const res = await authedFetch(serverUrl, token, "/api/device/info");
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Device info fetch failed ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  const data = await res.json();
  await put<DeviceInfoMeta>("meta", {
    key: "device-info",
    deviceId: data.deviceId,
    name: data.name,
    role: data.role,
    siteCode: data.siteCode,
    canteenId: data.canteenId ?? null,
    canteenName: data.canteenName ?? null,
    fetchedAt: Date.now(),
  });
}

// ── Config (PINs, windows, intervals) ───────────────────────────────────────

export async function getMealWindows(): Promise<MealWindow[]> {
  const m = await get<{ key: string; windows: MealWindow[] }>("meta", "meal-windows");
  return m?.windows ?? [];
}

export async function getReasonCodes(): Promise<ReasonCode[]> {
  const r = await get<{ key: string; codes: ReasonCode[] }>("meta", "reason-codes");
  return r?.codes ?? [];
}

/** Role names for the wage-enrolment picker (Wages > Roles, admin sets the
 * rate; the device only ever sees names — see server/routes/device.ts's
 * /config handler). Empty on a canteen device, which never enrols wage
 * workers. */
export async function getWageRoles(): Promise<string[]> {
  const r = await get<{ key: string; roles: string[] }>("meta", "wage-roles");
  return r?.roles ?? [];
}

export async function getSyncIntervals(): Promise<SyncIntervals> {
  const s = await get<{ key: string; intervals: SyncIntervals }>("meta", "sync-intervals");
  return (
    s?.intervals ?? {
      rushWindows: [[7, 0, 10, 0], [12, 0, 14, 0], [16, 0, 18, 0]],
      rushIntervalMs: 10_000,
      idleIntervalMs: 5 * 60_000,
    }
  );
}

export async function getPhotoRetentionDays(): Promise<number> {
  const v = await get<{ key: string; value: number }>("meta", "photo-retention-days");
  return typeof v?.value === "number" && v.value >= 0 ? v.value : 45; // contract 1.1 default
}

export async function getDuplicateWindowMs(): Promise<number> {
  const v = await get<{ key: string; value: number }>("meta", "duplicate-window-ms");
  return typeof v?.value === "number" && v.value > 0 ? v.value : 120_000;
}

export interface VersionInfoView {
  latestVersionCode: number;
  minVersionCode: number;
  apkUrl: string | null;
}

export async function getVersionInfo(): Promise<VersionInfoView> {
  const v = await get<{ key: string; latestVersionCode: number; minVersionCode: number; apkUrl: string | null }>(
    "meta",
    "app-version-info",
  );
  return {
    latestVersionCode: typeof v?.latestVersionCode === "number" ? v.latestVersionCode : 0,
    minVersionCode: typeof v?.minVersionCode === "number" ? v.minVersionCode : 0,
    apkUrl: typeof v?.apkUrl === "string" ? v.apkUrl : null,
  };
}

/** Everything the phone needs to run offline: PIN list, meal windows,
 * reason codes, sync cadence, version gates, retention knobs. Small — a few
 * KB — so it can ride a "every few minutes" cadence without hurting. */
async function pullConfig(serverUrl: string, token: string): Promise<void> {
  emitProgress(10, "Loading settings…");
  const res = await authedFetch(serverUrl, token, "/api/device/config");
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Config pull responded ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  const body = await res.json();

  const pins: PinEntry[] = Array.isArray(body?.pins) ? body.pins : [];
  await setPins(pins);

  const windows: MealWindow[] = Array.isArray(body?.mealWindows) ? body.mealWindows : [];
  await put<{ key: string; windows: MealWindow[] }>("meta", { key: "meal-windows", windows });

  const codes: ReasonCode[] = Array.isArray(body?.reasonCodes) ? body.reasonCodes : [];
  await put<{ key: string; codes: ReasonCode[] }>("meta", { key: "reason-codes", codes });

  const wageRoles: string[] = Array.isArray(body?.wageRoles) ? body.wageRoles : [];
  await put<{ key: string; roles: string[] }>("meta", { key: "wage-roles", roles: wageRoles });

  // Intervals come from /config, not constants — changing a rush window
  // must not need a new APK (UNIFIED-02 §6.2).
  const sync = body?.sync ?? {};
  await put<{ key: string; intervals: SyncIntervals }>("meta", {
    key: "sync-intervals",
    intervals: {
      rushWindows: Array.isArray(sync.rushWindows) ? sync.rushWindows : [[7, 0, 10, 0], [12, 0, 14, 0], [16, 0, 18, 0]],
      rushIntervalMs: typeof sync.rushIntervalMs === "number" ? sync.rushIntervalMs : 10_000,
      idleIntervalMs: typeof sync.idleIntervalMs === "number" ? sync.idleIntervalMs : 5 * 60_000,
    },
  });

  const version = body?.version ?? {};
  await put<{ key: string; latestVersionCode: number; minVersionCode: number; apkUrl: string | null }>("meta", {
    key: "app-version-info",
    latestVersionCode: typeof version.latestVersionCode === "number" ? version.latestVersionCode : 0,
    minVersionCode: typeof version.minVersionCode === "number" ? version.minVersionCode : 0,
    apkUrl: typeof version.apkUrl === "string" ? version.apkUrl : null,
  });

  if (typeof body?.photoRetentionDays === "number") {
    await put<{ key: string; value: number }>("meta", { key: "photo-retention-days", value: body.photoRetentionDays });
  }
  if (typeof body?.duplicateWindowMs === "number") {
    await put<{ key: string; value: number }>("meta", { key: "duplicate-window-ms", value: body.duplicateWindowMs });
  }
}

// ── Pull channels (delta) ───────────────────────────────────────────────────

interface CursorMeta {
  key: string;
  cursor: string;
}

async function getCursor(key: string): Promise<string | null> {
  const c = await get<CursorMeta>("meta", key);
  return c?.cursor ?? null;
}

async function setCursor(key: string, cursor: string): Promise<void> {
  await put<CursorMeta>("meta", { key, cursor });
}

// One page of roster per request. The whole-roster-in-one-response shape
// this replaced is what hung a phone at 12% for five minutes on a weak link:
// a megabytes-long JSON body arrives all at once, and unpacking it blocks
// the single JS thread hard enough that even the abort timer above cannot
// fire, so the 20s timeout never fought back. Small pages keep every
// response cheap to hold and cheap to parse, and make each one independently
// resumable.
const PEOPLE_PAGE_SIZE = 200;

// A stop, not a pace-setter: at 200 rows a page this covers 100k people. It
// exists so a server that always answers `hasMore: true` cannot spin here.
const MAX_PEOPLE_PAGES = 500;

// The roster page gets a longer leash than the 20s every other channel uses.
// A page is small, but "small" over a rural 2G link still is not 20 seconds,
// and a timeout the honest case cannot meet is just a sync that never
// succeeds. Cancel is the operator's escape hatch, not the clock.
const ROSTER_TIMEOUT_MS = 90_000;

// Roster download dominates the first sync: map rows 20% → 95%. Config and
// the device role come BEFORE this now (see syncNow), so by the time the bar
// reaches 20 the phone already knows who it is.
const PEOPLE_START = 20;
const PEOPLE_END = 95;

/** Identity: /api/device/pull/people?since=<cursor>. Names and descriptors.
 * Carries NO photos, and — per contract §5.3 — NO state either: the
 * response has no lastPunch/presentToday/servedToday fields, so this must
 * NEVER write them, or every identity pull would reset state to
 * null/false/[] for whoever it touched. Only the state channel writes
 * those. A quiet call returns zero rows; the cursor is treated as opaque —
 * never parsed (UNIFIED-00 §2). */
export async function pullPeople(serverUrl: string, token: string, depth = 0): Promise<number> {
  emitProgress(20, "Downloading roster…");

  let total = 0;
  let page = 0;
  let lastCursor = await getCursor("people-cursor");

  // Pages, not one giant response — see PEOPLE_PAGE_SIZE. A server that does
  // not paginate answers the first request with the whole roster and no
  // `hasMore`, which ends the loop after one pass: exactly the old
  // behaviour, no version check anywhere.
  for (;;) {
    throwIfCancelled();
    if (page >= MAX_PEOPLE_PAGES) {
      throw new Error("Roster pull exceeded the page limit — giving up.");
    }

    const params = new URLSearchParams();
    if (lastCursor) params.set("since", lastCursor);
    params.set("limit", String(PEOPLE_PAGE_SIZE));
    const res = await authedFetch(
      serverUrl,
      token,
      `/api/device/pull/people?${params.toString()}`,
      undefined,
      ROSTER_TIMEOUT_MS,
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`People pull responded ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }
    const body = await res.json();
    throwIfCancelled();

    // Depth guard: a correct server says this once; a broken one could say it
    // forever. Allow exactly one retry, then fail loudly rather than loop.
    if (body?.fullResyncRequired) {
      if (depth >= 1) throw new Error("Server keeps requesting a full resync — giving up.");
      await clear("people");
      await del("meta", "people-cursor");
      return pullPeople(serverUrl, token, depth + 1);
    }

    const rows: any[] = Array.isArray(body?.people) ? body.people : [];
    // A paginating server reports how many rows are still outstanding as of
    // this request, counting this page — so the whole-pull total is what has
    // already been written plus that. Without it, this page is all there is
    // and its own length completes the total.
    const grandTotal = typeof body?.totalPending === "number" && body.totalPending > 0
      ? total + body.totalPending
      : total + rows.length;
    const pulledAt = Date.now();

    for (let i = 0; i < rows.length; i++) {
      throwIfCancelled();
      const p = rows[i];
      const existing = await get<Person>("people", p.id);
      // A local row that is a locally-enrolled wage worker carries fields the
      // pull can never overwrite (aadhar/role). Merge rather than replace.
      // lastPunch/presentToday/servedToday/stateAt are preserved from the
      // existing row (or defaulted for a new one) — deliberately not read
      // from the response, which never carries them.
      await put<Person>("people", {
        ...(existing ?? {}),
        id: p.id,
        kind: p.kind,
        name: p.name,
        empCode: p.empCode ?? null,
        descriptor: Array.isArray(p.descriptor) ? Float32Array.from(p.descriptor) : null,
        recentEmbeddings: Array.isArray(p.recentEmbeddings)
          ? p.recentEmbeddings.filter((e: any) => Array.isArray(e)).map((e: number[]) => Float32Array.from(e))
          : [],
        photoHash: p.photoHash ?? null,
        thumb: null, // fetched lazily from the thumbs store, never inline in a pull
        eligibility: {
          breakfast: !!p.eligibility?.breakfast,
          lunch: true, // lunch needs no list — present → lunch (UNIFIED-00 §7.7)
          dinner: !!p.eligibility?.dinner,
        },
        lastPunch: existing?.lastPunch ?? null,
        presentToday: existing?.presentToday ?? false,
        servedToday: existing?.servedToday ?? [],
        stateAt: existing?.stateAt,
        isActive: p.isActive !== false,
        cachedAt: pulledAt,
      });
      const done = total + i + 1;
      emitProgress(
        Math.round(PEOPLE_START + (done / Math.max(done, grandTotal)) * (PEOPLE_END - PEOPLE_START)),
        `Downloading roster… ${done} of ${Math.max(done, grandTotal)}`,
      );
    }

    const deleted: string[] = Array.isArray(body?.deleted) ? body.deleted : [];
    await Promise.all(deleted.map((id) => Promise.all([del("people", id), del("thumbs", id)])));

    total += rows.length;
    page++;

    // The cursor is written per page, not once at the end: that is what makes
    // a cancelled or dropped pull resumable instead of throwing away
    // everything it just downloaded. Treated as opaque — never parsed
    // (UNIFIED-00 §2).
    const nextCursor = typeof body?.cursor === "string" ? body.cursor : null;
    if (nextCursor) await setCursor("people-cursor", nextCursor);

    if (body?.hasMore !== true) break;
    // A server claiming "more" without moving the cursor forward would spin
    // this loop forever on the same page — stop instead.
    if (!nextCursor || nextCursor === lastCursor) break;
    lastCursor = nextCursor;
  }

  emitProgress(PEOPLE_END, total > 0 ? `Roster downloaded (${total})` : "Roster up to date");

  // State entries for ids that only just became known — apply them now that
  // the rows exist.
  await applyPendingStateMerges();
  return total;
}

interface StateChangedEntry {
  id: string;
  lastPunch: { type: "in" | "out"; ts: number } | null;
  presentToday: boolean;
  servedToday: Meal[];
}

/** State: /api/device/pull/state?since=<cursor>. Where each person stands
 * today. A few KB at most. Merged field-by-field into the people store —
 * the state payload carries no identity, so it must never replace a row.
 * Returns ids this device has never seen, so the caller can pull identity
 * immediately (someone enrolled at the gate is standing at the canteen
 * counter right now — UNIFIED-00 §5.4). State for unknown ids is parked in
 * meta and applied when the identity pull creates the row. */
export async function pullState(serverUrl: string, token: string): Promise<{ unknownIds: string[]; changed: number }> {
  emitProgress(16, "Syncing today's attendance…");
  const cursor = await getCursor("state-cursor");
  const url = cursor ? `/api/device/pull/state?since=${encodeURIComponent(cursor)}` : "/api/device/pull/state";
  const res = await authedFetch(serverUrl, token, url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`State pull responded ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  const body = await res.json();

  const changed: StateChangedEntry[] = Array.isArray(body?.changed) ? body.changed : [];
  const knownIds = new Set((await getAllKeys("people")).map(String));
  const unknownIds = [...new Set(changed.map((c) => c.id).filter((id) => !knownIds.has(id)))];

  const pulledAt = Date.now();
  const parked: Record<string, StateChangedEntry> = {};
  for (const entry of changed) {
    const local = await get<Person>("people", entry.id);
    if (!local) {
      // Unknown id — the identity pull will create the row; park the state
      // so the merge below can apply it once the row exists.
      parked[entry.id] = entry;
      continue;
    }
    await put<Person>("people", {
      ...local,
      lastPunch: entry.lastPunch?.type ? { type: entry.lastPunch.type, ts: entry.lastPunch.ts } : null,
      presentToday: !!entry.presentToday,
      servedToday: Array.isArray(entry.servedToday) ? entry.servedToday : [],
      stateAt: pulledAt, // only the state channel stamps this — see types.ts
      cachedAt: pulledAt,
    });
  }
  if (Object.keys(parked).length > 0) {
    await put("meta", { key: "state-pending-merge", entries: parked });
  }

  if (typeof body?.cursor === "string") await setCursor("state-cursor", body.cursor);
  await setSyncStatus({ lastStatePullAt: Date.now() });
  return { unknownIds, changed: changed.length };
}

/** Applies state entries parked by pullState for ids whose identity rows
 * arrive later. Called by pullPeople after writing rows. */
async function applyPendingStateMerges(): Promise<void> {
  const parked = await get<{ key: string; entries: Record<string, StateChangedEntry> }>("meta", "state-pending-merge");
  if (!parked?.entries) return;
  await del("meta", "state-pending-merge");
  const pulledAt = Date.now();
  for (const [id, entry] of Object.entries(parked.entries)) {
    const local = await get<Person>("people", id);
    if (!local) continue; // still unknown — dropped; the next state pull will carry it again
    await put<Person>("people", {
      ...local,
      lastPunch: entry.lastPunch?.type ? { type: entry.lastPunch.type, ts: entry.lastPunch.ts } : null,
      presentToday: !!entry.presentToday,
      servedToday: Array.isArray(entry.servedToday) ? entry.servedToday : [],
      stateAt: pulledAt, // only the state channel stamps this — see types.ts
      cachedAt: pulledAt,
    });
  }
}

// ── Push ────────────────────────────────────────────────────────────────────

function eventToWire(e: Event) {
  return {
    id: e.id,
    personId: e.personId,
    personKind: e.personKind,
    personName: e.personName,
    empCode: e.empCode,
    type: e.type,
    meal: e.meal,
    ts: e.ts,
    date: e.date,
    method: e.method,
    matchScore: e.matchScore,
    state: e.state,
    extraPlateKind: e.extraPlateKind,
    authorisedBy: e.authorisedBy,
    reasonCode: e.reasonCode,
    reasonText: e.reasonText,
    guestBatchId: e.guestBatchId,
    guestParty: e.guestParty,
    photoUrl: e.photoUrl,
    outsideWindow: e.outsideWindow,
    tokenNumber: e.tokenNumber,
    latitude: e.latitude,
    longitude: e.longitude,
    accuracy: e.accuracy,
    // capturedPhoto is local audit only — NEVER uploaded
  };
}

/** Push the outbox, max 200 events per request, split and loop. Applies the
 * response (UNIFIED-00 §5.6):
 *   corrected  → overwrite the local label so the next punch alternates
 *                from the corrected state
 *   duplicates → mark synced, flag, never retry
 *   rejected   → a real event that really happened — keep it, mark failed,
 *                never retry, surface it on the exceptions list
 * Returns the number of events written to the server. */
export async function pushEvents(serverUrl: string, token: string): Promise<number> {
  // Read pending rows off the byPending index, not a full-store scan: the
  // outbox is small and the rest of the store carries capturedPhotos that
  // must never be dragged into memory during a rush-window tick.
  const pending = await getByIndex<Event>("events", "byPending", IDBKeyRange.only(1));
  if (pending.length === 0) return 0;
  emitProgress(5, "Pushing pending events…");

  const BATCH = 200;
  let pushed = 0;
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    const res = await authedFetch(serverUrl, token, "/api/device/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: batch.map(eventToWire) }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Server responded ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }
    const body = await res.json().catch(() => null);

    const corrected = new Map<string, { type?: EventType; field?: string; to?: string }>(
      (Array.isArray(body?.corrected) ? body.corrected : []).map((c: any) => [
        c.id,
        { field: c.field, to: c.to, type: c.field === "type" ? c.to : undefined },
      ]),
    );
    const duplicateIds = new Set<string>(
      (Array.isArray(body?.duplicates) ? body.duplicates : []).map((d: any) => d.id),
    );
    const rejectedById = new Map<string, string>(
      (Array.isArray(body?.rejected) ? body.rejected : []).map((r: any) => [r.id, String(r.reason ?? "rejected by server")]),
    );

    const now = Date.now();
    await Promise.all(
      batch.map(async (e) => {
        const rejected = rejectedById.get(e.id);
        if (rejected !== undefined) {
          // A real event that really happened — keep it, mark it failed so
          // it isn't retried, and surface it on the exceptions list.
          return put<Event>("events", { ...e, pending: 0, syncFailedReason: rejected });
        }
        const patch: Partial<Event> = { syncedAt: now, pending: 0 };
        if (duplicateIds.has(e.id)) patch.duplicate = true;
        const correction = corrected.get(e.id);
        if (correction?.type === "in" || correction?.type === "out") {
          patch.type = correction.type;
          // Adopt the correction on the person row too so the local view of
          // "where they stand" matches what the server recorded.
          if (e.personId) {
            const person = await get<Person>("people", e.personId);
            if (person && (!person.lastPunch || e.ts >= person.lastPunch.ts)) {
              await put<Person>("people", { ...person, lastPunch: { type: correction.type, ts: e.ts } });
            }
          }
        }
        return put<Event>("events", { ...e, ...patch });
      }),
    );
    pushed += batch.length;
  }
  return pushed;
}

/** Push wage workers enrolled locally at the gate (people.ts
 * createWagePerson/updateWagePerson set `enrollPending`) to
 * POST /api/device/enroll, so they show up in Wages > Workers/Today the
 * same as a worker enrolled on the old Eggsy-Payroll app. Runs where
 * syncNow() calls it — the same gated block as the config/people pulls, so
 * it never overlaps a full-size photo upload with a live camera. Small
 * population (tens, not thousands), so a plain getAll + filter is fine —
 * this is the same "people" store pullPeople already holds in memory. */
export async function pushWageWorkers(serverUrl: string, token: string): Promise<number> {
  const all = await getAll<Person>("people");
  const pending = all.filter((p) => p.kind === "wage" && p.enrollPending);
  if (pending.length === 0) return 0;

  const BATCH = 50;
  let pushed = 0;
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    const workers = await Promise.all(
      batch.map(async (p) => {
        const thumb = await get<{ dataUrl: string }>("thumbs", p.id);
        return {
          id: p.id,
          name: p.name,
          aadharNumber: p.aadhar ?? "",
          faceDescriptor: p.descriptor ? Array.from(p.descriptor) : [],
          role: p.role ?? null,
          photoDataUrl: thumb?.dataUrl ?? "",
          isActive: p.isActive,
        };
      }),
    );

    const res = await authedFetch(serverUrl, token, "/api/device/enroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workers }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Enroll push responded ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }

    await Promise.all(batch.map((p) => put<Person>("people", { ...p, enrollPending: false })));
    pushed += batch.length;
  }
  return pushed;
}

/** Cap audit-photo retention (UNIFIED-02 §8.8): capturedPhoto is base64 in
 * IndexedDB and grows forever without this. Prunes rows older than
 * photoRetentionDays. Runs on a sync tick, never per event, and never while
 * the camera is live. Walks the byDate index one row at a time instead of
 * getAll() — months of history would be one large single allocation. */
export async function pruneCapturedPhotos(): Promise<number> {
  if (cameraLive) return 0;
  const days = await getPhotoRetentionDays();
  if (days <= 0) return 0;
  const cutoff = Date.now() - days * 86_400_000;

  const staleIds: string[] = [];
  await forEachByIndex<Event>("events", "byDate", (e) => {
    if (e.capturedPhoto && e.ts < cutoff) staleIds.push(e.id);
  });

  let pruned = 0;
  for (const id of staleIds) {
    const e = await get<Event>("events", id);
    if (e?.capturedPhoto) {
      await put<Event>("events", { ...e, capturedPhoto: null });
      pruned++;
    }
  }
  return pruned;
}

export async function pendingCounts(): Promise<{ events: number }> {
  const pending = await getByIndex<Event>("events", "byPending", IDBKeyRange.only(1));
  return { events: pending.length };
}

/** Clears every store scoped to "this device's identity" — people, thumbs,
 * events, and every meta key except install-id and the device config itself
 * (callers overwrite that separately). Used when pairing into a different
 * device identity than this phone last held. */
export async function wipeLocalDeviceData(): Promise<void> {
  await Promise.all([clear("people"), clear("thumbs"), clear("events")]);
  await Promise.all([
    del("meta", "people-cursor"),
    del("meta", "state-cursor"),
    del("meta", "device-info"),
    del("meta", "pins"),
    del("meta", "meal-windows"),
    del("meta", "reason-codes"),
    del("meta", "wage-roles"),
    del("meta", "sync-intervals"),
    del("meta", "app-version-info"),
    del("meta", "photo-retention-days"),
    del("meta", "duplicate-window-ms"),
    // Local-only Settings PIN (settingsLock.ts) — a different device
    // identity re-paired onto this same phone should not inherit whatever
    // PIN was set for the previous assignment; whoever re-pairs it sets a
    // fresh one. A "replace" onto the SAME deviceId does not wipe (see the
    // comment above this function), so the old PIN correctly survives that
    // case — it's still the same phone, same site.
    del("meta", "settings-lock"),
  ]);
}

/** Force-restore: discard the local identity mirror and pull everything
 * fresh (a fresh install restores itself this way — no migration). */
export async function forceFullResync(serverUrl: string, token: string): Promise<void> {
  await Promise.all([clear("people"), clear("thumbs"), del("meta", "people-cursor"), del("meta", "state-cursor")]);
  await pullPeople(serverUrl, token);
  await pullState(serverUrl, token);
}

// ── Camera-live gating ──────────────────────────────────────────────────────
// The camera being live means no heavy pull: two big things at once is what
// OOM-kills the process (UNIFIED-02 §8.1). The Camera screen flips this
// flag on mount/off on teardown; the scheduler then pushes only.

let cameraLive = false;

export function setCameraLive(live: boolean): void {
  cameraLive = live;
}

export function isCameraLive(): boolean {
  return cameraLive;
}

// ── First-sync progress ─────────────────────────────────────────────────────
// The one genuinely slow thing a sync can do is the full /pull/people
// roster (first sync after pairing, or a replacement phone). Every other
// channel is a few KB and near-instant. These events let a UI show a
// 0–100% bar during that window instead of a dead "Pairing…" spinner.
// Dispatched on the window; the overlay component listens and hides on 100.

export const SYNC_PROGRESS_EVENT = "sync-progress";

export interface SyncProgressUpdate {
  /** 0..100 */
  pct: number;
  label: string;
}

// Reporting is off during ordinary scheduler ticks (the overlay would pop up
// randomly all day). It is switched on only around the pairing first sync.
let progressReporting = false;

function emitProgress(pct: number, label: string): void {
  if (!progressReporting) return;
  window.dispatchEvent(
    new CustomEvent<SyncProgressUpdate>(SYNC_PROGRESS_EVENT, { detail: { pct, label } }),
  );
}

/** Turn on progress reporting and mark the start of the pairing first sync. */
export function beginSyncProgress(): void {
  progressReporting = true;
  firstSyncAbort = new AbortController();
  firstSyncCancelled = false;
  emitProgress(0, "Preparing…");
}

/** Mark the end of the pairing first sync and turn reporting back off. */
export function endSyncProgress(): void {
  emitProgress(100, firstSyncCancelled ? "Stopped" : "Done");
  progressReporting = false;
  firstSyncAbort = null;
}

// ── Cancelling the first sync ───────────────────────────────────────────────
// The roster pull is the one step slow enough that an operator standing at
// the gate on a weak signal may reasonably want out of it. Cancelling is
// safe and loses nothing permanent: the token is already stored, every page
// of roster already written stays written (see the per-page cursor in
// pullPeople), and the next scheduled tick picks up exactly where this left
// off. What it buys is a usable phone NOW instead of a dialog.

/** Set once the operator presses Cancel, so the steps between fetches can
 * bail out too — aborting the in-flight request alone would just let the
 * next one start. */
let firstSyncCancelled = false;
let firstSyncAbort: AbortController | null = null;

/** Thrown when the operator cancelled. Distinct from a network failure so
 * syncNow can record "Stopped" rather than a scary error. */
export class SyncCancelledError extends Error {
  constructor() {
    super("Sync cancelled");
    this.name = "SyncCancelledError";
  }
}

/** The signal every authenticated request rides during the first sync, or
 * null outside that window. */
function firstSyncSignal(): AbortSignal | null {
  return firstSyncAbort?.signal ?? null;
}

/** True once Cancel has been pressed for the current first sync. */
export function isFirstSyncCancelled(): boolean {
  return firstSyncCancelled;
}

/** Whether a cancellable first sync is running right now — the overlay uses
 * this to decide whether to offer the button at all. */
export function isFirstSyncRunning(): boolean {
  return progressReporting && firstSyncAbort !== null;
}

/** Operator pressed Cancel. Kills the in-flight request immediately and
 * tells every remaining step to stand down. Never throws. */
export function cancelFirstSync(): void {
  if (!progressReporting) return;
  firstSyncCancelled = true;
  emitProgress(100, "Stopping…");
  try {
    firstSyncAbort?.abort();
  } catch {
    // an already-aborted controller is not an error worth surfacing
  }
}

/** Bail out of a long loop between fetches. */
function throwIfCancelled(): void {
  if (firstSyncCancelled) throw new SyncCancelledError();
}

// ── Sync orchestration ──────────────────────────────────────────────────────

let syncing = false;

/** Blocks sync (never events) when the server has declared this build too
 * old. Returns a user-facing reason, or null when sync may proceed. */
async function tooOldToSync(): Promise<string | null> {
  const info = await getVersionInfo();
  if (!info || info.minVersionCode <= 0) return null;
  const current = await getAppVersion();
  if (info.minVersionCode > current.versionCode) {
    return "This app version is too old to sync — update the phone. Events are still saved locally.";
  }
  return null;
}

export async function syncNow(opts?: { pushOnly?: boolean }): Promise<{
  ok: boolean;
  error?: string;
  cancelled?: boolean;
  synced?: number;
  stateChanged?: number;
  people?: number;
}> {
  if (syncing) return { ok: false, error: "Sync already in progress" };
  if (isOffline()) return { ok: false, error: OFFLINE_ERROR };
  const config = await getDeviceConfig();
  if (!config) return { ok: false, error: "No device token configured yet" };

  const tooOld = await tooOldToSync();
  if (tooOld) {
    await setSyncStatus({ lastAttemptAt: Date.now(), lastError: tooOld });
    return { ok: false, error: tooOld };
  }

  syncing = true;
  await setSyncStatus({ lastAttemptAt: Date.now() });
  const errors: string[] = [];
  let anySuccess = false;
  let revoked = false;
  let cancelled = false;
  let pushed = 0;
  let stateChanged = 0;
  let peopleRows = 0;
  let unknownIds: string[] = [];

  try {
    try {
      pushed = await pushEvents(config.serverUrl, config.token);
      anySuccess = true;
    } catch (err: any) {
      if (err instanceof DeviceRevokedError) revoked = true;
      else if (err instanceof SyncCancelledError) cancelled = true;
      else errors.push(err?.message ?? String(err));
    }

    // Config FIRST, ahead of the roster. Both are cheap — a few KB — and
    // between them they carry everything that makes the phone usable at all:
    // the PIN list, the meal windows, and the role from /info. They used to
    // run last, stuck behind a roster pull that can take minutes on a weak
    // link, which is why a phone mid-first-sync sat there showing "Role —"
    // and "PINs 0" (observed live). A roster that is still arriving is a
    // phone that works with an incomplete list; a role that is still
    // arriving is a phone that cannot do anything at all.
    if (!revoked && !opts?.pushOnly && !cameraLive) {
      const flag = await get<{ key: string; at: number }>("meta", "config-pulled");
      const due = !flag || Date.now() - flag.at > 5 * 60_000;
      if (due) {
        try {
          await pullConfig(config.serverUrl, config.token);
          await pullDeviceInfo(config.serverUrl, config.token);
          await put<{ key: string; at: number }>("meta", { key: "config-pulled", at: Date.now() });
          anySuccess = true;
        } catch (err: any) {
          if (err instanceof DeviceRevokedError) revoked = true;
          else if (err instanceof SyncCancelledError) cancelled = true;
          else errors.push(err?.message ?? String(err));
        }
      }
    }

    // Pulls never run while the camera is live — the single largest memory
    // win in the whole app (UNIFIED-02 §8.1).
    if (!revoked && !cancelled && !opts?.pushOnly && !cameraLive) {
      try {
        const state = await pullState(config.serverUrl, config.token);
        stateChanged = state.changed;
        unknownIds = state.unknownIds;
        anySuccess = true;
      } catch (err: any) {
        if (err instanceof DeviceRevokedError) revoked = true;
        else if (err instanceof SyncCancelledError) cancelled = true;
        else errors.push(err?.message ?? String(err));
      }
    }

    // Identity rarely — when the interval says it is due, or when the state
    // pull just returned an id this device has never seen.
    if (!revoked && !cancelled && !opts?.pushOnly && !cameraLive) {
      const flag = await get<{ key: string; at: number }>("meta", "people-pulled");
      const due = !flag || Date.now() - flag.at > 10 * 60_000 || unknownIds.length > 0;
      if (due) {
        try {
          peopleRows = await pullPeople(config.serverUrl, config.token);
          // Only a pull that ran to the last page counts as "done for the
          // next 10 minutes". A cancelled one deliberately leaves the flag
          // alone so the very next tick resumes from the saved cursor.
          await put<{ key: string; at: number }>("meta", { key: "people-pulled", at: Date.now() });
          anySuccess = true;
        } catch (err: any) {
          if (err instanceof DeviceRevokedError) revoked = true;
          else if (err instanceof SyncCancelledError) cancelled = true;
          else errors.push(err?.message ?? String(err));
        }
      }
    }

    // Wage-worker enrolments made locally at the gate — same gate as the
    // config/people pulls above (a full-size enrolment photo is exactly
    // the kind of thing that must never overlap a live camera). No due
    // check: it's a no-op scan whenever nothing is pending, which is nearly
    // always — new enrolments are rare, not a recurring poll.
    if (!revoked && !cancelled && !opts?.pushOnly && !cameraLive) {
      try {
        await pushWageWorkers(config.serverUrl, config.token);
        anySuccess = true;
      } catch (err: any) {
        if (err instanceof DeviceRevokedError) revoked = true;
        else if (err instanceof SyncCancelledError) cancelled = true;
        else errors.push(err?.message ?? String(err));
      }
    }

    // Audit-photo pruning rides the tick — cheap when there is nothing old.
    try {
      await pruneCapturedPhotos();
    } catch {
      // never let cleanup fail a sync
    }
  } finally {
    syncing = false;
  }

  if (revoked) {
    await clearDeviceConfig();
    window.dispatchEvent(new Event(DEVICE_REVOKED_EVENT));
    return { ok: false, error: "Device revoked — please re-pair" };
  }

  if (anySuccess) {
    await setSyncStatus({ lastSuccessAt: Date.now(), lastError: null });
    if (config.deviceId) saveBackup(config.deviceId);
  } else if (cancelled) {
    await setSyncStatus({ lastError: null });
  } else {
    await setSyncStatus({ lastError: errors[0] ?? "Sync failed" });
  }

  // `cancelled` rides back as ok:false with no error, so the scheduler's
  // backoff counter (syncAllNow) treats it as a non-event rather than
  // punishing the next tick for something the operator chose.
  return { ok: anySuccess, error: errors[0], cancelled, synced: pushed, stateChanged, people: peopleRows };
}

/** Fire-and-forget — call after an event so it shows up centrally quickly
 * without waiting for the next scheduled tick. Never throws. */
export function syncSoon(): void {
  syncNow({ pushOnly: true }).catch(() => {});
}

// ── Scheduler ───────────────────────────────────────────────────────────────
// Ported from Eggsy-Payroll's scheduler: rush windows, exponential backoff
// on consecutive failures, sync on `online`, sync on app foreground, push
// immediately after every event. Two changes (UNIFIED-02 §6.2): intervals
// come from /config (via getSyncIntervals, with the old constants as the
// default), and pulls are gated on the camera screen being torn down.

function isRushWindow(d: Date, windows: [number, number, number, number][]): boolean {
  const mins = d.getHours() * 60 + d.getMinutes();
  return windows.some(([fromH, fromM, toH, toM]) => {
    const from = fromH * 60 + fromM;
    const to = toH * 60 + toM;
    return mins >= from && mins <= to;
  });
}

// Backoff for a connection that is present but not working — weak signal, a
// captive wifi portal, a server that is down. navigator.onLine still reports
// true in all of those, so the offline check above never fires and every tick
// spends the full FETCH_TIMEOUT_MS failing. Each consecutive failed tick
// doubles the wait; the first success puts it straight back to the normal
// cadence. Capped at the idle interval: backoff can slow a rush window down
// to the everyday rate but can never make the app sync LESS often than it
// already does when things are quiet. This only paces the TIMER — it does
// not touch syncSoon(), so an event still pushes the moment it is recorded.
const MAX_FAILURE_EXPONENT = 8; // 2**8 — beyond this the cap has long since won
let consecutiveFailures = 0;

async function nextDelayMs(): Promise<number> {
  // Sync, like the old app, reads the persisted intervals here so a config
  // pull that changes them takes effect on the very next tick.
  const { rushWindows, rushIntervalMs, idleIntervalMs } = await getSyncIntervals();
  const base = isRushWindow(new Date(), rushWindows) ? rushIntervalMs : idleIntervalMs;
  if (consecutiveFailures === 0) return base;
  const backedOff = base * 2 ** Math.min(consecutiveFailures, MAX_FAILURE_EXPONENT);
  return Math.min(backedOff, idleIntervalMs);
}

/** Exposed for the diagnostics panel — how many scheduler ticks have failed
 * back to back, and what the next wait will be. */
export async function getBackoffState(): Promise<{ consecutiveFailures: number; nextDelayMs: number }> {
  return { consecutiveFailures, nextDelayMs: await nextDelayMs() };
}

let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;

async function syncAllNow(): Promise<void> {
  const result = await syncNow();
  if (result.ok) {
    consecutiveFailures = 0;
  } else if (!result.cancelled) {
    // A sync the operator stopped says nothing about the connection — backing
    // off after one would punish the next tick for a deliberate choice.
    consecutiveFailures = Math.min(consecutiveFailures + 1, MAX_FAILURE_EXPONENT);
  }
}

async function scheduleNext() {
  if (timer) clearTimeout(timer);
  const delay = await nextDelayMs();
  timer = setTimeout(async () => {
    await syncAllNow();
    scheduleNext(); // recomputed each tick so crossing a rush-window boundary — or clearing a backoff — re-paces immediately
  }, delay);
}

/** Runs a sync outside the timer (signal returned, app reopened) and then
 * re-arms the timer from the result. Without the re-arm, a phone that had
 * backed off to the idle cap would sync once on reconnect and then sit out
 * the rest of the old long wait, even though the connection is healthy
 * again and the counter has already been cleared. */
async function syncAllNowAndReschedule(): Promise<void> {
  await syncAllNow();
  scheduleNext(); // clears the pending timer first, so this never double-schedules
}

/** Call once, on app start. Safe to call more than once — no-ops after the first. */
export function startAutoSync(): void {
  if (started) return;
  started = true;
  scheduleNext();
  window.addEventListener("online", () => { syncAllNowAndReschedule().catch(() => {}); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") syncAllNowAndReschedule().catch(() => {});
  });
}
