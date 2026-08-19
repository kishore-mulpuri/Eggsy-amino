import { useEffect, useState } from "react";
import CameraCapture, { type CaptureResult } from "../components/CameraCapture";
import { createWagePerson, getPerson, updateWagePerson } from "../lib/people";
import { syncSoon } from "../lib/sync";
import { IconBack } from "../components/Icons";
import type { Person } from "../types";

/** Enrol / edit a wage worker — gate role only (UNIFIED-02 §4.2). The
 * canteen never renders a route to this screen. One person, one descriptor:
 * payroll people are enrolled at the Amino face-enrolment page; this screen
 * only ever touches kind "wage" rows. */
export default function PersonFormPage({
  personId,
  onBack,
}: {
  personId: string | null; // null = new enrolment
  onBack: () => void;
}) {
  const [name, setName] = useState("");
  const [aadhar, setAadhar] = useState("");
  const [role, setRole] = useState("");
  const [capture, setCapture] = useState<CaptureResult | null>(null);
  const [existing, setExisting] = useState<Person | null>(null);
  const [showCamera, setShowCamera] = useState(personId === null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!personId) return;
    getPerson(personId).then((p) => {
      if (!p || p.kind !== "wage") return;
      setExisting(p);
      setName(p.name);
      setAadhar(p.aadhar ?? "");
      setRole(p.role ?? "");
    });
  }, [personId]);

  async function handleSave() {
    setError(null);
    if (!name.trim()) return setError("Name is required");
    if (!/^\d{4}\s?\d{4}\s?\d{4}$/.test(aadhar.trim())) return setError("Aadhar should be 12 digits");
    if (!role.trim()) return setError("Role is required");
    if (!personId && !capture) return setError("Capture a face photo to enrol");

    setSaving(true);
    try {
      if (personId && existing) {
        await updateWagePerson(personId, {
          name: name.trim(),
          aadhar: aadhar.trim(),
          role: role.trim(),
          ...(capture ? { photoDataUrl: capture.photoDataUrl, descriptor: capture.face.embedding! } : {}),
        });
      } else if (capture) {
        await createWagePerson({
          name: name.trim(),
          aadhar: aadhar.trim(),
          role: role.trim(),
          photoDataUrl: capture.photoDataUrl,
          descriptor: capture.face.embedding!,
        });
      }
      syncSoon();
      onBack();
    } catch (err: any) {
      setError(err.message ?? "Could not save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-screen bg-bg pb-24">
      <div className="px-4 pt-4 pb-3 flex items-center gap-3">
        <button onClick={onBack} aria-label="Back" className="text-ink-muted p-1 -ml-1">
          <IconBack size={22} />
        </button>
        <h1 className="text-lg font-bold text-ink">{personId ? "Edit wage worker" : "Enrol wage worker"}</h1>
      </div>

      <div className="px-4 flex flex-col gap-3 max-w-sm mx-auto">
        <label className="block">
          <span className="label">Name</span>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Full name"
          />
        </label>
        <label className="block">
          <span className="label">Aadhar number</span>
          <input
            className="input"
            value={aadhar}
            onChange={(e) => setAadhar(e.target.value)}
            placeholder="1234 5678 9012"
            inputMode="numeric"
          />
        </label>
        <label className="block">
          <span className="label">Role</span>
          <input
            className="input"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="e.g. Mason, Helper"
          />
        </label>

        {existing && !showCamera && (
          <div className="flex items-center gap-3">
            <div className="w-14 h-14 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold">
              {existing.name[0]?.toUpperCase()}
            </div>
            <button onClick={() => setShowCamera(true)} className="text-sm text-primary underline">
              Re-capture face
            </button>
          </div>
        )}

        {showCamera && (
          <div className="pt-2">
            {capture ? (
              <div className="flex items-center gap-3">
                <img src={capture.photoDataUrl} className="w-14 h-14 rounded-full object-cover" />
                <span className="text-sm text-emerald-600">Face captured</span>
                <button onClick={() => setCapture(null)} className="text-sm text-ink-muted underline">
                  Retake
                </button>
              </div>
            ) : (
              <CameraCapture captureLabel="Capture face" onCapture={setCapture} />
            )}
          </div>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex gap-2 pt-2">
          <button onClick={onBack} className="btn-outline flex-1 py-3">
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving} className="btn-primary flex-1 py-3 disabled:opacity-50">
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
