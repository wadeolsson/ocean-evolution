/**
 * The environmental field stack: light, temperature, pressure, oxygen, nutrients,
 * current and plankton density.
 *
 * These are the Layer-0 globals from the architecture. Right now they are analytic
 * functions of position, which is enough to drive terrain classification and to
 * place food plausibly. Phase 2 replaces plankton and nutrients with an actual
 * advection-diffusion grid stepped by the clock; everything that reads them goes
 * through `sampleEnv`, so that swap does not touch any call site.
 */

import { bell, clamp01, lerp, smoothstep } from "../core/math";
import { Noise2D, fbm } from "../core/noise";
import { surfaceTemperature, upwelling } from "./profile";
import type { Terrain } from "./terrain";

export interface EnvSample {
  /** Depth below the surface, metres. */
  depth: number;
  /** Height above the local seabed, metres. Negative inside rock. */
  heightAboveBed: number;
  /** Fraction of surface irradiance reaching this depth, 0..1. */
  light: number;
  /** Degrees C. */
  temperature: number;
  /** Atmospheres. */
  pressure: number;
  /** Dissolved oxygen saturation, 0..1. Dips in the midwater minimum zone. */
  oxygen: number;
  /** Nutrient concentration, 0..1. High in upwelling and at depth. */
  nutrients: number;
  /** Substrate hardness of the seabed below, 0..1. */
  hardness: number;
  /** Seabed slope, depth-metres per horizontal metre. */
  slope: number;
  /** Horizontal and vertical current, metres per second. */
  currentX: number;
  currentY: number;
  /** Plankton biomass density, 0..1 of the world maximum. */
  plankton: number;
  /** How far you can see here, metres. */
  visibility: number;
}

export class EnvField {
  private readonly nCurrent: Noise2D;
  private readonly nPlankton: Noise2D;

  constructor(private readonly terrain: Terrain, seed: string) {
    this.nCurrent = new Noise2D(`${seed}/current`);
    this.nPlankton = new Noise2D(`${seed}/plankton`);
  }

  /** Surface-normalised irradiance. Euphotic zone runs out around 200m. */
  light(depth: number): number {
    return Math.exp(-depth / 58);
  }

  temperature(x: number, depth: number): number {
    const surface = surfaceTemperature(x);
    const thermocline = 1 - smoothstep(30, 400, depth);
    const deep = 2.8 - 0.4 * smoothstep(1_200, 2_600, depth);
    return lerp(deep, surface, thermocline);
  }

  pressure(depth: number): number {
    return 1 + depth / 10;
  }

  /** Oxygen minimum zone centred around 650m -- a real barrier for many species. */
  oxygen(x: number, depth: number): number {
    const base = 0.97 - 0.22 * smoothstep(0, 1_200, depth);
    const omz = 0.60 * bell(depth, 650, 300);
    const recovery = 0.12 * smoothstep(1_100, 2_500, depth);
    return clamp01(base - omz + recovery);
  }

  nutrients(x: number, depth: number): number {
    const fromDepth = smoothstep(60, 900, depth) * 0.8;
    const fromUpwelling = upwelling(x) * (1 - smoothstep(0, 220, depth)) * 0.7;
    const surfaceDepleted = 1 - 0.55 * (1 - smoothstep(0, 70, depth));
    return clamp01((0.2 + fromDepth + fromUpwelling) * surfaceDepleted);
  }

  /**
   * Current. Shoreward-flowing at the surface, a return flow at depth, deflected
   * along the seabed, with slow eddies from noise. Plankton drifts on this.
   */
  current(x: number, y: number, t = 0): { x: number; y: number } {
    const depth = y;
    const surfaceDrift = 0.42 * (1 - smoothstep(10, 180, depth));
    const returnFlow = -0.16 * smoothstep(200, 700, depth) * (1 - smoothstep(1_400, 2_300, depth));
    const eddyX = 0.14 * fbm(this.nCurrent, x / 900, y / 420 + t * 0.004, 3);
    const eddyY = 0.09 * fbm(this.nCurrent, x / 900 + 31.7, y / 420 + t * 0.004, 3);

    let cx = surfaceDrift + returnFlow + eddyX;
    let cy = eddyY;

    // Upwelling at the west end lifts water (and nutrients) up the shelf.
    cy -= 0.12 * upwelling(x) * (1 - smoothstep(0, 300, depth));

    // Deflect flow to run parallel to the seabed near the bottom.
    const hab = this.terrain.heightAboveBed(x, y);
    const nearBed = 1 - clamp01(hab / 45);
    if (nearBed > 0) {
      const s = this.terrain.slope(x);
      cy = lerp(cy, cx * s, nearBed * 0.8);
      cx *= lerp(1, 0.45, nearBed);
    }
    return { x: cx, y: cy };
  }

  /**
   * Plankton density, the base of the entire food web.
   * Peaks in the lit, nutrient-fed layer; a deep chlorophyll maximum sits just
   * below the mixed layer; vents support a chemosynthetic patch in the dark.
   */
  plankton(x: number, y: number): number {
    const depth = y;
    const lit = this.light(depth);
    const nut = this.nutrients(x, depth);
    const productive = Math.pow(lit, 0.45) * (0.35 + 0.95 * nut);
    const dcm = 0.5 * bell(depth, 72, 46) * (0.4 + nut);
    const patchiness = 0.55 + 0.45 * fbm(this.nPlankton, x / 520, y / 240, 3);
    const base = clamp01((productive + dcm) * patchiness);

    // Detrital rain and vent chemosynthesis keep the deep from being sterile.
    const marineSnow = 0.06 * smoothstep(200, 1_200, depth);
    return clamp01(base + marineSnow);
  }

  /** 0 in daylight, 1 in the aphotic zone. Drives bioluminescence. */
  darkness(depth: number): number {
    return 1 - smoothstep(0.0015, 0.12, this.light(depth));
  }

  /**
   * Visual range in metres.
   *
   * Two independent things limit it and they pull opposite ways down the water
   * column: how murky the water is (plankton and sediment scatter light) and
   * how much light there is at all. Productive shallow water is bright but
   * soupy; the abyss is pin-clear and pitch black. A single "it gets darker
   * with depth" curve cannot express that, and the difference is exactly what
   * makes the two places feel unlike each other.
   */
  visibility(x: number, y: number): number {
    const lit = this.light(y);
    const turbidity = 0.3 + 1.6 * this.plankton(x, y);
    const clearRange = 70 / turbidity;
    // A floor, not zero: in the aphotic zone you are seeing by biolumuminescence
    // and dark adaptation, not by sunlight.
    const litFactor = 0.17 + 0.83 * smoothstep(0.001, 0.14, lit);
    return clearRange * litFactor;
  }

  sample(x: number, y: number, t = 0): EnvSample {
    const depth = y;
    const cur = this.current(x, y, t);
    return {
      depth,
      heightAboveBed: this.terrain.heightAboveBed(x, y),
      light: this.light(depth),
      temperature: this.temperature(x, depth),
      pressure: this.pressure(depth),
      oxygen: this.oxygen(x, depth),
      nutrients: this.nutrients(x, depth),
      hardness: this.terrain.hardness(x),
      slope: this.terrain.slope(x),
      currentX: cur.x,
      currentY: cur.y,
      plankton: this.plankton(x, y),
      visibility: this.visibility(x, y),
    };
  }
}
