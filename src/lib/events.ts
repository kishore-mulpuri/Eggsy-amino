// The event write path — a punch and a plate are the same row with a
// different `type` (UNIFIED-02 §5). One outbox, one retry path.
//
// The three rules it encodes (UNIFIED-00 §7):
//   1. Never block. Record the truthful state; the server reconciles.
//   2. The device records a truthful event, not a correct label — the
//      server sees every source and owns reconciliation.
//   3. A rejected event is a real thing that really happened. Never
//      silently drop one.
import { get, put, getAll, getByIndex } from "./db";
import { newId, localDate } from "./id";
import type { Event, EventMethod, EventState, ExtraPlateKind, Meal, Person } from "../types";

// ── Date-rollover guards (UNIFIED-00 §5.4, v1.1) ────────────────────────────
// The three server-supplied state fields belong to a specific day. On a new
// calendar day the state pull is legitimately empty, so a phone left running
// across midnight would otherwise carry yesterday's punch/attendance as
// fact — labelling this morning's first punch OUT, or serving an absent
// person as "verified". Discard them when their day is not today.

/** True when the state channel last wrote this person's attendance today.
 * `stateAt` is stamped by the state pull only (see types.ts), so stale
 * attendance can never be refreshed by an identity pull. */
export function stateIsFreshForToday(person: Person, today = localDate()): boolean {
  return typeof person.stateAt === "number" && localDate(new Date(person.stateAt)) === today;
}

/** The server's lastPunch when it happened today, else null. */
export function lastPunchToday(
  person: Person,
  today = localDate(),
): { type: "in" | "out"; ts: number } | null {
  const lp = person.lastPunch;
  if (!lp) return null;
  return localDate(new Date(lp.ts)) === today ? lp : null;
}

// ── Punch logic (gate) ──────────────────────────────────────────────────────

/** What the NEXT punch for this person should be, from the freshest view
 * available: the server's state (`person.lastPunch`, only when it happened
 * today — see §5.4 v1.1) or, if this device holds a newer local punch that
 * hasn't synced yet, that. First punch of the day is always "in". Returns
 * null when nothing at all is known. */
export async function nextPunchType(person: Person): Promise<"in" | "out" | null> {
  const today = await getByIndex<Event>("events", "byPersonDate", [person.id, localDate()]);
  const localLast = today.filter((e) => e.type === "in" || e.type === "out").sort((a, b) => b.ts - a.ts)[0] ?? null;

  let last: { type: "in" | "out"; ts: number } | null = lastPunchToday(person);
  if (localLast && (!last || localLast.ts > last.ts)) {
    last = { type: localLast.type as "in" | "out", ts: localLast.ts };
  }
  if (!last) return null;
  return last.type === "in" ? "out" : "in";
}

/** The duplicate guard: has this person already punched within
 * duplicateWindowMs (server-configured, default 120s)? */
export async function alreadyPunchedRecently(personId: string, windowMs: number): Promise<Event | null> {
  const today = await getByIndex<Event>("events", "byPersonDate", [personId, localDate()]);
  const punch = today
    .filter((e) => e.type === "in" || e.type === "out")
    .sort((a, b) => b.ts - a.ts)[0];
  if (!punch) return null;
  return Date.now() - punch.ts < windowMs ? punch : null;
}

// ── Meal logic (canteen) ────────────────────────────────────────────────────

/** "HH:MM" -> minutes since midnight. */
export function parseTime(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Pick the meal whose window contains `now`. If none does, pick the nearest
 * window and set `outsideWindow: true`. Never returns null — there is always
 * a meal, because there is always a person standing there. */
export function currentMeal(
  now: Date,
  windows: { meal: Meal; startTime: string; endTime: string }[],
): { meal: Meal; outsideWindow: boolean } {
  const mins = now.getHours() * 60 + now.getMinutes();
  const parsed = windows.map((w) => ({ w, start: parseTime(w.startTime), end: parseTime(w.endTime) }));

  // No windows configured yet — can't tell, so don't flag "outside".
  if (parsed.length === 0) return { meal: "lunch", outsideWindow: false };

  for (const { w, start, end } of parsed) {
    if (mins >= start && mins <= end) return { meal: w.meal, outsideWindow: false };
  }

  let best: { meal: Meal; dist: number } = { meal: "lunch", dist: Infinity };
  for (const { w, start, end } of parsed) {
    const dist = mins < start ? start - mins : mins - end;
    if (dist < best.dist) best = { meal: w.meal, dist };
  }
  return { meal: best.meal, outsideWindow: true };
}

/** `lunch` → always true (present → lunch). Breakfast/dinner come from the
 * person's eligibility allow-list (UNIFIED-00 §7.7). */
export function checkEligible(person: Person, meal: Meal): boolean {
  if (meal === "lunch") return true;
  return person.eligibility[meal] === true;
}

/** Has this person already been served this meal today? Merges the server's
 * view (servedToday covers every counter/device) with this device's own
 * unsynced plates. The server view only counts when its state is fresh for
 * today — yesterday's servedToday must not block (or clear) today's plate
 * (§5.4 v1.1). */
export async function alreadyServed(
  person: Person,
  meal: Meal,
): Promise<{ event: Event | null; serverSays: boolean }> {
  const today = await getByIndex<Event>("events", "byPersonDate", [person.id, localDate()]);
  const local = today.filter((e) => e.type === "meal" && e.meal === meal).sort((a, b) => b.ts - a.ts)[0];
  if (local) return { event: local, serverSays: false };
  // servedToday is the server's view — when this device holds nothing newer
  // for that meal, trust it (another counter served this person today).
  if (stateIsFreshForToday(person) && (person.servedToday ?? []).includes(meal)) {
    return { event: null, serverSays: true };
  }
  return { event: null, serverSays: false };
}

/** Token number, e.g. "N-0819-L-042". Serial counter per (mealDate, meal)
 * held in meta, assigned offline. Display-only — never a key, never relied
 * on for uniqueness across devices. */
export async function nextTokenNumber(siteCode: string, mealDate: string, meal: Meal): Promise<string> {
  const key = `serial-${mealDate}-${meal}`;
  const counter = await get<{ key: string; value: number }>("meta", key);
  const next = (counter?.value ?? 0) + 1;
  await put("meta", { key, value: next });

  const mmdd = mealDate.slice(5).replace("-", "");
  const mealLetter = meal === "breakfast" ? "B" : meal === "lunch" ? "L" : "D";
  const serial = String(next).padStart(3, "0");
  return `${siteCode}-${mmdd}-${mealLetter}-${serial}`;
}

// ── Write path ──────────────────────────────────────────────────────────────

interface RecordEventInput {
  personId: string | null;
  personKind: "payroll" | "wage" | "guest";
  personName: string;
  empCode: string | null;
  type: "in" | "out" | "meal";
  meal?: Meal | null;
  method: EventMethod;
  matchScore?: number | null;
  state: EventState;
  extraPlateKind?: ExtraPlateKind | null;
  authorisedBy?: string | null;
  reasonCode?: string | null;
  reasonText?: string | null;
  guestBatchId?: string | null;
  guestParty?: string | null;
  photoUrl?: string | null;
  capturedPhoto?: string | null;
  outsideWindow?: boolean;
  tokenNumber?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  accuracy?: number | null;
  /** manual/backdated events may carry an explicit instant. */
  ts?: number;
}

/** Write one event locally (the outbox). `syncedAt` is left unset so the
 * sync layer treats it as pending. */
export async function recordEvent(input: RecordEventInput): Promise<Event> {
  const ts = input.ts ?? Date.now();
  const event: Event = {
    id: newId(),
    personId: input.personId,
    personKind: input.personKind,
    personName: input.personName,
    empCode: input.empCode,
    type: input.type,
    meal: input.type === "meal" ? input.meal ?? "lunch" : null,
    ts,
    date: localDate(new Date(ts)),
    method: input.method,
    matchScore: input.matchScore ?? null,
    state: input.state,
    extraPlateKind: input.extraPlateKind ?? null,
    authorisedBy: input.authorisedBy ?? null,
    reasonCode: input.reasonCode ?? null,
    reasonText: input.reasonText ?? null,
    guestBatchId: input.guestBatchId ?? null,
    guestParty: input.guestParty ?? null,
    photoUrl: input.photoUrl ?? null,
    capturedPhoto: input.capturedPhoto ?? null,
    outsideWindow: !!input.outsideWindow,
    tokenNumber: input.tokenNumber ?? null,
    latitude: input.latitude ?? null,
    longitude: input.longitude ?? null,
    accuracy: input.accuracy ?? null,
    pending: 1,
  };
  await put("events", event);

  // Keep the person row's local view current so the next punch alternates
  // correctly even before the state pull catches up.
  if (event.personId && (event.type === "in" || event.type === "out")) {
    const person = await get<Person>("people", event.personId);
    if (person && (!person.lastPunch || ts >= person.lastPunch.ts)) {
      await put<Person>("people", { ...person, lastPunch: { type: event.type, ts } });
    }
  }
  return event;
}

// ── Reads ───────────────────────────────────────────────────────────────────

/** All events for a person, newest first — punch history + exceptions live
 * here (UNIFIED-02 §4.2), neither earns its own tab. */
export async function listEventsForPerson(personId: string): Promise<Event[]> {
  const rows = await getByIndex<Event>("events", "byPerson", personId);
  return rows.sort((a, b) => b.ts - a.ts);
}

export async function listEventsForDate(date: string): Promise<Event[]> {
  const rows = await getByIndex<Event>("events", "byDate", date);
  return rows.sort((a, b) => b.ts - a.ts);
}

/** Anything flagged for review: rejected rows, duplicates, overrides,
 * guests, second plates. Runs on the People screen (camera down) — a full
 * scan is acceptable there, and capturedPhotos are pruned by retention. */
export async function listExceptions(): Promise<Event[]> {
  const all = await getAll<Event>("events");
  return all
    .filter((e) => e.syncFailedReason || e.duplicate || e.state === "override" || e.state === "guest" || e.extraPlateKind === "second_plate")
    .sort((a, b) => b.ts - a.ts);
}
