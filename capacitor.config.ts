import type { CapacitorConfig } from "@capacitor/cli";

// New applicationId on purpose — this is a separate app, not an upgrade:
// it installs alongside the old Niko-Payroll and Eggsy-Canteen apps so one
// phone can pilot it without losing a working install.
const config: CapacitorConfig = {
  appId: "com.aminofarms.eggsyamino",
  appName: "Eggsy Amino",
  version: "0.1.0",
  webDir: "dist",
  android: {
    allowMixedContent: false,
    adjustMarginsForEdgeToEdge: "force",
  },
  server: {
    androidScheme: "https",
  },
  plugins: {
    // The sync engine POSTs to aminofarms.replit.app, a different origin
    // from the app itself — route it through native HTTP so the WebView's
    // CORS restrictions don't apply, same reasoning as the main Amino Farms
    // Android app's capacitor.config.ts.
    CapacitorHttp: {
      enabled: true,
    },
  },
};

export default config;
