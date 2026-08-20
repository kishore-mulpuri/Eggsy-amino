// Shared domain types for the unified app — field names follow
// UNIFIED-00-CONTRACT.md §5 / §6 so the payloads map 1:1 onto the wire.

export type Role = "gate" | "canteen";
export type PersonKind = "payroll" | "wage" | "guest";
export type Meal = "breakfast" | "lunch" | "dinner";
export type EventType = "in" | "out" | "meal";
export type EventMethod = "face" | "manual";
export type EventState =
  | "verified"
  | "name_matched"
  | "unverified_attendance"
  | "override"
  | "guest";
export type ExtraPlateKind = "guest" | "second_plate" | "override";

/** One roster entry — a payroll employee or wage worker this device may
 * match. Payroll rows are a read-only mirror (server-owned); wage rows may
 * be enrolled locally at the gate. See UNIFIED-02 §5. */
export interface Person {
  id: string;
  kind: "payroll" | "wage";
  name: string;
  empCode: string | null;
  /** Face embedding — typed array, 4x less memory than number[] and stored
   * natively by IndexedDB. Converted from the wire's number[] on pull. */
  descriptor: Float32Array | null;
  /** Day-diverse recent live-capture embeddings, for matching tolerance. */
  recentEmbeddings: Float32Array[];
  /** sha256 hex of the server thumbnail; lets the device detect a stale thumb. */
  photoHash: string | null;
  /** 96px JPEG data URL, fetched lazily from /api/device/photo/:id. May be absent. */
  thumb: string | null;
  eligibility: { breakfast: boolean; lunch: boolean; dinner: boolean };
  /** Server's view of today's latest punch — see UNIFIED-00 §5.4. */
  lastPunch: { type: "in" | "out"; ts: number } | null;
  presentToday: boolean;
  /** Meals already served today, server's view (any counter/device). */
  servedToday: Meal[];
  isActive: boolean;
  /** unix ms this row was last written locally. */
  cachedAt: number;
  /** unix ms the STATE channel last wrote lastPunch/presentToday/servedToday.
   * Stamped only by the state pull — an identity pull can never refresh it,
   * so yesterday's attendance can never be laundered into looking fresh
   * (UNIFIED-00 §5.4 v1.1 date-rollover rule). Absent = never seen state. */
  stateAt?: number;
  /** Local-only extras for wage workers enrolled at the gate. The contract's
   * people payload carries neither field; they exist for the device's own
   * roster and are NOT uploaded by any endpoint in the contract (§5). */
  aadhar?: string | null;
  role?: string | null;
  /** True when this wage worker's identity (name/aadhar/photo/descriptor/
   * role) has local changes the server hasn't seen yet — set by
   * createWagePerson()/updateWagePerson(), cleared once pushWageWorkers()
   * (sync.ts) confirms the upload. Wage-only; payroll rows never set it. */
  enrollPending?: boolean;
}

/** The core record: a punch or a plate. Same row, different `type`.
 * Device-generated uuid; sync is upsert-by-id (UNIFIED-00 §3). */
export interface Event {
  id: string;
  personId: string | null; // null only for a guest
  personKind: PersonKind;
  personName: string; // denormalised — a guest has nothing to join to
  empCode: string | null;
  type: EventType;
  meal: Meal | null;
  /** unix ms */
  ts: number;
  /** YYYY-MM-DD, device-local */
  date: string;
  method: EventMethod;
  matchScore: number | null;
  /** contract §6 — for gate events this is "verified" (a punch is always
   * truthful); the five-state table applies to canteen meals. */
  state: EventState;
  extraPlateKind: ExtraPlateKind | null;
  /** pins.id of whoever authorised this event, if a PIN was required. */
  authorisedBy: string | null;
  reasonCode: string | null;
  reasonText: string | null;
  guestBatchId: string | null;
  guestParty: string | null;
  photoUrl: string | null; // guests only, uploaded
  capturedPhoto: string | null; // local audit only, NEVER uploaded
  outsideWindow: boolean;
  tokenNumber: string | null;
  latitude: number | null;
  longitude: number | null;
  accuracy: number | null;
  /** local-only outbox flag (indexed; never on the wire). 1 = pending.
   * A number because booleans are not valid IndexedDB keys. */
  pending: 1 | 0;
  /** set once pushed and confirmed. Absent = pending sync. */
  syncedAt?: number;
  /** set when the server rejected this row — kept locally, never retried. */
  syncFailedReason?: string;
  /** set when the server reported this as a duplicate of an existing event. */
  duplicate?: boolean;
}

/** One entry on the server PIN list, from /api/device/config. */
export interface PinEntry {
  id: string;
  name: string;
  saltHex: string;
  pinHash: string;
  canUnlock: boolean;
  canAuthorise: boolean;
}

export interface MealWindow {
  meal: Meal;
  startTime: string; // HH:MM
  endTime: string; // HH:MM
}

export interface ReasonCode {
  code: string;
  label: string;
  requiresText: boolean;
}

/** /api/device/config's sync block. Rush windows are [fromH, fromM, toH, toM]. */
export interface SyncIntervals {
  rushWindows: [number, number, number, number][];
  rushIntervalMs: number;
  idleIntervalMs: number;
}

/** What /api/device/info tells this phone about itself. */
export interface DeviceIdentity {
  deviceId: string;
  name: string;
  role: Role;
  siteCode: string;
  canteenId: string | null;
  canteenName: string | null;
}

export interface SyncConfig {
  key: "sync-config";
  serverUrl: string;
  token: string;
  deviceId?: string;
  deviceName?: string;
}

export interface SyncStatus {
  key: "sync-status";
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  /** when the /pull/state channel last succeeded — the camera screen's
   * 15-minute "stop guessing IN/OUT" clock (UNIFIED-00 §8) reads this. */
  lastStatePullAt: number | null;
}
