/** Adapts the shared flora/scatter geometry onto a Pixi Graphics. */

import type { Graphics } from "pixi.js";
import type { FloraSink } from "@ocean/sim";

export class GraphicsSink implements FloraSink {
  constructor(public g: Graphics) {}

  line(pts: readonly number[], width: number, color: number, alpha: number): void {
    this.g.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) this.g.lineTo(pts[i], pts[i + 1]);
    this.g.stroke({ width: Math.max(0.02, width), color, alpha, cap: "round", join: "round" });
  }

  disc(x: number, y: number, r: number, color: number, alpha: number): void {
    this.g.circle(x, y, r);
    this.g.fill({ color, alpha });
  }

  poly(pts: readonly number[], color: number, alpha: number): void {
    this.g.poly(pts as number[]);
    this.g.fill({ color, alpha });
  }
}
