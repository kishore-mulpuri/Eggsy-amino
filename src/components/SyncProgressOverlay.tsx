import { useEffect, useState } from "react";
import { SYNC_PROGRESS_EVENT, cancelFirstSync, type SyncProgressUpdate } from "../lib/sync";

/** Full-screen 0–100% progress bar shown during the pairing first sync. It is
 * driven by `sync-progress` events dispatched from the sync engine (see
 * beginSyncProgress/endSyncProgress), so it works no matter which screen is
 * underneath — the pairing wait screen or Settings. Hides itself shortly
 * after reaching 100. */
export default function SyncProgressOverlay() {
  const [update, setUpdate] = useState<SyncProgressUpdate | null>(null);
  const [visible, setVisible] = useState(false);
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    const onProgress = (e: Event) => {
      const detail = (e as CustomEvent<SyncProgressUpdate>).detail;
      if (!detail) return;
      setUpdate(detail);
      setVisible(true);
      if (hideTimer) clearTimeout(hideTimer);
      if (detail.pct >= 100) {
        // Let "Done" linger a beat so the operator sees it finish.
        hideTimer = setTimeout(() => {
          setVisible(false);
          setUpdate(null);
          setStopping(false);
        }, 1200);
      }
    };
    window.addEventListener(SYNC_PROGRESS_EVENT, onProgress as EventListener);
    return () => {
      window.removeEventListener(SYNC_PROGRESS_EVENT, onProgress as EventListener);
      if (hideTimer) clearTimeout(hideTimer);
    };
  }, []);

  if (!visible || !update) return null;

  return (
    <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-6">
      <div className="bg-bg rounded-3xl shadow-float max-w-sm w-full p-6">
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-semibold text-ink truncate pr-3">{update.label}</p>
          <span className="text-lg font-black text-primary tabular-nums shrink-0">{update.pct}%</span>
        </div>
        <div className="h-2.5 rounded-full bg-line overflow-hidden">
          <div
            className="h-full rounded-full bg-primary transition-all duration-300 ease-out"
            style={{ width: `${Math.max(0, Math.min(100, update.pct))}%` }}
          />
        </div>

        {/* The roster can take minutes on a weak signal, and the operator is
            usually standing at a gate with people waiting. Stopping is safe:
            the phone is already paired by this point, and every page of
            roster already downloaded is already saved — the next sync
            resumes from there rather than starting over. */}
        <button
          onClick={() => {
            setStopping(true);
            cancelFirstSync();
          }}
          disabled={stopping}
          className="mt-5 w-full rounded-2xl border border-line py-2.5 text-sm font-semibold text-ink-muted active:bg-line/40 disabled:opacity-50"
        >
          {stopping ? "Stopping…" : "Cancel — finish later"}
        </button>
        <p className="mt-2 text-center text-[11px] leading-snug text-ink-muted">
          Already downloaded people are kept. The rest arrives on the next sync.
        </p>
      </div>
    </div>
  );
}
