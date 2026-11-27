/**
 * Loose topography: boulders, rubble, outcrops and set-pieces.
 *
 * The density field gives the world its large shapes, but a noise field alone
 * produces smooth, samey ground. Discrete objects sitting *on* the seabed are
 * what make a place memorable, and they are also what give small creatures
 * something to hide behind -- so this is habitat, not decoration.
 *
 * Derived from position exactly like flora: no world state, stable from either
 * direction, identical on every machine. Unlike flora these never move, so the
 * renderer bakes them into its cached terrain chunks.
 */

import { lerp } from "../core/math";
import { groundDy, sampleFootprint } from "./flora";
import { hash2, hashStr } from "../core/rng";
import type { BiomeId } from "./biome";
import type { FloraDrawOpts, FloraSink } from "./floraDraw";
import { shadeHex, mixHex } from "../core/math";
import type { Terrain } from "./terrain";

export type ScatterKind =
  | "boulder" | "rubble" | "outcrop" | "shell_bed"
  | "drift_log" | "whale_fall" | "basalt_column" | "vent_chimney";

export interface ScatterSpec {
  readonly kind: ScatterKind;
  readonly name: string;
  readonly color: number;
  readonly minSize: number;
  readonly maxSize: number;
  /** Shelter for small creatures, 0..1. */
  readonly shelter: number;
  /** Food value, for the few of these that are edible (a whale fall is a feast). */
  readonly food: number;
}

export const SCATTER: Readonly<Record<ScatterKind, ScatterSpec>> = {
  boulder:        { kind: "boulder", name: "Boulder", color: 0x6b6358, minSize: 0.8, maxSize: 6.5, shelter: 0.7, food: 0 },
  rubble:         { kind: "rubble", name: "Rubble", color: 0x7a7063, minSize: 0.3, maxSize: 1.4, shelter: 0.45, food: 0 },
  outcrop:        { kind: "outcrop", name: "Rock outcrop", color: 0x5d564d, minSize: 2.5, maxSize: 11, shelter: 0.8, food: 0 },
  shell_bed:      { kind: "shell_bed", name: "Shell bed", color: 0xd8cdb4, minSize: 0.4, maxSize: 1.6, shelter: 0.25, food: 0.1 },
  drift_log:      { kind: "drift_log", name: "Drift log", color: 0x5a4733, minSize: 2, maxSize: 7, shelter: 0.6, food: 0.15 },
  whale_fall:     { kind: "whale_fall", name: "Whale fall", color: 0xcfc6b2, minSize: 8, maxSize: 16, shelter: 0.9, food: 1 },
  basalt_column:  { kind: "basalt_column", name: "Basalt column", color: 0x4a4752, minSize: 1.5, maxSize: 5, shelter: 0.6, food: 0 },
  vent_chimney:   { kind: "vent_chimney", name: "Vent chimney", color: 0x3b2f2a, minSize: 2.5, maxSize: 11, shelter: 0.75, food: 0 },
};

interface Strew { readonly kind: ScatterKind; readonly spacing: number; readonly density: number; }

const STREWN: Partial<Record<BiomeId, readonly Strew[]>> = {
  coastal_shallows:  [{ kind: "boulder", spacing: 9, density: 0.5 }, { kind: "rubble", spacing: 3.5, density: 0.45 }, { kind: "drift_log", spacing: 32, density: 0.4 }],
  kelp_forest:       [{ kind: "boulder", spacing: 12, density: 0.5 }, { kind: "rubble", spacing: 5, density: 0.4 }],
  rocky_reef:        [{ kind: "boulder", spacing: 10, density: 0.55 }, { kind: "outcrop", spacing: 38, density: 0.4 }, { kind: "rubble", spacing: 4.5, density: 0.4 }],
  coral_reef:        [{ kind: "rubble", spacing: 4, density: 0.45 }, { kind: "boulder", spacing: 22, density: 0.3 }],
  reef_dropoff:      [{ kind: "outcrop", spacing: 30, density: 0.45 }, { kind: "rubble", spacing: 6, density: 0.35 }],
  seagrass_meadow:   [{ kind: "shell_bed", spacing: 7, density: 0.35 }],
  sandy_seabed:      [{ kind: "shell_bed", spacing: 11, density: 0.3 }, { kind: "boulder", spacing: 70, density: 0.25 }],
  shelf_edge:        [{ kind: "boulder", spacing: 26, density: 0.35 }, { kind: "rubble", spacing: 9, density: 0.3 }],
  continental_slope: [{ kind: "outcrop", spacing: 45, density: 0.4 }, { kind: "boulder", spacing: 20, density: 0.4 }, { kind: "rubble", spacing: 8, density: 0.35 }],
  deep_canyon:       [{ kind: "outcrop", spacing: 32, density: 0.5 }, { kind: "boulder", spacing: 14, density: 0.5 }, { kind: "rubble", spacing: 6, density: 0.45 }],
  seamount_flank:    [{ kind: "basalt_column", spacing: 9, density: 0.5 }, { kind: "boulder", spacing: 18, density: 0.4 }],
  hydrothermal_vent: [
    { kind: "vent_chimney", spacing: 11, density: 0.62 },
    { kind: "basalt_column", spacing: 9, density: 0.35 },
    { kind: "rubble", spacing: 4, density: 0.4 },
  ],
  abyssal_plain:     [{ kind: "shell_bed", spacing: 26, density: 0.22 }, { kind: "whale_fall", spacing: 1_600, density: 0.6 }],
};

export interface ScatterPiece {
  readonly kind: ScatterKind;
  readonly spec: ScatterSpec;
  readonly x: number;
  readonly y: number;
  /** Half-width and height in metres. */
  readonly w: number;
  readonly h: number;
  readonly tint: number;
  readonly id: number;
  /** Half-width of the footprint, metres. */
  readonly half: number;
  /** Rock surface across that footprint, relative to the root. See groundDy(). */
  readonly ground: readonly number[];
}

/**
 * A species' random stream is derived from its NAME, not from the order it was
 * declared in. With an incrementing counter, adding one species renumbered
 * every species after it and silently relocated every instance in the world --
 * adding vent chimneys moved every boulder and deleted both whale falls.
 */
const SALT = new Map<ScatterKind, number>();
function saltFor(kind: ScatterKind): number {
  let v = SALT.get(kind);
  if (v === undefined) { v = hashStr(`scatter/${kind}`) >>> 1; SALT.set(kind, v); }
  return v;
}

// One global grid per kind at its finest spacing, thinned per habitat -- see the
// equivalent note in flora.ts. Window-relative habitat runs made an instance's
// existence depend on the query range, and let a whale fall on a 2.6 km grid
// land a kilometre outside the abyssal plain that authorised it.
const BASE: Partial<Record<ScatterKind, number>> = {};
function baseSpacing(kind: ScatterKind): number {
  let v = BASE[kind];
  if (v === undefined) {
    v = Infinity;
    for (const list of Object.values(STREWN)) {
      for (const p of list ?? []) if (p.kind === kind) v = Math.min(v, p.spacing);
    }
    if (!Number.isFinite(v)) v = 20;
    BASE[kind] = v;
  }
  return v;
}

const ALL: ScatterKind[] = [];
function allKinds(): ScatterKind[] {
  if (ALL.length === 0) {
    const seen = new Set<ScatterKind>();
    for (const list of Object.values(STREWN)) for (const p of list ?? []) seen.add(p.kind);
    ALL.push(...seen);
  }
  return ALL;
}

function strewFor(biome: BiomeId, kind: ScatterKind): Strew | undefined {
  const list = STREWN[biome];
  if (!list) return undefined;
  for (const p of list) if (p.kind === kind) return p;
  return undefined;
}

export function scatterIn(
  terrain: Terrain,
  classifyAt: (x: number, y: number) => BiomeId,
  xMin: number,
  xMax: number,
  seed = 90_210,
): ScatterPiece[] {
  const out: ScatterPiece[] = [];
  const SQ = 0.25;
  const surfCache = new Map<number, number>();
  const surfaceOf = (x: number): number => {
    const key = Math.round(x / SQ);
    let v = surfCache.get(key);
    if (v === undefined) { v = terrain.surfaceAt(key * SQ); surfCache.set(key, v); }
    return v;
  };
  const Q = 2;
  const cache = new Map<number, BiomeId>();
  const biomeOf = (x: number): BiomeId => {
    const key = Math.round(x / Q);
    let b = cache.get(key);
    if (b === undefined) {
      const xx = key * Q;
      b = classifyAt(xx, surfaceOf(xx) - 1.5);
      cache.set(key, b);
    }
    return b;
  };

  for (const kind of allKinds()) {
    const spec = SCATTER[kind];
    const step = baseSpacing(kind);
    const salt = saltFor(kind);
    for (let i = Math.floor(xMin / step) - 1; i <= Math.ceil(xMax / step) + 1; i++) {
      const x = (i + (hash2(seed + salt, i, 23) - 0.5) * 0.9) * step;
      if (x < xMin || x > xMax || x < 0) continue;
      const p = strewFor(biomeOf(x), kind);
      if (!p) continue;
      if (hash2(seed + salt, i, 19) > (step / p.spacing) * p.density) continue;

      const r = hash2(seed + salt, i, 29);
      const size = lerp(spec.minSize, spec.maxSize, r * r);
      // Exact, not the 0.25 m memo: the footprint below is sampled exactly, and
      // a root taken from the quantised probe disagreed with it by up to a
      // metre wherever the quantisation landed on the far side of a cave mouth.
      const y = terrain.surfaceAt(x);
      // A 6 m boulder cannot sit in 3 m of water.
      const clearance = Math.max(0.15, y - 0.4);
      const w = size * lerp(0.7, 1.3, hash2(seed + salt, i, 31));
      // Every piece carries the rock profile under it, so its base can follow
      // the seabed instead of ending at a flat line through the root. Without
      // this a boulder on a slope hangs over open water with no bottom.
      const half = w * 1.15;
      out.push({
        kind,
        spec,
        x,
        y,
        w,
        h: Math.min(size * lerp(0.45, 0.95, hash2(seed + salt, i, 41)), clearance),
        tint: hash2(seed + salt, i, 43) * 2 - 1,
        id: (salt ^ (i * 2_654_435_761)) >>> 0,
        half,
        // Sampled unquantised: scatter is sparse enough to afford it, and a
        // 0.25 m shift can land on the other side of a cave mouth, which moves
        // the "surface" by metres rather than centimetres.
        ground: sampleFootprint((xx) => terrain.surfaceAt(xx), x, half, 7),
      });
    }
  }
  out.sort((a, b) => b.w - a.w); // big shapes behind small ones
  return out;
}

/** Draw one piece through the shared sink. Static: no time dependence. */
export function drawScatter(p: ScatterPiece, o: FloraDrawOpts, sink: FloraSink): void {
  // Depth fade darkens the colour, never the alpha -- see floraDraw.ts.
  let col = shadeHex(p.spec.color, (0.82 + 0.34 * (p.tint * 0.5 + 0.5)) * o.fade);
  // Rock belongs to its surroundings: blend toward the local substrate so a
  // boulder on carbonate ooze is not a black cut-out.
  if (o.ground !== undefined && p.kind !== "whale_fall" && p.kind !== "shell_bed") {
    col = mixHex(col, shadeHex(o.ground, o.fade), 0.42);
  }
  const a = 1;
  switch (p.kind) {
    case "vent_chimney": return ventChimney(p, col, o, sink, a);
    case "whale_fall": return whaleFall(p, col, o, sink, a);
    case "drift_log": return driftLog(p, col, sink, a);
    case "basalt_column": return basaltColumn(p, col, sink, a);
    case "shell_bed": return shellBed(p, col, o, sink, a);
    case "rubble": return blob(p, col, sink, a, 6, 0.55);
    case "outcrop": return outcrop(p, col, sink, a);
    default: return blob(p, col, sink, a, 9, 0.8);
  }
}

/**
 * Irregular lump sitting on the seabed. Its underside follows the rock profile
 * and sinks slightly into it, so a boulder on a slope is partly buried rather
 * than a dome floating over open water with a flat line for a bottom.
 */
function blob(p: ScatterPiece, col: number, k: FloraSink, a: number, n: number, bury: number): void {
  const pts: number[] = [];
  const crown: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const ang = Math.PI * (1 + t);
    const rr = lerp(0.72, 1.12, hash2(p.id, i, 3));
    const dx = Math.cos(ang) * p.w * rr;
    const gy = groundDy(p.ground, p.half, dx);
    const px = p.x + dx;
    const py = p.y + gy + Math.sin(ang) * p.h * rr * bury;
    pts.push(px, py);
    crown.push(px, py);
  }
  const sink = Math.max(0.08, p.h * 0.22);
  const m = 5;
  for (let i = 0; i < m; i++) {
    const dx = lerp(p.w, -p.w, i / (m - 1));
    pts.push(p.x + dx, p.y + groundDy(p.ground, p.half, dx) + sink);
  }
  k.poly(pts, col, 0.98 * a);
  k.line(crown, Math.max(0.05, p.w * 0.07), shadeHex(col, 1.35), 0.8 * a);
}

/** Tall angular rock rising off the slope, keyed into the seabed at its base. */
function outcrop(p: ScatterPiece, col: number, k: FloraSink, a: number): void {
  const lean = p.tint * p.w * 0.3;
  const g = (dx: number) => p.y + groundDy(p.ground, p.half, dx);
  const sink = Math.max(0.1, p.h * 0.14);
  const pts = [
    p.x - p.w, g(-p.w) + sink,
    p.x - p.w * 0.72, g(-p.w * 0.72) - p.h * 0.55,
    p.x - p.w * 0.2 + lean, g(-p.w * 0.2) - p.h,
    p.x + p.w * 0.35 + lean, g(p.w * 0.35) - p.h * 0.78,
    p.x + p.w * 0.85, g(p.w * 0.85) - p.h * 0.2,
    p.x + p.w, g(p.w) + sink,
  ];
  k.poly(pts, col, 0.98 * a);
  k.poly([
    p.x - p.w, g(-p.w) + sink,
    p.x - p.w * 0.72, g(-p.w * 0.72) - p.h * 0.55,
    p.x - p.w * 0.2 + lean, g(-p.w * 0.2) - p.h,
    p.x - p.w * 0.1 + lean, g(-p.w * 0.1) + sink,
  ], shadeHex(col, 1.22), 0.6 * a);
}

/** Hexagonal basalt jointing: the seamount and vent ridge are volcanic. */
function basaltColumn(p: ScatterPiece, col: number, k: FloraSink, a: number): void {
  const n = 2 + Math.floor(hash2(p.id, 0, 5) * 3);
  for (let i = 0; i < n; i++) {
    const ox = (i / Math.max(1, n - 1) - 0.5) * p.w * 1.6;
    // Each column stands on the rock under *it*, not under the cluster's root.
    const base = p.y + groundDy(p.ground, p.half, ox) + Math.max(0.05, p.h * 0.1);
    const h = p.h * lerp(0.55, 1, hash2(p.id, i, 7));
    const w = p.w * 0.3;
    k.poly([p.x + ox - w, base, p.x + ox + w, base, p.x + ox + w * 0.85, base - h, p.x + ox - w * 0.85, base - h],
      shadeHex(col, 0.85 + 0.3 * hash2(p.id, i, 11)), 0.98 * a);
    k.line([p.x + ox - w * 0.85, base - h, p.x + ox + w * 0.85, base - h], Math.max(0.04, w * 0.2), shadeHex(col, 1.4), 0.7 * a);
  }
}

function driftLog(p: ScatterPiece, col: number, k: FloraSink, a: number): void {
  const r = p.h * 0.45;
  const gl = groundDy(p.ground, p.half, -p.w);
  const gr = groundDy(p.ground, p.half, p.w);
  k.poly([
    p.x - p.w, p.y + gl + r * 0.3, p.x + p.w, p.y + gr + r * 0.3,
    p.x + p.w * 0.95, p.y + gr - r * 1.7, p.x - p.w * 0.95, p.y + gl - r * 1.7,
  ], col, 0.98 * a);
  k.disc(p.x + p.w * 0.95, p.y + gr - r * 0.7, r, shadeHex(col, 1.25), 0.95 * a);
  k.line([p.x - p.w, p.y + gl - r * 1.7, p.x + p.w, p.y + gr - r * 1.7], Math.max(0.05, r * 0.3), shadeHex(col, 1.3), 0.7 * a);
}

/**
 * A black-smoker chimney: a flared sulphide spire with an orifice on top.
 *
 * The whole base sits on the rock -- a vent is a mineral deposit precipitated
 * out of fluid venting through the seabed, so a gap underneath is not a
 * rendering nit, it is physically impossible.
 */
function ventChimney(p: ScatterPiece, col: number, o: FloraDrawOpts, k: FloraSink, a: number): void {
  const g = (dx: number) => groundDy(p.ground, p.half, dx);
  const lean = p.tint * p.w * 0.22;
  const wBase = p.w;
  const wNeck = p.w * 0.34;
  const wTop = p.w * 0.26;
  const h = p.h;
  const sink = Math.max(0.12, h * 0.1);

  // Flared skirt + tapering spire, as one silhouette whose foot follows the rock.
  const pts: number[] = [];
  const m = 5;
  for (let i = 0; i < m; i++) {
    const dx = lerp(-wBase, wBase, i / (m - 1));
    pts.push(p.x + dx, p.y + g(dx) + sink);
  }
  pts.push(p.x + wNeck + lean * 0.4, p.y + g(wNeck) - h * 0.52);
  pts.push(p.x + wTop + lean, p.y + g(0) - h);
  pts.push(p.x - wTop + lean, p.y + g(0) - h);
  pts.push(p.x - wNeck + lean * 0.4, p.y + g(-wNeck) - h * 0.52);
  k.poly(pts, col, 0.98 * a);

  // Lit flank and mineral banding.
  k.poly([
    p.x - wBase, p.y + g(-wBase) + sink,
    p.x - wNeck + lean * 0.4, p.y + g(-wNeck) - h * 0.52,
    p.x - wTop + lean, p.y + g(0) - h,
    p.x - wTop * 0.3 + lean, p.y + g(0) - h,
    p.x - wNeck * 0.3, p.y + g(0) - h * 0.5,
    p.x - wBase * 0.3, p.y + g(-wBase * 0.3) + sink,
  ], shadeHex(col, 1.3), 0.55 * a);
  if (o.detail > 0.3) {
    for (let i = 1; i <= 3; i++) {
      const t = i / 4;
      const wy = p.y + g(0) - h * t;
      const ww = lerp(wBase * 0.8, wTop, t);
      k.line([p.x - ww + lean * t, wy, p.x + ww + lean * t, wy], Math.max(0.04, p.w * 0.05),
        shadeHex(col, 0.72), 0.5 * a);
    }
  }
  // The orifice, glowing with the fluid behind it.
  const ox = p.x + lean;
  const oy = p.y + g(0) - h;
  k.disc(ox, oy, Math.max(0.06, wTop * 0.85), 0x120b08, 0.95 * a);
  k.disc(ox, oy - wTop * 0.15, Math.max(0.04, wTop * 0.45), shadeHex(0xff7a3c, o.fade), 0.85 * a);
}

/**
 * The smoker plume. Fluid leaves the orifice at ~350 C and several hundred bar;
 * it is clear as it exits, then flashes into a billowing cloud of metal
 * sulphides a few metres up as it hits 2 C seawater. Drawn in two parts for
 * exactly that reason: a short shimmering throat, then the black smoke.
 */
export function drawVentPlume(p: ScatterPiece, o: FloraDrawOpts, sink: FloraSink): void {
  if (p.kind !== "vent_chimney") return;
  const lean = p.tint * p.w * 0.22;
  const ox = p.x + lean;
  const oy = p.y + groundDy(p.ground, p.half, 0) - p.h;
  const reach = p.h * 9;

  // Shimmering throat: clear superheated fluid, visible only as distortion.
  for (let i = 0; i < 4; i++) {
    const t = (i + 1) / 5;
    const wob = Math.sin(o.time * 4 + i * 1.3 + p.tint * 6) * p.w * 0.1 * t * t;
    sink.line(
      [ox + wob * 0.3, oy - reach * 0.02 * i, ox + wob, oy - reach * 0.055 * (i + 1)],
      Math.max(0.03, p.w * 0.07), 0xffd8b0, 0.3 * (1 - t) * o.fade,
    );
  }

  // Billowing sulphide smoke, rising and shearing off with the current.
  // Against near-black water a literally black plume is invisible, so it is
  // lit from the orifice: hot and bright at the throat, cooling to dark haze.
  const puffs = o.detail > 0.5 ? 24 : o.detail > 0.2 ? 12 : 6;
  for (let i = 0; i < puffs; i++) {
    // Each puff advances on its own loop so the column reads as continuous flow.
    const t = ((i / puffs) + o.time * 0.045 + hash2(p.id, i, 3) * 0.05) % 1;
    const rise = Math.pow(t, 0.72) * reach;
    const spread = p.w * (0.3 + 3.4 * t * t);
    // Drift must be ZERO at the orifice and grow as the puff rises. The old
    // form had a constant term, so the plume was born offset to one side and
    // the column looked detached from the chimney it comes out of.
    const shear = 0.45 + 0.55 * Math.sin(o.time * 0.5 + p.tint * 4);
    const drift = p.w * (0.5 + 3.2 * t) * t * shear
      + Math.sin(o.time * 1.1 + i * 2.1) * p.w * 0.3 * t * t;
    // Lower alpha with more puffs: overlapping translucent discs read as a
    // billowing cloud, where fewer opaque ones read as a string of circles.
    const alpha = Math.pow(1 - t, 1.15) * 0.42 * o.fade;
    if (alpha < 0.012) continue;
    // Hot only at the throat, then cooling fast to dark sulphide smoke -- a
    // black smoker is black, and staying orange all the way up read as a bonfire.
    const c = t < 0.12
      ? mixHex(0xffa047, 0x7a4426, t / 0.12)
      : mixHex(0x7a4426, 0x241d1a, Math.min(1, (t - 0.12) / 0.4));
    sink.disc(ox + drift, oy - rise, Math.max(0.06, spread), c, alpha);
  }
}

function shellBed(p: ScatterPiece, col: number, o: FloraDrawOpts, k: FloraSink, a: number): void {
  const n = o.detail > 0.35 ? 7 : 3;
  for (let i = 0; i < n; i++) {
    const ox = (hash2(p.id, i, 13) - 0.5) * p.w * 2.2;
    const oy = groundDy(p.ground, p.half, ox) - hash2(p.id, i, 17) * p.h * 0.5;
    k.disc(p.x + ox, p.y + oy, Math.max(0.04, p.w * 0.16 * lerp(0.6, 1.4, hash2(p.id, i, 19))),
      shadeHex(col, 0.85 + 0.35 * hash2(p.id, i, 23)), 0.9 * a);
  }
}

/**
 * A whale fall: a vertebral column and ribs on the abyssal mud. Rare, and a
 * decade-long food bonanza -- the one place down here with real calories.
 */
function whaleFall(p: ScatterPiece, col: number, o: FloraDrawOpts, k: FloraSink, a: number): void {
  const bone = mixHex(col, 0xffffff, 0.3);
  const g = (dx: number) => groundDy(p.ground, p.half, dx);
  // Spine, laid along the mud rather than along a flat line.
  k.line([p.x - p.w, p.y + g(-p.w) - p.h * 0.12, p.x, p.y + g(0) - p.h * 0.22, p.x + p.w, p.y + g(p.w) - p.h * 0.1],
    Math.max(0.1, p.h * 0.1), bone, 0.95 * a);
  // Ribs, splaying from the spine.
  const ribs = o.detail > 0.3 ? 9 : 5;
  for (let i = 0; i < ribs; i++) {
    const t = i / (ribs - 1);
    const bx = lerp(p.x - p.w * 0.8, p.x + p.w * 0.6, t);
    const by = p.y + g(bx - p.x) - p.h * lerp(0.14, 0.2, Math.sin(t * Math.PI));
    const span = p.h * (0.5 + 0.8 * Math.sin(t * Math.PI));
    // Every rib arcs the same way: we are looking at the carcass side-on, so
    // the ribs read as hoops. Alternating them left/right drew a sawtooth.
    k.line([
      bx, by,
      bx - span * 0.18, by - span * 0.62,
      bx + span * 0.22, by - span * 0.95,
      bx + span * 0.52, by - span * 0.55,
    ], Math.max(0.06, p.h * 0.05), shadeHex(bone, 0.92), 0.9 * a);
  }
  // Skull.
  k.disc(p.x - p.w * 0.95, p.y + g(-p.w * 0.95) - p.h * 0.18, p.h * 0.3, bone, 0.95 * a);
  // Bacterial mat haloing the carcass.
  k.poly([
    p.x - p.w * 1.3, p.y + g(-p.w * 1.3), p.x + p.w * 1.2, p.y + g(p.w * 1.2),
    p.x + p.w * 1.1, p.y + g(p.w * 1.1) - p.h * 0.07, p.x - p.w * 1.2, p.y + g(-p.w * 1.2) - p.h * 0.07,
  ], shadeHex(0xe6dca8, o.fade), 0.5);
}
