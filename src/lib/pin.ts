// PIN verification for AUTHORISING an action — entirely offline, against
// the server PIN list that arrives in /api/device/config: manual punch,
// backdated punch, day correction (gate); guest, second plate, override,
// ineligible meal (canteen). One verify function returns WHO matched, so
// the event records `authorisedBy`. PINs here are server-owned; the device
// never sets one.
//
// This is a DIFFERENT lock from the Settings screen lock (settingsLock.ts),
// which is a PIN set on the phone itself, local-only, unrelated to this
// server-issued list. `PinEntry.canUnlock` is a leftover of an earlier
// design where this same list also gated People/Settings — that screen
// lock has since moved to settingsLock.ts, so `canUnlock` (and
// `verifyPin(pin, "unlock")`) are unused on the client now, kept only
// because the server/admin UI still stores and offers the field.
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

