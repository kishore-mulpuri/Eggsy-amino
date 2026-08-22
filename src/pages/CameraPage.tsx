import { useCallback, useEffect, useRef, useState } from "react";
import {
  loadFaceEngine,
  disposeFaceEngine,
  getFaceEmbedding,
  findBestMatchInGalleries,
  looksSpoofed,
  frameToDataUrl,
  DEFAULT_MATCH_THRESHOLD,
  MIN_MATCH_MARGIN,
} from "../lib/face";
import {
  currentMeal,
  checkEligible,
  alreadyServed,
  nextTokenNumber,
  recordEvent,
  nextPunchType,
  alreadyPunchedRecently,
  listEventsForDate,
  stateIsFreshForToday,
} from "../lib/events";
import { listPeople, getPersonThumb, matchablePeople } from "../lib/people";
import {
  getMealWindows,
  getDeviceConfig,
  getDeviceIdentity,
  getSyncStatus,
  getDuplicateWindowMs,
  pendingCounts,
  syncSoon,
  syncNow,
  setCameraLive,
  getVersionInfo,
} from "../lib/sync";
import { getAppVersion } from "../lib/device";
import { primeLocation, getCachedLocation } from "../lib/location";
import { localDate } from "../lib/id";
import { MEAL_LABEL, STATE_LABEL, STATE_BADGE, formatTime } from "../lib/labels";
import type { Event, EventState, Meal, MealWindow, Person, Role } from "../types";
import AuthorizeSheet, { type AuthorizeData } from "../components/AuthorizeSheet";
import { IconSearch, IconWifiOff, IconCamera, IconCheck, IconRefresh, IconCameraSwitch } from "../components/Icons";

const STATE_PULL_MAX_AGE_MS = 15 * 60_000; // UNIFIED-00 §8 — stop guessing after 15 min

interface MatchInfo {
  person: Person;
  matchedByFace: boolean;
  score: number | null;
}

// PHASE 2 (deferred — UNIFIED-00 §6 v1.1): the ServePlan shape below keeps
// every field the authorise sheet needs, but in v1 computePlan never returns
// a plan with needsAuthorise. Override/guest/second-plate routing, the
// AuthorizeSheet, reason codes and extraPlateKind all stay in the codebase,
// unreachable, so phase 2 is a re-route rather than a rewrite.
interface ServePlan {
  personType: "payroll" | "wage" | "guest";
  personId: string | null;
  personName: string;
  empCode: string | null;
  state: EventState;
  matchScore: number | null;
  meal: Meal;
  outsideWindow: boolean;
  extraPlateKind: "guest" | "second_plate" | "override" | null;
  needsAuthorise: boolean;
  needsPhoto: boolean;
  needsName: boolean;
  needsCameFrom: boolean;
  sheetTitle: string;
  sheetSubtitle: string;
}

/** The outcome of planning a plate. "paper" means: v1 records nothing for
 * this case — the operator writes it on paper (UNIFIED-00 §6 v1.1). */
type PlanResult =
  | { kind: "serve"; plan: ServePlan }
  | { kind: "paper"; message: string };

interface PunchOutcome {
  kind: "success" | "no-match" | "ambiguous" | "duplicate";
  score?: number;
  topName?: string;
  secondScore?: number;
  name?: string;
  punchType?: string;
  secondsAgo?: number;
  person?: Person;
  event?: Event;
}

function playSound() {
  try {
    const ctx = new ((window as any).AudioContext || (window as any).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(800, ctx.currentTime);
    osc.frequency.linearRampToValueAtTime(1200, ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.25);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.25);
  } catch {
    /* audio blocked — best effort */
  }
}

function vibrate() {
  try {
    if (navigator.vibrate) navigator.vibrate(150);
  } catch {
    /* nop */
  }
}

export default function CameraPage({ active }: { active: boolean }) {
  const [configured, setConfigured] = useState(false);
  const [role, setRole] = useState<Role | null>(null);
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [siteCode, setSiteCode] = useState("X");

  const [people, setPeople] = useState<Person[]>([]);
  const [windows, setWindows] = useState<MealWindow[]>([]);

  const [engineReady, setEngineReady] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<"user" | "environment">("user");

  const [match, setMatch] = useState<MatchInfo | null>(null);
  const [lastSeen, setLastSeen] = useState<{ score: number } | null>(null);
  const [frozenFrame, setFrozenFrame] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [scanFail, setScanFail] = useState<string | null>(null);
  const [punchPlan, setPunchPlan] = useState<{
    person: Person;
    stale: boolean;
    suggested: "in" | "out" | null;
    byFace: boolean;
  } | null>(null);
  const [outcome, setOutcome] = useState<PunchOutcome | null>(null);
  const [plan, setPlan] = useState<ServePlan | null>(null);
  const [paperMessage, setPaperMessage] = useState<string | null>(null);
  const [tokenEvent, setTokenEvent] = useState<Event | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [counts, setCounts] = useState<Record<Meal, number>>({ breakfast: 0, lunch: 0, dinner: 0 });
  const [punchesToday, setPunchesToday] = useState(0);
  const [online, setOnline] = useState(navigator.onLine);
  const [pending, setPending] = useState(0);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [statePullAt, setStatePullAt] = useState<number | null>(null);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updateDismissed, setUpdateDismissed] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const peopleRef = useRef<Person[]>([]);
  const detectingRef = useRef(false);
  const cameraReadyRef = useRef(false);
  const engineReadyRef = useRef(false);
  const auditPhotoRef = useRef<string | null>(null);

  useEffect(() => {
    peopleRef.current = people;
  }, [people]);

  // The camera screen owns the "camera live" flag that gates the scheduler's
  // pulls (UNIFIED-02 §8.1: never two big things at once). "Live" means this
  // tab is actually showing — switching to People/Settings tears the camera
  // down (below) and un-gates the pulls, which is exactly the point: heavy
  // pulls may only happen while no camera is held.
  useEffect(() => {
    if (configured && role && active) {
      setCameraLive(true);
      return () => setCameraLive(false);
    }
    setCameraLive(false);
  }, [configured, role, active]);

  // Load config, role, roster, windows, counts and warm GPS. Re-runs when
  // the operator comes back to this tab — the page stays mounted across tab
  // switches because it owns the camera.
  useEffect(() => {
    if (!active) return;
    (async () => {
      const [cfg, identity, wins, ppl, status] = await Promise.all([
        getDeviceConfig(),
        getDeviceIdentity(),
        getMealWindows(),
        listPeople(),
        getSyncStatus(),
      ]);
      setConfigured(!!cfg);
      if (identity) {
        setRole(identity.role);
        setSiteCode(identity.siteCode);
      }
      if (cfg?.deviceName) setDeviceName(cfg.deviceName);
      setWindows(wins);
      setPeople(ppl);
      setStatePullAt(status.lastStatePullAt);
      primeLocation();
      refreshStats();
    })();
  }, [active]);

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  // Status bar numbers on a slow cadence, and once immediately.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      await refreshStats();
      const [info, version] = await Promise.all([getVersionInfo(), getAppVersion()]);
      if (!cancelled) {
        setUpdateAvailable(info.latestVersionCode > 0 && info.latestVersionCode > version.versionCode);
      }
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  async function refreshStats() {
    const [status, p, today] = await Promise.all([getSyncStatus(), pendingCounts(), listEventsForDate(localDate())]);
    setLastSyncAt(status.lastSuccessAt);
    setStatePullAt(status.lastStatePullAt);
    setPending(p.events);
    const next: Record<Meal, number> = { breakfast: 0, lunch: 0, dinner: 0 };
    let punches = 0;
    for (const e of today) {
      if (e.type === "meal" && e.meal) next[e.meal]++;
      if (e.type === "in" || e.type === "out") punches++;
    }
    setCounts(next);
    setPunchesToday(punches);
  }

  // Camera + face engine. Only paused when the authorize sheet is about to
  // need its OWN camera (needsPhoto) — a phone camera can't be held by two
  // streams at once. The token screen and name search are overlays on top of
  // this same camera view, so they don't need it stopped.
  // The camera stream runs only while this tab is the visible one. Stopping
  // it on tab switches costs a second on return, but it is the requirement:
  // pulls may only run while no camera is held, and this tab is the camera.
  const cameraPaused = !!plan?.needsPhoto;
  const cameraActive = !!configured && !!role && active && !cameraPaused;

  // Face engine: loaded once per activation, independent of which camera
  // (front/back) is streaming — switching cameras must not reload the model.
  useEffect(() => {
    if (!cameraActive) {
      engineReadyRef.current = false;
      setEngineReady(false);
      // Free the face engine too — a 2GB phone shouldn't hold the WebGL
      // context + tensors while it's not even on the camera.
      disposeFaceEngine();
      return;
    }

    let cancelled = false;
    loadFaceEngine()
      .then(() => {
        if (cancelled) return;
        setEngineReady(true);
        engineReadyRef.current = true;
      })
      .catch((err) => !cancelled && setCameraError(`Could not load face engine: ${err.message}`));

    return () => {
      cancelled = true;
      disposeFaceEngine();
    };
  }, [cameraActive]);

  // Camera stream: re-opened whenever facingMode flips (front/back switch).
  useEffect(() => {
    if (!cameraActive) {
      cameraReadyRef.current = false;
      setCameraReady(false);
      return () => {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      };
    }

    let cancelled = false;
    setCameraReady(false);
    cameraReadyRef.current = false;
    navigator.mediaDevices
      .getUserMedia({
        video: { facingMode, width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
        setCameraReady(true);
        cameraReadyRef.current = true;
      })
      .catch((err) => !cancelled && setCameraError(`Camera access denied: ${err.message}`));

    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [cameraActive, facingMode]);

  /** Grab the current video frame into an offscreen canvas. The canvas — not
   * the live <video> — is what gets scanned, so the face we analyse is
   * exactly the still the operator sees frozen on screen. */
  function grabFrame(): HTMLCanvasElement | null {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return null;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  type ScanOutcome =
    | { kind: "match"; person: Person; score: number }
    | { kind: "no-face" }
    | { kind: "spoof" }
    | { kind: "no-roster" }
    | { kind: "no-match"; score: number }
    | { kind: "error"; message: string };

  /** One recognition pass over a single captured still. */
  const scanFrame = useCallback(async (frame: HTMLCanvasElement): Promise<ScanOutcome> => {
    try {
      const face = await getFaceEmbedding(frame);
      if (!face.ok || !face.embedding) return { kind: "no-face" };
      if (looksSpoofed(face)) return { kind: "spoof" };

      const roster = peopleRef.current;
      if (roster.length === 0) return { kind: "no-roster" };

      const m = findBestMatchInGalleries(face.embedding, matchablePeople(roster));
      setLastSeen({ score: m.score });

      if (m.id && m.score >= DEFAULT_MATCH_THRESHOLD && m.score - m.secondScore >= MIN_MATCH_MARGIN) {
        const person = roster.find((p) => p.id === m.id);
        if (person) return { kind: "match", person, score: m.score };
      }
      return { kind: "no-match", score: m.score };
    } catch (err: any) {
      return { kind: "error", message: err?.message ?? "Recognition failed" };
    }
  }, []);

  function resetScan() {
    setMatch(null);
    setTokenEvent(null);
    setPlan(null);
    setPaperMessage(null);
    setPunchPlan(null);
    setOutcome(null);
    setLastSeen(null);
    setFrozenFrame(null);
    auditPhotoRef.current = null;
    setIsScanning(false);
    setScanFail(null);
  }

  async function scanNow() {
    if (detectingRef.current) return;
    if (!cameraReadyRef.current || !engineReadyRef.current) return;

    const first = grabFrame();
    if (!first) return;

    // Freeze the shot the operator picked, exactly like a camera shutter.
    detectingRef.current = true;
    setFrozenFrame(first.toDataURL("image/jpeg", 0.85));
    // A separate, downscaled copy is what gets stored as the audit photo —
    // the full-res frozen frame stays only for the on-screen preview.
    auditPhotoRef.current = frameToDataUrl(first, 320, 0.5);
    setScanFail(null);
    setIsScanning(true);

    try {
      // A single still can miss on a blink or motion blur. Retry with a couple
      // of fresh grabs before giving up — bounded, and only inside this one tap.
      let frame: HTMLCanvasElement | null = first;
      let outcome: ScanOutcome = { kind: "no-face" };
      for (let attempt = 0; attempt < 3 && frame; attempt++) {
        outcome = await scanFrame(frame);
        if (outcome.kind !== "no-face") break;
        await new Promise((r) => setTimeout(r, 150));
        frame = grabFrame();
      }

      if (outcome.kind === "match") {
        if (role === "gate") {
          await handleGateMatch(outcome.person, outcome.score, true);
        } else {
          setMatch({ person: outcome.person, matchedByFace: true, score: outcome.score });
        }
        return;
      }

      // Failed — drop back to the live preview so the operator can reframe.
      setFrozenFrame(null);
      switch (outcome.kind) {
        case "no-face":
          setScanFail("No face found — hold still, face the camera, try again");
          break;
        case "spoof":
          setScanFail("Couldn't confirm a live face — more light, try again");
          break;
        case "no-roster":
          setScanFail("No roster yet — sync in Settings");
          break;
        case "no-match":
          setScanFail(
            `Not recognised (best ${(outcome.score * 100).toFixed(0)}%) — try again or Find by name`,
          );
          break;
        case "error":
          setScanFail(outcome.message);
          break;
      }
    } finally {
      detectingRef.current = false;
      setIsScanning(false);
    }
  }

  // ── Gate: decide IN/OUT from the freshest view ────────────────────────────

  /** `byFace` is false when the person was picked by name — a routine
   * fallback for a face that failed from dust/sweat/sun. That punch is
   * recorded with method "manual" and no score, needs no PIN, and is NOT a
   * history correction (the authorise-gated Manual in/out under People is —
   * UNIFIED-04 §5). */
  async function handleGateMatch(person: Person, score: number | null, byFace: boolean) {
    const dupWindow = await getDuplicateWindowMs();
    const dup = await alreadyPunchedRecently(person.id, dupWindow);
    if (dup) {
      setFrozenFrame(null);
      setOutcome({
        kind: "duplicate",
        name: person.name,
        punchType: dup.type,
        secondsAgo: Math.round((Date.now() - dup.ts) / 1000),
      });
      return;
    }

    // If the last successful state pull is older than 15 minutes, stop
    // guessing (UNIFIED-00 §8): the previous punch may have happened at the
    // kiosk or another phone, and one tap beats silently writing the wrong
    // thing. Show IN and OUT as two buttons instead. With a fresh pull, no
    // known punch means it's their first punch today — IN.
    const stale = !statePullAt || Date.now() - statePullAt > STATE_PULL_MAX_AGE_MS;
    const suggested = stale ? null : (await nextPunchType(person)) ?? "in";
    setPunchPlan({ person, stale, suggested, byFace });
  }

  async function doPunch(person: Person, type: "in" | "out", matchScore: number | null, method: "face" | "manual") {
    const loc = getCachedLocation();
    const event = await recordEvent({
      personId: person.id,
      personKind: person.kind,
      personName: person.name,
      empCode: person.empCode,
      type,
      method,
      matchScore,
      state: "verified",
      capturedPhoto: method === "face" ? auditPhotoRef.current : null,
      latitude: loc?.latitude ?? null,
      longitude: loc?.longitude ?? null,
      accuracy: loc?.accuracy ?? null,
    });
    playSound();
    vibrate();
    setPunchPlan(null);
    setMatch(null);
    setFrozenFrame(null);
    setOutcome({ kind: "success", person, event });
    syncSoon();
    refreshStats();

    // Keep the gate moving: successful punches return to the camera on their
    // own after a few seconds.
    window.setTimeout(() => {
      setOutcome(null);
      setLastSeen(null);
    }, 4_000);
  }

  // ── Canteen: meal plan per the contract's state table ─────────────────────
  // v1 (UNIFIED-00 §6 v1.1): only verified / name_matched /
  // unverified_attendance are recorded. Override, guest and second plates
  // are PHASE 2 — the operator writes them on paper; the app records
  // nothing and says so bluntly. The plan shapes for the deferred cases are
  // kept in computePlan below but no path returns one in v1.

  async function computePlan(
    person: Person | null,
    matchedByFace: boolean,
    score: number | null,
    meal: Meal,
    outsideWindow: boolean,
  ): Promise<PlanResult> {
    // PHASE 2 (guest): no record at all — paper.
    if (!person) {
      return { kind: "paper", message: "Not in the system — record this plate on paper." };
    }

    // §5.4 v1.1: attendance is per-day. Per-person freshness (stateAt) wins
    // over the pull-level timestamp: a person the state channel has not
    // touched today has no attendance data today, whatever yesterday said.
    const pullFresh = statePullAt != null && localDate(new Date(statePullAt)) === localDate();
    const personFresh = stateIsFreshForToday(person);
    const base = {
      personType: person.kind as "payroll" | "wage",
      personId: person.id,
      personName: person.name,
      empCode: person.empCode,
      matchScore: score,
      meal,
      outsideWindow,
    };

    // State table (UNIFIED-00 §6): present → verified/name_matched; no
    // attendance data → unverified_attendance (stays in v1 — the offline
    // case must never go to paper); known + NOT present → override (PHASE 2).
    let state: EventState;
    if (!pullFresh || !personFresh) {
      state = "unverified_attendance";
    } else if (person.presentToday) {
      state = matchedByFace ? "verified" : "name_matched";
    } else {
      state = "override";
    }

    const eligible = checkEligible(person, meal);

    // PHASE 2 (ineligible meal): not a normal plate — paper.
    if (!eligible) {
      return {
        kind: "paper",
        message: `${person.name} is not on the ${MEAL_LABEL[meal].toLowerCase()} list — record this plate on paper.`,
      };
    }
    // PHASE 2 (override): known person, NOT present today — paper.
    if (state === "override") {
      return {
        kind: "paper",
        message: `${person.name} is not present today — record this plate on paper.`,
      };
    }
    // PHASE 2 (second plate): already served this meal — paper.
    const dup = await alreadyServed(person, meal);
    if (dup.event || dup.serverSays) {
      return {
        kind: "paper",
        message: `${person.name} was already served ${MEAL_LABEL[meal].toLowerCase()} today — record a second plate on paper.`,
      };
    }

    // v1 normal plate: recorded as-is. needsAuthorise is always false in v1.
    return {
      kind: "serve",
      plan: {
        ...base,
        state,
        extraPlateKind: null,
        needsAuthorise: false,
        needsPhoto: false,
        needsName: false,
        needsCameFrom: false,
        sheetTitle: "",
        sheetSubtitle: "",
      },
    };
  }

  async function handleServe(info: MatchInfo) {
    const { meal, outsideWindow } = currentMeal(new Date(), windows);
    const result = await computePlan(info.person, info.matchedByFace, info.score, meal, outsideWindow);
    if (result.kind === "paper") {
      setMatch(null);
      setFrozenFrame(null);
      setPaperMessage(result.message);
      return;
    }
    // PHASE 2: `plan.needsAuthorise` is never true in v1 — the branch below
    // (and the AuthorizeSheet render) stays for when exceptions switch on.
    if (result.plan.needsAuthorise) {
      setPlan(result.plan);
    } else {
      await finalizeServe(result.plan, null);
    }
  }

  async function finalizeServe(
    p: ServePlan,
    auth: {
      authoriser: { id: string; name: string };
      reasonCode: string;
      reasonText: string | null;
      cameFrom: string | null;
      name: string | null;
      photoUrl: string | null;
    } | null,
  ) {
    const loc = getCachedLocation();
    const tokenNumber = await nextTokenNumber(siteCode, localDate(), p.meal);
    const personName = p.needsName && auth ? auth.name ?? "Guest" : p.personName;

    const event = await recordEvent({
      personId: p.personId,
      personKind: p.personType,
      personName,
      empCode: p.empCode,
      type: "meal",
      meal: p.meal,
      method: p.matchScore != null ? "face" : "manual",
      matchScore: p.matchScore,
      state: p.state,
      extraPlateKind: p.extraPlateKind,
      authorisedBy: auth?.authoriser.id ?? null,
      reasonCode: auth?.reasonCode ?? null,
      reasonText: auth?.reasonText ?? null,
      guestBatchId: null, // group guests: field exists on the wire, single-guest flow ships first (UNIFIED-00 §9.2)
      guestParty: null,
      photoUrl: auth?.photoUrl ?? null,
      outsideWindow: p.outsideWindow,
      tokenNumber,
      latitude: loc?.latitude ?? null,
      longitude: loc?.longitude ?? null,
      accuracy: loc?.accuracy ?? null,
    });

    setPlan(null);
    setMatch(null);
    setTokenEvent(event);
    setLastSeen(null);
    setFrozenFrame(null);
    syncSoon();
    playSound();
    vibrate();
    refreshStats();
  }

  function handleAuthorize(data: AuthorizeData) {
    if (plan) {
      finalizeServe(plan, {
        authoriser: { id: data.authoriser.id, name: data.authoriser.name },
        reasonCode: data.reasonCode,
        reasonText: data.reasonText,
        cameFrom: data.cameFrom,
        name: data.name,
        photoUrl: data.photoUrl,
      });
    }
  }

  function handleSearchPick(person: Person) {
    setShowSearch(false);
    if (role === "gate") {
      // Name-pick at the gate: a routine fallback, not a history correction
      // (UNIFIED-04 §5) — no PIN, recorded with method "manual".
      handleGateMatch(person, null, false);
    } else {
      setMatch({ person, matchedByFace: false, score: null });
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (!configured) {
    return (
      <div className="min-h-screen bg-bg flex flex-col items-center justify-center gap-4 p-8 text-center pb-24">
        <div className="w-16 h-16 rounded-2xl bg-primary text-white flex items-center justify-center shadow-float">
          <IconCamera size={30} />
        </div>
        <h1 className="text-xl font-bold text-ink">Not paired yet</h1>
        <p className="text-sm text-ink-muted max-w-xs">
          Pair this phone with an 8-character code from the office. The office picks the role
          (gate or canteen) when it mints the code.
        </p>
        <button onClick={() => window.dispatchEvent(new Event("eggsy-go-settings"))} className="btn-primary px-6 py-3">
          Go to Settings
        </button>
      </div>
    );
  }

  if (!role) {
    return (
      <div className="min-h-screen bg-bg flex flex-col items-center justify-center gap-4 p-8 text-center pb-24">
        <p className="text-sm text-ink-muted max-w-xs">
          Waiting for the server to confirm this device's role…
        </p>
        <button onClick={() => syncNow().then(() => window.location.reload())} className="btn-primary px-6 py-3 flex items-center gap-2">
          <IconRefresh size={16} /> Sync now
        </button>
      </div>
    );
  }

  const stateStale = !statePullAt || Date.now() - statePullAt > STATE_PULL_MAX_AGE_MS;
  const { meal, outsideWindow } = currentMeal(new Date(), windows);
  const totalToday = counts.breakfast + counts.lunch + counts.dinner;

  return (
    <div className="min-h-screen bg-bg flex flex-col pb-24">
      {/* Header */}
      <div className="px-4 pt-3 pb-2 flex items-center justify-between select-none">
        <div>
          <h1 className="text-lg font-bold text-ink">{role === "gate" ? "Gate" : "Canteen"}</h1>
          <p className="text-xs text-ink-muted">{deviceName ?? (role === "gate" ? "Attendance gate" : "Canteen counter")}</p>
        </div>
        <div className="flex items-center gap-2">
          {role === "canteen" && (
            <span className={`badge ${outsideWindow ? "bg-amber-100 text-amber-800" : "bg-primary/10 text-primary"}`}>
              {MEAL_LABEL[meal]}
              {outsideWindow ? " · outside window" : ""}
            </span>
          )}
          {!online && <IconWifiOff size={18} className="text-amber-600" />}
        </div>
      </div>

      {/* Status line — pending sync, last sync, offline. The operator needs
          to know whether the office can see today (UNIFIED-02 §4.1). */}
      <div className="px-4 pb-1.5 flex items-center gap-3 text-[11px] text-ink-muted">
        {role === "canteen" ? (
          <>
            {(["breakfast", "lunch", "dinner"] as Meal[]).map((m) => (
              <span key={m} className="flex items-center gap-1">
                <span className="font-semibold text-ink">{counts[m]}</span>
                {MEAL_LABEL[m]}
              </span>
            ))}
            <span className="ml-auto">{totalToday} today</span>
          </>
        ) : (
          <>
            <span className="flex items-center gap-1">
              <span className="font-semibold text-ink">{punchesToday}</span>
              punches today
            </span>
            <span className="ml-auto flex items-center gap-2">
              {pending > 0 && <span className="font-semibold text-amber-600">{pending} pending</span>}
              <span>synced {formatWhenShort(lastSyncAt)}</span>
            </span>
          </>
        )}
      </div>

      {updateAvailable && !updateDismissed && (
        <div className="mx-4 mb-2 px-3 py-1.5 rounded-lg bg-sky-50 border border-sky-200 text-sky-800 text-xs flex items-center gap-2">
          <span className="flex-1">Update available — ask the office.</span>
          <button onClick={() => setUpdateDismissed(true)} className="text-sky-700 underline shrink-0">
            Dismiss
          </button>
        </div>
      )}

      {!online && (
        <div className="mx-4 mb-2 px-3 py-1.5 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-xs">
          Offline — {role === "gate" ? "punches" : "plates"} are saved on this phone and will sync automatically.
        </div>
      )}

      {/* Camera / match area */}
      <div className="relative flex-1 px-4">
        <div className="relative h-full min-h-[320px] rounded-2xl overflow-hidden bg-black border border-line">
          <video ref={videoRef} className="absolute inset-0 w-full h-full object-cover" muted playsInline />
          {frozenFrame && (
            <img src={frozenFrame} alt="Captured" className="absolute inset-0 w-full h-full object-cover" />
          )}
          {(!engineReady || !cameraReady) && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-white text-sm text-center px-4">
              {!cameraReady ? "Starting camera…" : "Loading face engine…"}
            </div>
          )}
          {cameraError && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-white text-sm text-center px-6">
              {cameraError}
            </div>
          )}

          {!match && !punchPlan && !outcome && (
            <button
              onClick={() => setFacingMode((m) => (m === "user" ? "environment" : "user"))}
              aria-label="Switch camera"
              className="absolute top-2 right-2 z-10 bg-black/50 text-white p-2 rounded-full"
            >
              <IconCameraSwitch size={18} />
            </button>
          )}

          {/* Scanning overlay */}
          {isScanning && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/40">
              <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-black/60 text-white text-sm font-medium">
                <span className="w-4 h-4 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                Scanning…
              </div>
            </div>
          )}

          {/* Status hint */}
          {!match && !punchPlan && !isScanning && !outcome && engineReady && cameraReady && !cameraError && (
            <div
              className={`absolute bottom-3 left-3 right-3 flex items-center justify-center gap-2 px-3 py-1.5 rounded-full text-white text-xs text-center ${
                scanFail ? "bg-amber-600/90" : "bg-black/50"
              }`}
            >
              {!scanFail && <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />}
              {people.length === 0
                ? "No roster yet — sync in Settings"
                : (scanFail ?? "Tap Scan face when ready")}
            </div>
          )}

          {/* Punch success (gate) */}
          {outcome && outcome.kind === "success" && outcome.person && outcome.event && (
            <div className="absolute inset-0 bg-primary flex flex-col items-center justify-center gap-3 p-6 text-white">
              <ThumbCircle personId={outcome.person.id} name={outcome.person.name} size={88} />
              <p className="text-2xl font-bold">{outcome.person.name}</p>
              <p className={`text-5xl font-black ${outcome.event.type === "in" ? "text-emerald-300" : "text-amber-300"}`}>
                {outcome.event.type === "in" ? "IN" : "OUT"}
              </p>
              <p className="text-sm text-white/70">
                {new Date(outcome.event.ts).toLocaleTimeString()}
                {outcome.event.matchScore != null ? ` · match ${(outcome.event.matchScore * 100).toFixed(0)}%` : ""}
              </p>
            </div>
          )}

          {/* Duplicate / failed outcomes (gate) */}
          {outcome && outcome.kind !== "success" && (
            <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center gap-3 p-6 text-center text-white">
              {outcome.kind === "duplicate" && (
                <>
                  <p className="text-2xl font-bold text-sky-300">Already punched</p>
                  <p className="text-sm text-white/80">
                    {outcome.name} just punched {outcome.punchType?.toUpperCase()} {outcome.secondsAgo}s ago.
                  </p>
                </>
              )}
              {outcome.kind === "no-match" && (
                <>
                  <p className="text-2xl font-bold text-red-400">Not recognised</p>
                  <p className="text-sm text-white/80">Best match {(outcome.score! * 100).toFixed(0)}% — try again with better light.</p>
                </>
              )}
              {outcome.kind === "ambiguous" && (
                <>
                  <p className="text-2xl font-bold text-amber-400">Not sure — too close</p>
                  <p className="text-sm text-white/80">
                    "{outcome.topName}" at {(outcome.score! * 100).toFixed(0)}% vs {(outcome.secondScore! * 100).toFixed(0)}%.
                  </p>
                </>
              )}
              <button
                onClick={() => {
                  setOutcome(null);
                  setLastSeen(null);
                }}
                className="btn bg-white text-ink px-8 py-3 font-semibold"
              >
                OK
              </button>
            </div>
          )}

          {/* Gate punch decision */}
          {punchPlan && (
            <div className="absolute inset-x-0 bottom-0 bg-white rounded-t-3xl px-4 pt-4 pb-4 shadow-float">
              <div className="flex items-center gap-3">
                <ThumbCircle personId={punchPlan.person.id} name={punchPlan.person.name} size={56} />
                <div className="min-w-0 flex-1">
                  <p className="text-lg font-bold text-ink truncate">{punchPlan.person.name}</p>
                  <p className="text-xs text-ink-muted">
                    {punchPlan.person.kind === "payroll" ? "Payroll" : "Wage worker"}
                    {punchPlan.person.empCode ? ` · ${punchPlan.person.empCode}` : ""}
                  </p>
                </div>
              </div>

              {punchPlan.stale && (
                <p className="mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  Sync is behind — can't tell whether this is an in or an out. Tap the right one.
                </p>
              )}

              <div className="mt-3 flex items-center justify-between">
                <button
                  onClick={() => setPunchPlan(null)}
                  className="text-xs text-ink-muted underline"
                >
                  Not this person
                </button>
                <div className="flex gap-2">
                  {punchPlan.suggested === null ? (
                    <>
                      <button
                        onClick={() =>
                          doPunch(punchPlan.person, "in", punchPlan.byFace ? (lastSeen?.score ?? null) : null, punchPlan.byFace ? "face" : "manual")
                        }
                        className="btn-primary px-6 py-3 text-base font-semibold"
                      >
                        IN
                      </button>
                      <button
                        onClick={() =>
                          doPunch(punchPlan.person, "out", punchPlan.byFace ? (lastSeen?.score ?? null) : null, punchPlan.byFace ? "face" : "manual")
                        }
                        className="btn-accent px-6 py-3 text-base font-semibold"
                      >
                        OUT
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() =>
                        doPunch(punchPlan.person, punchPlan.suggested!, punchPlan.byFace ? (lastSeen?.score ?? null) : null, punchPlan.byFace ? "face" : "manual")
                      }
                      className="btn-primary px-8 py-3 text-base font-semibold"
                    >
                      Punch {punchPlan.suggested.toUpperCase()}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Canteen match card */}
          {role === "canteen" && match && (
            <div className="absolute inset-x-0 bottom-0 bg-white rounded-t-3xl px-4 pt-4 pb-4 shadow-float">
              <div className="flex items-center gap-3">
                <ThumbCircle personId={match.person.id} name={match.person.name} size={64} />
                <div className="min-w-0 flex-1">
                  <p className="text-lg font-bold text-ink truncate">{match.person.name}</p>
                  <p className="text-xs text-ink-muted">
                    {match.person.kind === "payroll" ? "Payroll" : "Wage worker"}
                    {match.person.empCode ? ` · ${match.person.empCode}` : ""}
                  </p>
                  {match.matchedByFace && (
                    <p className="text-[11px] text-emerald-600 font-medium">
                      Face matched {((match.score ?? 0) * 100).toFixed(0)}%
                    </p>
                  )}
                </div>
              </div>

              <div className="mt-3 flex items-center justify-between">
                <button onClick={resetScan} className="text-xs text-ink-muted underline">
                  Not this person
                </button>
                <button onClick={() => handleServe(match)} className="btn-primary px-8 py-3 text-base font-semibold">
                  Serve {MEAL_LABEL[meal]}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Scan face button (below the camera) */}
      {!match && !punchPlan && !outcome && engineReady && cameraReady && !cameraError && (
        <div className="px-4 pt-3">
          <button
            onClick={scanNow}
            disabled={isScanning}
            className="btn-primary w-full py-3.5 text-base font-semibold flex items-center justify-center gap-2 disabled:opacity-60"
          >
            <IconCamera size={20} /> {isScanning ? "Scanning…" : scanFail ? "Scan again" : "Scan face"}
          </button>
        </div>
      )}

      {/* Bottom controls */}
      {/* Guest recording moved server-side (Canteen > Exceptions > Add
          exception, canteen.ts) — this button's only outcome was a "not
          recorded, write it on paper" dialog, so an admin now types it in
          directly from that paper log instead. */}
      {!match && !punchPlan && !outcome && (
        <div className="px-4 pt-3 flex gap-2">
          <button onClick={() => setShowSearch(true)} className="btn-outline flex-1 py-3">
            <IconSearch size={18} /> Find by name
          </button>
        </div>
      )}

      {/* PHASE 2: kept, unreachable in v1 — computePlan never returns a plan
          with needsAuthorise (UNIFIED-00 §6 v1.1 defers the exceptions). */}
      {plan && (
        <AuthorizeSheet
          title={plan.sheetTitle}
          subtitle={plan.sheetSubtitle}
          needsName={plan.needsName}
          needsCameFrom={plan.needsCameFrom}
          needsPhoto={plan.needsPhoto}
          confirmLabel={plan.personType === "guest" || plan.state === "override" ? "Confirm & serve" : "Confirm"}
          onCancel={() => setPlan(null)}
          onSubmit={handleAuthorize}
        />
      )}

      {/* Paper message (canteen v1): deferred cases record nothing, and say
          so bluntly — an operator who cannot tell whether the app recorded
          something will assume it did. */}
      {paperMessage && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-6">
          <div className="bg-bg rounded-3xl shadow-float max-w-sm w-full p-6 text-center">
            <p className="text-lg font-bold text-ink">Not recorded</p>
            <p className="mt-2 text-sm text-ink">{paperMessage}</p>
            <button
              onClick={() => setPaperMessage(null)}
              className="btn-primary w-full mt-5 py-3 font-semibold"
            >
              OK
            </button>
          </div>
        </div>
      )}

      {/* Name search */}
      {showSearch && <NameSearch people={people} onPick={handleSearchPick} onClose={() => setShowSearch(false)} />}

      {/* Token screen (canteen) — overlay so the camera underneath stays live. */}
      {tokenEvent && (
        <div className="fixed inset-0 z-50 bg-primary flex flex-col items-center justify-center gap-5 p-6 pb-24 text-white">
          <p className="text-sm font-medium text-white/70 uppercase tracking-widest">Token</p>
          <div className="bg-white text-ink rounded-3xl px-10 py-8 text-center shadow-float w-full max-w-sm">
            <p className="text-4xl font-black tracking-tight">{tokenEvent.tokenNumber}</p>
            <p className="mt-1 text-sm text-ink-muted">
              {tokenEvent.meal ? MEAL_LABEL[tokenEvent.meal] : ""} · {formatTime(tokenEvent.ts)}
            </p>
          </div>
          <p className="text-xl font-semibold">{tokenEvent.personName}</p>
          <div className="flex items-center gap-2">
            <span className={`badge ${STATE_BADGE[tokenEvent.state]}`}>{STATE_LABEL[tokenEvent.state]}</span>
            {tokenEvent.outsideWindow && <span className="badge bg-white/15 text-white">Outside window</span>}
          </div>
          <button onClick={resetScan} className="btn bg-white text-primary w-full max-w-sm py-3.5 font-semibold">
            <IconCheck size={20} /> Done
          </button>
        </div>
      )}
    </div>
  );
}

function formatWhenShort(ts: number | null): string {
  if (!ts) return "never";
  const diffSec = Math.round((Date.now() - ts) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  return new Date(ts).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

/** Reads the thumbs store for a face — a local IndexedDB read (not a network
 * fetch, which only happens when the camera is down per UNIFIED-02 §8.2). */
function ThumbCircle({ personId, name, size }: { personId: string; name: string; size: number }) {
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    getPersonThumb(personId).then((t) => !cancelled && setThumb(t));
    return () => {
      cancelled = true;
    };
  }, [personId]);
  if (thumb) {
    return (
      <img
        src={thumb}
        alt={name}
        style={{ width: size, height: size }}
        className="rounded-full object-cover border-2 border-line"
      />
    );
  }
  return (
    <div
      style={{ width: size, height: size, fontSize: size * 0.4 }}
      className="rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold"
    >
      {name[0]?.toUpperCase()}
    </div>
  );
}

function NameSearch({
  people,
  onPick,
  onClose,
}: {
  people: Person[];
  onPick: (p: Person) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const filtered = q.trim()
    ? people.filter(
        (p) =>
          p.name.toLowerCase().includes(q.toLowerCase()) ||
          (p.empCode ?? "").toLowerCase().includes(q.toLowerCase()),
      )
    : people;

  return (
    <div className="fixed inset-0 z-40 bg-black/50 flex items-end sm:items-center sm:justify-center">
      <div className="bg-bg w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl shadow-float max-h-[85vh] flex flex-col">
        <div className="px-5 pt-4 pb-3 border-b border-line">
          <h2 className="text-lg font-bold text-ink mb-2">Find by name</h2>
          <input
            className="input"
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name or code…"
          />
        </div>
        <div className="overflow-y-auto flex-1">
          {filtered.length === 0 && (
            <p className="p-6 text-center text-sm text-ink-muted">
              No one matches. Use <b>Guest</b> for someone with no record.
            </p>
          )}
          {filtered.map((p) => (
            <button
              key={p.id}
              onClick={() => onPick(p)}
              className="w-full flex items-center gap-3 px-5 py-3 border-b border-line/60 active:bg-bg text-left"
            >
              <ThumbCircle personId={p.id} name={p.name} size={40} />
              <div className="min-w-0">
                <p className="font-medium text-ink truncate">{p.name}</p>
                <p className="text-xs text-ink-muted">
                  {p.kind === "payroll" ? "Payroll" : "Wage"}
                  {p.empCode ? ` · ${p.empCode}` : ""}
                </p>
              </div>
            </button>
          ))}
        </div>
        <div className="p-3 border-t border-line">
          <button onClick={onClose} className="btn-outline w-full py-3">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
