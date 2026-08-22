import { useEffect, useState } from "react";
import { getPerson, deactivateWagePerson } from "../lib/people";
import { listEventsForPerson, recordEvent } from "../lib/events";
import { getDeviceIdentity, syncSoon } from "../lib/sync";
import { getCachedLocation } from "../lib/location";
import { MEAL_LABEL, STATE_LABEL, STATE_BADGE, formatDate, formatTime } from "../lib/labels";
import { IconBack, IconPlus } from "../components/Icons";
import type { Event, Person } from "../types";

/** One person's history: punch history and their exceptions list both live
 * here. Gate role → manual punch, now or backdated
 * (backdating is the day-correction mechanism, UNIFIED-02 §7). */
export default function PersonDetailPage({
  personId,
  onBack,
  onEdit,
}: {
  personId: string;
  onBack: () => void;
  onEdit?: () => void;
}) {
  const [person, setPerson] = useState<Person | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [role, setRole] = useState<string | null>(null);
  const [manualSetup, setManualSetup] = useState<"in" | "out" | null>(null);
  const [manualBusy, setManualBusy] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  const [backTs, setBackTs] = useState("");

  useEffect(() => {
    refresh();
    getDeviceIdentity().then((i) => setRole(i?.role ?? null));
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

  if (!person) return null;

  const punches = events.filter((e) => e.type === "in" || e.type === "out");
  const plates = events.filter((e) => e.type === "meal");

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
        {role === "gate" && onEdit && (
          <button onClick={onEdit} className="btn-outline px-3 py-2 text-sm">
            Edit
          </button>
        )}
      </div>

      {/* Manual punch — gate only. */}
      {role === "gate" && (
        <div className="px-4 flex gap-2">
          <button onClick={() => { setManualError(null); setManualSetup("in"); }} className="btn-outline flex-1 py-2.5 text-sm">
            <IconPlus size={15} /> Manual in
          </button>
          <button onClick={() => { setManualError(null); setManualSetup("out"); }} className="btn-outline flex-1 py-2.5 text-sm">
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
              <span className="text-[11px] text-ink-muted">Leave empty for right now.</span>
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
    </div>
  );
}
