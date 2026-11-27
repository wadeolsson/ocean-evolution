/**
 * Biome classification: habitats are *derived*, never placed.
 *
 * Given depth, substrate, slope, light and temperature, decide what lives here.
 * Because the inputs vary continuously across the world, the outputs blend and
 * neighbour correctly by construction: reef gives way to sand because the bank
 * slopes into sand, not because a designer drew a boundary there.
 */

import { canyonInfluence, seamountInfluence, ventInfluence } from "./profile";
import type { EnvSample } from "./env";

export type BiomeId =
  | "coastal_shallows"
  | "kelp_forest"
  | "seagrass_meadow"
  | "sandy_seabed"
  | "rocky_reef"
  | "coral_reef"
  | "reef_dropoff"
  | "shelf_edge"
  | "continental_slope"
  | "deep_canyon"
  | "seamount_flank"
  | "hydrothermal_vent"
  | "abyssal_plain"
  | "sunlit_open_water"
  | "twilight_zone"
  | "midnight_zone";

export const BENTHIC_BAND = 26; // metres above the bed that counts as "bottom habitat"

export interface BiomeInfo {
  readonly id: BiomeId;
  readonly name: string;
  readonly benthic: boolean;
  /** Short note used in the HUD and the map legend. */
  readonly note: string;
}

export const BIOMES: Readonly<Record<BiomeId, BiomeInfo>> = {
  coastal_shallows:   { id: "coastal_shallows",   name: "Coastal shallows",   benthic: true,  note: "Surge, bright light, nursery habitat" },
  kelp_forest:        { id: "kelp_forest",        name: "Kelp forest",        benthic: true,  note: "Cold rocky shelf, dense vertical cover" },
  seagrass_meadow:    { id: "seagrass_meadow",    name: "Seagrass meadow",    benthic: true,  note: "Shallow sand, grazing and shelter" },
  sandy_seabed:       { id: "sandy_seabed",       name: "Sandy seabed",       benthic: true,  note: "Open sand, burrowers and ambushers" },
  rocky_reef:         { id: "rocky_reef",         name: "Rocky reef",         benthic: true,  note: "Boulders, crevices, territorial fish" },
  coral_reef:         { id: "coral_reef",         name: "Coral reef",         benthic: true,  note: "Warm hard bottom, highest diversity" },
  reef_dropoff:       { id: "reef_dropoff",       name: "Reef dropoff",       benthic: true,  note: "Near-vertical wall into blue water" },
  shelf_edge:         { id: "shelf_edge",         name: "Shelf edge",         benthic: true,  note: "Where shelf fauna meets open ocean" },
  continental_slope:  { id: "continental_slope",  name: "Continental slope",  benthic: true,  note: "Long descent, terraces and outcrops" },
  deep_canyon:        { id: "deep_canyon",        name: "Deep canyon",        benthic: true,  note: "Nutrient funnel and route to the abyss" },
  seamount_flank:     { id: "seamount_flank",     name: "Seamount flank",     benthic: true,  note: "Current-swept oasis in open abyss" },
  hydrothermal_vent:  { id: "hydrothermal_vent",  name: "Hydrothermal vents", benthic: true,  note: "Chemosynthetic food web, no sunlight" },
  abyssal_plain:      { id: "abyssal_plain",      name: "Abyssal plain",      benthic: true,  note: "Soft mud, scavengers, marine snow" },
  sunlit_open_water:  { id: "sunlit_open_water",  name: "Sunlit open water",  benthic: false, note: "Epipelagic: plankton and schooling fish" },
  twilight_zone:      { id: "twilight_zone",      name: "Twilight zone",      benthic: false, note: "Mesopelagic: vertical migrators" },
  midnight_zone:      { id: "midnight_zone",      name: "Midnight zone",      benthic: false, note: "Aphotic, sparse, bioluminescent" },
};

/**
 * Classify a point. `x` is needed only for the three constructional features
 * (canyon, seamount, vents), which are geographic facts rather than local ones.
 */
export function classify(x: number, env: EnvSample): BiomeId {
  const { depth, heightAboveBed, hardness, light, temperature } = env;
  const slope = Math.abs(env.slope);

  // Note: a point *inside* the rock (negative height) classifies as bottom
  // habitat, not open water -- the rock is the habitat.
  if (heightAboveBed > BENTHIC_BAND) {
    // Open water: the vertical zones.
    if (depth < 200) return "sunlit_open_water";
    if (depth < 1_000) return "twilight_zone";
    return "midnight_zone";
  }

  // Bottom habitat. Order matters: specific geography first, then local conditions.
  if (ventInfluence(x) > 0.45 && depth > 1_600) return "hydrothermal_vent";
  if (seamountInfluence(x) > 0.3 && depth > 900) return "seamount_flank";
  if (canyonInfluence(x) > 0.4 && depth > 900) return "deep_canyon";

  // Surf zone, but only where there is actually land to break against: without
  // the x gate this swallowed the reef crest 5 km offshore.
  if (depth < 7 && x < 1_200) return "coastal_shallows";

  if (hardness > 0.55 && depth <= 42 && temperature < 16.5) return "kelp_forest";
  if (hardness > 0.5 && depth <= 52 && temperature >= 18.5 && light > 0.3) return "coral_reef";
  if (slope > 0.22 && depth > 45 && depth < 300) return "reef_dropoff";
  if (hardness > 0.48 && depth <= 220) return "rocky_reef";
  if (hardness <= 0.48 && depth <= 26) return "seagrass_meadow";
  if (hardness <= 0.48 && depth <= 230) return "sandy_seabed";
  if (depth <= 430) return "shelf_edge";
  if (depth <= 1_950) return "continental_slope";
  return "abyssal_plain";
}
