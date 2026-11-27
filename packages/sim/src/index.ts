/**
 * @ocean/sim -- the authoritative simulation.
 *
 * Hard rule: nothing in this package may import a renderer, touch the DOM, or
 * call Math.random / Date.now (enforced by tools/check-determinism.sh). That is
 * what lets the same code run the live game, the offline map renderer, and the
 * headless ecosystem balancing runs.
 */

export * from "./core/math";
export * from "./core/rng";
export * from "./core/noise";
export * from "./core/clock";
export * from "./world/profile";
export * from "./world/caves";
export * from "./world/terrain";
export * from "./world/env";
export * from "./world/biome";
export * from "./world/flora";
export * from "./world/floraDraw";
export * from "./world/scatter";
export * from "./world/palette";
export * from "./world/marching";
export * from "./world/world";
