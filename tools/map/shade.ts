/**
 * Offline shading of a world window into a raster.
 *
 * Three modes, all from the same generator: `natural` is the ocean as it looks,
 * `biome` is a flat classification read-out for verifying biome.ts by eye, and
 * `plankton` is the Layer-0 food field. Being able to flip between them is the
 * whole reason the map renderer exists -- it is a debugger for world generation.
 */

import {
  BENTHIC_BAND, BIOME_COLOR, World, drawFlora, drawScatter, drawVentPlume,
  clamp01, hash2, lerp, mixHex, rampHex, shadeHex, smoothstep,
  substrateColor, waterColor, contour, ventInfluence, Noise2D, fbm,
  type BiomeId, type FloraSink,
} from "../../packages/sim/src/index";
import { Raster } from "./raster";

export type Mode = "natural" | "biome" | "plankton";

const mppYOf = (v: View): number => (v.y1 - v.y0) / v.height;

export interface View {
  x0: number; y0: number; x1: number; y1: number;
  width: number; height: number;
  /**
   * Brightness multiplier for the rendered frame. The abyss is genuinely almost
   * black, which is correct in the game and useless in a reference image, so
   * deep close-ups are printed with the exposure pushed up -- the same way a
   * real submersible survey photo is lit rather than shot by ambient light.
   */
  exposure?: number;
}

const PLANKTON_RAMP: ReadonlyArray<readonly [number, number]> = [
  [0.0, 0x081423],
  [0.25, 0x123a4e],
  [0.45, 0x1c6b5a],
  [0.65, 0x4f9e42],
  [0.82, 0xb9c24a],
  [1.0, 0xf6e9a0],
];

export function renderView(world: World, view: View, mode: Mode = "natural"): Raster {
  const { x0, y0, x1, y1, width, height } = view;
  const r = new Raster(width, height);
  const nMottle = new Noise2D(`${world.seed}/map-mottle`);
  const crustNear = Math.max(1, mppYOf(view) * 2);
  const crustFar = Math.min(45, Math.max(7, mppYOf(view) * 26));
  const mppX = (x1 - x0) / width;
  const mppY = (y1 - y0) / height;
  const t = world.terrain;

  // ---- per-column precomputation: everything that depends on x alone ----
  const colX = new Float64Array(width);
  const colBed = new Float64Array(width);
  const colHard = new Float64Array(width);
  const colSlope = new Float64Array(width);
  const colBiome: BiomeId[] = new Array(width);
  for (let px = 0; px < width; px++) {
    const wx = x0 + (px + 0.5) * mppX;
    colX[px] = wx;
    colBed[px] = t.bed(wx);
    colHard[px] = t.hardness(wx);
    colSlope[px] = t.slope(wx);
    colBiome[px] = world.biomeAt(wx, Math.max(1, colBed[px] - 2));
  }

  // ---- base pass ----
  for (let px = 0; px < width; px++) {
    const wx = colX[px];
    const bed = colBed[px];
    const hard = colHard[px];
    const benthic = colBiome[px];
    const vent = ventInfluence(wx);

    for (let py = 0; py < height; py++) {
      const wy = y0 + (py + 0.5) * mppY;
      const dens = t.density(wx, wy);
      const hab = bed - wy;

      if (mode === "biome") {
        if (dens > 0) { r.set(px, py, 0x15120f); continue; }
        // The real benthic band is BENTHIC_BAND metres thick, which at overview
        // scale is four pixels -- unreadable, and this view exists to be read.
        // Widen it for display only; the classification itself is untouched.
        const band = Math.max(BENTHIC_BAND, mppYOf(view) * 13);
        const id: BiomeId = hab > band
          ? (wy < 200 ? "sunlit_open_water" : wy < 1_000 ? "twilight_zone" : "midnight_zone")
          : benthic;
        r.set(px, py, BIOME_COLOR[id]);
        continue;
      }

      if (mode === "plankton") {
        if (dens > 0) { r.set(px, py, 0x15120f); continue; }
        r.set(px, py, rampHex(PLANKTON_RAMP, world.env.plankton(wx, wy)));
        continue;
      }

      // ---------------- natural ----------------
      if (dens > 0) {
        // Rock. Only the crust -- the top few tens of metres -- carries substrate
        // colour, habitat tint and sun. Everything below is undifferentiated
        // basement. Tinting the whole column by its surface habitat was what
        // striped the first render from seabed to 2,650 m.
        // Geology is measured from the SEABED, not from the nearest surface of
        // any kind. Using the raw density here meant the rock around a cave was
        // shaded as sunlit crust for 20 m in every direction -- a glowing halo
        // around a pitch-dark interior.
        const belowBed = Math.max(0, wy - bed);
        const intoRock = dens * 28; // metres to the nearest rock surface
        // The lit crust is a fixed thickness *on screen*, not in metres: at 8 m/px
        // a 10 m veneer is invisible, and at 0.2 m/px a 40 m one swallows the frame.
        const crust = 1 - smoothstep(crustNear, crustFar, belowBed);
        let c = mixHex(substrateColor(hard), BIOME_COLOR[benthic], 0.32 * crust);
        c = mixHex(c, 0x241d16, 0.78 * smoothstep(crustNear, crustFar * 3, belowBed));
        // A thin rim on any rock face, including cave walls, so an interior
        // still reads as a space rather than a hole in a flat texture.
        const rim = 1 - smoothstep(0.2, 2.2, intoRock);

        const g = t.gradient(wx, wy, Math.max(1.0, mppX * 0.6));
        const lambert = clamp01(g.y * 0.5 + 0.5);
        const sun = lerp(0.38, 1, Math.exp(-wy / 620));
        // Mottling: without it the crust is a flat wash at close range.
        const mottle = fbm(nMottle, wx / 7.5, wy / 7.5, 3) + 0.5 * fbm(nMottle, wx / 1.8, wy / 1.8, 2);
        c = shadeHex(c, (0.46 + 0.3 * lambert + 0.6 * lambert * crust) * sun
          * (1 + 0.18 * mottle * (0.35 + 0.65 * crust))
          * (1 + 0.5 * rim));
        if (vent > 0.4 && hab > -6) c = mixHex(c, 0xff6a3a, 0.2 * vent * crust);
        r.set(px, py, c);
        continue;
      }

      // Water.
      let c = waterColor(wy);

      // Sun shafts in the upper water column.
      const shaftPhase = Math.sin(wx * 0.0042) + 0.6 * Math.sin(wx * 0.011 + 1.7);
      const shaft = Math.max(0, shaftPhase) * Math.exp(-wy / 95);
      c = mixHex(c, 0xdffbff, 0.16 * shaft);

      // Plankton greens the productive layer, very subtly.
      const pk = world.env.plankton(wx, wy);
      c = mixHex(c, 0x3f8f6a, 0.1 * pk * Math.exp(-wy / 240));

      // Ambient occlusion: water close to rock sits in its shadow.
      const near = clamp01(-dens * 28 / 26);
      c = shadeHex(c, lerp(0.58, 1, near));

      // Overhead occlusion: sample straight up for rock. This is what makes a
      // cave read as an interior and a ledge cast a shadow, rather than every
      // pocket of water glowing the same blue as open ocean. Skipped in open
      // water, where there is nothing overhead to occlude.
      if (hab < 60) {
        let shadow = 0;
        if (t.density(wx, wy - 4) > 0) shadow += 0.34;
        if (t.density(wx, wy - 13) > 0) shadow += 0.3;
        if (t.density(wx, wy - 32) > 0) shadow += 0.24;
        if (shadow > 0) c = shadeHex(c, 1 - 0.62 * shadow);
      }

      // (The vent plume used to be faked here as an x-phase glow across the
      // whole ridge. It is real geometry now, anchored to actual chimneys.)
      if (vent > 0.35 && hab > 0 && hab < 90) {
        c = mixHex(c, 0xff9a52, 0.07 * vent * (1 - smoothstep(0, 80, hab)));
      }

      r.set(px, py, c);

      // Marine snow / suspended particulate, denser where plankton is.
      if (hash2(7717, px, py) < 0.004 + 0.02 * pk) {
        r.blend(px, py, 0xeaf6ff, (wy > 400 ? 0.5 : 0.32) * (0.4 + 0.6 * hash2(104729, px, py)));
      }
    }
  }

  if (mode !== "natural") {
    drawContour(r, world, view, 0x000000, 0.35);
    return r;
  }

  const exposure = view.exposure ?? 1;
  if (exposure !== 1) {
    for (let i = 0; i < r.data.length; i++) {
      const v = r.data[i] * exposure;
      r.data[i] = v > 255 ? 255 : v | 0;
    }
  }

  // ---- flora pass ----
  drawFloraPass(r, world, view);

  drawContour(r, world, view, 0x0a0d10, 0.42);
  drawSurface(r, view);
  return r;
}

function drawContour(r: Raster, world: World, view: View, hex: number, alpha: number): void {
  const mppX = (view.x1 - view.x0) / view.width;
  const cell = Math.max(1.5, mppX * 1.3);
  const lines = contour(
    (x, y) => world.terrain.density(x, y),
    view.x0, view.y0, view.x1, view.y1, cell,
  );
  const sx = view.width / (view.x1 - view.x0);
  const sy = view.height / (view.y1 - view.y0);
  for (const line of lines) {
    for (let i = 0; i + 3 < line.length; i += 2) {
      r.line(
        (line[i] - view.x0) * sx, (line[i + 1] - view.y0) * sy,
        (line[i + 2] - view.x0) * sx, (line[i + 3] - view.y0) * sy,
        hex, 1, alpha,
      );
    }
  }
}

/**
 * Adapts the shared flora geometry (sim/world/floraDraw.ts) onto the raster, so
 * the map and the live game draw the same plants from the same code.
 */
class RasterSink implements FloraSink {
  constructor(
    private readonly r: Raster,
    private readonly view: View,
    private readonly sx: number,
    private readonly sy: number,
  ) {}

  private px(x: number): number { return (x - this.view.x0) * this.sx; }
  private py(y: number): number { return (y - this.view.y0) * this.sy; }

  line(pts: readonly number[], width: number, color: number, alpha: number): void {
    const w = Math.max(0.7, width * this.sx);
    for (let i = 0; i + 3 < pts.length; i += 2) {
      this.r.line(this.px(pts[i]), this.py(pts[i + 1]), this.px(pts[i + 2]), this.py(pts[i + 3]), color, w, alpha);
    }
  }

  disc(x: number, y: number, rad: number, color: number, alpha: number): void {
    this.r.disc(this.px(x), this.py(y), Math.max(0.6, rad * Math.min(this.sx, this.sy)), color, alpha);
  }

  poly(pts: readonly number[], color: number, alpha: number): void {
    // Scanline fill of a simple polygon.
    let minY = Infinity, maxY = -Infinity;
    const n = pts.length / 2;
    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      xs[i] = this.px(pts[i * 2]);
      ys[i] = this.py(pts[i * 2 + 1]);
      if (ys[i] < minY) minY = ys[i];
      if (ys[i] > maxY) maxY = ys[i];
    }
    const xsAt: number[] = [];
    for (let y = Math.floor(minY); y <= Math.ceil(maxY); y++) {
      xsAt.length = 0;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        if ((ys[i] > y) !== (ys[j] > y)) {
          xsAt.push(xs[i] + ((y - ys[i]) / (ys[j] - ys[i])) * (xs[j] - xs[i]));
        }
      }
      xsAt.sort((p, q) => p - q);
      for (let i = 0; i + 1 < xsAt.length; i += 2) {
        for (let x = Math.floor(xsAt[i]); x <= Math.ceil(xsAt[i + 1]); x++) {
          this.r.blend(x, y, color, alpha);
        }
      }
    }
  }
}

function drawFloraPass(r: Raster, world: World, view: View): void {
  const sx = view.width / (view.x1 - view.x0);
  const sy = view.height / (view.y1 - view.y0);
  const sink = new RasterSink(r, view, sx, sy);
  const pad = 40;
  const detail = clamp01((sx - 0.5) / 3);
  // Scatter first: flora grows on and around it.
  for (const p of world.scatter(view.x0 - pad, view.x1 + pad)) {
    if (p.h * sy < 0.8) continue;
    const ground = substrateColor(world.terrain.hardness(p.x));
    drawScatter(p, { time: 0, detail, fade: lerp(0.4, 1, Math.exp(-p.y / 750)), ground, dark: world.env.darkness(p.y) }, sink);
  }
  for (const s of world.strands(view.x0 - pad, view.x1 + pad)) {
    if (s.height * sy < 0.8) continue;
    const fade = lerp(0.38, 1, Math.exp(-s.y / 750));
    drawFlora(s, { time: 0, detail, fade, dark: world.env.darkness(s.y) }, sink);
  }
  for (const p of world.scatter(view.x0 - pad * 4, view.x1 + pad * 4)) {
    if (p.kind !== "vent_chimney") continue;
    drawVentPlume(p, { time: 11.3, detail, fade: lerp(0.55, 1, Math.exp(-p.y / 900)), dark: 1 }, sink);
  }
}

/** A bright band and ripple at the waterline, if the view includes the surface. */
function drawSurface(r: Raster, view: View): void {
  if (view.y0 > 2) return;
  const sy = view.height / (view.y1 - view.y0);
  const bandPx = Math.max(1, Math.round(2.2 * sy));
  for (let px = 0; px < view.width; px++) {
    const wx = view.x0 + (px + 0.5) * ((view.x1 - view.x0) / view.width);
    const ripple = 0.5 + 0.5 * Math.sin(wx * 0.05) * Math.sin(wx * 0.013 + 2.1);
    const top = Math.round((0 - view.y0) * sy);
    for (let k = 0; k < bandPx; k++) {
      r.blend(px, top + k, 0xf2fdff, (0.55 - 0.5 * (k / bandPx)) * (0.55 + 0.45 * ripple));
    }
  }
}
