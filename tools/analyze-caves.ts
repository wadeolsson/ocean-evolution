/**
 * Cave connectivity analysis. `npx tsx tools/analyze-caves.ts`
 *
 * Caves emerge from the density field rather than being authored, so the
 * question "are they a usable space?" is empirical: flood-fill the water from
 * open ocean and see how much of the sub-seabed void is actually reachable,
 * how big the chambers are, and whether the passages are wide enough to swim.
 */

import { World } from "../packages/sim/src/index";

const world = new World({ seed: process.argv[2] ?? "ocean-01" });
const t = world.terrain;

interface Region { name: string; x0: number; x1: number; }
const REGIONS: Region[] = [
  { name: "kelp / rocky reef", x0: 1_200, x1: 2_600 },
  { name: "coral reef crest", x0: 4_850, x1: 5_500 },
  { name: "reef dropoff", x0: 5_500, x1: 6_300 },
  { name: "canyon walls", x0: 9_300, x1: 10_600 },
  { name: "seamount flank", x0: 17_900, x1: 18_900 },
];

const RES = 0.5; // metres per cell

for (const r of REGIONS) {
  // Vertical extent: from the shallowest surface in the region down 180 m.
  let top = Infinity;
  for (let x = r.x0; x <= r.x1; x += 4) top = Math.min(top, t.bed(x));
  const y0 = Math.max(0, top - 30);
  const y1 = Math.min(world.maxDepth, top + 200);

  const w = Math.round((r.x1 - r.x0) / RES);
  const h = Math.round((y1 - y0) / RES);
  const solid = new Uint8Array(w * h);
  const bedAt = new Float64Array(w);

  for (let i = 0; i < w; i++) {
    const x = r.x0 + i * RES;
    bedAt[i] = t.bed(x);
    for (let j = 0; j < h; j++) {
      if (t.density(x, y0 + j * RES) > 0) solid[j * w + i] = 1;
    }
  }

  // Flood-fill the water from every open-water cell on the region boundary.
  const seen = new Uint8Array(w * h);
  const queue: number[] = [];
  const push = (i: number, j: number) => {
    if (i < 0 || j < 0 || i >= w || j >= h) return;
    const k = j * w + i;
    if (seen[k] || solid[k]) return;
    seen[k] = 1;
    queue.push(k);
  };
  for (let i = 0; i < w; i++) push(i, 0);
  for (let j = 0; j < h; j++) { push(0, j); push(w - 1, j); }
  for (let qi = 0; qi < queue.length; qi++) {
    const k = queue[qi];
    const i = k % w, j = (k / w) | 0;
    push(i + 1, j); push(i - 1, j); push(i, j + 1); push(i, j - 1);
  }

  // A "cave" cell is water that lies below the local seabed curve.
  let caveTotal = 0, caveReachable = 0, deepest = 0;
  let clearanceSum = 0, clearanceMax = 0;
  const wide: number[] = []; // clearance of reachable cave cells
  for (let j = 0; j < h; j++) {
    const y = y0 + j * RES;
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      if (solid[k]) continue;
      const below = y - bedAt[i];
      if (below < 4) continue; // not a cave, just open water over the bed
      caveTotal++;
      if (!seen[k]) continue;
      caveReachable++;
      if (below > deepest) deepest = below;
      const clear = -t.sdf(r.x0 + i * RES, y);
      clearanceSum += clear;
      if (clear > clearanceMax) clearanceMax = clear;
      wide.push(clear);
    }
  }

  const area = (n: number) => (n * RES * RES).toFixed(0);
  wide.sort((a, b) => a - b);
  const pct = (p: number) => (wide.length ? wide[Math.floor(wide.length * p)] : 0).toFixed(1);
  console.log(`\n${r.name}  (x ${r.x0}-${r.x1})`);
  console.log(`  cave void:        ${area(caveTotal)} m2`);
  console.log(`  reachable:        ${area(caveReachable)} m2  (${caveTotal ? (100 * caveReachable / caveTotal).toFixed(0) : 0}% connected to open water)`);
  console.log(`  deepest point:    ${deepest.toFixed(0)} m below the seabed`);
  if (wide.length) {
    console.log(`  clearance p50/p90/max: ${pct(0.5)} / ${pct(0.9)} / ${clearanceMax.toFixed(1)} m`);
    console.log(`  mean clearance:   ${(clearanceSum / wide.length).toFixed(1)} m`);
  }
}
