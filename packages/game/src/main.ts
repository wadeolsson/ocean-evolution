/**
 * Phase 1: world and movement prototype.
 *
 * A free-flying observer camera over the generated ocean, so the question this
 * phase exists to answer -- "does this world feel like somewhere?" -- can be
 * answered by looking. No creatures, no food, no evolution yet: the brief is
 * explicit that the ocean comes first, and everything after it is easier to
 * judge once the ocean is right.
 */

import { Application, Container } from "pixi.js";
import { BIOMES, World } from "@ocean/sim";
import { Camera } from "./camera";
import { Backdrop } from "./render/backdrop";
import { TerrainView } from "./render/terrainView";
import { FloraView } from "./render/floraView";
import { Minimap } from "./render/minimap";

/**
 * View state lives in the URL, so any spot in the ocean is a link you can copy,
 * bookmark or paste to someone else. Written with replaceState on a timer --
 * assigning location.hash directly would spam the back button with a history
 * entry per frame.
 */
function readView(): { seed: string; x?: number; y?: number; z?: number } {
  const q = new URLSearchParams(location.hash.replace(/^#/, ""));
  const num = (k: string): number | undefined => {
    const v = Number(q.get(k));
    return q.has(k) && Number.isFinite(v) ? v : undefined;
  };
  return {
    seed: q.get("seed") ?? new URLSearchParams(location.search).get("seed") ?? "ocean-01",
    x: num("x"),
    y: num("y"),
    z: num("z"),
  };
}

const startView = readView();
const world = new World({ seed: startView.seed });
const camera = new Camera(world.width, world.maxDepth);
if (startView.x !== undefined) camera.x = Math.min(world.width - 20, Math.max(20, startView.x));
if (startView.y !== undefined) camera.y = Math.min(world.maxDepth - 5, Math.max(1, startView.y));
if (startView.z !== undefined) camera.setZoom(startView.z);

const app = new Application();
await app.init({
  background: "#04121f",
  resizeTo: window,
  antialias: true,
  resolution: Math.min(2, window.devicePixelRatio || 1),
  autoDensity: true,
});
document.body.appendChild(app.canvas);

// Screen-space behind, world-space in the middle, screen-space UI on top.
const backdrop = new Backdrop(world);
const worldLayer = new Container();
const terrainView = new TerrainView(world);
const floraView = new FloraView(world);
const minimap = new Minimap(world);
worldLayer.addChild(terrainView.container, floraView.graphics);
app.stage.addChild(backdrop.container, worldLayer, backdrop.fogContainer, minimap.container);

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
const keys = new Set<string>();
addEventListener("keydown", (e) => {
  keys.add(e.code);
  if (e.code === "KeyG") showHabitatTint = !showHabitatTint;
  if (e.code === "KeyC") showCurrent = !showCurrent;
  if (e.code === "KeyV") showHaze = !showHaze;
  // 1-9 jump to the first nine features; 0 cycles through the rest, so the
  // vent field and the seamount are reachable without flying 7 km.
  let idx = -1;
  const n = Number(e.key);
  if (n >= 1 && n <= 9) idx = n - 1;
  else if (e.code === "Digit0" && world.features.length > 9) {
    extraFeature = 9 + ((extraFeature - 9 + 1) % (world.features.length - 9));
    idx = extraFeature;
  }
  if (idx >= 0 && world.features[idx]) {
    const f = world.features[idx];
    camera.x = (f.x0 + f.x1) / 2;
    camera.y = Math.max(6, f.labelDepth);
    camera.vx = camera.vy = 0;
    // Frame the whole feature: jumping into Mirador Canyon at reef zoom put the
    // camera 750 m above the floor with both walls off-screen -- accurate, and
    // completely uninformative.
    camera.frame(f.x1 - f.x0, app.screen.width);
    terrainView.invalidate();
  }
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) e.preventDefault();
});
addEventListener("keyup", (e) => keys.delete(e.code));
addEventListener("wheel", (e) => camera.nudgeZoom(e.deltaY > 0 ? 0.9 : 1.1), { passive: true });

let showHabitatTint = false;
let showCurrent = false;
let showHaze = true;
let extraFeature = 8;

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------
const hBiome = document.getElementById("h-biome")!;
const hFeat = document.getElementById("h-feat")!;
const hPos = document.getElementById("h-pos")!;
const hEnv = document.getElementById("h-env")!;
const elFps = document.getElementById("fps")!;

let time = 0;
let lastChunkY = camera.y;
let hudAcc = 0;
let urlAcc = 0;
let lastHash = "";
let fpsAcc = 0;
let fpsFrames = 0;

app.ticker.add((ticker) => {
  const dt = Math.min(0.05, ticker.deltaMS / 1000);
  time += dt;

  const ax = (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0) - (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0);
  const ay = (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0) - (keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0);
  if (keys.has("KeyQ")) camera.nudgeZoom(1 - 1.4 * dt);
  if (keys.has("KeyE")) camera.nudgeZoom(1 + 1.4 * dt);
  const sprint = keys.has("ShiftLeft") || keys.has("ShiftRight") ? 5.5 : 1;
  camera.update(dt, ax, ay, (34 * sprint) / Math.max(0.5, camera.zoom / 2.6));

  // `app.screen` is the logical (CSS-pixel) viewport. `renderer.width` is ALSO
  // already logical, so dividing it by `resolution` halved the viewport on every
  // Retina display: water bands, terrain chunks and the minimap were all laid
  // out for a screen half the real size, while the canvas was full size.
  const sw = app.screen.width;
  const sh = app.screen.height;
  const v = camera.view(sw, sh);

  // World layer transform: everything inside draws in metres.
  worldLayer.scale.set(camera.zoom);
  worldLayer.position.set(sw / 2 - camera.x * camera.zoom, sh / 2 - camera.y * camera.zoom);

  backdrop.update(camera.x, camera.y, camera.zoom, sw, sh, time);
  backdrop.drawVisibility(camera.x, camera.y, camera.zoom, sw, sh, showHaze);
  backdrop.drawCurrentField(camera.x, camera.y, camera.zoom, sw, sh, time, showCurrent);

  // Chunks are built for a depth window; rebuild once the camera has moved far
  // enough that the window no longer covers the view. The threshold has to
  // track the margin the chunks were actually built with, which now scales
  // with the viewport.
  if (Math.abs(camera.y - lastChunkY) > terrainView.margin * 0.6) {
    terrainView.invalidate();
    lastChunkY = camera.y;
  }
  terrainView.update(v.x0, v.x1, v.y0, v.y1, camera.zoom);
  floraView.update(v.x0, v.x1, time, camera.zoom);
  minimap.update(camera.x, camera.y, sw, sh);
  terrainView.container.tint = showHabitatTint ? 0x88bbff : 0xffffff;

  // HUD at 8Hz; world.describe does real field sampling and is not free.
  hudAcc += dt;
  if (hudAcc > 0.125) {
    hudAcc = 0;
    const e = world.sample(camera.x, camera.y);
    const info = BIOMES[world.biomeAt(camera.x, camera.y)];
    const feat = world.featureAt(camera.x);
    hBiome.textContent = info.name;
    hFeat.textContent = `${feat ? feat.name : "open water"} — ${info.note}`;
    hPos.innerHTML = `<b>${(camera.x / 1000).toFixed(2)} km</b> · <b>${camera.y.toFixed(0)} m</b> deep · `
      + `seabed ${world.terrain.bed(camera.x).toFixed(0)} m · zoom ${camera.zoom.toFixed(2)} px/m`;
    hEnv.innerHTML = `${e.temperature.toFixed(1)}°C · light <b>${(e.light * 100).toFixed(1)}%</b> · `
      + `O₂ ${(e.oxygen * 100).toFixed(0)}% · plankton <b>${(e.plankton * 100).toFixed(0)}%</b> · `
      + `current ${e.currentX >= 0 ? "+" : ""}${e.currentX.toFixed(2)} m/s · `
      + `visibility <b>${e.visibility.toFixed(0)} m</b>`;
  }

  // Keep the address bar in step with where you are, a few times a second.
  urlAcc += dt;
  if (urlAcc > 0.4) {
    urlAcc = 0;
    const h = `#x=${camera.x.toFixed(1)}&y=${camera.y.toFixed(1)}`
      + `&z=${camera.zoom.toFixed(3)}&seed=${encodeURIComponent(world.seed)}`;
    if (h !== lastHash) {
      lastHash = h;
      history.replaceState(null, "", h);
    }
  }

  fpsAcc += dt; fpsFrames++;
  if (fpsAcc > 0.5) {
    elFps.textContent = `${(fpsFrames / fpsAcc).toFixed(0)} fps · ${terrainView.chunkCount} chunks @ ${terrainView.columnStep} m · ${floraView.visible} flora`;
    fpsAcc = 0; fpsFrames = 0;
  }
});

addEventListener("resize", () => terrainView.invalidate());

// Pasting a different link into the address bar of an open tab moves the
// camera instead of doing nothing (the page would not reload on a hash change).
addEventListener("hashchange", () => {
  const v = readView();
  if (v.seed !== world.seed) { location.reload(); return; }
  if (v.x !== undefined) camera.x = v.x;
  if (v.y !== undefined) camera.y = v.y;
  if (v.z !== undefined) camera.setZoom(v.z);
  camera.vx = camera.vy = 0;
  terrainView.invalidate();
});
