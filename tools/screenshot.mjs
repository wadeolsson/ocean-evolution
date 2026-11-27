/**
 * Screenshot harness for the flythrough.
 *
 * `npm run dev` in one terminal, then `node tools/screenshot.mjs out/shot.png 4`
 * to capture feature 4. Useful for eyeballing a generation change without
 * flying there by hand, and for catching a render regression in CI later.
 */
import { chromium } from "playwright-core";

const out = process.argv[2] ?? "out/shot.png";
const jump = process.argv[3] ?? null;
const url = process.env.URL ?? "http://127.0.0.1:8040/";

// Use whatever Chromium this machine already has rather than forcing a
// playwright-managed download. The cache layout varies by revision and arch
// (chrome-mac vs chrome-mac-arm64, "Chromium.app" vs "Google Chrome for
// Testing.app"), so scan for it instead of hardcoding a path -- a wrong guess
// here fails silently by falling through to the user's own Chrome.
const { existsSync, readdirSync, statSync } = await import("node:fs");
const { join } = await import("node:path");

function findCachedChromium() {
  const cache = join(process.env.HOME ?? "", "Library/Caches/ms-playwright");
  if (!existsSync(cache)) return null;
  const revs = readdirSync(cache)
    .filter((d) => d.startsWith("chromium"))
    .sort((a, b) => (parseInt(b.split("-").pop(), 10) || 0) - (parseInt(a.split("-").pop(), 10) || 0));
  const dirs = (d) => {
    try { return readdirSync(d).filter((e) => statSync(join(d, e)).isDirectory()); }
    catch { return []; }
  };
  for (const rev of revs) {
    for (const arch of dirs(join(cache, rev))) {
      const base = join(cache, rev, arch);
      const shell = join(base, "chrome-headless-shell");
      if (existsSync(shell)) return shell;
      for (const entry of dirs(base)) {
        if (!entry.endsWith(".app")) continue;
        const macos = join(base, entry, "Contents/MacOS");
        if (!existsSync(macos)) continue;
        const bin = readdirSync(macos)[0];
        if (bin) return join(macos, bin);
      }
    }
  }
  return null;
}

const executablePath = [
  process.env.PW_CHROME,
  findCachedChromium(),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((p) => p && existsSync(p));
if (!executablePath) throw new Error("no chromium found; set PW_CHROME");
console.log("browser:", executablePath);
// Headless Chrome caps requestAnimationFrame at 30 fps by default -- a blank
// page measures 30 -- so without these flags every fps reading from this
// harness is the cap, not the renderer.
const browser = await chromium.launch({
  executablePath,
  args: ["--disable-frame-rate-limit", "--disable-gpu-vsync", "--use-angle=metal"],
});
// DPR matters: the renderer is configured with `resolution`, and a layout bug
// that divides by it is invisible at DPR 1 and halves the world at DPR 2.
// Default to 2 so captures match a Retina display.
const dpr = Number(process.env.DPR ?? 2);
const page = await browser.newPage({
  viewport: { width: 1600, height: 900 },
  deviceScaleFactor: dpr,
});
const errors = [];
page.on("console", (m) => { if (m.type() === "error" || process.env.VERBOSE) errors.push(`console[${m.type()}]: ` + m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message + "\n" + (e.stack ?? "")));
page.on("requestfailed", (r) => errors.push("requestfailed: " + r.url() + " " + (r.failure()?.errorText ?? "")));

await page.goto(url, { waitUntil: "load" });
await page.waitForTimeout(Number(process.env.WAIT ?? 2000));
for (const key of (jump ? jump.split(",") : [])) {
  await page.keyboard.press(key.trim());
  await page.waitForTimeout(700);
}
if (jump) await page.waitForTimeout(1200);
// ZOOM=n scrolls n notches in (negative = out), for close-up captures.
const zoomNotches = Number(process.env.ZOOM ?? 0);
if (zoomNotches) {
  await page.mouse.move(800, 450);
  for (let i = 0; i < Math.abs(zoomNotches); i++) {
    await page.mouse.wheel(0, zoomNotches > 0 ? -120 : 120);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(1600);
}

const hud = await page.evaluate(() => ({
  url: location.hash,
  biome: document.getElementById("h-biome")?.textContent,
  feat: document.getElementById("h-feat")?.textContent,
  pos: document.getElementById("h-pos")?.textContent,
  env: document.getElementById("h-env")?.textContent,
  fps: document.getElementById("fps")?.textContent,
}));
console.log(JSON.stringify(hud, null, 1));
console.log(errors.length ? "ERRORS:\n" + errors.slice(0, 8).join("\n") : "no console errors");
await page.screenshot({ path: out });
await browser.close();
