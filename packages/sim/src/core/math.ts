/** Small math helpers shared by every world system. No allocation in hot paths. */

export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Hermite ramp from 0 at e0 to 1 at e1. The workhorse of this codebase. */
export function smoothstep(e0: number, e1: number, x: number): number {
  const d = e1 - e0;
  const t = clamp01(d === 0 ? (x >= e1 ? 1 : 0) : (x - e0) / d);
  return t * t * (3 - 2 * t);
}

/** Inverse-lerp, clamped. */
export function invLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : clamp01((v - a) / (b - a));
}

/**
 * Smooth bump: 1 at t=0, falling to 0 at |t|>=1. `power` shapes the shoulders --
 * low power is a plateau (flat canyon floor), high power is a spike (a chimney).
 */
export function bump(t: number, power = 1): number {
  const a = Math.abs(t);
  if (a >= 1) return 0;
  return Math.pow(1 - a * a, power);
}

/** A bell centred on `c` with `w` as its half-width at roughly 60% height. */
export function bell(x: number, c: number, w: number): number {
  const t = (x - c) / w;
  return Math.exp(-t * t);
}

/**
 * Piecewise curve through control points, smoothstepped between them.
 * Points must be sorted by x. This is how the macro seabed profile is authored:
 * a designer edits a handful of (distance, depth) pairs and the curve stays smooth.
 */
export function pwl(pts: readonly (readonly [number, number])[], x: number): number {
  const n = pts.length;
  if (n === 0) return 0;
  if (x <= pts[0][0]) return pts[0][1];
  if (x >= pts[n - 1][0]) return pts[n - 1][1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid][0] <= x) lo = mid;
    else hi = mid;
  }
  const [x0, y0] = pts[lo];
  const [x1, y1] = pts[hi];
  return lerp(y0, y1, smoothstep(x0, x1, x));
}

// ---------- colour helpers (packed 0xRRGGBB, shared by map raster and Pixi) ----------

export function mixHex(a: number, b: number, t: number): number {
  const k = clamp01(t);
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const r = Math.round(ar + (br - ar) * k);
  const g = Math.round(ag + (bg - ag) * k);
  const bl = Math.round(ab + (bb - ab) * k);
  return (r << 16) | (g << 8) | bl;
}

/** Sample a colour ramp defined as [position, colour] stops sorted by position. */
export function rampHex(stops: readonly (readonly [number, number])[], v: number): number {
  const n = stops.length;
  if (v <= stops[0][0]) return stops[0][1];
  if (v >= stops[n - 1][0]) return stops[n - 1][1];
  let i = 0;
  while (i < n - 2 && stops[i + 1][0] < v) i++;
  const [p0, c0] = stops[i];
  const [p1, c1] = stops[i + 1];
  return mixHex(c0, c1, (v - p0) / (p1 - p0));
}

/** Multiply brightness, clamped. f=1 is identity. */
export function shadeHex(c: number, f: number): number {
  const r = clamp(Math.round(((c >> 16) & 255) * f), 0, 255);
  const g = clamp(Math.round(((c >> 8) & 255) * f), 0, 255);
  const b = clamp(Math.round((c & 255) * f), 0, 255);
  return (r << 16) | (g << 8) | b;
}

/** Pack to a CSS hex string, for HTML legends. */
export function cssHex(c: number): string {
  return "#" + c.toString(16).padStart(6, "0");
}
