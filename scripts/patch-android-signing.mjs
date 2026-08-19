import { readFileSync, writeFileSync, existsSync } from "node:fs";

const gradlePath = "android/app/build.gradle";

if (!existsSync(gradlePath)) {
  console.error(`[patch-android-signing] ${gradlePath} not found — run "npx cap add android" first.`);
  process.exit(1);
}

let gradle = readFileSync(gradlePath, "utf8");
let changed = false;

const SIGNING_CONFIG_BLOCK = `    signingConfigs {
        repoDebug {
            storeFile rootProject.file('../debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }`;

if (!gradle.includes("storeFile rootProject.file('../debug.keystore')")) {
  gradle = gradle.replace(
    /(android\s*\{)/,
    `$1\n${SIGNING_CONFIG_BLOCK}`
  );
  changed = true;
}

if (gradle.includes("signingConfig signingConfigs.repoDebug")) {
  // Already set
} else if (gradle.includes("debug {")) {
  gradle = gradle.replace(
    /(debug\s*\{)/,
    `$1\n            signingConfig signingConfigs.repoDebug`
  );
  changed = true;
} else {
  gradle = gradle.replace(
    /(buildTypes\s*\{)/,
    `$1\n        debug {\n            signingConfig signingConfigs.repoDebug\n        }`
  );
  changed = true;
}

if (changed) {
  writeFileSync(gradlePath, gradle);
  console.log("[patch-android-signing] pinned signingConfig to repo debug.keystore.");
} else {
  console.log("[patch-android-signing] already up to date.");
}
