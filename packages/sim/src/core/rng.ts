/**
 * Deterministic randomness.
 *
 * Everything in packages/sim draws from one of these, seeded from the world seed.
 * `Math.random` is banned here (see tools/check-determinism.sh) so that a headless
 * ecosystem run is byte-identical on every replay -- which is what makes population
 * balancing tractable and bug reports reproducible.
 */

export interface Rng {
  /** Uniform in [0,1). */
  next(): number;
  /** Integer in [0,n). */
  int(n: number): number;
  /** Uniform in [a,b). */
  range(a: number, b: number): number;
  /** Normal-ish deviate, mean 0, sd 1 (sum of uniforms -- cheap and good enough). */
  normal(): number;
  /** True with probability p. */
  chance(p: number): boolean;
  /** Pick an element. */
  pick<T>(xs: readonly T[]): T;
  /**
   * A child stream, derived from this seed and a label. Independent sub-systems
   * fork their own stream so that adding a draw in one does not shift the others.
   */
  fork(label: string): Rng;
}

function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

function sfc32(a: number, b: number, c: number, d: number): () => number {
  return () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

export function makeRng(seed: string | number): Rng {
  const key = typeof seed === "number" ? `n:${seed}` : seed;
  const h = xmur3(key);
  const next = sfc32(h(), h(), h(), h());
  // Discard the first few draws; sfc32 needs a moment to mix.
  for (let i = 0; i < 12; i++) next();
  const self: Rng = {
    next,
    int: (n) => Math.floor(next() * n),
    range: (a, b) => a + next() * (b - a),
    normal: () => (next() + next() + next() + next() + next() + next() - 3) / 0.7071,
    chance: (p) => next() < p,
    pick: (xs) => xs[Math.floor(next() * xs.length)],
    fork: (label) => makeRng(`${key}/${label}`),
  };
  return self;
}

/**
 * Stateless spatial hash: the same (seed, x, y) always gives the same value in [0,1).
 * Used where a stream would be wrong -- a kelp strand must look the same whether the
 * player arrives from the left or the right, so its properties are hashed from its
 * position rather than drawn in traversal order.
 */
export function hash2(seed: number, x: number, y: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Stable 32-bit hash of a string. Used to derive a species' own random stream
 * from its NAME, so adding a species never shifts where the others grow.
 */
export function hashStr(str: string): number {
  return xmur3(str)();
}

export function hash1(seed: number, x: number): number {
  return hash2(seed, x, 0x9e37);
}
