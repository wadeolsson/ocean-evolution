/**
 * Flora, redrawn every frame for the visible window so it can sway.
 *
 * Instances are derived from position (see sim/world/flora.ts), not stored, so
 * this is a pure function of the camera window and the clock: there is no flora
 * state to keep in sync, and the same plants appear whichever direction you
 * arrive from. Body geometry comes from sim/world/floraDraw.ts, shared with the
 * offline map renderer so the two cannot drift apart.
 */

import { Graphics } from "pixi.js";
import { World, clamp01, drawFlora, drawVentPlume, lerp, type ScatterPiece, type Strand } from "@ocean/sim";
import { GraphicsSink } from "./graphicsSink";

export class FloraView {
  readonly graphics = new Graphics();
  private readonly sink = new GraphicsSink(this.graphics);
  private cache: Strand[] = [];
  /** Chimneys live in the static terrain chunks, but their plumes animate. */
  private vents: ScatterPiece[] = [];
  private cachedFrom = NaN;
  private cachedTo = NaN;
  visible = 0;

  constructor(private readonly world: World) {}

  private lastDraw = -1;
  private lastCamX = NaN;
  private lastZoom = NaN;

  /**
   * Flora is redrawn at ~30 Hz rather than every frame. Sway runs at about
   * 0.9 rad/s, so a third of the frames carry no visible change, and rebuilding
   * a few thousand Graphics primitives was costing half the frame budget on a
   * 120 Hz display.
   */
  update(x0: number, x1: number, time: number, zoom: number): void {
    const moved = Math.abs(x0 - this.lastCamX) > 0.25 || zoom !== this.lastZoom;
    if (!moved && this.lastDraw >= 0 && time - this.lastDraw < 1 / 36) return;
    this.lastDraw = time;
    this.lastCamX = x0;
    this.lastZoom = zoom;

    const pad = 30;
    const from = x0 - pad;
    const to = x1 + pad;
    // Only re-derive when the window leaves the cached range: the per-frame
    // cost should be drawing, not generation.
    if (Number.isNaN(this.cachedFrom) || from < this.cachedFrom || to > this.cachedTo) {
      const span = (to - from) * 0.6;
      this.cachedFrom = from - span;
      this.cachedTo = to + span;
      this.cache = this.world.strands(this.cachedFrom, this.cachedTo);
      this.vents = this.world.scatter(this.cachedFrom, this.cachedTo)
        .filter((p) => p.kind === "vent_chimney");
    }

    this.graphics.clear();
    // Detail scales with zoom: sub-elements (kelp blades, coral forks, urchin
    // spines) are wasted geometry when a plant is four pixels tall.
    const detail = clamp01((zoom - 0.8) / 2.2);
    let drawn = 0;

    for (const s of this.cache) {
      if (s.x < from || s.x > to) continue;
      const fade = lerp(0.42, 1, Math.exp(-s.y / 750));
      // Cull anything smaller than a pixel or two.
      if (s.height * zoom < 1.2) continue;
      drawFlora(s, { time, detail, fade, dark: this.world.env.darkness(s.y) }, this.sink);
      drawn++;
    }

    // Plumes last: they are smoke in the water column, in front of everything.
    for (const p of this.vents) {
      if (p.x < from - p.h * 4 || p.x > to + p.h * 4) continue;
      drawVentPlume(p, { time, detail, fade: lerp(0.55, 1, Math.exp(-p.y / 900)), dark: 1 }, this.sink);
    }
    this.visible = drawn;
  }
}
