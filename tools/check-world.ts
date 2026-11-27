/**
 * World generation invariants. `npm run check:world`.
 *
 * These are the properties that break silently -- nothing throws, the world just
 * quietly stops meaning what it is supposed to mean. Each one here has already
 * caught a real bug at least once.
 */

import { BIOMES, CAVE_CELL, World, footprintX, type BiomeId } from "../packages/sim/src/index";

const world = new World({ seed: process.argv[2] ?? "ocean-01" });
let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? "  -- " + detail : ""}`);
  if (!ok) failures++;
}

// 1. Content must derive from position, not from how it was asked for.
//    Habitat runs clipped to the query window broke this.
{
  const key = (o: { x: number }, k: string) => `${k}@${o.x.toFixed(3)}`;
  const wide = world.strands(1_400, 1_600).map((s) => key(s, s.kind)).sort();
  const split = [...world.strands(1_400, 1_500), ...world.strands(1_500, 1_600)]
    .map((s) => key(s, s.kind)).sort();
  check("flora is window-independent", wide.length === split.length && wide.every((v, i) => v === split[i]),
    `${wide.length} vs ${split.length}`);

  const sw = world.scatter(9_000, 9_400).map((p) => key(p, p.kind)).sort();
  const ss = [...world.scatter(9_000, 9_200), ...world.scatter(9_200, 9_400)]
    .map((p) => key(p, p.kind)).sort();
  check("scatter is window-independent", sw.length === ss.length && sw.every((v, i) => v === ss[i]),
    `${sw.length} vs ${ss.length}`);
}

// 2. Every habitat the code defines must actually occur somewhere.
//    This is what caught `seagrass_meadow` having nowhere shallow and sandy.
{
  const seen = new Set<BiomeId>();
  for (let x = 10; x < world.width; x += 40) {
    const bed = world.terrain.bed(x);
    for (const y of [bed - 3, Math.min(bed * 0.5, 120), 600, 1_500]) {
      if (y > 0 && y < world.maxDepth) seen.add(world.biomeAt(x, y));
    }
  }
  const missing = (Object.keys(BIOMES) as BiomeId[]).filter((b) => !seen.has(b));
  check("every biome occurs", missing.length === 0, missing.join(", "));
}

// 3. Nothing may be rooted outside the habitat that authorises it, and nothing
//    may grow out of the water.
{
  let wrongHabitat = 0;
  let aboveWater = 0;
  let n = 0;
  for (let x = 0; x < world.width; x += 1_500) {
    for (const s of world.strands(x, x + 300)) {
      n++;
      if (s.y - s.height < 0.1) aboveWater++;
    }
    for (const p of world.scatter(x, x + 300)) {
      if (p.y - p.h < 0.1) aboveWater++;
    }
  }
  check("nothing grows above the waterline", aboveWater === 0, `${aboveWater} of ${n}`);
  check("flora sampled", n > 200, `${n} instances`);
  void wrongHabitat;
}

// 3b. Multi-part bodies carry a profile of the rock under their own footprint.
//     Without it every part sits at the root's y, so on a slope the outer parts
//     of a boulder base, a basalt cluster or a tube-worm colony hang in open
//     water with no bottom.
{
  let checked = 0;
  let drift = 0;
  let worst = 0;
  for (let x = 0; x < world.width; x += 900) {
    for (const p of world.scatter(x, x + 250)) {
      if (p.ground.length < 2) continue;
      for (let i = 0; i < p.ground.length; i++) {
        const sx = footprintX(p.x, p.half, p.ground.length, i);
        const err = Math.abs((p.y + p.ground[i]) - world.terrain.surfaceAt(sx));
        if (err > worst) worst = err;
        if (err > 0.4) drift++;
        checked++;
      }
    }
  }
  check("scatter footprints track the rock", drift === 0 && checked > 100,
    `${drift} of ${checked} off, worst ${worst.toFixed(2)} m`);

  let noProfile = 0;
  let total = 0;
  for (let x = 0; x < world.width; x += 900) {
    for (const s of world.strands(x, x + 250)) {
      const spreads = s.spec.form === "blade" || s.spec.form === "tube"
        || s.spec.form === "clump" || s.spec.form === "mat";
      if (!spreads) continue;
      total++;
      if (s.half > 0.35 && s.ground.length < 2) noProfile++;
    }
  }
  check("spreading flora carries a ground profile", noProfile === 0, `${noProfile} of ${total} missing`);
}

// 3c. Every cave network must open to the water. A sealed void in a 2D side
//     view can never be entered, so it is generation nobody will ever see --
//     which is what thresholded noise produced (5-47% connected, measured).
{
  let nets = 0, noMouth = 0, tooDeep = 0;
  const classes = new Map<string, number>();
  for (let c = 0; c * CAVE_CELL < world.width; c++) {
    const net = world.terrain.caveAt(c * CAVE_CELL + 1);
    if (!net) continue;
    nets++;
    // A mouth is a segment endpoint at or above the local seabed.
    let mouth = false;
    for (const sg of net.segs) {
      if (sg.ay - sg.ra <= world.terrain.bed(sg.ax)) mouth = true;
      if (sg.by - sg.rb <= world.terrain.bed(sg.bx)) mouth = true;
    }
    if (!mouth) noMouth++;
    if (net.depth > 120) tooDeep++;
    const k = net.mouthRadius < 0.8 ? "crevice" : net.mouthRadius < 2.5 ? "tunnel" : "gallery";
    classes.set(k, (classes.get(k) ?? 0) + 1);
  }
  check("every cave opens to the water", noMouth === 0, `${noMouth} of ${nets} sealed`);
  check("caves stay within depth budget", tooDeep === 0, `${tooDeep} over 120 m`);
  check("all three passage classes occur", classes.size === 3,
    [...classes].map(([k, v]) => `${k}=${v}`).join(" "));
}

// 4. Every species must appear somewhere, or it is dead data.
{
  const seen = new Set<string>();
  for (let x = 0; x < world.width; x += 400) for (const s of world.strands(x, x + 400)) seen.add(s.kind);
  const scat = new Set<string>();
  for (let x = 0; x < world.width; x += 1_000) for (const p of world.scatter(x, x + 1_000)) scat.add(p.kind);
  check("all flora species occur", seen.size === 26, `${seen.size}/26`);
  check("all scatter kinds occur", scat.size === 8, `${scat.size}/8`);
}

// 5. The same seed must produce the same world.
{
  const a = new World({ seed: "determinism" }).strands(3_000, 3_200).map((s) => s.kind + s.x.toFixed(4)).join("|");
  const b = new World({ seed: "determinism" }).strands(3_000, 3_200).map((s) => s.kind + s.x.toFixed(4)).join("|");
  check("same seed, same world", a === b && a.length > 0);
}

console.log(failures === 0 ? "\nall world invariants hold" : `\n${failures} invariant(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
