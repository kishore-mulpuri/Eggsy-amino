// GPS tagging for events — mirrors what the browser kiosk already sends, so
// a punch from this device carries the same proof-of-location.
//
// Deliberately decoupled from the event itself: a GPS fix can take several
// seconds, and a punch must never wait on it. Instead, primeLocation() is
// fired the moment the Camera screen is ready to recognise someone — well
// before anyone's actually been matched — so a fix has time to arrive in the
// background. getCachedLocation() then just returns whatever's already
// available, synchronously, with no risk of blocking.
import { Geolocation } from "@capacitor/geolocation";

interface CachedFix {
  latitude: number;
  longitude: number;
  accuracy: number;
  at: number;
}

// A fix older than this is more likely to describe where the phone was
// earlier than where it is now (e.g. carried home) than to be a stale-but-
// still-accurate read of the same spot — so it's treated as no fix at all.
const MAX_AGE_MS = 5 * 60_000;

let latest: CachedFix | null = null;
let requesting = false;
let watchId: string | null = null;

export interface LocationStatus {
  ok: boolean;
  /** Human-readable outcome — either the native error (e.g. "Location
   * services are not enabled") or a success summary. This is exactly what
   * used to be swallowed silently; keeping it is what makes a GPS problem
   * visible on the phone itself instead of only traceable from source. */
  message: string;
  at: number;
}

let lastStatus: LocationStatus | null = null;

/** Whatever the last attempt (from either primeLocation or checkLocationNow)
 * actually found, or null if nothing has run yet this session. Settings
 * reads this to show a diagnostic instead of a silent failure. */
export function getLocationStatus(): LocationStatus | null {
  return lastStatus;
}

/** The actual fix attempt, shared by both entry points below so the
 * diagnostic always reflects the real permission/GPS-off/timeout path a
 * punch would have hit — not a separate, possibly-different check. */
async function attemptFix(): Promise<void> {
  try {
    const perm = await Geolocation.checkPermissions();
    if (perm.location !== "granted") {
      const result = await Geolocation.requestPermissions();
      if (result.location !== "granted") {
        lastStatus = { ok: false, message: "Location permission denied", at: Date.now() };
        return;
      }
    }

    const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 20000 });
    latest = {
      latitude: pos.coords.latitude,
      longitude: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
      at: Date.now(),
    };
    lastStatus = { ok: true, message: `Accurate to ${Math.round(pos.coords.accuracy)}m`, at: Date.now() };
  } catch (err: any) {
    // The one place this used to be a bare `catch {}` — e.g. Android's
    // Geolocation plugin rejects with "Location services are not enabled"
    // when the phone's system Location toggle is off, *before* it would
    // ever show a permission dialog. That reason is worth keeping.
    lastStatus = { ok: false, message: err?.message ?? String(err), at: Date.now() };
  }
}

/** Starts a standing GPS watch for the life of the app (call once, from
 * App's top level) so a fix is already warm by the time anyone reaches the
 * Camera screen — a face can be recognised and a punch recorded in a couple
 * of seconds, well inside the time a one-shot fix used to need per punch.
 * Every update refreshes `latest`, so getCachedLocation() stays current for
 * the whole session instead of racing a fresh fix on every single punch. */
export function startWatchingLocation(): void {
  if (watchId) return;
  Geolocation.checkPermissions()
    .then((perm) => (perm.location === "granted" ? perm : Geolocation.requestPermissions()))
    .then((perm) => {
      if (perm.location !== "granted") {
        lastStatus = { ok: false, message: "Location permission denied", at: Date.now() };
        return;
      }
      Geolocation.watchPosition({ enableHighAccuracy: true, timeout: 20000 }, (pos, err) => {
        if (err) {
          lastStatus = { ok: false, message: err.message ?? String(err), at: Date.now() };
          return;
        }
        if (!pos) return;
        latest = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          at: Date.now(),
        };
        lastStatus = { ok: true, message: `Accurate to ${Math.round(pos.coords.accuracy)}m`, at: Date.now() };
      }).then((id) => { watchId = id; });
    })
    .catch((err) => {
      lastStatus = { ok: false, message: err?.message ?? String(err), at: Date.now() };
    });
}

/** Kicks off a one-off location fix in the background — used as a fallback
 * on the Camera screen in case the standing watch (startWatchingLocation)
 * hasn't produced a fix yet. Never awaited, never throws; a punch must
 * never be blocked or broken by location trouble. The outcome still lands
 * in getLocationStatus() for Settings to show, even though nothing here
 * waits on it. */
export function primeLocation(): void {
  if (requesting) return;
  requesting = true;
  attemptFix().finally(() => {
    requesting = false;
  });
}

/** For Settings' "Check location" button — runs the same attempt as
 * primeLocation() but awaited, so the UI can show a definitive result
 * immediately instead of polling getLocationStatus(). */
export async function checkLocationNow(): Promise<LocationStatus> {
  await attemptFix();
  return lastStatus!;
}

/** Whatever fix is currently available and fresh enough, or null. Pure,
 * synchronous, side-effect-free — safe to call at the exact moment of a
 * punch without it ever waiting or failing. */
export function getCachedLocation(): { latitude: number; longitude: number; accuracy: number } | null {
  if (!latest) return null;
  if (Date.now() - latest.at > MAX_AGE_MS) return null;
  return { latitude: latest.latitude, longitude: latest.longitude, accuracy: latest.accuracy };
}
