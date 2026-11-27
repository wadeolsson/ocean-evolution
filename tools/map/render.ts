/**
 * Offline map renderer: `npm run map`.
 *
 * Renders the generated world to PNGs plus an HTML sheet with labels, a depth
 * axis and a legend. This is the fastest loop we have for judging world
 * generation: change a control point in profile.ts, re-run, look at the ocean.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BIOMES, BIOME_COLOR, World, cssHex, type BiomeId,
} from "../../packages/sim/src/index";
import { encodePNG } from "./png";
import { renderView, type Mode, type View } from "./shade";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../out");

interface Job {
  readonly file: string;
  readonly title: string;
  readonly caption: string;
  readonly mode: Mode;
  readonly view: View;
  readonly overview?: boolean;
}

const seed = process.argv[2] ?? "ocean-01";
const world = new World({ seed });

const OVERVIEW: View = { x0: 0, y0: 0, x1: world.width, y1: world.maxDepth, width: 2400, height: 420 };

const JOBS: Job[] = [
  {
    file: "01-overview-natural.png",
    title: "The whole ocean",
    caption: `${(world.width / 1000).toFixed(0)} km of coastline to abyss, ${world.maxDepth} m deep. Vertically exaggerated about 8x -- the real proportions are far flatter.`,
    mode: "natural", view: OVERVIEW, overview: true,
  },
  {
    file: "02-overview-biome.png",
    title: "Derived habitats",
    caption: "Flat biome classification. Nothing here is placed: every colour is biome.ts reading depth, substrate, slope, light and temperature.",
    mode: "biome", view: OVERVIEW, overview: true,
  },
  {
    file: "03-overview-plankton.png",
    title: "Plankton density field",
    caption: "The base of the food web. Bright is productive: the lit surface layer, the deep chlorophyll maximum, and the cold upwelling at the west end.",
    mode: "plankton", view: OVERVIEW, overview: true,
  },
  {
    file: "04-kelp.png",
    title: "Kelp forest",
    caption: "x 1.40-1.70 km, 0-56 m. Giant kelp and bull kelp over a red-algae understory, with urchins and boulders on the floor. Kelp grows here because this is the only place that is shallow, hard-bottomed and under 16.5 C.",
    mode: "natural", view: { x0: 1_400, y0: 0, x1: 1_700, y1: 56, width: 1_620, height: 302 },
  },
  {
    file: "05-reef-dropoff.png",
    title: "Coral reef, lagoon & dropoff",
    caption: "x 4.35-6.45 km, 0-230 m. Sand flat, seagrass lagoon, hard reef crest, then the seaward face falling into blue water. Staghorn and brain coral, sea fans, soft coral and anemones, all derived from the same depth/substrate/temperature test. One continuous cross-section, no seams anywhere in it.",
    mode: "natural", view: { x0: 4_350, y0: 0, x1: 6_450, y1: 230, width: 1_800, height: 560 },
  },
  {
    file: "06-rocky-caves.png",
    title: "Rocky reef & cave system",
    caption: "x 1.90-2.20 km, 8-120 m. Caves, tunnels and overhangs, all emergent from the density field -- a heightmap could not express any of this.",
    mode: "natural", view: { x0: 1_900, y0: 8, x1: 2_200, y1: 120, width: 1_500, height: 560 },
  },
  {
    file: "07-canyon.png",
    title: "Mirador Canyon",
    caption: "x 9.30-10.70 km, 450-2,150 m. A steep landward wall to drop over and a long seaward ramp out onto the lower slope: a route to the deep, not a pit.",
    mode: "natural", view: { x0: 9_300, y0: 450, x1: 10_700, y1: 2_150, width: 1_000, height: 1_214 },
  },
  (() => {
    // Close enough to read the chimneys. The old 650 m window reduced them to a
    // dark fringe along the ridge, which is not what a vent field looks like.
    const x0 = 16_240, x1 = 16_400;
    let lo = Infinity, hi = -Infinity;
    for (let x = x0; x <= x1; x += 4) {
      const sy = world.terrain.surfaceAt(x);
      lo = Math.min(lo, sy); hi = Math.max(hi, sy);
    }
    const y0 = Math.round(lo) - 62;
    const y1 = Math.round(hi) + 8;
    return {
      file: "08-vents.png",
      title: "Hydrothermal vent field",
      caption: `x 16.24-16.40 km, ${Math.round(lo)}-${Math.round(hi)} m (exposure pushed). Sulphide chimneys on a spreading ridge, venting fluid at a few hundred degrees that flashes into black smoke as it hits 2 C seawater. Riftia tube worms and vent mussels crowd the flanks. The only food web here that owes nothing to sunlight.`,
      mode: "natural" as Mode,
      view: { x0, y0, x1, y1, width: 1_700, height: Math.round(1_700 * (y1 - y0) / (x1 - x0)), exposure: 1.5 },
    };
  })(),
  {
    file: "10-whale-fall.png",
    title: "Whale fall on the abyssal plain",
    caption: `A whale carcass at x 13.80 km, ${Math.round(world.terrain.surfaceAt(13_800))} m. Rare, and the only real concentration of calories down here -- a decade-long feast that supports its own succession of scavengers.`,
    mode: "natural",
    view: {
      x0: 13_730, y0: Math.round(world.terrain.surfaceAt(13_800)) - 42,
      x1: 13_880, y1: Math.round(world.terrain.surfaceAt(13_800)) + 12,
      width: 1_500, height: 540, exposure: 2.8,
    },
  },
  (() => {
    // The upper wall is near-vertical, which gave a 1600x4747 frame. Use the
    // canyon floor instead: same community, a window you can actually look at.
    const x0 = 10_020, x1 = 10_140;
    const s0 = world.terrain.surfaceAt(x0), s1 = world.terrain.surfaceAt(x1);
    const y0 = Math.round(Math.min(s0, s1)) - 26;
    const y1 = Math.round(Math.max(s0, s1)) + 10;
    return {
      file: "11-canyon-floor.png",
      title: "Canyon floor, deep-water garden",
      caption: `x 10.02-10.14 km, about ${Math.round(s0)} m on the floor of Mirador Canyon (exposure pushed; it is pitch dark down here). Glass sponges, bamboo and black coral and crinoids -- a current-swept community in total darkness, living on what the canyon funnels down from the shelf 10 km away.`,
      mode: "natural" as Mode,
      view: { x0, y0, x1, y1, width: 1_600, height: Math.round(1_600 * (y1 - y0) / (x1 - x0)), exposure: 2.6 },
    };
  })(),
  {
    file: "09-seamount.png",
    title: "Varu Seamount",
    caption: "x 17.40-19.40 km, 900-2,600 m. A basalt cone rising 1.3 km off the abyssal plain into the twilight zone: an isolated oasis in open water.",
    mode: "natural", view: { x0: 17_400, y0: 900, x1: 19_400, y1: 2_600, width: 1_200, height: 1_020, exposure: 1.6 },
  },
];

mkdirSync(OUT, { recursive: true });

const timings: Array<{ job: Job; ms: number; px: number }> = [];
for (const job of JOBS) {
  const t0 = process.hrtime.bigint();
  const raster = renderView(world, job.view, job.mode);
  writeFileSync(resolve(OUT, job.file), encodePNG(job.view.width, job.view.height, raster.data));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const px = job.view.width * job.view.height;
  timings.push({ job, ms, px });
  console.log(`${job.file.padEnd(26)} ${job.view.width}x${job.view.height}  ${ms.toFixed(0)} ms`);
}

// ---------------------------------------------------------------------------
// Probe a transect so the numbers can be sanity-checked without a browser.
// ---------------------------------------------------------------------------
const PROBES: Array<[number, number, string]> = [
  [1_550, 24, "kelp understory"],
  [3_500, 54, "sand flats"],
  [4_700, 12, "back-reef lagoon"],
  [4_950, 10, "reef crest"],
  [5_800, 100, "dropoff wall"],
  [7_200, 190, "outer shelf"],
  [9_900, 1_900, "canyon floor"],
  [12_000, 900, "slope midwater"],
  [16_320, 2_300, "vent field"],
  [18_400, 1_250, "seamount summit"],
];

console.log("");
for (const [x, y, label] of PROBES) {
  console.log(`${label.padEnd(18)} ${world.describe(x, y)}`);
}

// Which biomes actually occur? A biome defined but never produced is a bug.
const occurrence = new Map<BiomeId, number>();
for (let x = 10; x < world.width; x += 40) {
  const bed = world.terrain.bed(x);
  for (const y of [bed - 3, bed * 0.5, Math.min(bed * 0.5, 120), 600, 1_500]) {
    if (y <= 0 || y >= world.maxDepth) continue;
    const id = world.biomeAt(x, y);
    occurrence.set(id, (occurrence.get(id) ?? 0) + 1);
  }
}
console.log("");
console.log("biome coverage (samples):");
for (const id of Object.keys(BIOMES) as BiomeId[]) {
  const n = occurrence.get(id) ?? 0;
  console.log(`  ${n === 0 ? "MISSING " : "        "}${id.padEnd(20)} ${n}`);
}

// ---------------------------------------------------------------------------
// HTML sheet
// ---------------------------------------------------------------------------
const labelFor = (f: { name: string; x0: number; x1: number; labelDepth: number }) => {
  const cx = ((f.x0 + f.x1) / 2 / world.width) * 100;
  const cy = (f.labelDepth / world.maxDepth) * 100;
  return `<div class="feat" style="left:${cx.toFixed(2)}%;top:${cy.toFixed(2)}%">
      <span class="dot"></span><span class="txt">${f.name}</span>
    </div>`;
};

const depthTicks = [0, 200, 500, 1000, 1500, 2000, 2500]
  .map((d) => `<div class="tick" style="top:${((d / world.maxDepth) * 100).toFixed(2)}%"><span>${d} m</span></div>`)
  .join("");

const kmTicks = Array.from({ length: 11 }, (_, i) => i * 2)
  .map((km) => `<div class="ktick" style="left:${((km * 1000 / world.width) * 100).toFixed(2)}%"><span>${km} km</span></div>`)
  .join("");

const legend = (Object.keys(BIOMES) as BiomeId[])
  .map((id) => `<li><i style="background:${cssHex(BIOME_COLOR[id])}"></i><b>${BIOMES[id].name}</b><em>${BIOMES[id].note}</em></li>`)
  .join("");

const panels = JOBS.map((job, i) => {
  const t = timings[i];
  const overlay = job.overview
    ? `<div class="overlay">${world.features.map(labelFor).join("")}${depthTicks}${kmTicks}</div>`
    : "";
  const mpp = ((job.view.x1 - job.view.x0) / job.view.width).toFixed(2);
  return `<section>
    <h2>${job.title}</h2>
    <div class="frame${job.overview ? " ov" : ""}">
      <img src="${job.file}" alt="${job.title}">
      ${overlay}
    </div>
    <p class="cap">${job.caption}</p>
    <p class="meta">${job.view.width}&times;${job.view.height} px &middot; ${mpp} m/px &middot; rendered in ${t.ms.toFixed(0)} ms</p>
  </section>`;
}).join("\n");

const probeRows = PROBES
  .map(([x, y, label]) => `<tr><td>${label}</td><td>${world.describe(x, y).split("  |  ").join("</td><td>")}</td></tr>`)
  .join("");

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Ocean Evolution &mdash; world ${seed}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { --bg:#070d14; --panel:#0d1620; --ink:#dce8f2; --dim:#7d93a6; --line:#1d2b3a; --accent:#49c7e0; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
         font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  .wrap { max-width:1360px; margin:0 auto; padding:40px 16px 90px; }
  h1 { font-size:30px; margin:0 0 4px; letter-spacing:-0.01em; }
  .sub { color:var(--dim); margin:0 0 34px; }
  .sub code { color:var(--accent); background:#0e1b26; padding:2px 6px; border-radius:4px; }
  section { margin:0 0 40px; }
  h2 { font-size:17px; margin:0 0 10px; font-weight:600; }
  .frame { position:relative; border:1px solid var(--line); border-radius:8px; overflow:hidden; background:#000; }
  .frame img { display:block; width:100%; height:auto; }
  .overlay { position:absolute; inset:0; pointer-events:none; }
  .feat { position:absolute; transform:translate(-50%,-50%); display:flex; align-items:center; gap:5px; white-space:nowrap; }
  .feat .dot { width:5px; height:5px; border-radius:50%; background:#fff; box-shadow:0 0 0 2px rgba(0,0,0,.55); flex:0 0 auto; }
  .feat .txt { font-size:11px; font-weight:600; letter-spacing:.02em;
               color:#fff; text-shadow:0 1px 3px rgba(0,0,0,.95),0 0 10px rgba(0,0,0,.8); }
  .tick { position:absolute; left:0; right:0; border-top:1px dashed rgba(255,255,255,.14); }
  .tick span { position:absolute; left:4px; top:1px; font-size:10px; color:rgba(255,255,255,.5); }
  .ktick { position:absolute; top:0; bottom:0; border-left:1px dashed rgba(255,255,255,.09); }
  .ktick span { position:absolute; bottom:2px; left:3px; font-size:10px; color:rgba(255,255,255,.45); }
  .cap { color:var(--dim); margin:10px 0 2px; max-width:92ch; }
  .meta { color:#4e6475; font-size:12px; margin:0; font-variant-numeric:tabular-nums; }
  ul.legend { list-style:none; padding:0; margin:0; display:grid; gap:7px 22px;
              grid-template-columns:repeat(auto-fit,minmax(310px,1fr)); }
  ul.legend li { display:flex; align-items:baseline; gap:9px; font-size:13px; }
  ul.legend i { width:13px; height:13px; border-radius:3px; flex:0 0 auto; position:relative; top:2px;
                box-shadow:inset 0 0 0 1px rgba(255,255,255,.18); }
  ul.legend em { color:var(--dim); font-style:normal; }
  table { border-collapse:collapse; width:100%; font-size:12.5px; font-variant-numeric:tabular-nums; }
  th,td { text-align:left; padding:5px 10px 5px 0; border-bottom:1px solid var(--line); white-space:nowrap; }
  td:first-child { color:var(--accent); }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:22px 24px; margin:0 0 40px; }
  .card h2 { margin-top:0; }
  @media (max-width:700px) { .feat .txt { display:none; } }
</style></head><body><div class="wrap">
<h1>Ocean Evolution &mdash; generated world</h1>
<p class="sub">Seed <code>${seed}</code> &middot; ${(world.width / 1000).toFixed(0)} km &times; ${world.maxDepth} m &middot; regenerate with <code>npm run map</code></p>
${panels}
<div class="card"><h2>Environmental probes</h2>
<table><thead><tr><th>Site</th><th>Position</th><th>Feature</th><th>Habitat</th><th>Temp</th><th>Light</th><th>O&#8322;</th><th>Plankton</th><th>Current</th></tr></thead>
<tbody>${probeRows}</tbody></table></div>
<div class="card"><h2>Habitats</h2><ul class="legend">${legend}</ul></div>
</div></body></html>`;

writeFileSync(resolve(OUT, "map.html"), html);
console.log(`\nwrote ${JOBS.length} images + map.html to ${OUT}`);
