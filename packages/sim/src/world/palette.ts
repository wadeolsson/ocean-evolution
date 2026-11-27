/**
 * One palette, shared by the offline map raster and the live renderer, so the
 * map you plan with and the ocean you swim in are the same colours.
 */

import { rampHex } from "../core/math";
import type { BiomeId } from "./biome";

/** Water colour by depth in metres. */
const WATER: ReadonlyArray<readonly [number, number]> = [
  [0, 0x4fd6e8],
  [18, 0x2bbdda],
  [45, 0x169dc4],
  [120, 0x0c7aa8],
  [300, 0x075887],
  [700, 0x05466f],
  [1_300, 0x03314f],
  [2_000, 0x022339],
  [2_650, 0x01192c],
];

export function waterColor(depth: number): number {
  return rampHex(WATER, depth);
}

/** Substrate colour by hardness: mud, sand, rock. */
const SUBSTRATE: ReadonlyArray<readonly [number, number]> = [
  [0.0, 0x4a4336],
  [0.3, 0x8f7f5c],
  [0.5, 0xbda87c],
  [0.62, 0x8b8275],
  [1.0, 0x55504a],
];

export function substrateColor(hardness: number): number {
  return rampHex(SUBSTRATE, hardness);
}

/** Biome accent, used for the rock tint near the bed and for the map legend. */
export const BIOME_COLOR: Readonly<Record<BiomeId, number>> = {
  coastal_shallows:  0xe4d6a7,
  kelp_forest:       0x2f6b3a,
  seagrass_meadow:   0x6f9d4a,
  sandy_seabed:      0xd8c493,
  rocky_reef:        0x7d7466,
  coral_reef:        0xe0745f,
  reef_dropoff:      0x9a6a55,
  shelf_edge:        0x6f7f86,
  continental_slope: 0x565f63,
  deep_canyon:       0x3b4a58,
  seamount_flank:    0x5b4f5e,
  hydrothermal_vent: 0xb8503a,
  abyssal_plain:     0x3a382f,
  sunlit_open_water: 0x2bbdda,
  twilight_zone:     0x075887,
  midnight_zone:     0x011628,
};
