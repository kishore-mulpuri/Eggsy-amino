// PIN verification — entirely offline, against the server PIN list that
// arrives in /api/device/config. There is NO device-local PIN: before
// pairing there is nothing to protect, and the 8-character pairing code is
// the gate. PINs are server-owned; the device never sets one.
//
// Two capabilities, not two roles:
//   canUnlock     — People, Settings, view history
//   canAuthorise  — manual punch, backdated punch, day correction (gate);
//                   guest, second plate, override, ineligible meal (canteen)
// One verify function returns WHO matched, so the event records `authorisedBy`.
// One 15-minute idle re-lock covers People and Settings — that is a screen
// lock, not part of the PIN model.
//
// Hashing is sha256(saltBytes || utf8(pin)), hex — the existing scheme,
// unchanged, so verification works with no network.
import { get, put } from "./db";
import type { PinEntry } from "../types";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function hashPin(pin: string, saltHex: string): Promise<string> {
  const salt = hexToBytes(saltHex);
  const enc = new TextEncoder();
  const data = new Uint8Array(salt.length + enc.encode(pin).length);
  data.set(salt, 0);
  data.set(enc.encode(pin), salt.length);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(digest));
}

/** The PIN list from the last /config pull. Stored in meta so the camera
 * screen can read it without touching the people store. */
export async function listPins(): Promise<PinEntry[]> {
  const stored = await get<{ key: string; pins: PinEntry[] }>("meta", "pins");
  const pins = Array.isArray(stored?.pins) ? stored.pins : [];
  return pins.sort((a, b) => a.name.localeCompare(b.name));
}

export function setPins(pins: PinEntry[]): Promise<void> {
  return put<{ key: string; pins: PinEntry[] }>("meta", { key: "pins", pins });
}

/** Verify a PIN against the server list for a specific capability. Returns
 * the matched entry — so the event records WHO authorised — or null. */
export async function verifyPin(
  pin: string,
  need: "unlock" | "authorise",
): Promise<PinEntry | null> {
  const pins = await listPins();
  for (const entry of pins) {
    if (need === "unlock" && !entry.canUnlock) continue;
    if (need === "authorise" && !entry.canAuthorise) continue;
    if ((await hashPin(pin, entry.saltHex)) === entry.pinHash) return entry;
  }
  return null;
}

/** Whether the device holds a PIN list yet. Before pairing there is nothing
 * to protect — the 8-character pairing code is the gate (UNIFIED-02 §7) —
 * so guarded screens open freely while this is false. */
export async function hasPins(): Promise<boolean> {
  return (await listPins()).length > 0;
}

// ── Screen lock (15-minute idle re-lock on People and Settings) ─────────────

const SESSION_KEY = "eggsy-amino-unlocked-at";
const PIN_KEY = "eggsy-amino-unlocked-pin";
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;

export function markUnlocked(entry: PinEntry): void {
  sessionStorage.setItem(SESSION_KEY, String(Date.now()));
  sessionStorage.setItem(PIN_KEY, JSON.stringify(entry));
}

export function isUnlocked(): boolean {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) return false;
  return Date.now() - Number(raw) < IDLE_TIMEOUT_MS;
}

/** The PIN-holder who unlocked this session, or null once the idle timeout
 * has passed. */
export function getActivePin(): PinEntry | null {
  if (!isUnlocked()) return null;
  const raw = sessionStorage.getItem(PIN_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PinEntry;
  } catch {
    return null;
  }
}

export function lock(): void {
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(PIN_KEY);
}
