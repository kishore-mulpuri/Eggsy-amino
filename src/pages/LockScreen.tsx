import { useState } from "react";
import PinPad from "../components/PinPad";
import { IconX, IconLock } from "../components/Icons";
import { verifyPin, markUnlocked } from "../lib/pin";

/** Full-screen PIN lock shown when a guarded screen (People/Settings) is
 * requested without an active session. One 15-minute idle re-lock, one PIN
 * list — no operator/supervisor split (UNIFIED-02 §7). */
export default function LockScreen({
  onUnlock,
  onCancel,
}: {
  onUnlock: () => void;
  onCancel: () => void;
}) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleVerify() {
    if (!pin) return;
    setBusy(true);
    setError(null);
    const entry = await verifyPin(pin, "unlock");
    setBusy(false);
    if (!entry) {
      setError("Wrong PIN");
      setPin("");
      return;
    }
    markUnlocked(entry);
    onUnlock();
  }

  return (
    <div className="min-h-screen bg-bg flex flex-col items-center justify-center gap-6 p-6">
      <div className="w-14 h-14 rounded-2xl bg-primary/10 text-primary flex items-center justify-center">
        <IconLock size={26} />
      </div>
      <div className="text-center">
        <h1 className="text-xl font-bold text-ink">Locked</h1>
        <p className="text-sm text-ink-muted mt-1">
          Enter a PIN issued by the office. It arrives with the next sync.
        </p>
      </div>
      <PinPad
        value={pin}
        onChange={setPin}
        error={error}
        busy={busy}
        onSubmit={handleVerify}
        submitLabel="Unlock"
        onCancel={onCancel}
      />
      <button onClick={onCancel} className="text-sm text-ink-muted underline flex items-center gap-1">
        <IconX size={14} /> Back to camera
      </button>
    </div>
  );
}
