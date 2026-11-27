/**
 * Chunked terrain rendering.
 *
 * Rock is taken from the density field as vertical spans per column rather than
 * as stitched polygons: spans handle caves, tunnels and overhangs with no
 * topology work and cannot produce a degenerate polygon.
 *
 * Those spans are then drawn as *trapezoid strips between adjacent columns*,
 * not as flat-topped rectangles. Rectangles gave every rock surface a visible
 * staircase, because each column's top edge was flat and the next one started
 * at a different height; a strip interpolates between them, so the surface and
 * every cave mouth come out smooth at any zoom.
 *
 * Each 120 m chunk is built once and cached, so flying across the world costs
 * one chunk build per 120 m travelled rather than a rebuild per frame.
 */

import { Container, Graphics } from "pixi.js";
import {
  BIOME_COLOR, Noise2D, World, drawScatter, fbm, lerp, mixHex, shadeHex,
  smoothstep, substrateColor, type BiomeId,
} from "@ocean/sim";
import { GraphicsSink } from "./graphicsSink";

const KEEP_MARGIN = 3;    // chunks kept beyond the viewport before eviction

/**
 * Column resolution has to follow the zoom. Strips interpolate linearly between
 * sampled columns, so a 1 m step that is invisible at 3 px/m becomes 30 px of
 * flat facet at 30 px/m. Chunk width shrinks with it so a high-detail chunk is
 * still cheap to build.
 *
 * Discrete rungs, not a continuous function: every change throws away every
 * cached chunk, so this must not react to each scroll-wheel click.
 */
const LODS: ReadonlyArray<{ minZoom: number; step: number; chunk: number; bands: number; deep: number }> = [
  { minZoom: 14, step: 0.12, chunk: 26, bands: 7, deep: 5 },
  { minZoom: 7, step: 0.25, chunk: 48, bands: 7, deep: 5 },
  { minZoom: 3.5, step: 0.5, chunk: 72, bands: 6, deep: 4 },
  { minZoom: 1.6, step: 0.8, chunk: 110, bands: 4, deep: 3 },
  { minZoom: 0, step: 1.3, chunk: 170, bands: 3, deep: 2 },
];

function lodFor(zoom: number): { step: number; chunk: number; bands: number; deep: number } {
  for (const l of LODS) if (zoom >= l.minZoom) return l;
  return LODS[LODS.length - 1];
}
const CRUST_M = 20;       // lit crust thickness, metres
const MATCH_TOL = 9;      // metres: how far a span may move between columns

interface Column {
  x: number;
  bed: number;
  hard: number;
  benthic: BiomeId;
  spans: Array<[number, number]>;
}

export class TerrainView {
  readonly container = new Container();
  private readonly chunks = new Map<number, Graphics>();
  private readonly nMottle: Noise2D;
  private step = 1.3;
  private chunkW = 170;
  private bands = 3;
  private deepBands = 2;
  private builtMargin = 400;

  constructor(private readonly world: World) {
    this.nMottle = new Noise2D(`${world.seed}/rock-mottle`);
  }

  /** Build/evict chunks so the given world window is covered. */
  update(x0: number, x1: number, yTop: number, yBottom: number, zoom: number): void {
    const lod = lodFor(zoom);
    if (lod.step !== this.step) {
      this.step = lod.step;
      this.chunkW = lod.chunk;
      this.bands = lod.bands;
      this.deepBands = lod.deep;
      this.invalidate();
    }
    const first = Math.floor(x0 / this.chunkW);
    const last = Math.floor(x1 / this.chunkW);

    for (let i = first; i <= last; i++) {
      if (this.chunks.has(i)) continue;
      const g = this.build(i, yTop, yBottom);
      this.chunks.set(i, g);
      this.container.addChild(g);
    }
    for (const [i, g] of this.chunks) {
      if (i < first - KEEP_MARGIN || i > last + KEEP_MARGIN) {
        this.container.removeChild(g);
        g.destroy();
        this.chunks.delete(i);
      }
    }
  }

  /** Chunks are built for a depth window; a big vertical move invalidates them. */
  invalidate(): void {
    for (const [, g] of this.chunks) { this.container.removeChild(g); g.destroy(); }
    this.chunks.clear();
  }

  get chunkCount(): number { return this.chunks.size; }

  get columnStep(): number { return this.step; }

  /** Vertical margin the current chunks were built with. */
  get margin(): number { return this.builtMargin; }

  private column(x: number, top: number, bottom: number): Column {
    const t = this.world.terrain;
    const bed = t.bed(x);
    return {
      x,
      bed,
      hard: t.hardness(x),
      benthic: this.world.biomeAt(x, Math.max(1, bed - 2)),
      spans: t.columnSpans(x, top, bottom, Math.min(0.9, Math.max(0.15, this.step))),
    };
  }

  private build(index: number, yTop: number, yBottom: number): Graphics {
    const g = new Graphics();
    const xStart = index * this.chunkW;
    // Vertical margin must scale with the viewport, not be a flat 400 m. At
    // 11 px/m a fixed margin meant each column sampled an 880 m span at 0.25 m
    // resolution -- about 2.7 million density evaluations before the first
    // frame could draw, which looked exactly like a hang.
    const viewH = Math.max(20, yBottom - yTop);
    const margin = Math.min(400, Math.max(40, viewH * 0.6));
    const top = Math.max(0, yTop - margin);
    const bottom = Math.min(this.world.maxDepth, yBottom + margin);
    this.builtMargin = margin;

    // Sample once, draw twice. Start a column early so strips meet seamlessly
    // across chunk borders.
    const cols: Column[] = [];
    for (let x = xStart - this.step; x <= xStart + this.chunkW; x += this.step) {
      cols.push(this.column(x, top, bottom));
    }

    // Pass 1: the insides of caves, drawn BEFORE the rock.
    //
    // A cave is water, so nothing was drawn there and the open-ocean backdrop
    // showed through -- which made every overhang look like an island floating
    // in the sea rather than a shelf with an unlit space under it.
    for (let i = 1; i < cols.length; i++) this.voidStrip(g, cols[i - 1], cols[i]);

    // Pass 2: the rock itself.
    for (let i = 1; i < cols.length; i++) this.strip(g, cols[i - 1], cols[i], top);

    // Boulders, outcrops and set-pieces are static, so they are baked into the
    // cached chunk rather than redrawn every frame like the swaying flora.
    const sink = new GraphicsSink(g);
    for (const p of this.world.scatter(xStart, xStart + this.chunkW)) {
      const fade = lerp(0.45, 1, Math.exp(-p.y / 750));
      const ground = substrateColor(this.world.terrain.hardness(p.x));
      drawScatter(p, { time: 0, detail: 1, fade, ground, dark: this.world.env.darkness(p.y) }, sink);
    }
    return g;
  }

  /**
   * The enclosed water between two rock spans: a cave chamber or passage.
   * Shaded as an unlit flooded space -- near-black, tinted by the rock around
   * it rather than by the open sea -- so the rock above and below it reads as
   * one continuous mass with a hole in it.
   */
  private voidStrip(g: Graphics, a: Column, b: Column): void {
    const gapsOf = (c: Column): Array<[number, number]> => {
      const out: Array<[number, number]> = [];
      for (let i = 0; i + 1 < c.spans.length; i++) out.push([c.spans[i][1], c.spans[i + 1][0]]);
      return out;
    };
    const ga = gapsOf(a);
    const gb = gapsOf(b);
    if (ga.length === 0 && gb.length === 0) return;

    const rock = substrateColor((a.hard + b.hard) * 0.5);
    const emit = (va: [number, number], vb: [number, number]): void => {
      const mid = (va[0] + vb[0] + va[1] + vb[1]) * 0.25;
      // Deeper into the rock, less of anything reaches it.
      const sun = lerp(0.28, 0.75, Math.exp(-mid / 500));
      g.poly([a.x, va[0], b.x, vb[0], b.x, vb[1], a.x, va[1]]);
      g.fill({ color: shadeHex(mixHex(0x0a0c10, rock, 0.3), sun) });
    };

    const matched = new Set<number>();
    for (const vb of gb) {
      let best = -1;
      let bestD = MATCH_TOL;
      for (let i = 0; i < ga.length; i++) {
        const d = Math.abs(ga[i][0] - vb[0]);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best >= 0) matched.add(best);
      emit(best >= 0 ? ga[best] : vb, vb);
    }
    // A void present in one column but not its neighbour still has to be
    // filled, or a one-column sliver of open-ocean blue shows through the
    // middle of a cave.
    for (let i = 0; i < ga.length; i++) {
      if (!matched.has(i)) emit(ga[i], ga[i]);
    }
  }

  /** Draw the rock between two adjacent columns as banded trapezoids. */
  private strip(g: Graphics, a: Column, b: Column, top: number): void {
    const matched = new Set<number>();

    for (const sb of b.spans) {
      let best = -1;
      let bestD = MATCH_TOL;
      for (let i = 0; i < a.spans.length; i++) {
        const d = Math.abs(a.spans[i][0] - sb[0]);
        if (d < bestD) { bestD = d; best = i; }
      }
      const sa = best >= 0 ? a.spans[best] : sb;
      if (best >= 0) matched.add(best);
      this.quadBand(g, a, b, sa, sb, top);
    }

    // A span present in the previous column but not this one would leave a
    // one-column crack; close it against itself rather than dropping it.
    for (let i = 0; i < a.spans.length; i++) {
      if (!matched.has(i)) this.quadBand(g, a, b, a.spans[i], a.spans[i], top);
    }
  }

  private quadBand(
    g: Graphics, a: Column, b: Column,
    sa: [number, number], sb: [number, number],
    top: number,
  ): void {
    const bedMid = (a.bed + b.bed) * 0.5;
    const spanTop = (sa[0] + sb[0]) * 0.5;
    // How deeply this span's own surface is buried below the seabed. A cave
    // floor is still a rock surface and gets its own lit lip, just a dimmer one.
    const buried = smoothstep(0, 55, spanTop - bedMid);
    const sun = lerp(0.4, 1, Math.exp(-spanTop / 620));
    const hard = (a.hard + b.hard) * 0.5;
    const rock = substrateColor(hard);
    const crustTop = mixHex(rock, BIOME_COLOR[b.benthic], 0.3 * (1 - buried));
    // Basement colour must not depend on which span reaches it, or a cave
    // shifting a span's start tints a whole column differently from its neighbour.
    const basement = mixHex(rock, 0x241d16, 0.78);

    const BANDS = this.bands;
    const bandH = CRUST_M / BANDS;
    for (let i = 0; i < BANDS; i++) {
      const d0 = i * bandH;
      const d1 = d0 + bandH;
      const ay0 = Math.min(sa[0] + d0, sa[1]);
      const ay1 = Math.min(sa[0] + d1, sa[1]);
      const by0 = Math.min(sb[0] + d0, sb[1]);
      const by1 = Math.min(sb[0] + d1, sb[1]);
      if (ay1 - ay0 <= 0 && by1 - by0 <= 0) continue;

      const k = smoothstep(0, CRUST_M, d0 + bandH * 0.5);
      // 2D mottling. A per-column hash drew the deep rock as vertical streaks:
      // the variation has to be two-dimensional or it reads as stripes.
      const mx = (a.x + b.x) * 0.5;
      const my = spanTop + d0 + bandH * 0.5;
      const mottle = fbm(this.nMottle, mx / 11, my / 11, 3) + 0.45 * fbm(this.nMottle, mx / 2.6, my / 2.6, 2);
      let c = mixHex(crustTop, basement, k);
      c = shadeHex(c, sun * (1 + 0.13 * mottle) * lerp(1, 0.86, buried * (1 - k)));

      g.poly([a.x, ay0, b.x, by0, b.x, by1, a.x, ay1]);
      g.fill({ color: c });
    }

    // Basement below the crust. Split into bands as well: drawn as one trapezoid
    // its mottle could only be sampled at a single depth, so the variation was
    // a function of x alone and the deep rock striped vertically again.
    const aDeep = Math.min(sa[0] + CRUST_M, sa[1]);
    const bDeep = Math.min(sb[0] + CRUST_M, sb[1]);
    if (sa[1] > aDeep || sb[1] > bDeep) {
      const DEEP_BANDS = this.deepBands;
      const mx = (a.x + b.x) * 0.5;
      for (let i = 0; i < DEEP_BANDS; i++) {
        // Geometric growth: fine banding near the crust, coarse far below,
        // where nothing can see it anyway.
        const f0 = (Math.pow(2, i) - 1) / (Math.pow(2, DEEP_BANDS) - 1);
        const f1 = (Math.pow(2, i + 1) - 1) / (Math.pow(2, DEEP_BANDS) - 1);
        const ay0 = aDeep + (sa[1] - aDeep) * f0;
        const ay1 = aDeep + (sa[1] - aDeep) * f1;
        const by0 = bDeep + (sb[1] - bDeep) * f0;
        const by1 = bDeep + (sb[1] - bDeep) * f1;
        if (ay1 - ay0 <= 0 && by1 - by0 <= 0) continue;
        const my = (ay0 + ay1 + by0 + by1) * 0.25;
        const mottle = fbm(this.nMottle, mx / 24, my / 24, 3) + 0.4 * fbm(this.nMottle, mx / 6, my / 6, 2);
        g.poly([a.x, ay0, b.x, by0, b.x, by1, a.x, ay1]);
        g.fill({ color: shadeHex(basement, sun * (1 + 0.11 * mottle)) });
      }
    }

    // A bright lip along the rock surface: reads as the seabed catching light,
    // and gives the silhouette a crisp edge at every zoom level.
    if (sa[0] > top + 0.5 && sb[0] > top + 0.5) {
      g.moveTo(a.x, sa[0]);
      g.lineTo(b.x, sb[0]);
      g.stroke({ width: 0.55, color: shadeHex(crustTop, sun * 1.5), alpha: 0.9, cap: "round" });
    }
  }
}
