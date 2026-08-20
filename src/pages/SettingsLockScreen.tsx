import { useEffect, useState } from "react";
import PinPad from "../components/PinPad";
import { IconX, IconLock } from "../components/Icons";
import { hasSettingsPin, setSettingsPin, verifySettingsPin, markSettingsUnlocked } from "../lib/settingsLock";

const PIN_LENGTH = 4;

/** Guards Settings only (People and Camera are always open — UNIFIED-02
 * §4.1 covers Camera; People was deliberately un-gated so any operator can
 * check the roster without a PIN). Two modes, decided by whether this
 * phone has a Settings PIN yet:
 *   - not set  → "Set a PIN" then "Confirm PIN", both must match
 *   - set      → "Enter PIN" to unlock, 15-minute idle session (settingsLock.ts)
 * The PIN itself lives only on this phone — no server round-trip, no
 * office visibility, no remote reset. See settingsLock.ts for why. */
export default function SettingsLockScreen({
  onUnlock,
  onCancel,
}: {
  onUnlock: () => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<"loading" | "set" | "confirm" | "verify">("loading");
  const [pin, setPin] = useState("");
  const [firstPin, setFirstPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    hasSettingsPin().then((has) => setMode(has ? "verify" : "set"));
  }, []);

  async function handleSubmit() {
    if (pin.length < PIN_LENGTH) return;
    setError(null);

    if (mode === "set") {
      setFirstPin(pin);
      setPin("");
      setMode("confirm");
      return;
    }

    if (mode === "confirm") {
      if (pin !== firstPin) {
        setError("PINs didn't match — try again");
        setPin("");
        setFirstPin("");
        setMode("set");
        return;
      }
      setBusy(true);
      await setSettingsPin(pin);
      markSettingsUnlocked();
      setBusy(false);
      onUnlock();
      return;
    }

    // verify
    setBusy(true);
    const ok = await verifySettingsPin(pin);
    setBusy(false);
    if (!ok) {
      setError("Wrong PIN");
      setPin("");
      return;
    }
    markSettingsUnlocked();
    onUnlock();
  }

  const titles: Record<typeof mode, { title: string; subtitle: string }> = {
    loading: { title: "", subtitle: "" },
    set: { title: "Set a Settings PIN", subtitle: "Choose a PIN to protect Settings on this phone. Camera and People stay open to everyone." },
    confirm: { title: "Confirm PIN", subtitle: "Enter the same PIN again." },
    verify: { title: "Settings locked", subtitle: "Enter this phone's Settings PIN." },
  };
  const { title, subtitle } = titles[mode];

  if (mode === "loading") return null;

  return (
    <div className="min-h-screen bg-bg flex flex-col items-center justify-center gap-6 p-6">
      <div className="w-14 h-14 rounded-2xl bg-primary/10 text-primary flex items-center justify-center">
        <IconLock size={26} />
      </div>
      <div className="text-center">
        <h1 className="text-xl font-bold text-ink">{title}</h1>
        <p className="text-sm text-ink-muted mt-1 max-w-xs">{subtitle}</p>
      </div>
      <PinPad
        value={pin}
        onChange={setPin}
        error={error}
        busy={busy}
        onSubmit={handleSubmit}
        submitLabel={mode === "verify" ? "Unlock" : "Continue"}
        submitDisabled={pin.length < PIN_LENGTH}
        onCancel={onCancel}
      />
      <button onClick={onCancel} className="text-sm text-ink-muted underline flex items-center gap-1">
        <IconX size={14} /> Back to camera
      </button>
    </div>
  );
}
