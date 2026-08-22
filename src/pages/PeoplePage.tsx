import { useEffect, useState } from "react";
import { listPeople, getThumbKeys, fetchThumb, getPersonThumb } from "../lib/people";
import { listExceptions, lastPunchToday, stateIsFreshForToday } from "../lib/events";
import { pendingCounts, getDeviceIdentity } from "../lib/sync";
import { MEAL_LABEL, STATE_LABEL, STATE_BADGE, formatDate, formatTime } from "../lib/labels";
import { IconAlert, IconPlus, IconSearch } from "../components/Icons";
import type { Event, Person, Role } from "../types";

/** The roster. PIN-gated. Gate enrols wage workers; canteen is read-only —
 * the enrol button does not render (UNIFIED-02 §4.2). Punch history and the
 * exceptions list both live in here — neither earns its own tab. */
export default function PeoplePage({
  onOpenPerson,
  onEnrol,
}: {
  onOpenPerson: (id: string) => void;
  onEnrol: () => void;
}) {
  const [tab, setTab] = useState<"roster" | "exceptions">("roster");
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState<Person[]>([]);
  const [exceptions, setExceptions] = useState<Event[]>([]);
  const [pending, setPending] = useState(0);
  const [role, setRole] = useState<Role | null>(null);
  const [thumbs, setThumbs] = useState<Set<string>>(new Set());

  async function refresh() {
    const [ppl, ex, p, identity] = await Promise.all([
      listPeople(),
      listExceptions(),
      pendingCounts(),
      getDeviceIdentity(),
    ]);
    setPeople(ppl);
    setExceptions(ex);
    setPending(p.events);
    setRole(identity?.role ?? null);
    const keys = new Set(await getThumbKeys());
    setThumbs(keys);
  }

  useEffect(() => {
    refresh();
  }, []);

  // Thumbnails arrive lazily — this page is never the camera screen, so it is
  // the right place to fetch the ones the device lacks (UNIFIED-02 §8.2).
  //
  // A small fixed pool rather than a plain sequential loop: each thumb is its
  // own request, so on a slow link the round-trip latency — not the payload —
  // is the whole cost, and running them strictly one after another stacks
  // every one of those waits end to end (158 people on a weak connection took
  // minutes to trickle in, observed live). Four at a time overlaps the waits
  // without ever holding more than four 96px JPEGs in flight, which keeps the
  // memory rule this loop exists to respect (UNIFIED-02 §8.1) intact. Do NOT
  // raise this to "just fetch them all" — that is the unbounded-parallel
  // fetch the memory budget cannot absorb.
  useEffect(() => {
    let cancelled = false;
    const CONCURRENCY = 4;
    // One shared cursor across the workers — each takes the next person as it
    // frees up, so a slow request never blocks the others behind it.
    let next = 0;
    const worker = async () => {
      while (!cancelled) {
        const i = next++;
        if (i >= people.length) return;
        const thumb = await fetchThumb(people[i].id);
        if (thumb && !cancelled) setThumbs((prev) => new Set(prev).add(people[i].id));
      }
    };
    void Promise.all(Array.from({ length: Math.min(CONCURRENCY, people.length) }, worker));
    return () => {
      cancelled = true;
    };
  }, [people]);

  return (
    <div className="min-h-screen bg-bg pb-24">
      <div className="px-4 pt-4 pb-3 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-ink">People</h1>
          <p className="text-xs text-ink-muted">Roster, history and exceptions</p>
        </div>
        {role === "gate" && (
          <button onClick={onEnrol} className="btn-primary px-3.5 py-2 text-sm">
            <IconPlus size={16} /> Enrol
          </button>
        )}
      </div>

      {/* Pending sync, front and centre. */}
      <div className="px-4">
        <div className="card px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                pending > 0 ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"
              }`}
            >
              <IconAlert size={20} />
            </div>
            <div>
              <p className="font-semibold text-ink">
                {pending > 0 ? `${pending} pending sync` : "Fully synced"}
              </p>
              <p className="text-xs text-ink-muted">
                {pending > 0 ? "Waiting to reach the server" : "Everything on this phone is on the server"}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Roster / Exceptions toggle */}
      <div className="px-4 mt-4 flex gap-2">
        <TabButton active={tab === "roster"} onClick={() => setTab("roster")}>
          Roster ({people.length})
        </TabButton>
        <TabButton active={tab === "exceptions"} onClick={() => setTab("exceptions")}>
          Exceptions ({exceptions.length})
        </TabButton>
      </div>

      {tab === "roster" ? (
        <div className="px-4 mt-3 space-y-2">
          {people.length > 0 && (
            <div className="relative">
              <IconSearch size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" />
              <input
                className="input pl-9"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name or code…"
              />
            </div>
          )}
          {people.length === 0 && (
            <p className="text-center text-sm text-ink-muted py-10">
              No people yet. {role === "gate" ? "Enrol the first one, or pair this phone to pull the roster." : "Sync in Settings to pull the roster."}
            </p>
          )}
          {people.length > 0 &&
            filterPeople(people, query).length === 0 && (
              <p className="text-center text-sm text-ink-muted py-10">No one matches "{query}".</p>
            )}
          {filterPeople(people, query).map((p) => (
            <button
              key={p.id}
              onClick={() => onOpenPerson(p.id)}
              className="card w-full flex items-center gap-3 px-3.5 py-3 text-left active:bg-bg"
            >
              {thumbs.has(p.id) ? (
                <ThumbImg personId={p.id} />
              ) : (
                <div className="w-10 h-10 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold">
                  {p.name[0]?.toUpperCase()}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="font-medium text-ink truncate">{p.name}</p>
                <p className="text-xs text-ink-muted">
                  {p.kind === "payroll" ? "Payroll" : p.role ? `Wage · ${p.role}` : "Wage"}
                  {p.empCode ? ` · ${p.empCode}` : ""}
                </p>
              </div>
              <div className="text-right">
                {/* §5.4 v1.1: yesterday's punch/attendance must not show as
                    today's — use only state that belongs to today. */}
                {(() => {
                  const lp = lastPunchToday(p);
                  const fresh = stateIsFreshForToday(p);
                  if (lp?.type === "in") return <span className="badge bg-emerald-100 text-emerald-800">In</span>;
                  if (lp?.type === "out") return <span className="badge bg-ink-muted/10 text-ink-muted">Out</span>;
                  if (fresh && p.presentToday) return <span className="badge bg-emerald-100 text-emerald-800">Present</span>;
                  return null;
                })()}
                {!p.isActive && <span className="badge bg-slate-200 text-slate-600">Inactive</span>}
              </div>
            </button>
          ))}
        </div>
      ) : (
        <div className="px-4 mt-3 space-y-2">
          {exceptions.length === 0 && (
            <p className="text-center text-sm text-ink-muted py-10">No exceptions. Clean run.</p>
          )}
          {exceptions.map((e) => (
            <div key={e.id} className="card px-3.5 py-3">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-ink truncate">{e.personName}</p>
                  <p className="text-xs text-ink-muted">
                    {formatDate(e.date)} ·{" "}
                    {e.type === "meal" ? MEAL_LABEL[e.meal ?? "lunch"] : e.type.toUpperCase()} · {formatTime(e.ts)}
                  </p>
                </div>
                <span className={`badge ${STATE_BADGE[e.state]} shrink-0`}>{STATE_LABEL[e.state]}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {e.duplicate && <span className="badge bg-sky-100 text-sky-800">Duplicate</span>}
                {e.syncFailedReason && (
                  <span className="badge bg-red-100 text-red-800" title={e.syncFailedReason}>
                    Rejected by server
                  </span>
                )}
                {e.extraPlateKind === "second_plate" && <span className="badge bg-sky-100 text-sky-800">Second plate</span>}
                {e.extraPlateKind === "override" && <span className="badge bg-orange-100 text-orange-800">Missing punch</span>}
                {e.reasonText && (
                  <span className="badge bg-bg border border-line text-ink-muted">{e.reasonText}</span>
                )}
                {e.photoUrl && <span className="badge bg-bg border border-line text-ink-muted">Has photo</span>}
              </div>
              {e.syncFailedReason && <p className="mt-2 text-xs text-red-700">{e.syncFailedReason}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function filterPeople(people: Person[], query: string): Person[] {
  const q = query.trim().toLowerCase();
  if (!q) return people;
  return people.filter(
    (p) => p.name.toLowerCase().includes(q) || (p.empCode ?? "").toLowerCase().includes(q),
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 py-2.5 rounded-xl text-sm font-semibold ${
        active ? "bg-primary text-white" : "bg-surface border border-line text-ink-muted"
      }`}
    >
      {children}
    </button>
  );
}

function ThumbImg({ personId }: { personId: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    getPersonThumb(personId).then((t) => !cancelled && setSrc(t));
    return () => {
      cancelled = true;
    };
  }, [personId]);
  if (!src) return <div className="w-10 h-10 rounded-full bg-line" />;
  return <img src={src} alt="" className="w-10 h-10 rounded-full object-cover border border-line" />;
}
