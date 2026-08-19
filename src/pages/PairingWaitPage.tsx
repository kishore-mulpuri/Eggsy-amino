import { useEffect, useRef, useState } from "react";
import {
  getPendingPairing,
  pollPairing,
  applyPairingApproved,
  clearPendingPairing,
  formatCode,
  setPairingNotice,
  type PairPollResult,
} from "../lib/pairing";
import { getServerUrl, getDeviceConfig } from "../lib/sync";
import { getAppVersion } from "../lib/device";
import { IconCamera } from "../components/Icons";

const POLL_MS = 10_000;
// The server rate-limits polling; keep the client floor a second wider so a
// resume/focus poll can't land exactly on the boundary.
const MIN_POLL_GAP_MS = 6_000;

/** Full-screen "waiting for office approval" state. Rendered only when a
 * pendingId exists and no token is stored, so a paired device never sees it.
 * Polls every 10s and once on app resume; never faster than every 6s. */
export default function PairingWaitPage({ onApproved }: { onApproved: () => void }) {
  const [code, setCode] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [versionName, setVersionName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const lastPollRef = useRef(0);

  useEffect(() => {
    (async () => {
      const [pending, cfg, version] = await Promise.all([
        getPendingPairing(),
        getDeviceConfig(),
        getAppVersion(),
      ]);
      setCode(pending?.code ?? null);
      if (cfg?.deviceName) setDeviceName(cfg.deviceName);
      setVersionName(version.versionName);
    })();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      const now = Date.now();
      if (now - lastPollRef.current < MIN_POLL_GAP_MS) return;
      lastPollRef.current = now;

      const pending = await getPendingPairing();
      if (!pending) return; // cleared by Cancel / approved elsewhere
      const serverUrl = await getServerUrl();

      const outcome: PairPollResult = await pollPairing(pending.pendingId);
      if (cancelled) return;

      if (outcome.status === "approved") {
        // Persist the token first — the endpoint delivers it exactly once.
        await applyPairingApproved(outcome);
        if (!cancelled) onApproved();
        return;
      }
      if (outcome.status === "rejected" || outcome.status === "expired") {
        setPairingNotice(
          outcome.reason ||
            (outcome.status === "rejected" ? "Rejected by the office." : "That request expired."),
        );
        await clearPendingPairing();
        return;
      }
      if (outcome.status === "error") {
        if (!cancelled) setMessage("Can't reach the office right now — will keep checking.");
      }
    };

    // Poll every 10s, and immediately once on mount.
    poll();
    timer = setInterval(poll, POLL_MS);

    // Both listeners must be removed with the SAME function reference they
    // were added with — an inline arrow here would leak a listener on every
    // mount, and each leaked one keeps firing a poll after unmount.
    const onResume = () => {
      if (document.visibilityState === "visible") poll();
    };
    document.addEventListener("visibilitychange", onResume);
    window.addEventListener("focus", onResume);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", onResume);
      window.removeEventListener("focus", onResume);
    };
  }, [onApproved]);

  async function handleCancel() {
    setCancelling(true);
    await clearPendingPairing();
    setCancelling(false);
  }

  return (
    <div className="min-h-screen bg-bg flex flex-col items-center justify-center gap-5 p-8 text-center">
      <div className="w-16 h-16 rounded-2xl bg-primary text-white flex items-center justify-center shadow-float">
        <IconCamera size={32} />
      </div>
      <div>
        <h1 className="text-xl font-bold text-ink">Waiting for approval from the office.</h1>
        {deviceName && <p className="text-sm text-ink-muted mt-1">{deviceName}</p>}
      </div>

      <div className="space-y-1 text-xs text-ink-muted">
        {code && (
          <p>
            Code <span className="font-mono font-semibold text-ink">…{formatCode(code).slice(-4)}</span>
          </p>
        )}
        {versionName && <p>App version {versionName}</p>}
      </div>

      {message && <p className="text-sm text-amber-700">{message}</p>}

      <button onClick={handleCancel} disabled={cancelling} className="btn-outline px-8 py-3">
        {cancelling ? "Cancelling…" : "Cancel"}
      </button>
    </div>
  );
}
