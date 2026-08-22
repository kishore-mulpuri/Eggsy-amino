// Read/write access to the unified person store + the lazy thumbnail
// channel. Payroll rows are a server-owned read-only mirror; wage rows may
// be enrolled at the gate (name, Aadhar, photo, role — UNIFIED-02 §4.2).
// Thumbnails live in their own store, fetched one at a time from
// /api/device/photo/:id, only for people the device lacks, only when the
// camera is down (UNIFIED-02 §8.2).
import { getAll, getAllKeys, get, put, del } from "./db";
import { newId } from "./id";
import { apiBase, fetchWithTimeout, getDeviceConfig, isCameraLive } from "./sync";
import type { Person } from "../types";

/** The roster, sorted by name. This is the one place a store-wide read of
 * `people` is legitimate: the camera screen needs every descriptor in
 * memory to match against anyway. Rows carry no image data (thumbs live in
 * their own store), so this pulls descriptors — not photos. */
export async function listPeople(): Promise<Person[]> {
  const all = await getAll<Person>("people");
  return all.sort((a, b) => a.name.localeCompare(b.name));
}

/** Descriptors only — the matching gallery the camera screen compares
 * against. Avoids constructing/allocating anything but typed arrays. */
export function matchablePeople(people: Person[]): { id: string; descriptors: Float32Array[] }[] {
  return people
    .filter((p) => p.isActive)
    .map((p) => ({
      id: p.id,
      // `?? []` is load-bearing: rows written before localSamples existed have
      // no such key, and spreading undefined throws. This runs on every
      // recognition pass, so it must never be the thing that kills the camera.
      descriptors: [p.descriptor, ...(p.localSamples ?? []), ...p.recentEmbeddings].filter(
        (d): d is Float32Array => d instanceof Float32Array && d.length > 0,
      ),
    }));
}

/** Hard cap on device-local samples per person. The whole gallery is rebuilt
 * on every recognition pass (CameraPage.scanFrame), so this bounds both the
 * per-scan work and the IndexedDB row size. Five different days/lighting
 * conditions is already well past the point of diminishing returns. */
export const MAX_LOCAL_SAMPLES = 5;

/** Teach THIS PHONE another view of someone the camera keeps missing.
 * Descriptor only — no photo — so the row stays small. Oldest sample is
 * dropped once the cap is reached, keeping the most recent appearance.
 * Never sets enrollPending: this is local matching help, not an identity
 * change, and must not be pushed to the server. */
export async function addLocalFaceSample(id: string, descriptor: ArrayLike<number>): Promise<number> {
  const existing = await getPerson(id);
  if (!existing) throw new Error("Person not found");
  const sample = Float32Array.from(descriptor);
  if (sample.length === 0) throw new Error("Empty face sample");
  const kept = [...(existing.localSamples ?? []), sample].slice(-MAX_LOCAL_SAMPLES);
  await put<Person>("people", { ...existing, localSamples: kept, cachedAt: Date.now() });
  return kept.length;
}

/** Drop every device-local sample for someone — the undo when samples were
 * captured against the wrong person. Enrolment and server-sent embeddings
 * are untouched, so matching falls back to exactly what it was before. */
export async function clearLocalFaceSamples(id: string): Promise<void> {
  const existing = await getPerson(id);
  if (!existing) return;
  await put<Person>("people", { ...existing, localSamples: [], cachedAt: Date.now() });
}

export async function getPerson(id: string): Promise<Person | undefined> {
  return get<Person>("people", id);
}

// ── Thumbnails (lazy, one at a time, camera down only) ─────────────────────

interface ThumbRow {
  id: string; // personId
  photoHash: string;
  dataUrl: string;
  fetchedAt: number;
}

export async function getPersonThumb(personId: string): Promise<string | null> {
  const t = await get<ThumbRow>("thumbs", personId);
  return t?.dataUrl ?? null;
}

/** Which people have a thumb cached locally — used to decide who to fetch. */
export async function getThumbKeys(): Promise<string[]> {
  return (await getAllKeys("thumbs")).map(String);
}

/** Fetch one 96px JPEG for the confirmation screen only. Never while the
 * camera is live; never for a person who already has one. Returns the data
 * URL on success, null when there is nothing to do (already cached, camera
 * live, offline, unpaired). */
export async function fetchThumb(personId: string): Promise<string | null> {
  if (isCameraLive()) return null;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return null;
  const existing = await get<ThumbRow>("thumbs", personId);
  const person = await get<Person>("people", personId);
  if (!person) return null;
  // A thumb is already cached for the current photoHash — nothing to do.
  if (existing && person.photoHash && existing.photoHash === person.photoHash) {
    return existing.dataUrl;
  }
  const config = await getDeviceConfig();
  if (!config) return null;

  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${apiBase(config.serverUrl)}/api/device/photo/${encodeURIComponent(personId)}`,
      { headers: { Authorization: `Bearer ${config.token}` } },
    );
  } catch {
    return null;
  }
  if (!res.ok) return null;

  const blob = await res.blob().catch(() => null);
  if (!blob) return null;
  const dataUrl = await new Promise<string | null>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
  if (!dataUrl) return null;
  await put<ThumbRow>("thumbs", {
    id: personId,
    photoHash: person.photoHash ?? "",
    dataUrl,
    fetchedAt: Date.now(),
  });
  return dataUrl;
}

// ── Wage enrolment (gate role only) ────────────────────────────────────────
// A wage worker enrolled here is a local row: name, Aadhar, photo (kept as
// the local thumb), role, and a face descriptor captured at enrolment.
// `enrollPending` marks it for the next sync — see pushWageWorkers() in
// sync.ts, which uploads it to POST /api/device/enroll and clears the flag.

export async function createWagePerson(input: {
  name: string;
  aadhar: string;
  role: string;
  photoDataUrl: string;
  descriptor: number[];
}): Promise<Person> {
  const person: Person = {
    id: newId(),
    kind: "wage",
    name: input.name.trim(),
    empCode: null,
    descriptor: Float32Array.from(input.descriptor),
    recentEmbeddings: [],
    localSamples: [],
    photoHash: null,
    thumb: null,
    eligibility: { breakfast: false, lunch: true, dinner: false },
    lastPunch: null,
    presentToday: false,
    servedToday: [],
    isActive: true,
    cachedAt: Date.now(),
    aadhar: input.aadhar.trim(),
    role: input.role.trim(),
    enrollPending: true,
  };
  await put<Person>("people", person);
  // The enrolment photo is the one photo this row owns — store it as the
  // person's thumb so roster + confirmation screens can show a face.
  await put<ThumbRow>("thumbs", {
    id: person.id,
    photoHash: "local",
    dataUrl: input.photoDataUrl,
    fetchedAt: Date.now(),
  });
  return person;
}

export async function updateWagePerson(
  id: string,
  patch: { name?: string; aadhar?: string; role?: string; isActive?: boolean; photoDataUrl?: string; descriptor?: number[] },
): Promise<void> {
  const existing = await getPerson(id);
  if (!existing) throw new Error("Person not found");
  const next: Person = {
    ...existing,
    name: patch.name?.trim() || existing.name,
    aadhar: patch.aadhar?.trim() || existing.aadhar,
    role: patch.role?.trim() || existing.role,
    isActive: patch.isActive ?? existing.isActive,
    descriptor: patch.descriptor ? Float32Array.from(patch.descriptor) : existing.descriptor,
    cachedAt: Date.now(),
    enrollPending: true,
  };
  await put<Person>("people", next);
  if (patch.photoDataUrl) {
    await put<ThumbRow>("thumbs", { id, photoHash: "local", dataUrl: patch.photoDataUrl, fetchedAt: Date.now() });
  }
}

export async function deactivateWagePerson(id: string): Promise<void> {
  await updateWagePerson(id, { isActive: false });
}

export async function removePerson(id: string): Promise<void> {
  await Promise.all([del("people", id), del("thumbs", id)]);
}
