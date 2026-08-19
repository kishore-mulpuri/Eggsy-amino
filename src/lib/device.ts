// Device identity + build-version helpers used by pairing (see pairing.ts)
// and the update banner. Everything here must work in a plain desktop
// browser (npm run dev) too — the Capacitor plugins simply aren't available
// there — so each native read has a userAgent/build-constant fallback and
// none of this ever throws or blocks pairing.
import { Device } from "@capacitor/device";
import { App } from "@capacitor/app";
import { get, put } from "./db";

function generateUuid(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

interface InstallIdRecord {
  key: "install-id";
  value: string;
}

/** A random UUID generated once per install and persisted in the meta store.
 * Survives re-pairing; only dies on uninstall. */
export async function getInstallId(): Promise<string> {
  const existing = await get<InstallIdRecord>("meta", "install-id");
  if (existing?.value) return existing.value;
  const value = generateUuid();
  await put<InstallIdRecord>("meta", { key: "install-id", value });
  return value;
}

function parseFromUserAgent(): { deviceModel: string; osVersion: string } {
  const ua = navigator.userAgent;
  let osVersion = "";
  const androidMatch = ua.match(/Android\s+([\d.]+)/i);
  if (androidMatch) {
    osVersion = androidMatch[1];
  } else {
    const iosMatch = ua.match(/OS\s+([\d_]+)\s+like/i);
    if (iosMatch) osVersion = iosMatch[1].replace(/_/g, ".");
  }

  let deviceModel = "";
  const parens = ua.match(/\(([^)]*)\)/);
  if (parens) {
    const parts = parens[1].split(";").map((s) => s.trim());
    const idx = parts.findIndex((p) => /Android/i.test(p));
    const candidate = idx >= 0 ? parts[idx + 1] : parts[parts.length - 1];
    if (candidate && !/Build/i.test(candidate) && !/Linux|U;|K\b/i.test(candidate)) {
      deviceModel = candidate;
    }
  }
  if (!deviceModel) deviceModel = "Unknown device";
  return { deviceModel, osVersion };
}

/** Best-effort device model + OS version for the pairing request. Native
 * first, browser userAgent fallback second. Never throws. */
export async function getDeviceModelAndOs(): Promise<{ deviceModel: string; osVersion: string }> {
  try {
    const info = await Device.getInfo();
    const model = info.model && info.model !== "unknown" ? info.model : "";
    const osVersion = info.osVersion || "";
    if (model || osVersion) return { deviceModel: model, osVersion };
  } catch {
    // fall through to userAgent
  }
  return parseFromUserAgent();
}

export interface AppVersion {
  versionCode: number;
  versionName: string;
}

/** Current build's version. Native App.getInfo() covers the packaged app
 * (versionCode/versionName patched into build.gradle); the build-time
 * constants below cover the plain-browser dev case. Never throws. */
export async function getAppVersion(): Promise<AppVersion> {
  try {
    const info = await App.getInfo();
    const code = parseInt(info.build, 10);
    return {
      versionCode: Number.isFinite(code) && code > 0 ? code : __APP_VERSION_CODE__,
      versionName: info.version || __APP_VERSION_NAME__,
    };
  } catch {
    return { versionCode: __APP_VERSION_CODE__, versionName: __APP_VERSION_NAME__ };
  }
}
