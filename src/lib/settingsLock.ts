// Settings-only lock, set on the phone itself — separate from pin.ts's
// server-issued PIN list (which gates People/Settings together and is
// controlled centrally by the office). This one protects ONLY Settings:
// server URL, pairing/replace/unpair, device identity. People stays freely
// accessible so any operator can check the roster without a PIN.
//
// Deliberately local: the office cannot see or reset this PIN remotely (no
// server round-trip involved at all). If it's forgotten, the only recovery
// is clearing the app's local data (which unpairs the phone and starts
// fresh) — there is no "forgot PIN" bypass here on purpose; a self-service
// reset button would defeat the entire point of a lock.
import { get, put, del } from "./db";

interface SettingsLockMeta {
  key: "settings-lock";
  saltHex: string;
  pinHash: string;
}

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

/** True once this phone has a Settings PIN set — before that, Settings
 * opens freely (nothing to protect yet, same reasoning as pin.ts). */
export async function hasSettingsPin(): Promise<boolean> {
  return !!(await get<SettingsLockMeta>("meta", "settings-lock"));
}

export async function setSettingsPin(pin: string): Promise<void> {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = bytesToHex(saltBytes);
  const pinHash = await hashPin(pin, saltHex);
  await put<SettingsLockMeta>("meta", { key: "settings-lock", saltHex, pinHash });
}

export async function verifySettingsPin(pin: string): Promise<boolean> {
  const stored = await get<SettingsLockMeta>("meta", "settings-lock");
  if (!stored) return false;
  return (await hashPin(pin, stored.saltHex)) === stored.pinHash;
}

export async function clearSettingsPin(): Promise<void> {
  await del("meta", "settings-lock");
}

// ── Screen lock (same 15-minute idle re-lock shape as pin.ts, own session
// key so unlocking Settings never also unlocks anything server-PIN-gated
// and vice versa) ────────────────────────────────────────────────────────

const SESSION_KEY = "eggsy-amino-settings-unlocked-at";
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;

export function markSettingsUnlocked(): void {
  sessionStorage.setItem(SESSION_KEY, String(Date.now()));
}

export function isSettingsUnlocked(): boolean {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) return false;
  return Date.now() - Number(raw) < IDLE_TIMEOUT_MS;
}

export function lockSettings(): void {
  sessionStorage.removeItem(SESSION_KEY);
}
