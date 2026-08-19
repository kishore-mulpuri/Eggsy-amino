// `npx cap add android` regenerates android/app/build.gradle with versionCode
// 1 and versionName "1.0" every single time, so every build would report the
// same version — which is why update detection (see src/lib/sync.ts version
// info) can't work on an unpatched project. This script rewrites those two
// values after `cap add` runs. Idempotent: safe to run more than once.
//
// Source of truth:
//   versionName  <- package.json "version"
//   versionCode  <- $APP_VERSION_CODE (CI passes github.run_number) else 1
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const gradlePath = "android/app/build.gradle";

if (!existsSync(gradlePath)) {
  console.error(`[patch-android-version] ${gradlePath} not found — run "npx cap add android" first.`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const versionName = pkg.version || "0.1.0";
const versionCode = Number(process.env.APP_VERSION_CODE || 1);

let gradle = readFileSync(gradlePath, "utf8");

const codeRegex = /versionCode\s+\d+/;
const nameRegex = /versionName\s+"[^"]*"/;

if (!codeRegex.test(gradle)) {
  console.error("[patch-android-version] could not find versionCode in build.gradle.");
  process.exit(1);
}
if (!nameRegex.test(gradle)) {
  console.error("[patch-android-version] could not find versionName in build.gradle.");
  process.exit(1);
}

const newCode = `versionCode ${versionCode}`;
const newName = `versionName "${versionName}"`;

let changed = false;
if (gradle.match(codeRegex)[0] !== newCode) {
  gradle = gradle.replace(codeRegex, newCode);
  changed = true;
}
if (gradle.match(nameRegex)[0] !== newName) {
  gradle = gradle.replace(nameRegex, newName);
  changed = true;
}

if (changed) {
  writeFileSync(gradlePath, gradle);
  console.log(`[patch-android-version] set versionCode ${versionCode}, versionName "${versionName}".`);
} else {
  console.log("[patch-android-version] already up to date.");
}
