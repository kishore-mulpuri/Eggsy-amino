// Face recognition — runs fully on-device, no network calls of any kind.
//
// Ported from the Amino Farms payroll module's face.ts, with one change:
// @vladmandic/human and its model weight files are bundled into the app
// (via the npm package + `scripts/copy-face-models.mjs`, which copies
// node_modules/@vladmandic/human/models into public/models at build time)
// instead of being fetched from a CDN. This app has to work with zero
// connectivity, so there is no CDN fallback here at all.
//
// No biometric data ever leaves the device: embeddings are stored in the
// local IndexedDB and matching happens on-device.

let humanPromise: Promise<any> | null = null;

const MODEL_BASE = "/models/";

/** Similarity above which we auto-accept a match. See Amino Farms' face.ts
 * for the score-distribution reasoning this threshold is based on. */
export const DEFAULT_MATCH_THRESHOLD = 0.65;

/** Minimum gap between the top match and the runner-up for an auto-accept. */
export const MIN_MATCH_MARGIN = 0.05;

/** Minimum anti-spoof ("real face") score to accept a capture. */
export const MIN_REAL_SCORE = 0.6;

export function looksSpoofed(face: { real?: number; live?: number }): boolean {
  const real = typeof face.real === "number" ? face.real : null;
  const live = typeof face.live === "number" ? face.live : null;
  if (real !== null && real < MIN_REAL_SCORE) return true;
  if (live !== null && live < MIN_REAL_SCORE) return true;
  return false;
}

/** The face-engine config, shared by every backend attempt. See the
 * maxDetected note below — those two knobs were learned the hard way and
 * must not be "optimised" back up. */
function humanConfig(backend: "webgl" | "wasm") {
  return {
    // Explicit webgl first: the browser/human default is webgpu, which no
    // Android WebView has — human then spends a wasteful init + internal
    // fallback, and on cheap GPUs that flip-flop is a crash source. wasm is
    // the fallback (slower, but it never crashes the process).
    backend,
    modelBasePath: MODEL_BASE,
    cacheSensitivity: 0,
    filter: { enabled: true, equalization: true },
    face: {
      enabled: true,
      // The detector runs once, but mesh/description/antispoof/liveness
      // then run PER detected face — so maxDetected multiplies the
      // expensive half of every capture. At 5 it meant a rush-hour queue
      // with people visible behind the person punching cost up to five
      // times the model work and five times the tensors, on the slowest
      // phone, at the busiest moment. Two keeps the largest-face guard
      // below meaningful (that guard only matters when more than one face
      // is found) while cutting the worst case by 60%.
      detector: { rotation: true, maxDetected: 2, minConfidence: 0.4 },
      mesh: { enabled: true },
      iris: { enabled: false },
      emotion: { enabled: false },
      description: { enabled: true }, // produces the embedding
      antispoof: { enabled: true },
      liveness: { enabled: true },
    },
    body: { enabled: false },
    hand: { enabled: false },
    object: { enabled: false },
    gesture: { enabled: false },
    segmentation: { enabled: false },
  };
}

async function createHuman(backend: "webgl" | "wasm"): Promise<any> {
  const mod: any = await import("@vladmandic/human");
  const Human = mod.Human ?? mod.default;
  const human = new Human(humanConfig(backend));
  await human.load();
  return human;
}

export async function loadFaceEngine(): Promise<any> {
  if (!humanPromise) {
    humanPromise = (async () => {
      try {
        return await createHuman("webgl");
      } catch (webglErr) {
        // WebGL unavailable/broken (common on low-end GPUs) — fall back to
        // wasm, which is slower but never crashes the process.
        console.warn("[face] webgl backend failed, falling back to wasm:", webglErr);
        return await createHuman("wasm");
      }
    })().catch((err) => {
      humanPromise = null; // allow retry
      throw err;
    });
  }
  return humanPromise;
}

/** Tear the engine down and free its WebGL context + tensors. Called when the
 * camera screen is torn down (tab switch), so a 2GB phone isn't holding
 * 200–600MB of face engine while it's not even on the camera. The next
 * loadFaceEngine() re-creates it. Safe to call even when nothing is loaded. */
export async function disposeFaceEngine(): Promise<void> {
  if (!humanPromise) return;
  const pending = humanPromise;
  humanPromise = null;
  try {
    const human = await pending;
    if (human?.dispose) human.dispose();
  } catch {
    // never let cleanup throw — a failed load is already surfaced to the caller
  }
}

export interface FaceResult {
  ok: boolean;
  embedding?: number[];
  faceCount: number;
  confidence?: number;
  real?: number;
  live?: number;
  error?: string;
}

/** Human allocates a full set of tensors per detect() and frees them as the
 * next one starts — so two overlapping detects hold two sets at once. That
 * used to be reachable: the timeout below rejects, the capture button frees
 * up, and the abandoned detect is still running when the next one begins. On
 * a slow phone, where timeouts are exactly what happens, each one left its
 * tensors live. Serialising detects removes the overlap entirely. */
let detectInFlight: Promise<any> | null = null;

/** Human hands back the input tensor on the result when one was allocated.
 * Nothing downstream reads it — only the embedding is used — so release it
 * rather than waiting for the next detect to do it. */
function disposeResult(human: any, result: any): void {
  try {
    if (result?.tensor) human.tf.dispose(result.tensor);
  } catch {
    // never let cleanup fail a capture
  }
}

/** Cap the long edge of the frame fed to detect(). The model runs at its own
 * fixed input size internally, so this doesn't change recognition quality —
 * it only shrinks the input decode + texture upload, which is real memory on
 * a low-end phone. */
const MAX_DETECT_DIM = 360;

function downscaleForDetect(
  input: HTMLImageElement | HTMLCanvasElement | HTMLVideoElement,
): HTMLImageElement | HTMLCanvasElement | HTMLVideoElement {
  let w = 0;
  let h = 0;
  if (input instanceof HTMLVideoElement) {
    w = input.videoWidth;
    h = input.videoHeight;
  } else if (input instanceof HTMLImageElement) {
    w = input.naturalWidth;
    h = input.naturalHeight;
  } else {
    w = input.width;
    h = input.height;
  }
  if (!w || !h) return input;
  const maxDim = Math.max(w, h);
  if (maxDim <= MAX_DETECT_DIM) return input;
  const scale = MAX_DETECT_DIM / maxDim;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return input;
  ctx.drawImage(input, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export async function getFaceEmbedding(
  input: HTMLImageElement | HTMLCanvasElement | HTMLVideoElement,
): Promise<FaceResult> {
  const human = await loadFaceEngine();
  const DETECT_TIMEOUT_MS = 10_000;

  // Wait out any previous detect — including one whose caller already gave up
  // on it — before starting another. Its outcome is irrelevant here; what
  // matters is that its tensors are gone before we allocate ours.
  if (detectInFlight) await detectInFlight.catch(() => {});

  const detectInput = downscaleForDetect(input);
  const detect = human.detect(detectInput);
  // Tracks the detect to completion whether or not this caller still cares.
  // Cleared only when detect() genuinely settles — NOT when the timeout
  // fires — so a caller who gave up still makes the next one wait.
  const tracked: Promise<void> = detect
    .catch(() => {})
    .finally(() => {
      if (detectInFlight === tracked) detectInFlight = null;
    });
  detectInFlight = tracked;

  let result: any;
  try {
    result = await Promise.race([
      detect,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Face detection timed out — try again")), DETECT_TIMEOUT_MS),
      ),
    ]);
  } catch (err) {
    // Timed out. detect() carries on regardless — there is no way to cancel
    // it — so release whatever it eventually produces rather than leaving it
    // for the garbage collector to find.
    detect.then((r: any) => disposeResult(human, r)).catch(() => {});
    throw err;
  }

  const faces = (result?.face || []).filter((f: any) => Array.isArray(f.embedding) && f.embedding.length > 0);
  if (faces.length === 0) {
    disposeResult(human, result);
    return { ok: false, faceCount: 0, error: "No face detected" };
  }
  if (faces.length > 1) {
    faces.sort((a: any, b: any) => (b.box?.[2] || 0) * (b.box?.[3] || 0) - (a.box?.[2] || 0) * (a.box?.[3] || 0));
  }
  const face = faces[0];
  // Array.from copies the embedding out, so nothing below still points into
  // the result — safe to release it here rather than on the next capture.
  const embedding = Array.from(face.embedding as number[]);
  disposeResult(human, result);
  return {
    ok: true,
    embedding,
    faceCount: faces.length,
    confidence: face.faceScore ?? face.score,
    real: typeof face.real === "number" ? face.real : undefined,
    live: typeof face.live === "number" ? face.live : undefined,
  };
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export interface MatchCandidate {
  id: string;
  descriptor: ArrayLike<number>;
}

export interface MatchResult {
  id: string | null;
  score: number;
  secondScore: number;
}

export function findBestMatch(embedding: number[], candidates: MatchCandidate[]): MatchResult {
  let best: string | null = null;
  let bestScore = -1;
  let secondScore = -1;
  for (const c of candidates) {
    const s = cosineSimilarity(embedding, c.descriptor);
    if (s > bestScore) {
      secondScore = bestScore;
      bestScore = s;
      best = c.id;
    } else if (s > secondScore) {
      secondScore = s;
    }
  }
  return { id: best, score: Math.max(0, bestScore), secondScore: Math.max(0, secondScore) };
}

export interface MatchGallery {
  id: string;
  /** One or more descriptors for this identity (e.g. an enrollment photo
   * plus several recent live-capture embeddings). Accepts Float32Array —
   * descriptors are stored as typed arrays, never number[] (UNIFIED-02 §8.3). */
  descriptors: ArrayLike<number>[];
}

/** Like findBestMatch, but each candidate may have MULTIPLE descriptors.
 * Pools each identity's best score first, so a second/third descriptor for
 * the SAME identity is never mistaken for a different identity's runner-up
 * score (which would wrongly trigger the too-close-to-call ambiguous path).
 * Mirrors the main app's server-side relearn-conflict gallery logic. */
export function findBestMatchInGalleries(embedding: number[], galleries: MatchGallery[]): MatchResult {
  let best: string | null = null;
  let bestScore = -1;
  let secondScore = -1;
  for (const g of galleries) {
    let s = -1;
    for (const d of g.descriptors) {
      const v = cosineSimilarity(embedding, d);
      if (v > s) s = v;
    }
    if (s > bestScore) {
      secondScore = bestScore;
      bestScore = s;
      best = g.id;
    } else if (s > secondScore) {
      secondScore = s;
    }
  }
  return { id: best, score: Math.max(0, bestScore), secondScore: Math.max(0, secondScore) };
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load image"));
    img.src = src;
  });
}

export function frameToDataUrl(source: HTMLVideoElement | HTMLCanvasElement, maxWidth = 320, quality = 0.5): string {
  const srcW = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
  const srcH = source instanceof HTMLVideoElement ? source.videoHeight : source.height;
  const scale = Math.min(1, maxWidth / (srcW || maxWidth));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(srcW * scale);
  canvas.height = Math.round(srcH * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}
