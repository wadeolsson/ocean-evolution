/**
 * The macro cross-section: one authored curve from shore to abyssal plain.
 *
 * This file is the answer to "don't make the world a row of rectangular levels".
 * Nothing places a biome anywhere. Instead we author the *geography* -- how deep
 * the seabed is at each distance from shore, and how hard the substrate is -- and
 * then biome.ts derives habitats from depth, substrate, light and temperature,
 * the same variables that decide them in the real ocean. Kelp ends up on the cool
 * rocky shelf because that is the only place that is cool, rocky and lit; it is
 * not placed there.
 *
 * Edit the control points below to redesign the world. Everything downstream follows.
 */

import { bump, clamp, pwl, smoothstep } from "../core/math";

export const WORLD_WIDTH = 20_000; // metres, shore (x=0) to open abyss
export const WORLD_DEPTH = 2_650;  // metres, surface (y=0) downward

/**
 * Seabed depth in metres at distance x from shore. Smoothstepped between points,
 * so the shelf break and the reef dropoff are steep without being discontinuous.
 */
const BED: ReadonlyArray<readonly [number, number]> = [
  [0, 0],         // waterline
  [220, 6],       // surf zone
  [900, 19],      // coastal shallows
  [1_600, 31],    // inner rocky shelf  (kelp)
  [2_600, 45],
  [3_400, 57],    // sandy mid shelf    (seagrass, sand flats)
  [4_150, 66],
  [4_330, 38],    // the reef bank rises back toward the light
  [4_480, 16],
  [4_640, 12],    // back-reef lagoon: shallow, sheltered, sandy
  [4_800, 13],
  [4_900, 8],     // reef crest, nearly awash
  [5_040, 11],
  [5_180, 20],
  [5_420, 36],
  [5_700, 92],    // reef dropoff
  [6_200, 178],
  [7_000, 206],   // outer shelf
  [8_200, 242],
  [8_650, 335],   // shelf break
  [9_050, 530],
  [9_700, 775],   // upper slope
  [10_400, 985],
  [11_200, 1_255],
  [12_200, 1_565],
  [13_000, 1_855], // lower slope
  [14_000, 2_150],
  [15_000, 2_325],
  [16_000, 2_400], // abyssal plain
  [17_000, 2_425],
  [18_000, 2_455],
  [19_000, 2_480],
  [20_000, 2_500],
];

/**
 * Substrate hardness, 0 = soft mud, 1 = bare rock. Drives rugosity, cave
 * formation, and which benthic habitats can exist.
 */
const HARDNESS: ReadonlyArray<readonly [number, number]> = [
  [0, 0.88],
  [900, 0.90],    // rocky shore
  [2_600, 0.78],  // rocky shelf
  [2_900, 0.84],  // pinnacles
  [3_250, 0.34],
  [4_150, 0.28],  // sand flats
  [4_330, 0.55],  // bank flank
  [4_470, 0.30],
  [4_640, 0.20],  // lagoon sand
  [4_800, 0.42],
  [4_890, 0.92],  // reef crest framework: hard
  [5_300, 0.95],
  [5_700, 0.78],
  [6_400, 0.33],
  [8_200, 0.28],  // outer shelf sand
  [8_700, 0.55],  // break exposes rock
  [10_400, 0.62],
  [13_000, 0.44],
  [14_500, 0.20],
  [16_000, 0.18],
  [16_300, 0.92], // vent field basalt
  [16_750, 0.28],
  [17_800, 0.18], // abyssal mud
  [18_400, 0.88], // seamount
  [19_100, 0.26],
  [20_000, 0.18],
];

/** Named features, used for the map legend, HUD readout and later for spawn regions. */
export interface GeoFeature {
  readonly id: string;
  readonly name: string;
  readonly x0: number;
  readonly x1: number;
  /** Where to anchor a label, as depth in metres. */
  readonly labelDepth: number;
}

export const FEATURES: readonly GeoFeature[] = [
  { id: "shore", name: "Coastal shallows", x0: 0, x1: 950, labelDepth: 12 },
  { id: "kelp", name: "Kelp forest", x0: 950, x1: 2_750, labelDepth: 26 },
  { id: "flats", name: "Seagrass & sand flats", x0: 2_750, x1: 4_300, labelDepth: 44 },
  { id: "lagoon", name: "Back-reef lagoon", x0: 4_300, x1: 4_850, labelDepth: 11 },
  { id: "reef", name: "Coral reef crest", x0: 4_850, x1: 5_500, labelDepth: 17 },
  { id: "dropoff", name: "Reef dropoff", x0: 5_500, x1: 6_300, labelDepth: 120 },
  { id: "outershelf", name: "Outer shelf", x0: 6_300, x1: 8_400, labelDepth: 170 },
  { id: "break", name: "Shelf break", x0: 8_400, x1: 9_200, labelDepth: 380 },
  { id: "canyon", name: "Mirador Canyon", x0: 9_200, x1: 10_700, labelDepth: 1_250 },
  { id: "slope", name: "Continental slope", x0: 10_700, x1: 13_400, labelDepth: 1_150 },
  { id: "abyss", name: "Abyssal plain", x0: 13_400, x1: 20_000, labelDepth: 2_050 },
  { id: "vents", name: "Hydrothermal vents", x0: 16_050, x1: 16_600, labelDepth: 1_900 },
  { id: "seamount", name: "Varu Seamount", x0: 17_600, x1: 19_200, labelDepth: 1_400 },
];

export function featureAt(x: number): GeoFeature | undefined {
  // Later entries win, so the vent field and seamount override the abyssal plain.
  let found: GeoFeature | undefined;
  for (const f of FEATURES) if (x >= f.x0 && x < f.x1) found = f;
  return found;
}

// ---------------------------------------------------------------------------
// Incised and constructional features, applied on top of the base curve.
// ---------------------------------------------------------------------------

/**
 * Mirador Canyon: a submarine canyon head cutting into the upper slope.
 * Asymmetric on purpose -- a steep landward wall you drop over, and a long
 * seaward ramp that carries you out onto the lower slope. That asymmetry is the
 * difference between "a pit" and "a route to the deep".
 */
function canyon(x: number): number {
  const axis = 9_900;
  const t = x < axis ? (x - axis) / 460 : (x - axis) / 1_020;
  return 1_180 * bump(t, 0.75); // low power => broad flat floor
}

/** Varu Seamount: a basalt cone rising off the abyssal plain into the twilight. */
function seamount(x: number): number {
  return 1_300 * bump((x - 18_400) / 980, 1.35);
}

/** The vent ridge: a low spreading ridge with chimney-scale bumps on top. */
function ventRidge(x: number): number {
  const ridge = 430 * bump((x - 16_320) / 430, 1.1);
  const chimneys = 55 * Math.max(0, Math.sin((x - 16_100) * 0.055)) * bump((x - 16_320) / 330, 1.5);
  return ridge + chimneys;
}

/** Isolated rock pinnacles on the mid shelf -- structure in otherwise open sand. */
function pinnacles(x: number): number {
  return 26 * bump((x - 2_880) / 70, 1.6) + 18 * bump((x - 3_020) / 48, 1.8);
}

/** Base seabed depth before terrain noise. Positive is down. */
export function macroBed(x: number): number {
  const base = pwl(BED, clamp(x, 0, WORLD_WIDTH));
  const d = base + canyon(x) - seamount(x) - ventRidge(x) - pinnacles(x);
  return Math.max(0.6, d);
}

/** Base substrate hardness before terrain noise, 0..1. */
export function macroHardness(x: number): number {
  return clamp(pwl(HARDNESS, clamp(x, 0, WORLD_WIDTH)), 0, 1);
}

/** True inside the canyon's walls -- used by biome classification. */
export function canyonInfluence(x: number): number {
  return smoothstep(120, 600, canyon(x));
}

export function seamountInfluence(x: number): number {
  return smoothstep(80, 500, seamount(x));
}

export function ventInfluence(x: number): number {
  return smoothstep(60, 300, ventRidge(x));
}

/**
 * Sea-surface temperature in degrees C at distance x. The west end sits under a
 * cold upwelling cell and the east is tropical open water: that single gradient
 * is why kelp grows inshore and coral grows on the bank 4km out, without either
 * being placed by hand.
 */
export function surfaceTemperature(x: number): number {
  return 11.4 + 11.2 * smoothstep(900, 5_200, x);
}

/** Upwelling strength, 0..1 -- cold, nutrient-rich water rising at the west end. */
export function upwelling(x: number): number {
  return 1 - smoothstep(600, 4_200, x);
}
