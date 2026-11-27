/**
 * Benthic flora and sessile fauna, derived from position rather than spawned.
 *
 * A kelp strand is not stored anywhere. It is derived from its own x position,
 * so the renderer asks "what grows between x=1200 and x=1400?" and gets the same
 * answer every time, from either direction, on any machine. That is what lets a
 * 20 km world carry dense vegetation with no world state at all.
 *
 * ECOLOGY NOTE, because it drives the whole food system:
 * almost none of this is directly edible. In the real ocean ~95% of the primary
 * production that anything eats is phytoplankton. Living kelp is grazed by
 * almost nothing; kelp forests feed the sea by *shedding* detritus. Seagrass is
 * grazed, but most of that pressure lands on the epiphyte film growing on the
 * blades rather than the blades. Coral and sponges are animals and are eaten by
 * a handful of specialists.
 *
 * So each species carries three separate numbers:
 *   `edible`    direct food value (zero for most things here)
 *   `epiphyte`  the regenerating grazeable film on its surface -- this is what
 *               Tier-1 grazers actually live on
 *   `detritus`  what it sheds into the water column, which feeds the plankton
 *               and detritus fields downstream and downslope
 * plus `shelter` and `currentDamping`, which are why flora matters even when it
 * is not food at all.
 */

import { clamp, clamp01, lerp, smoothstep } from "../core/math";
import { hash2, hashStr } from "../core/rng";
import type { BiomeId } from "./biome";
import type { Terrain } from "./terrain";

export type FloraKind =
  // cold shallow rock
  | "giant_kelp" | "bull_kelp" | "red_algae" | "surfgrass"
  // soft shallow bottom
  | "seagrass" | "algal_turf" | "sea_lettuce"
  // warm reef
  | "staghorn_coral" | "brain_coral" | "sea_fan" | "soft_coral" | "anemone" | "urchin"
  // temperate hard bottom
  | "barrel_sponge" | "tube_sponge" | "encrusting_sponge" | "hydroid"
  // deep water
  | "glass_sponge" | "bamboo_coral" | "black_coral" | "crinoid"
  // chemosynthetic
  | "tube_worm" | "vent_mussel" | "bacterial_mat"
  // abyssal mud
  | "sea_pen" | "xenophyophore";

/** How an instance is drawn. See floraDraw.ts. */
export type FloraForm =
  | "stipe"   // long flexible stem with blades (kelp)
  | "blade"   // tuft of short flexible blades (grass, turf)
  | "clump"   // lumpy head of overlapping lobes (massive coral, mussels)
  | "branch"  // branching antler structure (staghorn, bamboo, black coral)
  | "fan"     // flat vertical fan with radial ribs (sea fan, crinoid)
  | "barrel"  // tapered cylinder with a dark osculum (barrel sponge)
  | "tube"    // cluster of vertical tubes (tube sponge, tube worms)
  | "mat"     // low wide crust hugging the rock
  | "ball";   // radial body, optionally spined (urchin, anemone)

export interface FloraSpec {
  readonly kind: FloraKind;
  readonly name: string;
  readonly form: FloraForm;
  readonly color: number;
  readonly minHeight: number;
  readonly maxHeight: number;
  /** Base width in metres (stem thickness for stipes, body width otherwise). */
  readonly width: number;
  /** Horizontal lean at the tip, metres. */
  readonly lean: number;
  /** 0 rigid, 1 very flexible. */
  readonly sway: number;
  /** Direct food value per instance. 0 means structure only. */
  readonly edible: number;
  /** Grazeable epiphyte / detritus film, 0..1. */
  readonly epiphyte: number;
  /** Shelter for small creatures, 0..1. */
  readonly shelter: number;
  /** Local current damping, 0..1. */
  readonly currentDamping: number;
  /** Detritus shed into the water column, 0..1. */
  readonly detritus: number;
  /** Bioluminescence, 0..1. Most things do not glow; in the deep it matters. */
  readonly glow: number;
}

const S = (
  kind: FloraKind, name: string, form: FloraForm, color: number,
  minHeight: number, maxHeight: number, width: number, lean: number, sway: number,
  edible: number, epiphyte: number, shelter: number, currentDamping: number, detritus: number,
  glow = 0,
): FloraSpec => ({ kind, name, form, color, minHeight, maxHeight, width, lean, sway, edible, epiphyte, shelter, currentDamping, detritus, glow });

export const FLORA: Readonly<Record<FloraKind, FloraSpec>> = {
  //                                                        h_min h_max  w    lean sway  eat  epi  shel damp detr
  giant_kelp:        S("giant_kelp", "Giant kelp", "stipe", 0x4a7c2f, 12, 36, 0.55, 5.5, 1.0, 0.02, 0.55, 0.95, 0.85, 0.90),
  bull_kelp:         S("bull_kelp", "Bull kelp", "stipe", 0x5f8a33, 8, 24, 0.75, 3.0, 0.8, 0.02, 0.45, 0.70, 0.60, 0.70),
  red_algae:         S("red_algae", "Red algae", "blade", 0x9c3f55, 0.4, 1.6, 0.3, 0.6, 0.9, 0.25, 0.70, 0.45, 0.25, 0.40),
  surfgrass:         S("surfgrass", "Surfgrass", "blade", 0x5d9a3c, 0.5, 1.4, 0.18, 0.9, 1.0, 0.30, 0.80, 0.50, 0.30, 0.35),

  seagrass:          S("seagrass", "Seagrass", "blade", 0x76a83f, 0.8, 3.2, 0.22, 1.3, 1.0, 0.35, 0.95, 0.65, 0.45, 0.55),
  algal_turf:        S("algal_turf", "Algal turf", "mat", 0x6d8f3a, 0.1, 0.3, 1.1, 0, 0.2, 0.45, 1.00, 0.10, 0.05, 0.20),
  sea_lettuce:       S("sea_lettuce", "Sea lettuce", "blade", 0x8fc65a, 0.2, 0.7, 0.4, 0.5, 1.0, 0.55, 0.65, 0.15, 0.05, 0.30),

  staghorn_coral:    S("staghorn_coral", "Staghorn coral", "branch", 0xd98f6a, 0.6, 3.4, 1.6, 0, 0.0, 0.0, 0.30, 0.95, 0.55, 0.15),
  brain_coral:       S("brain_coral", "Brain coral", "clump", 0xcf9a5e, 0.4, 2.2, 2.2, 0, 0.0, 0.0, 0.25, 0.35, 0.30, 0.10),
  sea_fan:           S("sea_fan", "Sea fan", "fan", 0xd1566b, 0.6, 2.8, 1.8, 0, 0.35, 0.0, 0.20, 0.40, 0.35, 0.10),
  soft_coral:        S("soft_coral", "Soft coral", "clump", 0xe08aa0, 0.3, 1.5, 1.2, 0, 0.5, 0.0, 0.25, 0.35, 0.20, 0.15),
  anemone:           S("anemone", "Anemone", "ball", 0xe2a05c, 0.2, 0.8, 0.7, 0, 0.6, 0.0, 0.15, 0.45, 0.05, 0.05),
  urchin:            S("urchin", "Urchin", "ball", 0x3b2f4a, 0.1, 0.35, 0.4, 0, 0.0, 0.0, 0.05, 0.10, 0.02, 0.05),

  barrel_sponge:     S("barrel_sponge", "Barrel sponge", "barrel", 0xb8743f, 0.5, 2.4, 1.3, 0, 0.0, 0.0, 0.10, 0.55, 0.25, 0.08),
  tube_sponge:       S("tube_sponge", "Tube sponge", "tube", 0xc98a5a, 0.4, 1.8, 0.8, 0, 0.1, 0.0, 0.12, 0.45, 0.15, 0.08),
  encrusting_sponge: S("encrusting_sponge", "Encrusting sponge", "mat", 0xd2a24e, 0.05, 0.2, 1.4, 0, 0.0, 0.0, 0.08, 0.05, 0.02, 0.05),
  hydroid:           S("hydroid", "Hydroid", "fan", 0xbfae8a, 0.2, 0.9, 0.6, 0, 0.5, 0.0, 0.20, 0.25, 0.10, 0.08),

  glass_sponge:      S("glass_sponge", "Glass sponge", "barrel", 0xd8e4ea, 0.6, 3.2, 0.9, 0, 0.0, 0.0, 0.06, 0.60, 0.30, 0.05),
  bamboo_coral:      S("bamboo_coral", "Bamboo coral", "branch", 0xe0d6c0, 0.5, 2.6, 1.1, 0, 0.15, 0.0, 0.10, 0.55, 0.25, 0.05),
  black_coral:       S("black_coral", "Black coral", "branch", 0x5b5248, 0.7, 3.0, 1.4, 0, 0.2, 0.0, 0.12, 0.60, 0.30, 0.05),
  crinoid:           S("crinoid", "Crinoid", "fan", 0xc08a6a, 0.3, 1.2, 0.7, 0, 0.45, 0.0, 0.15, 0.25, 0.08, 0.05, 0.30),

  tube_worm:         S("tube_worm", "Riftia tube worms", "tube", 0xe8e2d8, 0.5, 2.6, 0.35, 0.4, 0.35, 0.0, 0.35, 0.50, 0.20, 0.25),
  vent_mussel:       S("vent_mussel", "Vent mussels", "clump", 0x4a4238, 0.1, 0.4, 0.9, 0, 0.0, 0.0, 0.20, 0.25, 0.05, 0.10),
  bacterial_mat:     S("bacterial_mat", "Bacterial mat", "mat", 0xe6dca8, 0.03, 0.12, 2.0, 0, 0.0, 0.30, 1.00, 0.05, 0.02, 0.35),

  sea_pen:           S("sea_pen", "Sea pen", "fan", 0xa88ea0, 0.5, 2.0, 0.5, 0.5, 0.7, 0.0, 0.10, 0.20, 0.05, 0.05, 0.75),
  xenophyophore:     S("xenophyophore", "Xenophyophore", "ball", 0x8d8574, 0.1, 0.4, 0.6, 0, 0.0, 0.0, 0.15, 0.15, 0.02, 0.05),
};

/** One species' presence in a habitat. */
interface Planting {
  readonly kind: FloraKind;
  /** Mean metres between candidate roots. */
  readonly spacing: number;
  /** Fraction of candidates that actually grow. */
  readonly density: number;
}

/**
 * Habitat communities. Each biome holds a *mixed assemblage*, not one species:
 * a single rule per biome made every kelp forest in the world identical.
 */
const COMMUNITIES: Partial<Record<BiomeId, readonly Planting[]>> = {
  coastal_shallows: [
    { kind: "surfgrass", spacing: 1.1, density: 0.55 },
    { kind: "red_algae", spacing: 2.0, density: 0.45 },
    { kind: "algal_turf", spacing: 2.6, density: 0.5 },
    { kind: "anemone", spacing: 9, density: 0.3 },
  ],
  kelp_forest: [
    { kind: "giant_kelp", spacing: 2.4, density: 0.78 },
    { kind: "bull_kelp", spacing: 8, density: 0.45 },
    { kind: "red_algae", spacing: 1.8, density: 0.55 },
    { kind: "urchin", spacing: 7, density: 0.35 },
    { kind: "encrusting_sponge", spacing: 11, density: 0.3 },
  ],
  seagrass_meadow: [
    { kind: "seagrass", spacing: 0.7, density: 0.85 },
    { kind: "sea_lettuce", spacing: 3.2, density: 0.4 },
    { kind: "algal_turf", spacing: 4.0, density: 0.35 },
  ],
  sandy_seabed: [
    { kind: "sea_pen", spacing: 13, density: 0.3 },
    { kind: "anemone", spacing: 17, density: 0.25 },
  ],
  rocky_reef: [
    { kind: "barrel_sponge", spacing: 7, density: 0.35 },
    { kind: "tube_sponge", spacing: 5, density: 0.4 },
    { kind: "encrusting_sponge", spacing: 3.2, density: 0.45 },
    { kind: "hydroid", spacing: 4.0, density: 0.35 },
    { kind: "red_algae", spacing: 5, density: 0.3 },
  ],
  coral_reef: [
    { kind: "staghorn_coral", spacing: 2.6, density: 0.6 },
    { kind: "brain_coral", spacing: 4.5, density: 0.5 },
    { kind: "sea_fan", spacing: 5.0, density: 0.45 },
    { kind: "soft_coral", spacing: 3.4, density: 0.5 },
    { kind: "anemone", spacing: 6, density: 0.35 },
    { kind: "algal_turf", spacing: 3.0, density: 0.4 },
  ],
  reef_dropoff: [
    { kind: "sea_fan", spacing: 4.0, density: 0.5 },
    { kind: "tube_sponge", spacing: 6, density: 0.35 },
    { kind: "soft_coral", spacing: 5.5, density: 0.35 },
    { kind: "black_coral", spacing: 12, density: 0.25 },
  ],
  shelf_edge: [
    { kind: "sea_fan", spacing: 9, density: 0.3 },
    { kind: "barrel_sponge", spacing: 12, density: 0.25 },
    { kind: "crinoid", spacing: 7, density: 0.3 },
  ],
  continental_slope: [
    { kind: "glass_sponge", spacing: 9, density: 0.3 },
    { kind: "bamboo_coral", spacing: 13, density: 0.25 },
    { kind: "crinoid", spacing: 8, density: 0.3 },
    { kind: "sea_pen", spacing: 11, density: 0.25 },
  ],
  deep_canyon: [
    { kind: "glass_sponge", spacing: 6, density: 0.42 },
    { kind: "black_coral", spacing: 9, density: 0.3 },
    { kind: "bamboo_coral", spacing: 8, density: 0.3 },
    { kind: "crinoid", spacing: 6, density: 0.35 },
  ],
  seamount_flank: [
    { kind: "glass_sponge", spacing: 5, density: 0.45 },
    { kind: "bamboo_coral", spacing: 6, density: 0.4 },
    { kind: "black_coral", spacing: 7, density: 0.35 },
    { kind: "crinoid", spacing: 5, density: 0.4 },
  ],
  hydrothermal_vent: [
    { kind: "tube_worm", spacing: 1.2, density: 0.65 },
    { kind: "vent_mussel", spacing: 2.0, density: 0.55 },
    { kind: "bacterial_mat", spacing: 2.4, density: 0.6 },
  ],
  abyssal_plain: [
    { kind: "sea_pen", spacing: 18, density: 0.28 },
    { kind: "xenophyophore", spacing: 9, density: 0.35 },
    { kind: "glass_sponge", spacing: 40, density: 0.2 },
  ],
};

export interface Strand {
  readonly kind: FloraKind;
  readonly spec: FloraSpec;
  /** Root position. */
  readonly x: number;
  readonly y: number;
  readonly height: number;
  readonly width: number;
  readonly lean: number;
  /** Sway phase offset, radians. */
  readonly phase: number;
  /** Per-instance colour jitter, -1..1. */
  readonly tint: number;
  /** Stable per-instance id, for later per-instance state (grazing depletion). */
  readonly id: number;
  /**
   * Horizontal current at this instance, m/s. Flora bends downstream and sways
   * harder in fast water: the current field already existed and drove nothing
   * you could see, which is most of why a still ocean looked still.
   */
  readonly flow: number;
  /** Half-width of the footprint the body occupies, metres. */
  readonly half: number;
  /** Rock surface across that footprint, relative to the root. See groundDy(). */
  readonly ground: readonly number[];
}

const EMPTY_GROUND: readonly number[] = [];

/**
 * A species' random stream is derived from its NAME, not from the order it was
 * declared in. With an incrementing counter, adding one species renumbered
 * every species after it and silently relocated every instance in the world --
 * adding vent chimneys moved every boulder and deleted both whale falls.
 */
const SALT = new Map<FloraKind, number>();
function saltFor(kind: FloraKind): number {
  let v = SALT.get(kind);
  if (v === undefined) { v = hashStr(`flora/${kind}`) >>> 1; SALT.set(kind, v); }
  return v;
}

/**
 * Each species is planted on ONE global grid, at its finest spacing anywhere in
 * the world, and then thinned per habitat. That matters for two reasons:
 *
 *  - the grid index derives from absolute x, so an instance's existence does not
 *    depend on the window it was queried with. An earlier version built habitat
 *    runs clipped to the query range, which meant asking for [13000,13500] and
 *    [0,20000] produced different plants in the same place.
 *  - a species living in two habitats with different densities keeps one stable
 *    grid, so crossing a habitat boundary thins the population instead of
 *    resampling it into a completely different set of plants.
 */
const BASE_SPACING: Partial<Record<FloraKind, number>> = {};
function baseSpacing(kind: FloraKind): number {
  let v = BASE_SPACING[kind];
  if (v === undefined) {
    v = Infinity;
    for (const community of Object.values(COMMUNITIES)) {
      for (const p of community ?? []) if (p.kind === kind) v = Math.min(v, p.spacing);
    }
    if (!Number.isFinite(v)) v = 8;
    BASE_SPACING[kind] = v;
  }
  return v;
}

const ALL_KINDS: FloraKind[] = [];
function allPlantedKinds(): FloraKind[] {
  if (ALL_KINDS.length === 0) {
    const seen = new Set<FloraKind>();
    for (const community of Object.values(COMMUNITIES)) {
      for (const p of community ?? []) seen.add(p.kind);
    }
    ALL_KINDS.push(...seen);
  }
  return ALL_KINDS;
}

function plantingFor(biome: BiomeId, kind: FloraKind): Planting | undefined {
  const community = COMMUNITIES[biome];
  if (!community) return undefined;
  for (const p of community) if (p.kind === kind) return p;
  return undefined;
}

/**
 * A short profile of the rock surface across an instance's own footprint,
 * relative to its root. Multi-part bodies (grass tufts, boulder bases, basalt
 * columns, tube-worm clusters) place every part at the root's y without this,
 * so on any slope the outer parts hang in open water with no bottom.
 */
export function sampleFootprint(
  surfaceOf: (x: number) => number,
  x: number,
  half: number,
  n = 5,
): number[] {
  const y0 = surfaceOf(x);
  const out: number[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = surfaceOf(footprintX(x, half, n, i)) - y0;
  return out;
}

/**
 * Where footprint sample `i` sits. Shared so a caller checking a profile
 * computes bit-identical positions: near a cave mouth an epsilon difference in
 * x puts the surface probe on the other side of the opening, which moves the
 * answer by a metre.
 */
export function footprintX(x: number, half: number, n: number, i: number): number {
  return x - half + 2 * half * (i / (n - 1));
}

/** Interpolate a footprint profile at an offset from the root. */
export function groundDy(ground: readonly number[] | undefined, half: number, dx: number): number {
  if (!ground || ground.length < 2 || half <= 0) return 0;
  const t = clamp(((dx + half) / (2 * half)), 0, 1);
  const f = t * (ground.length - 1);
  const i = Math.min(ground.length - 2, Math.floor(f));
  return lerp(ground[i], ground[i + 1], f - i);
}

/** Surface probe memoised on a 0.25 m grid; it is the expensive part of planting. */
function surfaceLookup(terrain: Terrain) {
  const Q = 0.25;
  const cache = new Map<number, number>();
  return (x: number): number => {
    const key = Math.round(x / Q);
    let v = cache.get(key);
    if (v === undefined) { v = terrain.surfaceAt(key * Q); cache.set(key, v); }
    return v;
  };
}

/** Habitat lookup memoised on a 2 m grid; classification is the expensive part. */
function habitatLookup(
  terrain: Terrain,
  classifyAt: (x: number, y: number) => BiomeId,
  surfaceOf: (x: number) => number,
) {
  const Q = 2;
  const cache = new Map<number, BiomeId>();
  return (x: number): BiomeId => {
    const key = Math.round(x / Q);
    let b = cache.get(key);
    if (b === undefined) {
      const xx = key * Q;
      b = classifyAt(xx, surfaceOf(xx) - 1.5);
      cache.set(key, b);
    }
    return b;
  };
}

/** Every instance rooted in [xMin, xMax]. */
export function strandsIn(
  terrain: Terrain,
  classifyAt: (x: number, y: number) => BiomeId,
  flowAt: (x: number, y: number) => number,
  xMin: number,
  xMax: number,
  seed = 1337,
): Strand[] {
  const out: Strand[] = [];
  const surfaceOf = surfaceLookup(terrain);
  const biomeOf = habitatLookup(terrain, classifyAt, surfaceOf);

  for (const kind of allPlantedKinds()) {
    const spec = FLORA[kind];
    const step = baseSpacing(kind);
    const salt = saltFor(kind);
    const i0 = Math.floor(xMin / step) - 1;
    const i1 = Math.ceil(xMax / step) + 1;

    for (let i = i0; i <= i1; i++) {
      const x = (i + (hash2(seed + salt, i, 11) - 0.5) * 0.85) * step;
      if (x < xMin || x > xMax || x < 0) continue;

      // Classify at the instance's own position, not at a run boundary.
      const p = plantingFor(biomeOf(x), kind);
      if (!p) continue;
      // Thin the global grid down to this habitat's density for this species.
      if (hash2(seed + salt, i, 37) > (step / p.spacing) * p.density) continue;

      const y = surfaceOf(x);
      const r = hash2(seed + salt, i, 53);
      let height = lerp(spec.minHeight, spec.maxHeight, r * r * 0.7 + 0.3 * hash2(seed + salt, i, 67));
      let width = spec.width * lerp(0.7, 1.35, hash2(seed + salt, i, 71));

      // Nothing may grow out of the water. This has to apply to every body
      // form, not just kelp: surfgrass in 0.6 m of water was poking into the
      // sky, and a radial body extends about 0.9 * width above its root.
      const clearance = Math.max(0.12, y - 0.4);
      height = Math.min(height, spec.form === "stipe" ? Math.max(1.5, y - 2.5) : clearance);
      if (spec.form === "ball") width = Math.min(width, clearance / 0.9);

      // Footprint width depends on the form: a tuft or a cluster spreads much
      // wider than its nominal width, and that spread is what must follow the
      // rock. Single-stemmed forms need no profile at all.
      const spreads = spec.form === "blade" || spec.form === "tube" || spec.form === "clump" || spec.form === "mat";
      const half = spreads ? width * (spec.form === "blade" ? 1.7 : spec.form === "tube" ? 1.2 : 1.1) : 0;

      out.push({
        kind,
        spec,
        x,
        y,
        height,
        width,
        lean: spec.lean * (hash2(seed + salt, i, 83) * 2 - 1),
        phase: hash2(seed + salt, i, 97) * Math.PI * 2,
        tint: hash2(seed + salt, i, 103) * 2 - 1,
        id: (salt ^ (i * 2654435761)) >>> 0,
        flow: flowAt(x, Math.max(0.5, y - height * 0.5)),
        half,
        ground: half > 0.35 ? sampleFootprint(surfaceOf, x, half) : EMPTY_GROUND,
      });
    }
  }
  out.sort((a, b) => a.y - b.y); // taller/shallower things drawn behind
  return out;
}

/** Centreline of a flexible strand at t (0 root, 1 tip), including sway. */
export function strandPoint(s: Strand, t: number, time: number): { x: number; y: number } {
  const k = clamp(t, 0, 1);
  const flex = s.spec.sway;
  // Steady bend downstream, proportional to flow and to how flexible the body
  // is, plus a sway whose amplitude and rate rise with the current.
  const bend = s.flow * 9 * flex * s.height * 0.09;
  const speed = 0.7 + Math.abs(s.flow) * 2.2;
  const amp = (1.1 + 3.0 * Math.abs(s.flow)) * flex;
  const sway = Math.sin(time * speed + s.phase + k * 2.1) * amp * k * k;
  return { x: s.x + (s.lean + bend) * k * k + sway, y: s.y - s.height * k };
}

/**
 * What a grazer can actually get from this instance right now.
 * `epiphyteLoad` regrows over time; depletion will live in the agent layer.
 */
export function forageValue(s: Strand): { direct: number; epiphyte: number } {
  const mass = s.height * s.width;
  return { direct: s.spec.edible * mass, epiphyte: s.spec.epiphyte * mass * 0.35 };
}

/** Total detritus shed per second by the flora in a metre of seabed. */
export function detritusRate(strands: readonly Strand[], width: number): number {
  let sum = 0;
  for (const s of strands) sum += s.spec.detritus * s.height * s.width;
  return width > 0 ? clamp01(sum / width * 0.02) : 0;
}

/** Shelter and current damping at a point, from nearby flora. */
export function coverAt(strands: readonly Strand[], x: number, y: number): { shelter: number; damping: number } {
  let shelter = 0;
  let damping = 0;
  for (const s of strands) {
    const dx = Math.abs(s.x - x);
    if (dx > 4) continue;
    const within = y > s.y - s.height - 1 && y < s.y + 1;
    if (!within) continue;
    const w = (1 - smoothstep(0, 4, dx));
    shelter += s.spec.shelter * w;
    damping += s.spec.currentDamping * w;
  }
  return { shelter: clamp01(shelter), damping: clamp01(damping) };
}
