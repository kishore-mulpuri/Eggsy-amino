import { useEffect, useRef, useState } from "react";
import { loadFaceEngine, getFaceEmbedding, frameToDataUrl, looksSpoofed, type FaceResult } from "../lib/face";

export interface CaptureResult {
  face: FaceResult;
  photoDataUrl: string;
}

interface Props {
  /** "user" = front/selfie camera (default), "environment" = back camera */
  facingMode?: "user" | "environment";
  onCapture: (result: CaptureResult) => void;
  captureLabel?: string;
}

export default function CameraCapture({
  facingMode: initialFacingMode = "user",
  onCapture,
  captureLabel = "Capture",
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [facingMode, setFacingMode] = useState(initialFacingMode);
  const [engineReady, setEngineReady] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    loadFaceEngine()
      .then(() => !cancelled && setEngineReady(true))
      .catch((err) => !cancelled && setError(`Could not load face engine: ${err.message}`));

    setCameraReady(false);
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode, width: { ideal: 640 }, height: { ideal: 480 } }, audio: false })
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
      })
      .catch((err) => !cancelled && setError(`Camera access denied: ${err.message}`));

    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [facingMode]);

  async function handleCapture() {
    if (!videoRef.current || busy) return;
    setBusy(true);
    setError(null);
    try {
      const face = await getFaceEmbedding(videoRef.current);
      const photoDataUrl = frameToDataUrl(videoRef.current, 320, 0.5);
      if (!face.ok) {
        setError(face.error ?? "No face detected — line the face up in the frame and try again.");
        return;
      }
      if (looksSpoofed(face)) {
        setError("This looks like a photo of a photo/screen. Use a live camera capture.");
        return;
      }
      onCapture({ face, photoDataUrl });
    } catch (err: any) {
      setError(err.message ?? "Capture failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative w-full max-w-sm aspect-[3/4] rounded-xl overflow-hidden bg-black">
        <video ref={videoRef} className="w-full h-full object-cover" muted playsInline />
        {(!engineReady || !cameraReady) && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-white text-sm text-center px-4">
            {!cameraReady ? "Starting camera…" : "Loading face engine…"}
          </div>
        )}
        <button
          onClick={() => setFacingMode((m) => (m === "user" ? "environment" : "user"))}
          className="absolute top-2 right-2 bg-black/50 text-white text-xs px-2.5 py-1.5 rounded-full"
        >
          Flip camera
        </button>
      </div>
      {error && <p className="text-sm text-red-600 text-center max-w-sm">{error}</p>}
      <button
        onClick={handleCapture}
        disabled={!engineReady || !cameraReady || busy}
        className="w-full max-w-sm py-3 rounded-xl bg-primary text-white font-medium disabled:opacity-50"
      >
        {busy ? "Checking…" : captureLabel}
      </button>
    </div>
  );
}
