/**
 * Flora geometry, emitted as drawing primitives.
 *
 * The live Pixi renderer and the offline map raster both consume this, so the
 * nine body forms exist once rather than being reimplemented (and drifting
 * apart) in each. A sink receives primitives in world metres; the renderer
 * decides how to rasterise them.
 *
 * `pts` arrays are reused scratch buffers -- a sink must consume them within
 * the call and must not retain a reference.
 */

import { lerp, mixHex, shadeHex } from "../core/math";
import { hash2 } from "../core/rng";
import { groundDy, strandPoint, type Strand } from "./flora";

export interface FloraSink {
  line(pts: readonly number[], width: number, color: number, alpha: number): void;
  disc(x: number, y: number, r: number, color: number, alpha: number): void;
  poly(pts: readonly number[], color: number, alpha: number): void;
}

export interface FloraDrawOpts {
  /** Seconds, for sway. */
  readonly time: number;
  /** 0 = far/coarse (skip sub-elements), 1 = close/full detail. */
  readonly detail: number;
  /**
   * Brightness multiplier for depth. Applied to COLOUR, never to alpha: these
   * are solid bodies, and a translucent sponge reads as a rendering fault.
   */
  readonly fade: number;
  /** 0 in daylight, 1 in the aphotic zone. Drives bioluminescence. */
  readonly dark: number;
  /**
   * Local substrate colour. Scatter blends toward it so a boulder reads as rock
   * of the same geology as the seabed it sits on, rather than a black silhouette
   * dropped onto pale sediment.
   */
  readonly ground?: number;
}

const buf: number[] = [];
const take = (n: number): number[] => { buf.length = n; return buf; };

export function drawFlora(s: Strand, o: FloraDrawOpts, sink: FloraSink): void {
  const spec = s.spec;
  // Depth fade DARKENS the colour; it must not reduce alpha. Fading by alpha
  // made deep sponges see-through and double-blended wherever one part of a
  // body overlapped another, so every boulder had a two-tone base.
  const base = shadeHex(spec.color, (0.84 + 0.32 * (s.tint * 0.5 + 0.5)) * o.fade);
  const a = 1;
  // Bioluminescence, drawn behind the body: a soft halo that is only worth
  // anything where there is no sunlight, so it scales with how dark it is.
  if (spec.glow > 0 && o.dark > 0.05) {
    const pulse = 0.55 + 0.45 * Math.sin(o.time * 1.3 + s.phase * 2.1);
    const r = s.height * (0.55 + 0.5 * pulse);
    for (let i = 3; i >= 1; i--) {
      sink.disc(s.x + s.lean * 0.4, s.y - s.height * 0.6, r * i * 0.55,
        0x6fe6d8, 0.055 * spec.glow * o.dark * pulse);
    }
  }
  switch (spec.form) {
    case "stipe": return stipe(s, base, o, sink, a);
    case "blade": return blade(s, base, o, sink, a);
    case "clump": return clump(s, base, o, sink, a);
    case "branch": return branch(s, base, o, sink, a);
    case "fan": return fan(s, base, o, sink, a);
    case "barrel": return barrel(s, base, o, sink, a);
    case "tube": return tube(s, base, o, sink, a);
    case "mat": return mat(s, base, o, sink, a);
    case "ball": return ball(s, base, o, sink, a);
  }
}

// --- long flexible stem with blades: giant kelp, bull kelp -------------------
function stipe(s: Strand, col: number, o: FloraDrawOpts, k: FloraSink, a: number): void {
  const steps = o.detail > 0.4 ? 10 : 5;
  const pts = take((steps + 1) * 2);
  for (let i = 0; i <= steps; i++) {
    const p = strandPoint(s, i / steps, o.time);
    pts[i * 2] = p.x;
    pts[i * 2 + 1] = p.y;
  }
  k.line(pts, s.width, col, 0.95 * a);
  if (o.detail < 0.35) return;
  // Blades. Without them a kelp forest renders as a thicket of bare sticks.
  for (let i = 2; i <= steps; i++) {
    const u = i / steps;
    const p = strandPoint(s, u, o.time);
    const side = i % 2 === 0 ? 1 : -1;
    const len = s.height * 0.09 * (0.5 + 0.5 * Math.sin(u * Math.PI));
    const b = take(6);
    b[0] = p.x; b[1] = p.y;
    b[2] = p.x + side * len * 0.7; b[3] = p.y + len * 0.3;
    b[4] = p.x + side * len; b[5] = p.y + len * 0.8;
    k.line(b, s.width * 0.8, shadeHex(col, 1.1), 0.85 * a);
  }
}

// --- tuft of short flexible blades: seagrass, surfgrass, red algae -----------
function blade(s: Strand, col: number, o: FloraDrawOpts, k: FloraSink, a: number): void {
  const n = o.detail > 0.4 ? 5 : 3;
  for (let j = 0; j < n; j++) {
    const spread = (j / (n - 1) - 0.5) * s.width * 3.2;
    const h = s.height * lerp(0.65, 1, hash2(s.id, j, 5));
    const phase = s.phase + j * 1.1;
    const sway = Math.sin(o.time * 1.4 + phase) * 0.35 * s.spec.sway;
    // Root this blade on the rock beneath it, not beneath the tuft's centre.
    const y = s.y + groundDy(s.ground, s.half, spread * 0.25);
    const b = take(8);
    b[0] = s.x + spread * 0.25; b[1] = y;
    b[2] = s.x + spread * 0.6 + sway * h * 0.2; b[3] = y - h * 0.4;
    b[4] = s.x + spread + sway * h * 0.5; b[5] = y - h * 0.75;
    b[6] = s.x + spread * 1.3 + sway * h; b[7] = y - h;
    k.line(b, s.width, shadeHex(col, 0.9 + 0.2 * hash2(s.id, j, 9)), 0.92 * a);
  }
}

// --- lumpy head of overlapping lobes: brain coral, soft coral, mussels -------
function clump(s: Strand, col: number, o: FloraDrawOpts, k: FloraSink, a: number): void {
  const lobes = 3 + Math.floor(hash2(s.id, 0, 3) * 4);
  for (let i = 0; i < lobes; i++) {
    const u = (i + 0.5) / lobes;
    const ox = (u - 0.5) * s.width * 1.7;
    const oy = groundDy(s.ground, s.half, ox) - s.height * (0.32 + 0.6 * Math.sin(u * Math.PI));
    const r = 0.5 * s.width * (0.55 + 0.5 * Math.sin(u * Math.PI)) * lerp(0.8, 1.2, hash2(s.id, i, 7));
    k.disc(s.x + ox, s.y + oy, Math.max(0.08, r), shadeHex(col, 0.82 + 0.34 * u), 0.96 * a);
  }
}

// --- branching antler: staghorn, bamboo coral, black coral -------------------
function branch(s: Strand, col: number, o: FloraDrawOpts, k: FloraSink, a: number): void {
  const arms = 2 + Math.floor(hash2(s.id, 0, 13) * 3);
  for (let i = 0; i < arms; i++) {
    const dir = (i / Math.max(1, arms - 1) - 0.5) * 1.5;
    const h = s.height * lerp(0.6, 1, hash2(s.id, i, 17));
    const tipX = s.x + dir * s.width * 0.8;
    const b = take(6);
    b[0] = s.x; b[1] = s.y;
    b[2] = s.x + dir * s.width * 0.3; b[3] = s.y - h * 0.5;
    b[4] = tipX; b[5] = s.y - h;
    k.line(b, s.width * 0.22, col, 0.95 * a);
    if (o.detail < 0.4) continue;
    // Secondary forks, which is what makes it read as coral and not a twig.
    for (let j = 1; j <= 2; j++) {
      const u = 0.45 + j * 0.22;
      const px = s.x + dir * s.width * 0.3 * u * 2;
      const py = s.y - h * u;
      const side = j % 2 === 0 ? 1 : -1;
      const f = take(4);
      f[0] = px; f[1] = py;
      f[2] = px + side * s.width * 0.3; f[3] = py - h * 0.22;
      k.line(f, s.width * 0.16, shadeHex(col, 1.08), 0.9 * a);
    }
  }
}

// --- flat vertical fan with radial ribs: sea fan, crinoid, hydroid, sea pen --
function fan(s: Strand, col: number, o: FloraDrawOpts, k: FloraSink, a: number): void {
  const stalk = s.height * 0.25;
  const st = take(4);
  st[0] = s.x; st[1] = s.y;
  st[2] = s.x + s.lean * 0.3; st[3] = s.y - stalk;
  k.line(st, s.width * 0.18, shadeHex(col, 0.8), 0.95 * a);

  const cx = s.x + s.lean * 0.3;
  const cy = s.y - stalk;
  const r = s.height - stalk;
  const half = s.width * 0.75;
  const ribs = o.detail > 0.4 ? 7 : 4;
  // Outline first so the ribs read against a body.
  const n = 9;
  const pts = take(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const ang = lerp(-1, 1, t);
    const sway = Math.sin(o.time * 0.8 + s.phase) * 0.12 * s.spec.sway;
    pts[i * 2] = cx + ang * half + sway * r;
    pts[i * 2 + 1] = cy - r * Math.cos(ang * 0.9) * (0.75 + 0.25 * Math.cos(ang * 2));
  }
  k.poly(pts, shadeHex(col, 0.78), 0.55 * a);
  for (let i = 0; i < ribs; i++) {
    const ang = lerp(-1, 1, i / (ribs - 1));
    const sway = Math.sin(o.time * 0.8 + s.phase) * 0.12 * s.spec.sway;
    const b = take(6);
    b[0] = cx; b[1] = cy;
    b[2] = cx + ang * half * 0.55 + sway * r * 0.4; b[3] = cy - r * 0.55;
    b[4] = cx + ang * half + sway * r; b[5] = cy - r * Math.cos(ang * 0.9) * (0.75 + 0.25 * Math.cos(ang * 2));
    k.line(b, s.width * 0.12, shadeHex(col, 1.12), 0.95 * a);
  }
}

// --- tapered cylinder with a dark osculum: barrel sponge, glass sponge -------
function barrel(s: Strand, col: number, o: FloraDrawOpts, k: FloraSink, a: number): void {
  const wB = s.width * 0.55;
  const wT = s.width * 0.42;
  const sway = Math.sin(o.time * 0.5 + s.phase) * 0.05 * s.spec.sway * s.height;
  const p = take(8);
  p[0] = s.x - wB; p[1] = s.y;
  p[2] = s.x + wB; p[3] = s.y;
  p[4] = s.x + wT + sway; p[5] = s.y - s.height;
  p[6] = s.x - wT + sway; p[7] = s.y - s.height;
  k.poly(p, col, 0.96 * a);
  // Lit side and the dark opening on top.
  const l = take(8);
  l[0] = s.x - wB; l[1] = s.y;
  l[2] = s.x - wB * 0.35; l[3] = s.y;
  l[4] = s.x - wT * 0.35 + sway; l[5] = s.y - s.height;
  l[6] = s.x - wT + sway; l[7] = s.y - s.height;
  k.poly(l, shadeHex(col, 1.18), 0.5 * a);
  k.disc(s.x + sway, s.y - s.height, Math.max(0.06, wT * 0.8), shadeHex(col, 0.42), 0.9 * a);
}

// --- cluster of vertical tubes: tube sponge, riftia tube worms ---------------
function tube(s: Strand, col: number, o: FloraDrawOpts, k: FloraSink, a: number): void {
  const n = 3 + Math.floor(hash2(s.id, 0, 23) * 4);
  for (let i = 0; i < n; i++) {
    const ox = (i / Math.max(1, n - 1) - 0.5) * s.width * 2.2;
    const h = s.height * lerp(0.55, 1, hash2(s.id, i, 29));
    const sway = Math.sin(o.time * 0.9 + s.phase + i) * 0.1 * s.spec.sway * h;
    // Tube worms grow straight out of the rock: no gap under any of them.
    const y = s.y + groundDy(s.ground, s.half, ox) + 0.04;
    const b = take(6);
    b[0] = s.x + ox; b[1] = y;
    b[2] = s.x + ox + sway * 0.4; b[3] = y - h * 0.6;
    b[4] = s.x + ox + sway; b[5] = y - h;
    k.line(b, s.width * 0.42, shadeHex(col, 0.88 + 0.24 * hash2(s.id, i, 31)), 0.96 * a);
    if (o.detail > 0.4) {
      // Red plume on tube worms, dark osculum on sponges.
      const tipCol = s.kind === "tube_worm" ? 0xc2342b : shadeHex(col, 0.45);
      k.disc(s.x + ox + sway, y - h, Math.max(0.05, s.width * 0.3), tipCol, 0.95 * a);
    }
  }
}

// --- low wide crust hugging the rock: turf, encrusting sponge, bacterial mat -
function mat(s: Strand, col: number, o: FloraDrawOpts, k: FloraSink, a: number): void {
  const w = s.width;
  const h = Math.max(0.04, s.height);
  const n = 7;
  const pts = take(n * 2 + 4);
  pts[0] = s.x - w; pts[1] = s.y + groundDy(s.ground, s.half, -w) + h * 0.4;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const dx = -w + 2 * w * t;
    pts[2 + i * 2] = s.x + dx;
    pts[3 + i * 2] = s.y + groundDy(s.ground, s.half, dx)
      - h * (0.55 + 0.45 * Math.sin(t * Math.PI)) * lerp(0.7, 1.3, hash2(s.id, i, 41));
  }
  pts[2 + n * 2] = s.x + w; pts[3 + n * 2] = s.y + groundDy(s.ground, s.half, w) + h * 0.4;
  k.poly(pts, col, 0.9 * a);
}

// --- radial body: urchin, anemone, xenophyophore -----------------------------
function ball(s: Strand, col: number, o: FloraDrawOpts, k: FloraSink, a: number): void {
  const r = Math.max(0.05, s.width * 0.5);
  const cy = s.y - r * 0.8;
  if (s.kind === "urchin" && o.detail > 0.3) {
    const spines = 11;
    for (let i = 0; i < spines; i++) {
      const ang = (i / spines) * Math.PI * 2;
      const len = r * lerp(1.5, 2.4, hash2(s.id, i, 43));
      const b = take(4);
      b[0] = s.x; b[1] = cy;
      b[2] = s.x + Math.cos(ang) * len; b[3] = cy + Math.sin(ang) * len * 0.8;
      k.line(b, r * 0.16, shadeHex(col, 0.75), 0.85 * a);
    }
  }
  if (s.kind === "anemone" && o.detail > 0.3) {
    const tent = 9;
    for (let i = 0; i < tent; i++) {
      const ang = Math.PI + (i / (tent - 1)) * Math.PI;
      const wob = Math.sin(o.time * 1.2 + s.phase + i * 0.7) * 0.18 * s.spec.sway;
      const len = r * lerp(1.1, 1.9, hash2(s.id, i, 47));
      const b = take(6);
      b[0] = s.x; b[1] = cy;
      b[2] = s.x + Math.cos(ang) * len * 0.6; b[3] = cy + Math.sin(ang) * len * 0.6;
      b[4] = s.x + Math.cos(ang + wob) * len; b[5] = cy + Math.sin(ang + wob) * len;
      k.line(b, r * 0.22, mixHex(col, 0xffffff, 0.25), 0.9 * a);
    }
  }
  k.disc(s.x, cy, r, col, 0.96 * a);
}
