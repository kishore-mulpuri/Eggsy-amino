import { useEffect, useState } from "react";
import {
  getPerson,
  deactivateWagePerson,
  addLocalFaceSample,
  clearLocalFaceSamples,
  MAX_LOCAL_SAMPLES,
} from "../lib/people";
import CameraCapture, { type CaptureResult } from "../components/CameraCapture";
import {
  listEventsForPerson,
  recordEvent,
  currentMeal,
  checkEligible,
  alreadyServed,
  nextTokenNumber,
  stateIsFreshForToday,
} from "../lib/events";
import { getDeviceIdentity, syncSoon, getMealWindows, getSyncStatus } from "../lib/sync";
import { getCachedLocation } from "../lib/location";
import { localDate } from "../lib/id";
import { MEAL_LABEL, STATE_LABEL, STATE_BADGE, formatDate, formatTime } from "../lib/labels";
import { IconBack, IconPlus, IconCheck } from "../components/Icons";
import type { Event, EventState, MealWindow, Person } from "../types";

/** One person's history: punch history and their exceptions list both live
 * here. Gate role → manual punch, now or backdated
 * (backdating is the day-correction mechanism, UNIFIED-02 §7). */
export default function PersonDetailPage({
  personId,
  onBack,
}: {
  personId: string;
  onBack: () => void;
}) {
  const [person, setPerson] = useState<Person | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [role, setRole] = useState<string | null>(null);
  const [siteCode, setSiteCode] = useState("X");
  const [windows, setWindows] = useState<MealWindow[]>([]);
  const [statePullAt, setStatePullAt] = useState<number | null>(null);
  const [manualSetup, setManualSetup] = useState<"in" | "out" | null>(null);
  const [manualBusy, setManualBusy] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  const [backTs, setBackTs] = useState("");
  const [faceHelp, setFaceHelp] = useState(false);
  const [faceMsg, setFaceMsg] = useState<string | null>(null);
  const [serveBusy, setServeBusy] = useState(false);
  const [serveMsg, setServeMsg] = useState<string | null>(null);
  const [serveDone, setServeDone] = useState<Event | null>(null);

  useEffect(() => {
    refresh();
    (async () => {
      const [i, wins, status] = await Promise.all([
        getDeviceIdentity(),
        getMealWindows(),
        getSyncStatus(),
      ]);
      setRole(i?.role ?? null);
      setSiteCode(i?.siteCode ?? "X");
      setWindows(wins);
      setStatePullAt(status.lastStatePullAt);
    })();
  }, [personId]);

  async function refresh() {
    const [p, evs] = await Promise.all([getPerson(personId), listEventsForPerson(personId)]);
    setPerson(p ?? null);
    setEvents(evs);
  }

  async function handleManualPunch(type: "in" | "out", ts: number) {
    if (manualBusy || !person) return;
    try {
      setManualBusy(true);
      setManualError(null);
      const loc = getCachedLocation();
      await recordEvent({
        personId: person.id,
        personKind: person.kind,
        personName: person.name,
        empCode: person.empCode,
        type,
        method: "manual",
        state: "verified",
        ts,
        latitude: loc?.latitude ?? null,
        longitude: loc?.longitude ?? null,
        accuracy: loc?.accuracy ?? null,
      });
      setManualSetup(null);
      setBackTs("");
      syncSoon();
      refresh();
    } catch (err: any) {
      // The punch was NOT written — say so and keep the sheet open with the
      // entered time, so the operator can retry rather than walk away
      // assuming it saved.
      setManualError(err?.message ?? "Could not record punch");
    } finally {
      setManualBusy(false);
    }
  }

  /** Store one more view of this face on THIS phone. The camera already
   * rejected spoofs and confirmed a face before handing us an embedding, so
   * the only judgement left is "is this the right person", which is the
   * operator's — they navigated here by name. */
  async function handleFaceSample(cap: CaptureResult) {
    if (!person) return;
    try {
      const n = await addLocalFaceSample(person.id, cap.face.embedding!);
      setFaceMsg(
        n >= MAX_LOCAL_SAMPLES
          ? `Saved — ${n} of ${MAX_LOCAL_SAMPLES} samples (oldest now replaced as you add more).`
          : `Saved — ${n} of ${MAX_LOCAL_SAMPLES} samples. Add more on different days or lighting.`,
      );
      setFaceHelp(false);
      refresh();
    } catch (err: any) {
      setFaceMsg(err?.message ?? "Could not save the face sample");
    }
  }

  async function handleClearSamples() {
    if (!person) return;
    if (!confirm(`Remove the face samples added on this phone for ${person.name}?`)) return;
    await clearLocalFaceSamples(person.id);
    setFaceMsg("Removed. Matching is back to the enrolled photo.");
    refresh();
  }

  /** Serve this person the current meal from their detail page — the canteen
   * mirror of the camera's Serve card, reached by name-pick. Same v1 rules
   * (UNIFIED-00 §6): eligibility, present-today and duplicate checks all
   * route to paper; a normal plate is recorded as-is. */
  async function handleServe() {
    if (serveBusy || !person) return;
    setServeBusy(true);
    setServeMsg(null);
    try {
      const { meal, outsideWindow } = currentMeal(new Date(), windows);
      const pullFresh = statePullAt != null && localDate(new Date(statePullAt)) === localDate();
      const personFresh = stateIsFreshForToday(person);

      if (!checkEligible(person, meal)) {
        setServeMsg(`${person.name} is not on the ${MEAL_LABEL[meal].toLowerCase()} list — record this plate on paper.`);
        return;
      }

      let state: EventState;
      if (!pullFresh || !personFresh) {
        state = "unverified_attendance";
      } else if (person.presentToday) {
        state = "name_matched";
      } else {
        setServeMsg(`${person.name} is not present today — record this plate on paper.`);
        return;
      }

      const dup = await alreadyServed(person, meal);
      if (dup.event || dup.serverSays) {
        setServeMsg(`${person.name} was already served ${MEAL_LABEL[meal].toLowerCase()} today — record a second plate on paper.`);
        return;
      }

      const loc = getCachedLocation();
      const tokenNumber = await nextTokenNumber(siteCode, localDate(), meal);
      const event = await recordEvent({
        personId: person.id,
        personKind: person.kind,
        personName: person.name,
        empCode: person.empCode,
        type: "meal",
        meal,
        method: "manual",
        matchScore: null,
        state,
        extraPlateKind: null,
        outsideWindow,
        tokenNumber,
        latitude: loc?.latitude ?? null,
        longitude: loc?.longitude ?? null,
        accuracy: loc?.accuracy ?? null,
      });
      setServeDone(event);
      syncSoon();
      refresh();
    } catch (err: any) {
      setServeMsg(err?.message ?? "Could not record the plate");
    } finally {
      setServeBusy(false);
    }
  }

  if (!person) return null;

  const punches = events.filter((e) => e.type === "in" || e.type === "out");
  const plates = events.filter((e) => e.type === "meal");
  const { meal, outsideWindow } = currentMeal(new Date(), windows);

  return (
    <div className="min-h-screen bg-bg pb-24">
      <div className="px-4 pt-4 pb-3 flex items-center gap-3">
        <button onClick={onBack} aria-label="Back" className="text-ink-muted p-1 -ml-1">
          <IconBack size={22} />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-bold text-ink truncate">{person.name}</h1>
          <p className="text-xs text-ink-muted">
            {person.kind === "payroll" ? "Payroll" : person.role ? `Wage · ${person.role}` : "Wage"}
            {person.empCode ? ` · ${person.empCode}` : ""}
            {person.aadhar ? ` · Aadhar ${person.aadhar}` : ""}
          </p>
        </div>
      </div>

      {/* Serve meal — canteen only. */}
      {role === "canteen" && (
        <div className="px-4 flex gap-2 items-center">
          <button onClick={handleServe} disabled={serveBusy} className="btn-primary flex-1 py-2.5 text-sm">
            {serveBusy ? "Serving…" : `Serve ${MEAL_LABEL[meal]}`}
          </button>
          {outsideWindow && (
            <span className="badge bg-amber-100 text-amber-800 shrink-0">Outside window</span>
          )}
        </div>
      )}
      {serveMsg && <p className="px-4 mt-2 text-[13px] text-red-600">{serveMsg}</p>}

      {/* Manual punch — gate only. */}
      {role === "gate" && (
        <div className="px-4 flex gap-2">
          <button onClick={() => { setManualError(null); setBackTs(nowForDateTimeInput()); setManualSetup("in"); }} className="btn-outline flex-1 py-2.5 text-sm">
            <IconPlus size={15} /> Manual in
          </button>
          <button onClick={() => { setManualError(null); setBackTs(nowForDateTimeInput()); setManualSetup("out"); }} className="btn-outline flex-1 py-2.5 text-sm">
            <IconPlus size={15} /> Manual out
          </button>
          {person.kind === "wage" && (
            <button
              onClick={() => {
                if (confirm(`Deactivate ${person.name}?`)) deactivateWagePerson(person.id).then(refresh);
              }}
              className="btn-danger px-3 py-2.5 text-sm shrink-0"
            >
              Deactivate
            </button>
          )}
        </div>
      )}

      {/* Teach this phone a face the camera keeps missing. Any paired role —
          canteen misses matches too — and local to this device; the office
          never sees these samples. */}
      {(role === "gate" || role === "canteen") && (
        <div className="px-4 mt-2">
          <div className="flex gap-2">
            <button onClick={() => { setFaceMsg(null); setFaceHelp(true); }} className="btn-outline flex-1 py-2.5 text-sm">
              Improve face match
              {(person.localSamples?.length ?? 0) > 0 && ` (${person.localSamples!.length})`}
            </button>
            {(person.localSamples?.length ?? 0) > 0 && (
              <button onClick={handleClearSamples} className="btn-outline px-3 py-2.5 text-sm shrink-0">
                Reset
              </button>
            )}
          </div>
          {faceMsg && <p className="text-[13px] text-ink-muted mt-2">{faceMsg}</p>}
        </div>
      )}

      {/* History */}
      <div className="px-4 mt-4">
        <h2 className="section-title mb-2">History</h2>
        {events.length === 0 && (
          <p className="text-sm text-ink-muted py-6 text-center">Nothing recorded yet.</p>
        )}
        <div className="space-y-2">
          {punches.map((e) => (
            <div key={e.id} className="card px-3.5 py-3 flex items-center gap-3">
              <span
                className={`w-12 h-9 rounded-lg flex items-center justify-center text-sm font-black shrink-0 ${
                  e.type === "in" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"
                }`}
              >
                {e.type.toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink">
                  {formatDate(e.date)} · {formatTime(e.ts)}
                </p>
                <p className="text-[11px] text-ink-muted">
                  {e.method === "face"
                    ? `Face ${e.matchScore != null ? (e.matchScore * 100).toFixed(0) + "%" : ""}`
                    : "Manual"}
                  {e.authorisedBy ? " · authorised" : ""}
                  {e.syncFailedReason ? " · rejected" : e.syncedAt ? "" : " · pending"}
                </p>
              </div>
              {e.syncFailedReason && <span className="badge bg-red-100 text-red-800">Rejected</span>}
              {!e.syncedAt && !e.syncFailedReason && <span className="badge bg-amber-100 text-amber-800">Pending</span>}
            </div>
          ))}

          {plates.map((e) => (
            <div key={e.id} className="card px-3.5 py-3 flex items-center gap-3">
              <span className="w-12 h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center text-[11px] font-black shrink-0">
                {e.meal ? MEAL_LABEL[e.meal].slice(0, 3).toUpperCase() : "MEAL"}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink">
                  {formatDate(e.date)} · {formatTime(e.ts)}
                </p>
                <p className="text-[11px] text-ink-muted">
                  {e.meal ? MEAL_LABEL[e.meal] : ""}
                  {e.tokenNumber ? ` · ${e.tokenNumber}` : ""}
                  {e.syncFailedReason ? " · rejected" : e.syncedAt ? "" : " · pending"}
                </p>
              </div>
              <span className={`badge ${STATE_BADGE[e.state]} shrink-0`}>{STATE_LABEL[e.state]}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Face-sample capture. Mounted only while open so the camera stream
          and the face engine are released the moment it closes — leaving a
          second video stream running is what makes the phone heat up. */}
      {faceHelp && (
        <div className="fixed inset-0 z-40 bg-black/50 flex items-end sm:items-center sm:justify-center">
          <div className="bg-bg w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl shadow-float p-5 max-h-[92vh] overflow-y-auto">
            <h2 className="text-lg font-bold text-ink mb-1">Improve face match — {person.name}</h2>
            <p className="text-[13px] text-ink-muted mb-4">
              Capture {person.name} as they look now. This stays on this phone
              and only helps the camera recognise them here — it does not
              change their enrolled photo.
            </p>
            <CameraCapture captureLabel="Capture face sample" onCapture={handleFaceSample} />
            <button
              onClick={() => setFaceHelp(false)}
              className="btn-outline w-full py-3 mt-3"
            >
              Done
            </button>
          </div>
        </div>
      )}

      {/* Manual punch setup: now or backdated. */}
      {manualSetup && (
        <div className="fixed inset-0 z-40 bg-black/50 flex items-end sm:items-center sm:justify-center">
          <div className="bg-bg w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl shadow-float p-5">
            <h2 className="text-lg font-bold text-ink mb-1">
              Manual {manualSetup.toUpperCase()} — {person.name}
            </h2>
            <p className="text-[13px] text-ink-muted mb-4">
              A backdated punch is the day correction.
            </p>
            <label className="block mb-4">
              <span className="label">When did this happen?</span>
              <input
                className="input"
                type="datetime-local"
                value={backTs}
                disabled={manualBusy}
                onChange={(e) => setBackTs(e.target.value)}
              />
              <span className="text-[11px] text-ink-muted">Today by default — change only to backdate.</span>
            </label>
            {manualError && <p className="text-sm text-red-600 mb-3">{manualError}</p>}
            <div className="flex gap-2">
              <button
                onClick={() => { setManualSetup(null); setBackTs(""); setManualError(null); }}
                disabled={manualBusy}
                className="btn-outline flex-1 py-3"
              >
                Cancel
              </button>
              <button
                disabled={manualBusy}
                onClick={() => {
                  const ts = backTs && Number.isFinite(new Date(backTs).getTime()) ? new Date(backTs).getTime() : Date.now();
                  handleManualPunch(manualSetup, ts);
                }}
                className="btn-primary flex-1 py-3"
              >
                {manualBusy ? "Recording..." : "Record punch"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Served token (canteen) — mirror of the camera's token screen. */}
      {serveDone && (
        <div className="fixed inset-0 z-50 bg-primary flex flex-col items-center justify-center gap-5 p-6 pb-24 text-white">
          <p className="text-sm font-medium text-white/70 uppercase tracking-widest">Token</p>
          <div className="bg-white text-ink rounded-3xl px-10 py-8 text-center shadow-float w-full max-w-sm">
            <p className="text-4xl font-black tracking-tight">{serveDone.tokenNumber}</p>
            <p className="mt-1 text-sm text-ink-muted">
              {serveDone.meal ? MEAL_LABEL[serveDone.meal] : ""} · {formatTime(serveDone.ts)}
            </p>
          </div>
          <p className="text-xl font-semibold">{serveDone.personName}</p>
          <div className="flex items-center gap-2">
            <span className={`badge ${STATE_BADGE[serveDone.state]}`}>{STATE_LABEL[serveDone.state]}</span>
            {serveDone.outsideWindow && <span className="badge bg-white/15 text-white">Outside window</span>}
          </div>
          <button
            onClick={() => setServeDone(null)}
            className="btn bg-white text-primary w-full max-w-sm py-3.5 font-semibold"
          >
            <IconCheck size={20} /> Done
          </button>
        </div>
      )}
    </div>
  );
}

/** "now" formatted for a datetime-local input (YYYY-MM-DDTHH:mm) — the
 * manual punch sheet defaults to today so an operator only changes it to
 * backdate a punch. */
function nowForDateTimeInput(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
