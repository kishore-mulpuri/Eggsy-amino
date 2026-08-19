// Regenerates every app icon + splash PNG from the vector sources in
// resources/ (icon.svg, icon-foreground.svg). Run after editing those SVGs:
//
//   node scripts/generate-icons.mjs
//
// Outputs:
//   - resources/icon.png (1024) and resources/splash.png (2732) — Capacitor master assets
//   - public/ favicon + PWA icons (referenced by index.html)
//   - android/app/src/main/res/** launcher icons, adaptive foreground, splash
import sharp from "sharp";
import { mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const res = (...p) => path.join(root, ...p);

const ICON_SVG = res("resources", "icon.svg");
const FG_SVG = res("resources", "icon-foreground.svg");
const MAROON = "#870206";

// Fraction of the icon-foreground.svg viewBox the glyph actually occupies.
const FG_GLYPH_FRACTION = 0.59;

function ensure(dir) {
  mkdirSync(dir, { recursive: true });
}

// Rasterize a 512-viewBox square SVG to an exact pixel size (density-scaled,
// so it stays crisp), then clamp to the exact requested size.
async function renderSquare(src, size) {
  const scale = Math.max(1, Math.ceil(size / 512));
  const density = 72 * scale; // rasterize at >= 512*scale px
  return sharp(src, { density })
    .resize(size, size, { fit: "fill" })
    .png()
    .toBuffer();
}

// Render just the transparent glyph at a target *visible* height (px).
async function renderGlyph(visiblePx) {
  const canvasPx = Math.round(visiblePx / FG_GLYPH_FRACTION);
  return renderSquare(FG_SVG, canvasPx);
}

async function writeSquare(src, size, outPath) {
  ensure(path.dirname(outPath));
  await sharp(await renderSquare(src, size)).toFile(outPath);
}

const job = async () => {
  // ── Capacitor master assets ────────────────────────────────────────────────
  ensure(res("resources"));
  await writeSquare(ICON_SVG, 1024, res("resources", "icon.png"));

  // ── Web (public/) ─────────────────────────────────────────────────────────
  copyFileSync(ICON_SVG, res("public", "icon.svg"));
  await writeSquare(ICON_SVG, 192, res("public", "icon-192.png"));
  await writeSquare(ICON_SVG, 512, res("public", "icon-512.png"));
  await writeSquare(ICON_SVG, 180, res("public", "apple-touch-icon.png"));

  // ── Android launcher icons (legacy + round) ───────────────────────────────
  const launcher = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
  for (const [dpi, size] of Object.entries(launcher)) {
    const dir = res("android", "app", "src", "main", "res", `mipmap-${dpi}`);
    await writeSquare(ICON_SVG, size, path.join(dir, "ic_launcher.png"));
    await writeSquare(ICON_SVG, size, path.join(dir, "ic_launcher_round.png"));
  }

  // ── Android adaptive-icon foreground (108dp canvas) ───────────────────────
  const fg = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
  for (const [dpi, size] of Object.entries(fg)) {
    const dir = res("android", "app", "src", "main", "res", `mipmap-${dpi}`);
    await writeSquare(FG_SVG, size, path.join(dir, "ic_launcher_foreground.png"));
  }

  // ── Adaptive-icon background color ────────────────────────────────────────
  // `cap add android` regenerates this file as white; keep it in sync with the
  // icon background so the white glyph isn't white-on-white (blank icon).
  ensure(res("android", "app", "src", "main", "res", "values"));
  writeFileSync(
    res("android", "app", "src", "main", "res", "values", "ic_launcher_background.xml"),
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${MAROON}</color>\n</resources>\n`,
  );

  // ── Android splash screens ────────────────────────────────────────────────
  const splash = {
    port: { mdpi: [320, 480], hdpi: [480, 800], xhdpi: [720, 1280], xxhdpi: [960, 1600], xxxhdpi: [1280, 1920] },
    land: { mdpi: [480, 320], hdpi: [800, 480], xhdpi: [1280, 720], xxhdpi: [1600, 960], xxxhdpi: [1920, 1280] },
  };
  for (const [orient, sizes] of Object.entries(splash)) {
    for (const [dpi, [w, h]] of Object.entries(sizes)) {
      const dir = res("android", "app", "src", "main", "res", `drawable-${orient}-${dpi}`);
      ensure(dir);
      const glyph = await renderGlyph(Math.round(0.2 * Math.min(w, h)));
      await sharp({ create: { width: w, height: h, channels: 4, background: MAROON } })
        .composite([{ input: glyph, gravity: "centre" }])
        .png()
        .toFile(path.join(dir, "splash.png"));
    }
  }

  // ── Master splash (2732x2732) ─────────────────────────────────────────────
  {
    const glyph = await renderGlyph(Math.round(0.2 * 2732));
    await sharp({ create: { width: 2732, height: 2732, channels: 4, background: MAROON } })
      .composite([{ input: glyph, gravity: "centre" }])
      .png()
      .toFile(res("resources", "splash.png"));
  }

  console.log("icons generated.");
};

job().catch((e) => {
  console.error(e);
  process.exit(1);
});
