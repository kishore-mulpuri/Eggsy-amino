import { useEffect, useState } from "react";
import PinPad from "./PinPad";
import CameraCapture, { type CaptureResult } from "./CameraCapture";
import { IconX, IconShield, IconLock } from "./Icons";
import { verifyPin } from "../lib/pin";
import { getReasonCodes } from "../lib/sync";
import type { PinEntry, ReasonCode } from "../types";

export interface AuthorizeData {
  authoriser: PinEntry;
  reasonCode: string;
  reasonText: string | null;
  cameFrom: string | null;
  name: string | null;
  photoUrl: string | null;
}

interface Props {
  title: string;
  subtitle: string;
  /** true for guest — collect a typed name */
  needsName?: boolean;
  /** true for override — collect "came from" */
  needsCameFrom?: boolean;
  /** true for override/guest/ineligible — mandatory photo */
  needsPhoto?: boolean;
  confirmLabel?: string;
  onCancel: () => void;
  onSubmit: (data: AuthorizeData) => void;
}

/** The entire exception control, in one sheet. For override/guest/second
 * plate/ineligible meal, the app requires an authorising PIN, a reason code
 * from the server list, and — where the state calls for it — a photo.
 * No bypass. Adapted from Eggsy-Food: no operator/supervisor split, one
 * PIN list, one capability (UNIFIED-02 §7). */
export default function AuthorizeSheet({
  title,
  subtitle,
  needsName,
  needsCameFrom,
  needsPhoto,
  confirmLabel = "Confirm",
  onCancel,
  onSubmit,
}: Props) {
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const [authoriser, setAuthoriser] = useState<PinEntry | null>(null);
  const [verifying, setVerifying] = useState(false);

  const [reasonCodes, setReasonCodes] = useState<ReasonCode[]>([]);
  const [reasonCode, setReasonCode] = useState("");
  const [reasonText, setReasonText] = useState("");
  const [cameFrom, setCameFrom] = useState("");
  const [name, setName] = useState("");
  const [photo, setPhoto] = useState<CaptureResult | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    getReasonCodes().then((codes) => {
      setReasonCodes(codes);
      if (codes.length > 0) setReasonCode(codes[0].code);
    });
  }, []);

  async function handleVerifyPin() {
    if (!pin) return;
    setVerifying(true);
    setPinError(null);
    const entry = await verifyPin(pin, "authorise");
    setVerifying(false);
    if (!entry) {
      setPinError("Wrong PIN");
      setPin("");
      return;
    }
    setAuthoriser(entry);
  }

  function canSubmit(): boolean {
    if (!authoriser) return false;
    if (!reasonCode) return false;
    const selected = reasonCodes.find((r) => r.code === reasonCode);
    if (selected?.requiresText && !reasonText.trim()) return false;
    if (needsName && !name.trim()) return false;
    if (needsPhoto && !photo) return false;
    return true;
  }

  async function handleSubmit() {
    if (!authoriser) return;
    const selected = reasonCodes.find((r) => r.code === reasonCode);
    if (!selected) return setFormError("Pick a reason.");
    if (selected.requiresText && !reasonText.trim()) return setFormError(`${selected.label} needs a short explanation.`);
    if (needsName && !name.trim()) return setFormError("Enter the guest's name.");
    if (needsPhoto && !photo) return setFormError("A photo is required.");
    setSubmitting(true);
    onSubmit({
      authoriser,
      reasonCode,
      reasonText: reasonText.trim() || null,
      cameFrom: needsCameFrom ? cameFrom.trim() || null : null,
      name: needsName ? name.trim() : null,
      photoUrl: needsPhoto ? photo?.photoDataUrl ?? null : null,
    });
    setSubmitting(false);
  }

  return (
    <div className="fixed inset-0 z-40 bg-black/50 flex items-end sm:items-center sm:justify-center">
      <div className="bg-bg w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl shadow-float max-h-[92vh] overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-bg z-10 px-5 pt-4 pb-3 border-b border-line flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <IconShield size={22} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-bold text-ink">{title}</h2>
            <p className="text-[13px] text-ink-muted">{subtitle}</p>
          </div>
          <button onClick={onCancel} className="text-ink-muted p-1">
            <IconX size={22} />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* PIN */}
          {!authoriser ? (
            <section className="card p-4">
              <div className="flex items-center gap-2 mb-1">
                <IconLock size={16} className="text-primary" />
                <span className="text-sm font-semibold text-ink">Authorising PIN</span>
              </div>
              <p className="text-xs text-ink-muted mb-3">
                This records who authorised the exception.
              </p>
              <PinPad
                value={pin}
                onChange={setPin}
                error={pinError}
                busy={verifying}
                onSubmit={handleVerifyPin}
                submitLabel="Verify PIN"
                onCancel={onCancel}
              />
            </section>
          ) : (
            <>
              <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-emerald-50 border border-emerald-200">
                <span className="w-7 h-7 rounded-full bg-emerald-500 text-white text-xs font-bold flex items-center justify-center">
                  {authoriser.name[0]?.toUpperCase()}
                </span>
                <div>
                  <p className="text-sm font-semibold text-emerald-900">{authoriser.name}</p>
                  <p className="text-[11px] text-emerald-700">Authorised</p>
                </div>
              </div>

              {needsName && (
                <label className="block">
                  <span className="label">Guest name</span>
                  <input
                    className="input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Full name"
                  />
                </label>
              )}

              <label className="block">
                <span className="label">Reason *</span>
                {reasonCodes.length === 0 ? (
                  <input
                    className="input"
                    value={reasonText}
                    onChange={(e) => setReasonText(e.target.value)}
                    placeholder="Why is this being authorised?"
                  />
                ) : (
                  <div className="space-y-2">
                    <select
                      className="input bg-surface"
                      value={reasonCode}
                      onChange={(e) => setReasonCode(e.target.value)}
                    >
                      {reasonCodes.map((r) => (
                        <option key={r.code} value={r.code}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                    {reasonCodes.find((r) => r.code === reasonCode)?.requiresText && (
                      <input
                        className="input"
                        value={reasonText}
                        onChange={(e) => setReasonText(e.target.value)}
                        placeholder="Short explanation"
                      />
                    )}
                  </div>
                )}
              </label>

              {needsCameFrom && (
                <label className="block">
                  <span className="label">Came from</span>
                  <input
                    className="input"
                    value={cameFrom}
                    onChange={(e) => setCameFrom(e.target.value)}
                    placeholder="e.g. Nbl gate, off-site visit"
                  />
                </label>
              )}

              {needsPhoto && (
                <section>
                  <span className="label">Photo (required)</span>
                  {photo ? (
                    <div className="relative">
                      <img
                        src={photo.photoDataUrl}
                        alt="captured"
                        className="w-full max-w-xs mx-auto rounded-xl border border-line"
                      />
                      <button
                        onClick={() => setPhoto(null)}
                        className="absolute top-2 right-2 bg-black/60 text-white text-xs px-2.5 py-1.5 rounded-full"
                      >
                        Retake
                      </button>
                    </div>
                  ) : (
                    <CameraCapture
                      onCapture={(r) => setPhoto(r)}
                      captureLabel="Take photo"
                    />
                  )}
                </section>
              )}

              {formError && <p className="text-sm text-primary font-medium">{formError}</p>}

              <button
                onClick={handleSubmit}
                disabled={!canSubmit() || submitting}
                className="w-full py-3.5 rounded-xl bg-primary text-white font-semibold disabled:opacity-40"
              >
                {submitting ? "Saving…" : confirmLabel}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
