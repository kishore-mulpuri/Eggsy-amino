import { useCallback, useEffect, useRef, useState } from "react";
import BottomNav, { type View } from "./components/BottomNav";
import SyncProgressOverlay from "./components/SyncProgressOverlay";
import SettingsLockScreen from "./pages/SettingsLockScreen";
import CameraPage from "./pages/CameraPage";
import PeoplePage from "./pages/PeoplePage";
import PersonDetailPage from "./pages/PersonDetailPage";
import PersonFormPage from "./pages/PersonFormPage";
import SettingsPage from "./pages/SettingsPage";
import PairingWaitPage from "./pages/PairingWaitPage";
import { isSettingsUnlocked } from "./lib/settingsLock";
import { startWatchingLocation } from "./lib/location";
import { getDeviceConfig, DEVICE_REVOKED_EVENT } from "./lib/sync";
import { getPendingPairing, PAIRING_CHANGE_EVENT } from "./lib/pairing";

type Screen =
  | { view: "camera" }
  | { view: "people" }
  | { view: "person"; id: string }
  | { view: "person-form"; id: string | null }
  | { view: "settings" };

// Camera and People are always open — anyone should be able to walk up and
// punch or collect a plate without a PIN (UNIFIED-02 §4.1), and any
// operator should be able to check the roster. Only Settings is behind a
// PIN — set on this phone the first time it's opened (settingsLock.ts).
const PROTECTED: View[] = ["settings"];

export default function App() {
  const [screen, setScreen] = useState<Screen>({ view: "camera" });
  const [pendingScreen, setPendingScreen] = useState<Screen | null>(null);

  // Pairing state, re-read whenever pairing or revocation changes.
  const [paired, setPaired] = useState<boolean | null>(null);
  const [pendingPairing, setPendingPairing] = useState<{ pendingId: string; code: string } | null>(null);
  const prevPendingRef = useRef(false);

  // Warm GPS for the whole app session, starting the moment the app opens —
  // not just when the Camera screen mounts — so a fix is already cached by
  // the time someone actually punches (see src/lib/location.ts).
  useEffect(() => {
    startWatchingLocation();
  }, []);

  useEffect(() => {
    let active = true;
    async function load() {
      const [config, pending] = await Promise.all([
        getDeviceConfig(),
        getPendingPairing(),
      ]);
      if (!active) return;
      const wasPending = prevPendingRef.current;
      const nowPending = !!pending?.pendingId;
      setPaired(!!config);
      setPendingPairing(nowPending ? pending : null);
      // A device that was waiting for approval and just got paired lands on
      // the camera — where the first sync's restored data is visible. This
      // runs in the same commit as the paired/pending state, so there's no
      // flash of Settings in between.
      if (wasPending && !nowPending && !!config) {
        setScreen({ view: "camera" });
      }
      prevPendingRef.current = nowPending;
    }
    load();
    const onPairingChange = () => load();
    const onRevoked = () => {
      // Token was cleared by the sync path; drop to the pairing (unpaired)
      // state. Local events are left untouched.
      setScreen({ view: "camera" });
      setPendingScreen(null);
      load();
    };
    const goSettings = () => requestScreen({ view: "settings" });
    window.addEventListener(PAIRING_CHANGE_EVENT, onPairingChange);
    window.addEventListener(DEVICE_REVOKED_EVENT, onRevoked);
    window.addEventListener("eggsy-go-settings", goSettings);
    return () => {
      active = false;
      window.removeEventListener(PAIRING_CHANGE_EVENT, onPairingChange);
      window.removeEventListener(DEVICE_REVOKED_EVENT, onRevoked);
      window.removeEventListener("eggsy-go-settings", goSettings);
    };
  }, []);

  function screenIsProtected(s: Screen): boolean {
    return PROTECTED.includes(s.view as View);
  }

  function requestScreen(target: Screen) {
    if (screenIsProtected(target) && !isSettingsUnlocked()) {
      setPendingScreen(target);
      return;
    }
    setScreen(target);
  }

  function handleUnlocked() {
    const target = pendingScreen;
    setPendingScreen(null);
    if (target) setScreen(target);
  }

  function handleNavigate(view: View) {
    requestScreen({ view } as Screen);
  }

  const handleApproved = useCallback(() => setScreen({ view: "camera" }), []);

  // A pending pairing request (and no token yet) takes over the whole app.
  // A paired device must never see this screen. The progress overlay rides
  // on top of it, since approval (and the first sync) can arrive here.
  if (paired === false && pendingPairing) {
    return (
      <>
        <PairingWaitPage onApproved={handleApproved} />
        <SyncProgressOverlay />
      </>
    );
  }

  // PIN lock for Settings.
  if (pendingScreen) {
    return (
      <SettingsLockScreen
        onUnlock={handleUnlocked}
        onCancel={() => {
          setPendingScreen(null);
          setScreen({ view: "camera" });
        }}
      />
    );
  }

  if (paired === null) return null;

  return (
    <div className="min-h-screen bg-bg">
      {/* Camera stays mounted across tab switches — it owns the camera, and
          stopping/restarting getUserMedia every time the operator switches
          tabs is the single slowest thing in the app. */}
      <div style={{ display: screen.view === "camera" ? "contents" : "none" }}>
        <CameraPage active={screen.view === "camera"} />
      </div>

      {screen.view === "people" && (
        <PeoplePage
          onOpenPerson={(id) => requestScreen({ view: "person", id })}
          onEnrol={() => requestScreen({ view: "person-form", id: null })}
        />
      )}
      {screen.view === "person" && (
        <PersonDetailPage
          personId={screen.id}
          onBack={() => setScreen({ view: "people" })}
          onEdit={() => requestScreen({ view: "person-form", id: screen.id })}
        />
      )}
      {screen.view === "person-form" && (
        <PersonFormPage personId={screen.id} onBack={() => setScreen(screen.id ? { view: "person", id: screen.id } : { view: "people" })} />
      )}
      {screen.view === "settings" && <SettingsPage onBack={() => setScreen({ view: "camera" })} />}

      {screen.view === "camera" && (
        <BottomNav active="camera" onChange={handleNavigate} unlocked={isSettingsUnlocked()} />
      )}
      {screen.view === "people" && <BottomNav active="people" onChange={handleNavigate} unlocked={isSettingsUnlocked()} />}
      {screen.view === "settings" && <BottomNav active="settings" onChange={handleNavigate} unlocked={isSettingsUnlocked()} />}

      {/* Pairing first-sync progress — shows over whatever screen is under it
          (Settings pairing, or the wait screen above). */}
      <SyncProgressOverlay />
    </div>
  );
}
