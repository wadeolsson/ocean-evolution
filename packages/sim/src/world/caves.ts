/**
 * Cave networks: explicit chambers and passages, not a noise threshold.
 *
 * Carving caves by thresholding a noise field produces voids that are mostly
 * SEALED -- measured at 5-47% connected to open water, 7-15 m deep. In a 2D
 * side view a sealed void is permanently unreachable, so that is generation
 * nobody can ever visit. Worse, you cannot control any of the things that make
 * a cave matter: whether it has a mouth, how wide the passage is, how far it
 * goes.
 *
 * So a network is built as a graph instead. Nodes are chambers, edges are
 * passages, at least one node is a mouth that breaks the seabed surface, and
 * the whole thing is subtracted from the density field as a distance function.
 * Everything a cave needs to be useful is then a parameter:
 *
 *  - every network reaches open water, by construction
 *  - passage width is chosen from creature-sized classes, so a crevice a
 *    sardine fits through can exclude the grouper chasing it
 *  - penetration depth is set, not emergent
 *
 * Networks are derived from their cell index, so they are stable, seed-only,
 * and need no world state -- the same rule the flora and scatter layers follow.
 */

import { clamp, lerp } from "../core/math";
import { makeRng } from "../core/rng";

/** Horizontal size of one cave cell, metres. */
const CELL = 210;
/**
 * Passage classes, in metres of radius. These are creature sizes, not scenery:
 * the gap between a crevice and a tunnel is what lets a small fish escape
 * something bigger, which is the whole gameplay reason caves exist.
 */
export const PASSAGE = {
  crevice: [0.35, 0.75] as const,   // sardine, shrimp, goby
  tunnel: [1.1, 2.4] as const,      // mackerel, small squid, octopus
  gallery: [3.0, 7.5] as const,     // grouper, shark, anything big
};
export type PassageClass = keyof typeof PASSAGE;

export interface CaveSeg {
  ax: number; ay: number; ra: number;
  bx: number; by: number; rb: number;
}

export interface CaveNet {
  readonly cell: number;
  readonly segs: readonly CaveSeg[];
  /** Expanded bounding box, for the early-out that keeps density() cheap. */
  readonly x0: number; readonly y0: number;
  readonly x1: number; readonly y1: number;
  /** The widest passage at the mouth: what can get in at all. */
  readonly mouthRadius: number;
  /** Deepest point below the seabed. */
  readonly depth: number;
}

interface Node { x: number; y: number; r: number; }

/**
 * Build the network for a cell, or null if this stretch of seabed has none.
 * `bedAt` must not depend on the density field, or this recurses.
 */
export function buildNet(
  seed: string,
  cell: number,
  bedAt: (x: number) => number,
  hardnessAt: (x: number) => number,
): CaveNet | null {
  const rng = makeRng(`${seed}/cave/${cell}`);
  const cx = cell * CELL + CELL * (0.25 + 0.5 * rng.next());
  if (cx < 120) return null;

  const hard = hardnessAt(cx);
  const bed = bedAt(cx);
  // Caves need rock to form in, and enough water column above to be worth it.
  if (hard < 0.42 || bed < 9) return null;
  // Density of networks scales with how competent the rock is.
  if (!rng.chance(0.25 + 0.6 * hard)) return null;

  // Pick what this network is for. Most are small; galleries are rare and are
  // what a large predator can actually den in.
  const roll = rng.next();
  // Crevices are the commonest on purpose: a refuge only a small fish fits
  // into is the single most useful thing a cave can be at Tier 1.
  const cls: PassageClass = roll < 0.52 ? "crevice" : roll < 0.9 ? "tunnel" : "gallery";
  const [rMin, rMax] = PASSAGE[cls];
  const radius = () => lerp(rMin, rMax, rng.next());

  const nodes: Node[] = [];
  const segs: CaveSeg[] = [];

  // The mouth sits just ABOVE the local seabed, so the passage necessarily
  // breaks the surface and opens into the water column.
  const mouthR = radius();
  const mouth: Node = { x: cx, y: bed - mouthR * 0.8, r: mouthR };
  nodes.push(mouth);

  const maxDepth = cls === "gallery" ? 75 : cls === "tunnel" ? 55 : 32;
  const count = 2 + rng.int(cls === "crevice" ? 3 : 5);
  let prev = mouth;

  for (let i = 0; i < count; i++) {
    const wander = rng.range(-1, 1) * (cls === "gallery" ? 48 : 34);
    const drop = rng.range(5, 16) * (cls === "gallery" ? 1.5 : 1);
    // Keep the network inside its own cell's reach, so density() only ever has
    // to consult three cells instead of searching outward.
    const nx = clamp(prev.x + wander, cx - CELL * 0.8, cx + CELL * 0.8);
    const ny = clamp(prev.y + drop, bedAt(nx) + 2.5, bedAt(nx) + maxDepth);
    // Chambers: every few nodes the passage opens out.
    const chamber = rng.chance(0.42);
    const node: Node = { x: nx, y: ny, r: chamber ? radius() * 1.9 : radius() };
    nodes.push(node);
    segs.push({ ax: prev.x, ay: prev.y, ra: prev.r, bx: node.x, by: node.y, rb: node.r });

    // Side passages: dead ends give a cave an interior to explore and a place
    // to hide that is not just "further in".
    if (rng.chance(0.38)) {
      const sx = clamp(node.x + rng.range(-1, 1) * 26, cx - CELL * 0.8, cx + CELL * 0.8);
      const sy = clamp(node.y + rng.range(-6, 10), bedAt(sx) + 2, bedAt(sx) + maxDepth);
      const sr = radius() * 0.8;
      segs.push({ ax: node.x, ay: node.y, ra: node.r, bx: sx, by: sy, rb: sr });
      nodes.push({ x: sx, y: sy, r: sr });
    }
    prev = node;
  }

  // A second mouth turns a dead end into a through-route, which is the
  // difference between a hiding place and an escape.
  if (rng.chance(0.45) && nodes.length > 2) {
    const from = nodes[1 + rng.int(nodes.length - 1)];
    const mx = clamp(from.x + rng.range(-1, 1) * 40, cx - CELL * 0.8, cx + CELL * 0.8);
    const mr = radius();
    segs.push({ ax: from.x, ay: from.y, ra: from.r, bx: mx, by: bedAt(mx) - mr * 0.8, rb: mr });
  }

  // The box is padded well beyond the passages themselves. Subtracting the
  // cave clamps the density field for some distance around it, and if the box
  // ends while that clamp still binds, the cutoff draws a literal rectangle in
  // the rock. PAD must exceed the taper range used in Terrain.density().
  const PAD = 86;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  let deepest = 0;
  for (const s of segs) {
    const r = Math.max(s.ra, s.rb) + PAD;
    x0 = Math.min(x0, s.ax - r, s.bx - r);
    x1 = Math.max(x1, s.ax + r, s.bx + r);
    y0 = Math.min(y0, s.ay - r, s.by - r);
    y1 = Math.max(y1, s.ay + r, s.by + r);
    deepest = Math.max(deepest, s.ay - bedAt(s.ax), s.by - bedAt(s.bx));
  }
  if (segs.length === 0) return null;

  return { cell, segs, x0, y0, x1, y1, mouthRadius: mouthR, depth: deepest };
}

/**
 * Signed distance IN METRES from a point to the nearest passage wall:
 * negative inside a passage, positive outside, +Infinity if no network is near.
 *
 * It has to be a real distance, not a smooth falloff. Subtracting caves with a
 * smoothstep term destroyed the signed-distance property of the whole field --
 * the middle of a 1.5 m tunnel reported 200 m of clearance, which would have
 * told collision there was nothing anywhere near the fish.
 *
 * Hot path: called from Terrain.density(), so the bounding-box rejection
 * matters more than the segment maths.
 */
export function caveDistance(nets: readonly (CaveNet | null)[], x: number, y: number): number {
  let best = Infinity;
  for (const net of nets) {
    if (!net) continue;
    if (x < net.x0 || x > net.x1 || y < net.y0 || y > net.y1) continue;
    for (const s of net.segs) {
      const vx = s.bx - s.ax, vy = s.by - s.ay;
      const wx = x - s.ax, wy = y - s.ay;
      const len2 = vx * vx + vy * vy;
      const t = len2 > 1e-9 ? clamp((wx * vx + wy * vy) / len2, 0, 1) : 0;
      const dx = wx - vx * t, dy = wy - vy * t;
      const r = s.ra + (s.rb - s.ra) * t;
      const d = Math.sqrt(dx * dx + dy * dy) - r;
      if (d < best) best = d;
    }
  }
  return best;
}

export const CAVE_CELL = CELL;
