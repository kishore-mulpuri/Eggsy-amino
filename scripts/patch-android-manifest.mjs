// `npx cap add android` generates AndroidManifest.xml fresh every time (the
// android/ project isn't committed — see .gitignore). This script patches in
// the permissions the camera/backup/geolocation features need — camera
// always, plus location for the GPS tag attached to each event — right after
// `cap add android` runs. Idempotent: safe to run more than once.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const manifestPath = "android/app/src/main/AndroidManifest.xml";

if (!existsSync(manifestPath)) {
  console.error(`[patch-android-manifest] ${manifestPath} not found — run "npx cap add android" first.`);
  process.exit(1);
}

let xml = readFileSync(manifestPath, "utf8");
const needed = [
  '<uses-permission android:name="android.permission.CAMERA" />',
  '<uses-feature android:name="android.hardware.camera" android:required="true" />',
  '<uses-feature android:name="android.hardware.camera.autofocus" android:required="false" />',
  '<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" />',
  '<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28" />',
  // Coarse is requested alongside fine because Android's permission dialog
  // offers "approximate" as a user-chosen downgrade from "precise" — the app
  // must declare both or that dialog option silently fails. GPS itself
  // (used for the accuracy fine gives) is not required=true on the
  // <uses-feature> below, since a punch should still work without it.
  '<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />',
  '<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />',
  '<uses-feature android:name="android.hardware.location.gps" android:required="false" />',
];

let changed = false;
for (const line of needed) {
  const tag = line.match(/android:name="([^"]+)"/)[1];
  if (xml.includes(tag)) continue;
  xml = xml.replace(/<manifest[^>]*>/, (m) => `${m}\n    ${line}`);
  changed = true;
}

// The encrypted backup lives in the public Documents directory (see
// BACKUP_DIRECTORY in src/lib/backup.ts) so it survives an uninstall.
// On Android 11+ that "just works" for files the app itself created, no
// permission needed — but Android 10 alone still enforces the pre-scoped-
// storage rules unless legacy access is explicitly opted into here. This is
// an <application> attribute, not a <uses-permission>, so it's patched in
// separately from the list above.
if (!xml.includes("android:requestLegacyExternalStorage")) {
  xml = xml.replace(/<application/, '<application\n        android:requestLegacyExternalStorage="true"');
  changed = true;
}

// The face engine (WebGL tensors + model weights) is the biggest memory
// consumer in the app, and it matters on 2GB phones. largeHeap raises the
// per-process heap ceiling so the camera + engine have headroom instead of
// hitting Android's default limit. Blunt, but the trade-off is safe here:
// Android may then be more willing to kill the app in the background, which
// loses nothing — every event is already in IndexedDB.
if (!xml.includes("android:largeHeap")) {
  xml = xml.replace(/<application/, '<application\n        android:largeHeap="true"');
  changed = true;
}

if (changed) {
  writeFileSync(manifestPath, xml);
  console.log("[patch-android-manifest] added camera/location permissions and features.");
} else {
  console.log("[patch-android-manifest] already up to date.");
}
