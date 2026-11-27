/**
 * The world object: terrain, fields and classification behind one façade.
 *
 * Deliberately contains no rendering, no DOM and no creature state. The agent,
 * region and field layers from the architecture will all hang off this, and the
 * headless balancing harness constructs exactly the same object the game does.
 */

import { Clock } from "../core/clock";
import { makeRng, type Rng } from "../core/rng";
import { BIOMES, classify, type BiomeId, type BiomeInfo } from "./biome";
import { EnvField, type EnvSample } from "./env";
import { strandsIn, type Strand } from "./flora";
import { scatterIn, type ScatterPiece } from "./scatter";
import { FEATURES, featureAt, WORLD_DEPTH, WORLD_WIDTH, type GeoFeature } from "./profile";
import { Terrain } from "./terrain";

export interface WorldOptions {
  readonly seed?: string;
}

export class World {
  readonly seed: string;
  readonly width = WORLD_WIDTH;
  readonly maxDepth = WORLD_DEPTH;
  readonly terrain: Terrain;
  readonly env: EnvField;
  readonly clock: Clock;
  readonly rng: Rng;
  readonly features: readonly GeoFeature[] = FEATURES;

  constructor(opts: WorldOptions = {}) {
    this.seed = opts.seed ?? "ocean-01";
    this.rng = makeRng(this.seed);
    this.terrain = new Terrain(this.seed);
    this.env = new EnvField(this.terrain, this.seed);
    this.clock = new Clock();
  }

  sample(x: number, y: number, t = 0): EnvSample {
    return this.env.sample(x, y, t);
  }

  biomeAt(x: number, y: number, t = 0): BiomeId {
    return classify(x, this.env.sample(x, y, t));
  }

  biomeInfo(x: number, y: number): BiomeInfo {
    return BIOMES[this.biomeAt(x, y)];
  }

  featureAt(x: number): GeoFeature | undefined {
    return featureAt(x);
  }

  /** Flora rooted in a horizontal window. Stable and repeatable, see flora.ts. */
  strands(xMin: number, xMax: number): Strand[] {
    return strandsIn(
      this.terrain,
      (x, y) => this.biomeAt(x, y),
      (x, y) => this.env.current(x, y, 0).x,
      xMin,
      xMax,
    );
  }

  /** Boulders, rubble, outcrops and set-pieces in a window. Static, see scatter.ts. */
  scatter(xMin: number, xMax: number): ScatterPiece[] {
    return scatterIn(this.terrain, (x, y) => this.biomeAt(x, y), xMin, xMax);
  }

  /** Human-readable probe, for the HUD and for debugging generation by hand. */
  describe(x: number, y: number): string {
    const e = this.sample(x, y);
    const b = BIOMES[classify(x, e)];
    const f = featureAt(x);
    const parts = [
      `${(x / 1000).toFixed(2)} km, ${y.toFixed(0)} m deep`,
      f ? f.name : "open water",
      b.name,
      `${e.temperature.toFixed(1)} C`,
      `light ${(e.light * 100).toFixed(1)}%`,
      `O2 ${(e.oxygen * 100).toFixed(0)}%`,
      `plankton ${(e.plankton * 100).toFixed(0)}%`,
      `current ${e.currentX >= 0 ? "+" : ""}${e.currentX.toFixed(2)} m/s`,
    ];
    return parts.join("  |  ");
  }
}
