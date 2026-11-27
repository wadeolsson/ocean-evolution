/**
 * Terrain as a signed density field.
 *
 * A heightmap cannot express a cave, a tunnel or an overhang, and the brief wants
 * all three. So the rock is defined implicitly: `density(x,y) > 0` is solid. That
 * single choice gets us overhangs and connected cave systems for free, and makes
 * collision two cheap samples (value for depth of penetration, gradient for the
 * push-out direction) instead of polygon intersection.
 *
 * Units are metres throughout. y is depth below the surface, increasing downward.
 */

import { clamp, clamp01, lerp, smoothstep } from "../core/math";
import { Noise2D, fbm } from "../core/noise";
import { CAVE_CELL, buildNet, caveDistance, type CaveNet } from "./caves";
import { macroBed, macroHardness, WORLD_DEPTH, WORLD_WIDTH } from "./profile";

/** One density unit is this many metres -- keeps the field roughly a true SDF. */
const DENSITY_SCALE = 28;

export interface Collision {
  /** True if the sample point is inside rock. */
  readonly hit: boolean;
  /** Metres of penetration (0 if clear). */
  readonly depth: number;
  /** Unit surface normal pointing out of the rock. */
  readonly nx: number;
  readonly ny: number;
}

export class Terrain {
  private readonly nBedCoarse: Noise2D;
  private readonly nBedFine: Noise2D;
  private readonly nRug: Noise2D;
  private readonly nHard: Noise2D;

  /** Generated cave networks, keyed by cell index. */
  private readonly nets = new Map<number, CaveNet | null>();

  constructor(readonly seed: string) {
    this.nBedCoarse = new Noise2D(`${seed}/bed-coarse`);
    this.nBedFine = new Noise2D(`${seed}/bed-fine`);
    this.nRug = new Noise2D(`${seed}/rugosity`);
    this.nHard = new Noise2D(`${seed}/hardness`);
  }

  /** Substrate hardness at x, 0 = mud, 1 = rock. */
  hardness(x: number): number {
    const base = macroHardness(x);
    const v = base + 0.18 * fbm(this.nHard, x / 760, 0.5, 3);
    return clamp01(v);
  }

  /**
   * Relief amplitude: rock is rugged, sand is smooth. Suppressed at the shoreline
   * so noise can never push the seabed above the waterline.
   */
  private reliefAmp(x: number): number {
    const h = macroHardness(x);
    const rugged = 5 + 48 * h * h;
    // Relief cannot exceed what the water column can hold: 48 m of boulders on a
    // 15 m reef crest would push rock through the surface and swamp the habitat
    // classification. Cap it against the macro depth.
    const headroom = 3 + 0.35 * macroBed(x);
    return Math.min(rugged, headroom) * smoothstep(0, 420, x);
  }

  /** Seabed depth at x, macro profile plus multi-scale relief. */
  bed(x: number): number {
    const amp = this.reliefAmp(x);
    const coarse = fbm(this.nBedCoarse, x / 430, 0.7, 4);
    const fine = fbm(this.nBedFine, x / 88, 3.3, 3);
    const d = macroBed(x) + amp * coarse + amp * 0.3 * fine;
    return clamp(d, 0.6, WORLD_DEPTH - 20);
  }

  /** Local seabed slope, metres of depth per metre of distance. */
  slope(x: number): number {
    const h = 6;
    return (this.bed(x + h) - this.bed(x - h)) / (2 * h);
  }

  /**
   * Signed density. Greater than 0 is solid rock, less than 0 is water,
   * 0 is the rock surface. Scaled so one unit is ~DENSITY_SCALE metres.
   */
  density(x: number, y: number): number {
    if (x < 0) return 1.6;                       // land to the west
    if (x > WORLD_WIDTH) return 1.6;             // closed eastern wall
    const bedY = this.bed(x);
    let d = (y - bedY) / DENSITY_SCALE;

    // Rugosity: boulders, ledges and overhangs, only near the rock surface so the
    // interior stays solid and the open water stays clear.
    const nearSurface = 1 - smoothstep(0, 3.0, Math.abs(d));
    const hard = this.hardness(x);
    const rug = fbm(this.nRug, x / 46, y / 46, 3) * (0.25 + 0.95 * hard);
    // Rugosity displaces the rock surface by up to ~25 m. On a reef crest sitting
    // in 8 m of water that pushed bare rock (and the coral growing on it) above
    // the waterline, so scale it by the water column actually available.
    const headroom = clamp01((bedY - 2.5) / 25);
    d += 0.9 * nearSurface * rug * headroom;

    // Caves: an explicit network of chambers and passages, not a noise
    // threshold. See caves.ts -- thresholded noise produced voids that were
    // mostly sealed off from the water, which in a side view means they can
    // never be entered at all.
    //
    // Subtracted as a true distance (CSG difference, min of the two fields) so
    // the result stays an approximate SDF and collision still works inside a
    // passage. A little noise on the wall keeps them from looking like pipes.
    const caveM = caveDistance(this.netsNear(x), x, y);
    if (caveM < 80) {
      const wob = 1.7 * fbm(this.nRug, x / 8.5, y / 8.5, 2);
      // Faded out over the last 20 m rather than cut off, so the edge of a
      // network's influence is not a visible straight line in the rock.
      const w = 1 - smoothstep(60, 80, caveM);
      d = lerp(d, Math.min(d, (caveM + wob) / DENSITY_SCALE), w);
    }
    return d;
  }

  /**
   * The cave networks that could possibly reach x. A network is clamped to
   * within 0.8 cells of its own anchor, so three cells always covers it.
   */
  private netsNear(x: number): readonly (CaveNet | null)[] {
    const c = Math.floor(x / CAVE_CELL);
    this.scratch[0] = this.net(c - 1);
    this.scratch[1] = this.net(c);
    this.scratch[2] = this.net(c + 1);
    return this.scratch;
  }

  private readonly scratch: (CaveNet | null)[] = [null, null, null];

  private net(cell: number): CaveNet | null {
    let n = this.nets.get(cell);
    if (n === undefined) {
      // bed() and hardness() never consult the density field, so this cannot
      // recurse back into density().
      n = buildNet(this.seed, cell, (xx) => this.bed(xx), (xx) => this.hardness(xx));
      if (this.nets.size > 4_096) this.nets.clear();
      this.nets.set(cell, n);
    }
    return n;
  }

  /** The cave network nearest x, for tooling and later for AI den placement. */
  caveAt(x: number): CaveNet | null {
    return this.net(Math.floor(x / CAVE_CELL));
  }

  /** Approximate signed distance to rock in metres. Negative in water. */
  sdf(x: number, y: number): number {
    return this.density(x, y) * DENSITY_SCALE;
  }

  solid(x: number, y: number): boolean {
    return this.density(x, y) > 0;
  }

  /** Numeric gradient of the density field; points into the rock. */
  gradient(x: number, y: number, h = 1.2): { x: number; y: number } {
    const gx = this.density(x + h, y) - this.density(x - h, y);
    const gy = this.density(x, y + h) - this.density(x, y - h);
    const len = Math.hypot(gx, gy) || 1e-6;
    return { x: gx / len, y: gy / len };
  }

  /**
   * Collision query for a creature of the given radius. Returns how far it has
   * penetrated and the direction to push it out. Cheap enough to call per-creature
   * per-step for a few thousand creatures.
   */
  collide(x: number, y: number, radius: number): Collision {
    const dist = this.sdf(x, y);
    if (dist > radius) return { hit: false, depth: 0, nx: 0, ny: 0 };
    const g = this.gradient(x, y);
    return { hit: true, depth: radius - dist, nx: -g.x, ny: -g.y };
  }

  /**
   * The true rock surface at x, which rugosity moves away from the smooth bed
   * curve. Coarse scan then bisection -- called once per flora/scatter instance,
   * so it must not be a fine linear scan.
   */
  surfaceAt(x: number): number {
    const bedY = this.bed(x);
    let lo = bedY - 30;
    const hi0 = bedY + 30;
    if (this.density(x, lo) > 0) return lo;
    let hi = hi0;
    let found = false;
    for (let y = lo + 1.2; y <= hi0; y += 1.2) {
      if (this.density(x, y) > 0) { hi = y; lo = y - 1.2; found = true; break; }
    }
    if (!found) return bedY;
    for (let i = 0; i < 5; i++) {
      const mid = (lo + hi) * 0.5;
      if (this.density(x, mid) > 0) hi = mid; else lo = mid;
    }
    return hi;
  }

  /** Height of a point above the local seabed (negative when buried). */
  heightAboveBed(x: number, y: number): number {
    return this.bed(x) - y;
  }

  /**
   * Walk down a column and return the water/rock crossings, surface-first.
   * The renderer draws rock as filled vertical spans from this, which handles
   * caves and overhangs correctly without any polygon stitching.
   */
  columnSpans(x: number, yTop: number, yBottom: number, step = 2): Array<[number, number]> {
    const spans: Array<[number, number]> = [];
    let prev = this.density(x, yTop);
    let openAt = prev > 0 ? yTop : NaN;
    for (let y = yTop + step; y <= yBottom; y += step) {
      const cur = this.density(x, y);
      if (prev <= 0 && cur > 0) {
        openAt = lerp(y - step, y, prev / (prev - cur)); // entering rock
      } else if (prev > 0 && cur <= 0) {
        const close = lerp(y - step, y, prev / (prev - cur));
        if (!Number.isNaN(openAt)) spans.push([openAt, close]);
        openAt = NaN;
      }
      prev = cur;
    }
    if (!Number.isNaN(openAt)) spans.push([openAt, yBottom]);
    return spans;
  }
}
