import { IconBackspace } from "./Icons";

interface PinPadProps {
  value: string;
  onChange: (v: string) => void;
  error?: string | null;
  onSubmit: () => void;
  submitLabel: string;
  onCancel?: () => void;
  cancelLabel?: string;
  busy?: boolean;
  submitDisabled?: boolean;
}

/** Reusable numeric keypad + dots for entering operator / supervisor PINs.
 * Works for 4- or 6-digit PINs alike — a submit button rather than an
 * auto-fire on length, since the server may issue either length. */
export default function PinPad({
  value,
  onChange,
  error,
  onSubmit,
  submitLabel,
  onCancel,
  cancelLabel = "Cancel",
  busy,
  submitDisabled,
}: PinPadProps) {
  function press(d: string) {
    if (busy) return;
    onChange((value + d).slice(0, 8));
  }
  function backspace() {
    if (busy) return;
    onChange(value.slice(0, -1));
  }

  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

  return (
    <div className="flex flex-col items-center gap-4 w-full max-w-xs mx-auto">
      {/* dots */}
      <div className="flex items-center gap-3 h-6" aria-live="polite">
        {Array.from({ length: Math.max(4, value.length) }).map((_, i) => (
          <span
            key={i}
            className={`h-3.5 w-3.5 rounded-full transition-colors ${
              i < value.length ? "bg-primary" : "bg-line"
            }`}
          />
        ))}
      </div>

      {error && <p className="text-sm text-primary text-center -mt-1">{error}</p>}

      <div className="grid grid-cols-3 gap-2.5 w-full">
        {keys.map((k) => (
          <button
            key={k}
            onClick={() => press(k)}
            className="h-14 rounded-xl bg-surface border border-line text-2xl font-semibold text-ink active:bg-bg"
          >
            {k}
          </button>
        ))}
        <button
          onClick={onCancel}
          className="h-14 rounded-xl text-sm font-medium text-ink-muted active:bg-bg"
        >
          {cancelLabel}
        </button>
        <button
          onClick={() => press("0")}
          className="h-14 rounded-xl bg-surface border border-line text-2xl font-semibold text-ink active:bg-bg"
        >
          0
        </button>
        <button
          onClick={backspace}
          className="h-14 rounded-xl text-ink-muted flex items-center justify-center active:bg-bg"
          aria-label="Backspace"
        >
          <IconBackspace size={24} />
        </button>
      </div>

      <button
        onClick={onSubmit}
        disabled={busy || submitDisabled || value.length === 0}
        className="w-full py-3.5 rounded-xl bg-primary text-white font-semibold disabled:opacity-40"
      >
        {busy ? "Checking…" : submitLabel}
      </button>
    </div>
  );
}
