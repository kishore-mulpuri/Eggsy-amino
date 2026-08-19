// Copies @vladmandic/human's model weight files into public/models so the
// production build (and `npm run dev`) serves them from the app itself —
// no CDN call, ever. Runs automatically after `npm install` and before
// `npm run build`. Safe to run multiple times.
import { existsSync, mkdirSync, cpSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const src = path.join(root, "node_modules", "@vladmandic", "human", "models");
const dest = path.join(root, "public", "models");

if (!existsSync(src)) {
  console.warn(
    "[copy-face-models] node_modules/@vladmandic/human/models not found yet — " +
      "run `npm install` first. Skipping (this is expected during a fresh clone).",
  );
  process.exit(0);
}

mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`[copy-face-models] copied model files from ${src} -> ${dest}`);
