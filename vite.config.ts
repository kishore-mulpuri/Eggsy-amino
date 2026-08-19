import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { readFileSync } from "fs";

// Which server `npm run dev` talks to. Defaults to production; point it at a
// Replit dev workspace to try server changes that aren't deployed yet:
//   API_TARGET=https://<workspace>.replit.dev npm run dev
// Dev-only — production builds always call the server URL saved in Settings
// (see apiBase() in src/lib/sync.ts), never this.
const API_TARGET = process.env.API_TARGET || "https://aminofarms.replit.app";

// Build-time version constants, fed to the browser bundle as the fallback in
// src/lib/device.ts when the Capacitor App plugin isn't available (npm run
// dev). These mirror what scripts/patch-android-version.mjs writes into the
// Android build.gradle: versionName <- package.json "version", versionCode <-
// $APP_VERSION_CODE (github.run_number in CI) else 1.
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf8"));
const APP_VERSION_CODE = Number(process.env.APP_VERSION_CODE || 1);
const APP_VERSION_NAME = pkg.version || "0.1.0";

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION_CODE__: JSON.stringify(APP_VERSION_CODE),
    __APP_VERSION_NAME__: JSON.stringify(APP_VERSION_NAME),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    proxy: {
      "/api": {
        target: API_TARGET,
        changeOrigin: true,
        secure: true,
        // The server rejects requests carrying a browser Origin header
        // (returns 403 with no CORS headers, which the browser surfaces as
        // "Failed to fetch"). Strip it so the proxied request looks the
        // same as a native app / curl request, which the server accepts.
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.removeHeader("origin");
            proxyReq.removeHeader("referer");
          });
        },
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
