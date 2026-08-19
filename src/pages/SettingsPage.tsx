import { useEffect, useState } from "react";
import {
  DEFAULT_SERVER_URL,
  getDeviceConfig,
  clearDeviceConfig,
  getSyncStatus,
  getDeviceIdentity,
  getMealWindows,
  pendingCounts,
  syncNow,
  forceFullResync,
  getBackoffState,
} from "../lib/sync";
import { listPins, lock } from "../lib/pin";
import { checkBackup, restoreFromBackup, saveBackup, type BackupMetadata } from "../lib/backup";
import { checkLocationNow, getLocationStatus, type LocationStatus } from "../lib/location";
import { MEAL_LABEL, formatWhen } from "../lib/labels";
import {
  claimPairingCode,
  applyPairingApproved,
  normalizeCode,
  formatCode,
  setPendingPairing,
  getPairingNotice,
  setPairingNotice,
} from "../lib/pairing";
import { getAppVersion } from "../lib/device";
import { getAll } from "../lib/db";
import { describeMemory, getMemoryInfo } from "../lib/memory";
import { IconBack } from "../components/Icons";
import type { MealWindow, PinEntry, Role } from "../types";

/** Pairing, sync status and diagnostics, backup and restore, app version —
 * PIN-gated like People (UNIFIED-02 §4.3). */
export default function SettingsPage({ onBack }: { onBack: () => void }) {
  const [serverUrl] = useState(DEFAULT_SERVER_URL);
  const [pairingCode, setPairingCode] = useState("");
  const [paired, setPaired] = useState(false);
  const [status, setStatus] = useState<Awaited<ReturnType<typeof getSyncStatus>> | null>(null);
  const [pending, setPending] = useState(0);
  const [windows, setWindows] = useState<MealWindow[]>([]);
  const [pins, setPins] = useState<PinEntry[]>([]);
  const [role, setRole] = useState<Role | null>(null);
  const [siteCode, setSiteCode] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [versionName, setVersionName] = useState("");
  const [rosterCount, setRosterCount] = useState(0);

  const [pairing, setPairing] = useState(false);
  const [pairResult, setPairResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [backoff, setBackoff] = useState<{ consecutiveFailures: number; nextDelayMs: number } | null>(null);

  const [backupMeta, setBackupMeta] = useState<BackupMetadata | null>(null);
  const [restoreResult, setRestoreResult] = useState<{ ok: boolean; message: string } | null>(null);

  const [locationStatus, setLocationStatus] = useState<LocationStatus | null>(getLocationStatus());
  const [checkingLocation, setCheckingLocation] = useState(false);
  const [memory] = useState(() => describeMemory(getMemoryInfo()));

  async function refresh() {
    const [config, s, w, p, pending_, identity] = await Promise.all([
      getDeviceConfig(),
      getSyncStatus(),
      getMealWindows(),
      listPins(),
      pendingCounts(),
      getDeviceIdentity(),
    ]);
    if (config) {
      setPaired(true);
      if (config.deviceName) setDeviceName(config.deviceName);
    } else {
      setPaired(false);
      setDeviceName(null);
    }
    setStatus(s);
    setWindows(w);
    setPins(p);
    setPending(pending_.events);
    setRole(identity?.role ?? null);
    setSiteCode(identity?.siteCode ?? null);
    setRosterCount((await getAll<any>("people")).length);
    setBackoff(await getBackoffState());
  }

  useEffect(() => {
    refresh();
    getAppVersion().then((v) => setVersionName(`v${v.versionName} (build ${v.versionCode})`));
    const notice = getPairingNotice();
    if (notice) {
      setPairResult({ ok: false, message: notice });
      setPairingNotice(null);
    }
  }, []);

  useEffect(() => {
    getDeviceConfig().then((config) => {
      if (!config?.deviceId) {
        setBackupMeta(null);
        return;
      }
      checkBackup(config.deviceId).then(setBackupMeta);
    });
  }, [paired]);

  function handleCodeChange(raw: string) {
    setPairingCode(normalizeCode(raw));
  }

  async function handlePair() {
    const code = normalizeCode(pairingCode);
    if (code.length !== 8) {
      setPairResult({ ok: false, message: "Enter the full 8-character code." });
      return;
    }

    setPairing(true);
    setPairResult(null);
    try {
      const result = await claimPairingCode(code);
      if (result.status === "approved") {
        await applyPairingApproved(result);
        setPairResult({
          ok: true,
          message:
            result.mode === "replace"
              ? `Paired as ${result.name}. This phone has taken over ${result.name} — its data is being restored.`
              : `Paired as ${result.name}.`,
        });
        setPairingCode("");
        refresh();
      } else if (result.status === "pending") {
        // Persist the pending request; App.tsx now shows the wait screen.
        await setPendingPairing(result.pendingId, code);
      } else if (result.status === "invalid") {
        setPairResult({ ok: false, message: "That code didn't work. Ask the office for a new one." });
      } else if (result.status === "rate_limited") {
        setPairResult({ ok: false, message: "Too many attempts, wait a few minutes." });
      } else {
        setPairResult({ ok: false, message: result.message });
      }
    } finally {
      setPairing(false);
    }
  }

  async function handleUnpair() {
    if (!confirm("Unpair this phone? Sync will stop until you pair again. Local events stay on the phone.")) return;
    await clearDeviceConfig();
    setPairResult(null);
    refresh();
  }

  async function handleSyncNow() {
    setSyncing(true);
    await syncNow();
    setSyncing(false);
    refresh();
  }

  async function handleForceRestore() {
    const config = await getDeviceConfig();
    if (!config) return;
    setRestoring(true);
    setRestoreResult(null);
    try {
      await forceFullResync(config.serverUrl, config.token);
      setRestoreResult({ ok: true, message: "Roster re-pulled from the server." });
      refresh();
    } catch (err: any) {
      setRestoreResult({ ok: false, message: `Restore failed: ${err.message}` });
    } finally {
      setRestoring(false);
    }
  }

  async function handleCheckLocation() {
    setCheckingLocation(true);
    const result = await checkLocationNow();
    setLocationStatus(result);
    setCheckingLocation(false);
  }

  async function handleBackupNow() {
    const config = await getDeviceConfig();
    if (!config?.deviceId) return;
    await saveBackup(config.deviceId, { force: true });
    checkBackup(config.deviceId).then(setBackupMeta);
  }

  async function handleRestoreBackup() {
    const config = await getDeviceConfig();
    if (!config?.deviceId) return;
    setRestoring(true);
    try {
      const res = await restoreFromBackup(config.deviceId);
      const parts = [
        res.people > 0 ? `${res.people} people` : null,
        res.events > 0 ? `${res.events} events` : null,
        res.thumbs > 0 ? `${res.thumbs} photos` : null,
        res.metaKeys > 0 ? `${res.metaKeys} settings` : null,
      ].filter(Boolean);
      setRestoreResult({
        ok: true,
        message: parts.length > 0 ? `Restored: ${parts.join(", ")}.` : "Nothing to restore.",
      });
      refresh();
    } catch (err: any) {
      setRestoreResult({ ok: false, message: `Failed to restore: ${err.message}` });
    } finally {
      setRestoring(false);
    }
  }

  return (
    <div className="min-h-screen bg-bg pb-24">
      <div className="px-4 pt-4 pb-3 flex items-center gap-3">
        <button onClick={onBack} aria-label="Back" className="text-ink-muted p-1 -ml-1">
          <IconBack size={22} />
        </button>
        <h1 className="text-lg font-bold text-ink">Settings</h1>
      </div>

      <div className="px-4 max-w-md mx-auto space-y-6">
        {/* Device & connection */}
        <section className="space-y-3">
          <h2 className="section-title">Device &amp; connection</h2>
          <p className="text-xs text-ink-muted">
            Pair this phone with an 8-character code from the office. The office picks the role
            (gate or canteen) when it mints the code.
          </p>

          <label className="block">
            <span className="label">Server URL</span>
            <input className="input bg-bg text-ink-muted" value={serverUrl} readOnly disabled />
          </label>

          {paired ? (
            <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl border border-line bg-surface">
              <span className="inline-flex items-center justify-center w-9 h-9 rounded-xl bg-primary/10 text-primary font-bold shrink-0">
                {(deviceName ?? "?")[0].toUpperCase()}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink truncate">
                  {deviceName ?? "Paired device"}
                  {role ? ` · ${role === "gate" ? "Gate" : "Canteen"}` : ""}
                  {siteCode ? ` · site ${siteCode}` : ""}
                </p>
                <p className="text-[11px] text-ink-muted">Paired</p>
              </div>
              <button onClick={handleUnpair} className="ml-auto btn-danger px-3 py-2 shrink-0">
                Unpair
              </button>
            </div>
          ) : (
            <>
              <label className="block">
                <span className="label">Pairing code</span>
                <input
                  className="input font-mono tracking-widest text-lg"
                  inputMode="text"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  value={formatCode(pairingCode)}
                  onChange={(e) => handleCodeChange(e.target.value)}
                  placeholder="XXXX-XXXX"
                />
              </label>

              <button onClick={handlePair} disabled={pairing} className="btn-primary w-full py-2.5">
                {pairing ? "Pairing…" : "Pair device"}
              </button>
            </>
          )}

          {pairResult && (
            <div
              className={`p-3 border rounded-xl text-xs font-medium ${
                pairResult.ok
                  ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                  : "bg-red-50 border-red-200 text-red-800"
              }`}
            >
              {pairResult.ok ? "✓ " : "✕ "}
              {pairResult.message}
            </div>
          )}
        </section>

        {/* Device info */}
        <section className="space-y-3 border-t border-line pt-4">
          <h2 className="section-title">Device</h2>
          <div className="card divide-y divide-line">
            <InfoRow label="Role" value={role ? (role === "gate" ? "Gate" : "Canteen") : "—"} />
            <InfoRow label="Roster" value={`${rosterCount} people`} />
            <InfoRow label="PINs" value={`${pins.length}`} />
          </div>

          {pins.length > 0 && (
            <div className="card divide-y divide-line">
              {pins.map((o) => (
                <div key={o.id} className="px-3.5 py-2.5 flex items-center gap-2">
                  <span className="w-7 h-7 rounded-full bg-primary text-white flex items-center justify-center text-xs font-bold">
                    {o.name[0]?.toUpperCase()}
                  </span>
                  <span className="text-sm text-ink">{o.name}</span>
                  <span className="ml-auto flex gap-1">
                    {o.canUnlock && <span className="badge bg-primary/10 text-primary">unlock</span>}
                    {o.canAuthorise && <span className="badge bg-accent/30 text-ink">authorise</span>}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Meal windows (canteen) */}
        {windows.length > 0 && (
          <section className="space-y-2 border-t border-line pt-4">
            <h2 className="section-title">Meal windows</h2>
            <div className="card divide-y divide-line">
              {windows.map((w) => (
                <InfoRow key={w.meal} label={MEAL_LABEL[w.meal]} value={`${w.startTime} – ${w.endTime}`} />
              ))}
            </div>
          </section>
        )}

        {/* Sync */}
        <section className="space-y-2 border-t border-line pt-4">
          <h2 className="section-title">Sync</h2>
          <div className="text-sm text-ink space-y-1">
            <p className="text-ink-muted">Last attempt: {formatWhen(status?.lastAttemptAt ?? null)}</p>
            <p className="text-ink-muted">Last success: {formatWhen(status?.lastSuccessAt ?? null)}</p>
            <p className="text-ink-muted">Last state pull: {formatWhen(status?.lastStatePullAt ?? null)}</p>
            <p>
              Pending:{" "}
              {pending === 0 ? (
                <span className="text-emerald-600">nothing — fully synced</span>
              ) : (
                <span className="text-amber-600">{pending} event{pending === 1 ? "" : "s"}</span>
              )}
            </p>
            {status?.lastError && <p className="text-red-600">Last error: {status.lastError}</p>}
            {backoff && backoff.consecutiveFailures > 0 && (
              <p className="text-amber-700">
                {backoff.consecutiveFailures} failed syncs in a row — next attempt in{" "}
                {Math.round(backoff.nextDelayMs / 1000)}s.
              </p>
            )}
          </div>
          <div className="flex gap-2 pt-1">
            <button onClick={handleSyncNow} disabled={syncing || !paired} className="btn-brand-outline flex-1 py-2.5">
              {syncing ? "Syncing…" : "Sync now"}
            </button>
            <button onClick={handleForceRestore} disabled={restoring || !paired} className="btn-outline flex-1 py-2.5">
              {restoring ? "Restoring…" : "Restore from server"}
            </button>
          </div>
          {restoreResult && (
            <div
              className={`p-3 border rounded-xl text-xs font-medium ${
                restoreResult.ok ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-red-50 border-red-200 text-red-800"
              }`}
            >
              {restoreResult.message}
            </div>
          )}
        </section>

        {/* Diagnostics */}
        <section className="space-y-3 border-t border-line pt-4">
          <h2 className="section-title">Diagnostics</h2>
          <p className="text-xs text-ink-muted">
            App version {versionName || "—"}. Events carry GPS as a secondary signal. If this
            shows an error, that's why recent events from this phone have no location.
          </p>
          <p className="text-sm text-ink-muted">{memory}</p>
          {locationStatus && (
            <div className={`text-sm ${locationStatus.ok ? "text-emerald-600" : "text-red-600"}`}>
              {locationStatus.ok ? "✓ " : "✕ "}
              {locationStatus.message}
              <span className="text-ink-muted"> · {formatWhen(locationStatus.at)}</span>
            </div>
          )}
          <button onClick={handleCheckLocation} disabled={checkingLocation} className="btn-brand-outline w-full py-2.5">
            {checkingLocation ? "Checking…" : "Check location"}
          </button>
        </section>

        {/* Backup */}
        <section className="space-y-3 border-t border-line pt-4">
          <h2 className="section-title">Backup &amp; recovery</h2>
          <div className="text-sm text-ink space-y-1">
            {backupMeta?.exists ? (
              backupMeta.readable ? (
                <>
                  <p className="text-emerald-600 font-medium">Backup found for this device</p>
                  {backupMeta.savedAt && <p className="text-ink-muted">Saved: {formatWhen(backupMeta.savedAt)}</p>}
                  {backupMeta.people !== undefined && (
                    <p className="text-xs text-ink-muted">
                      Contents: {backupMeta.people} people, {backupMeta.events} events,{" "}
                      {backupMeta.thumbs} photos, {backupMeta.metaKeys} settings
                    </p>
                  )}
                </>
              ) : (
                <>
                  <p className="text-amber-600 font-medium">Backup file found but inaccessible</p>
                  <p className="text-xs text-amber-600">
                    This happens when the app was reinstalled with a different signing key. Re-pair
                    and sync to restore from the server instead.
                  </p>
                </>
              )
            ) : (
              <p className="text-ink-muted">No backup yet — one is saved automatically after pairing and syncing.</p>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={handleBackupNow} disabled={!paired} className="btn-outline flex-1 py-2.5">
              Backup now
            </button>
            <button
              onClick={handleRestoreBackup}
              disabled={!backupMeta?.readable || restoring}
              className="btn-brand-outline flex-1 py-2.5"
            >
              {restoring ? "Restoring…" : "Restore from backup"}
            </button>
          </div>
        </section>

        <section className="border-t border-line pt-4 pb-2">
          <button
            onClick={() => {
              lock();
              window.location.reload();
            }}
            className="text-sm text-ink-muted underline"
          >
            Lock this device
          </button>
        </section>
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-3.5 py-2.5 flex items-center justify-between">
      <span className="text-sm text-ink-muted">{label}</span>
      <span className="text-sm font-medium text-ink">{value}</span>
    </div>
  );
}
