/** Seeded Perlin-style gradient noise, plus the two fractal sums the world uses. */

import { makeRng, type Rng } from "./rng";

const GRAD: ReadonlyArray<readonly [number, number]> = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1],
];

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

export class Noise2D {
  private readonly p = new Uint8Array(512);

  constructor(seed: string | Rng) {
    const rng = typeof seed === "string" ? makeRng(seed) : seed;
    const perm = new Uint8Array(256);
    for (let i = 0; i < 256; i++) perm[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = rng.int(i + 1);
      const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
    }
    for (let i = 0; i < 512; i++) this.p[i] = perm[i & 255];
  }

  /** Roughly -1..1. */
  at(x: number, y: number): number {
    const xi = Math.floor(x), yi = Math.floor(y);
    const X = xi & 255, Y = yi & 255;
    const fx = x - xi, fy = y - yi;
    const u = fade(fx), v = fade(fy);
    const a = this.p[X] + Y, b = this.p[X + 1] + Y;
    const g00 = GRAD[this.p[a] & 7], g01 = GRAD[this.p[a + 1] & 7];
    const g10 = GRAD[this.p[b] & 7], g11 = GRAD[this.p[b + 1] & 7];
    const n00 = g00[0] * fx + g00[1] * fy;
    const n01 = g01[0] * fx + g01[1] * (fy - 1);
    const n10 = g10[0] * (fx - 1) + g10[1] * fy;
    const n11 = g11[0] * (fx - 1) + g11[1] * (fy - 1);
    const lo = n00 + u * (n10 - n00);
    const hi = n01 + u * (n11 - n01);
    return (lo + v * (hi - lo)) * 1.4142;
  }
}

/** Fractal sum. Smooth, signed, -1..1. Terrain rugosity and field variation. */
export function fbm(n: Noise2D, x: number, y: number, oct = 4, lac = 2, gain = 0.5): number {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * n.at(x * freq, y * freq);
    norm += amp;
    amp *= gain;
    freq *= lac;
  }
  return sum / norm;
}

/**
 * Ridged sum, 0..1, with high values along connected sheets rather than in blobs.
 * This is what makes caves read as *tunnels* you can swim through instead of
 * disconnected pockets -- the ridges of the field are naturally continuous.
 */
export function ridged(n: Noise2D, x: number, y: number, oct = 3, lac = 2, gain = 0.5): number {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    const v = 1 - Math.abs(n.at(x * freq, y * freq));
    sum += amp * v * v;
    norm += amp;
    amp *= gain;
    freq *= lac;
  }
  return sum / norm;
}
