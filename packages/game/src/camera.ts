/** Free-flying observer camera. Replaced by a creature-follow camera in step 3. */

import { clamp } from "@ocean/sim";

export class Camera {
  x = 1_500;
  y = 24;
  /** Pixels per world metre. */
  zoom = 3.4;
  private zoomTarget = 3.4;
  vx = 0;
  vy = 0;

  constructor(readonly worldWidth: number, readonly worldDepth: number) {}

  static readonly MIN_ZOOM = 0.55;
  // 6 px/m made a 0.35 m urchin two pixels across and a barrel sponge a smudge.
  // At 30 px/m a 1600 px viewport is 53 m wide, which is the scale a small fish
  // actually lives at, and sponges and sea fans read as objects.
  static readonly MAX_ZOOM = 30;

  /** Set zoom so a feature of the given world width fills most of the viewport. */
  frame(featureWidth: number, screenW: number): void {
    this.setZoom((screenW * 0.85) / Math.max(1, featureWidth));
  }

  /** Jump straight to a zoom level, with no easing (used by the URL and jumps). */
  setZoom(z: number): void {
    const v = clamp(z, Camera.MIN_ZOOM, Camera.MAX_ZOOM);
    this.zoom = v;
    this.zoomTarget = v;
  }

  nudgeZoom(factor: number): void {
    this.zoomTarget = clamp(this.zoomTarget * factor, Camera.MIN_ZOOM, Camera.MAX_ZOOM);
  }

  update(dt: number, ax: number, ay: number, speed: number): void {
    // Critically-damped-ish motion: accelerate toward the input, bleed off fast.
    const accel = speed * 9;
    this.vx += ax * accel * dt;
    this.vy += ay * accel * dt;
    const drag = Math.pow(0.0009, dt);
    this.vx *= drag;
    this.vy *= drag;
    this.x = clamp(this.x + this.vx * dt, 20, this.worldWidth - 20);
    this.y = clamp(this.y + this.vy * dt, 1, this.worldDepth - 5);
    this.zoom += (this.zoomTarget - this.zoom) * Math.min(1, dt * 9);
  }

  /** Visible world rectangle for a given viewport size in pixels. */
  view(screenW: number, screenH: number) {
    const hw = screenW / this.zoom / 2;
    const hh = screenH / this.zoom / 2;
    return { x0: this.x - hw, y0: this.y - hh, x1: this.x + hw, y1: this.y + hh };
  }
}
