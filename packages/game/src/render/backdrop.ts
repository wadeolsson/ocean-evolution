/**
 * Water column, parallax silhouettes and suspended particulate.
 *
 * Everything here is screen-space and cheap. The parallax layers are the same
 * seabed curve sampled at reduced amplitude -- enough to give the open ocean a
 * sense of distance and scale, which is most of what sells "this is enormous".
 */

import { Container, Graphics } from "pixi.js";
import { World, clamp01, hash2, lerp, mixHex, rampHex, shadeHex, smoothstep, waterColor } from "@ocean/sim";

const BANDS = 54;

/** Above the waterline, by metres of altitude. */
const SKY: ReadonlyArray<readonly [number, number]> = [
  [0, 0xcfeef7],
  [40, 0x9ad4ee],
  [160, 0x6aaedb],
  [600, 0x3f7fba],
];

export class Backdrop {
  readonly container = new Container();
  private readonly water = new Graphics();
  private readonly far = new Graphics();
  private readonly near = new Graphics();
  private readonly motes = new Graphics();
  private readonly flow = new Graphics();
  /** Drawn OVER the world, so it must live in its own container. */
  readonly fogContainer = new Container();
  private readonly fog = new Graphics();
  moteCount = 0;
  visibility = 0;
  private fogKey = "";

  constructor(private readonly world: World) {
    this.container.addChild(this.water, this.far, this.near, this.motes, this.flow);
    this.fogContainer.addChild(this.fog);
  }

  update(
    camX: number, camY: number, zoom: number,
    screenW: number, screenH: number, time: number,
  ): void {
    const y0 = camY - screenH / zoom / 2;
    const y1 = camY + screenH / zoom / 2;
    const x0 = camX - screenW / zoom / 2;
    const x1 = camX + screenW / zoom / 2;

    // --- water column as horizontal bands ---
    const g = this.water;
    g.clear();
    const bandH = screenH / BANDS;
    for (let i = 0; i < BANDS; i++) {
      const depth = lerp(y0, y1, (i + 0.5) / BANDS);
      let c: number;
      if (depth < 0) {
        // Above the waterline is sky, not water. Clamping depth to 0 here painted
        // the whole upper half of the screen in surface-turquoise.
        c = rampHex(SKY, -depth);
      } else {
        c = waterColor(depth);
        // Sunlight shafts, strongest just under the surface.
        const shaft = Math.max(0, Math.sin(camX * 0.004 + time * 0.08)) * Math.exp(-depth / 110);
        c = mixHex(c, 0xdffbff, 0.1 * shaft);
      }
      g.rect(0, i * bandH, screenW, bandH + 1);
      g.fill({ color: c });
    }
    // Surface, if it is on screen.
    if (y0 < 0 && y1 > 0) {
      const sy = (0 - y0) * zoom;
      // Underside of the surface: a bright, slightly rippled mirror line.
      const segs = 48;
      for (let i = 0; i < segs; i++) {
        const wx = lerp(x0, x1, (i + 0.5) / segs);
        const ripple = Math.sin(wx * 0.18 + time * 1.3) * 0.6 + Math.sin(wx * 0.07 - time * 0.8) * 0.9;
        g.rect((i / segs) * screenW, sy - 1.5 + ripple * zoom * 0.12, screenW / segs + 1, 2.5);
        g.fill({ color: 0xf2fdff, alpha: 0.65 });
      }
    }

    // --- parallax seabed silhouettes ---
    this.drawParallax(this.far, 0.42, 0.55, 0x0a3550, 0.55, camX, camY, zoom, screenW, screenH);
    this.drawParallax(this.near, 0.68, 0.78, 0x072638, 0.6, camX, camY, zoom, screenW, screenH);

    // --- suspended particulate, streaked along the flow ---
    // Round dots told you nothing about the water. Drawing each mote as a short
    // streak aligned with the local current turns the whole field into
    // something you can read at a glance: speed, direction, shear near the bed,
    // the return flow at depth, the upwelling at the west end.
    const m = this.motes;
    m.clear();
    // Spacing in METRES follows the zoom, or the water looks empty close in
    // and solid far out.
    const cell = Math.min(26, Math.max(0.7, 24 / zoom));
    const i0 = Math.floor(x0 / cell), i1 = Math.ceil(x1 / cell);
    const j0 = Math.floor(y0 / cell), j1 = Math.ceil(y1 / cell);
    const maxMotes = 1_100;
    let n = 0;
    for (let j = j0; j <= j1 && n < maxMotes; j++) {
      for (let i = i0; i <= i1 && n < maxMotes; i++) {
        const h = hash2(4211, i, j);
        const wy0 = j * cell + hash2(913, i, j) * cell;
        if (wy0 < 0) continue;
        const wx0 = i * cell + hash2(577, i, j) * cell;
        const density = 0.1 + 0.55 * this.world.env.plankton(wx0, wy0);
        if (h > density) continue;

        // Advect the mote along the current, looping over a fixed period so no
        // state is needed and the field stays a pure function of (i, j, time).
        const cur = this.world.env.current(wx0, wy0, time);
        const PERIOD = 26;
        const age = (time + h * PERIOD) % PERIOD;
        const wx = wx0 + cur.x * age;
        const wy = wy0 + cur.y * age;
        const sx = (wx - camX) * zoom + screenW / 2;
        const sy = (wy - camY) * zoom + screenH / 2;
        if (sx < -12 || sy < -12 || sx > screenW + 12 || sy > screenH + 12) continue;

        // Fade in and out so the loop never pops.
        const life = Math.sin((age / PERIOD) * Math.PI);
        const speed = Math.hypot(cur.x, cur.y);
        const tail = Math.min(26, speed * 5.5 * zoom);
        const alpha = (0.12 + 0.34 * hash2(7, i, j)) * life;
        if (tail > 1.6) {
          m.moveTo(sx - cur.x * 5.5 * zoom, sy - cur.y * 5.5 * zoom);
          m.lineTo(sx, sy);
          m.stroke({ width: lerp(0.8, 1.8, hash2(331, i, j)), color: 0xeaf6ff, alpha, cap: "round" });
        } else {
          m.circle(sx, sy, lerp(0.7, 1.7, hash2(331, i, j)));
          m.fill({ color: 0xeaf6ff, alpha });
        }
        n++;
      }
    }
    this.moteCount = n;
  }

  /**
   * Water haze: everything past the local visual range fades into the ambient
   * water colour. In a side view there is no depth axis to fog along, so range
   * is applied radially from the camera -- which is what actually limits what
   * a fish can see anyway.
   *
   * This replaces the map renderer's exposure hack with a model: the abyss is
   * dark because there is no light, and the shallows are hazy because they are
   * full of plankton, and those are different limits with different looks.
   */
  drawVisibility(
    camX: number, camY: number, zoom: number,
    screenW: number, screenH: number, enabled: boolean,
  ): void {
    const range = this.world.env.visibility(camX, Math.max(0, camY));
    this.visibility = range;

    const haze = mixHex(waterColor(Math.max(0, camY)), 0x000000, 0.25);
    const cx = screenW / 2, cy = screenH / 2;
    const corner = Math.hypot(screenW, screenH) / 2;
    // Haze only makes sense at something like gameplay scale. Thirty metres of
    // visibility across a 666 m survey view blanks the entire screen, which is
    // physically honest and completely useless -- so it fades out as you zoom
    // out past the range a creature would actually occupy.
    const survey = smoothstep(6, 2.2, zoom);
    const strength = (enabled ? 1 : 0) * (1 - survey);
    // Silhouettes carry much further than colour does underwater, so the ramp
    // runs well past the nominal range rather than cutting off at it.
    const r0 = range * 0.8 * zoom;
    const r1 = range * 3.5 * zoom;

    // Big translucent fills are pure overdraw, and the haze only changes when
    // the camera's depth or zoom does. Rebuild on change, not every frame.
    const key = `${Math.round(r0)}|${Math.round(r1)}|${haze}|${strength.toFixed(2)}|${screenW}x${screenH}`;
    if (key === this.fogKey) return;
    this.fogKey = key;

    const g = this.fog;
    g.clear();
    if (strength < 0.01 || r0 > corner) return;

    // Concentric ANNULI, drawn as thick strokes.
    //
    // Stacked filled discs do the opposite of what is wanted: every disc covers
    // the centre, so alpha accumulates to opaque in the middle and thins toward
    // the edge. A stroked circle covers only its own ring, so each band can
    // carry its final alpha directly.
    const BANDS = 18;
    for (let i = 0; i < BANDS; i++) {
      const t0 = i / BANDS;
      const t1 = (i + 1) / BANDS;
      const ri0 = lerp(r0, r1, t0);
      const ri1 = lerp(r0, r1, t1);
      const a = Math.pow((t0 + t1) * 0.5, 1.4) * 0.88 * strength;
      if (a < 0.004) continue;
      g.circle(cx, cy, (ri0 + ri1) * 0.5);
      g.stroke({ width: ri1 - ri0 + 1, color: haze, alpha: a });
    }
    // Everything past the outer ring is full haze.
    const outer = Math.max(2, corner * 1.7 - r1);
    if (r1 < corner * 1.7) {
      g.circle(cx, cy, r1 + outer * 0.5);
      g.stroke({ width: outer, color: haze, alpha: 0.88 * strength });
    }
  }

  /** Debug overlay: the raw current field as arrows. Toggled with C. */
  drawCurrentField(
    camX: number, camY: number, zoom: number,
    screenW: number, screenH: number, time: number, on: boolean,
  ): void {
    const g = this.flow;
    g.clear();
    if (!on) return;
    const STEP = 58; // pixels between arrows
    for (let py = STEP * 0.5; py < screenH; py += STEP) {
      for (let px = STEP * 0.5; px < screenW; px += STEP) {
        const wx = camX + (px - screenW / 2) / zoom;
        const wy = camY + (py - screenH / 2) / zoom;
        if (wy < 0 || this.world.terrain.density(wx, wy) > 0) continue;
        const cur = this.world.env.current(wx, wy, time);
        const speed = Math.hypot(cur.x, cur.y);
        const k = Math.min(1, speed / 0.45);
        const len = 8 + 26 * k;
        const ux = speed > 1e-6 ? cur.x / speed : 1;
        const uy = speed > 1e-6 ? cur.y / speed : 0;
        const ex = px + ux * len, ey = py + uy * len;
        const col = mixHex(0x2fa7c9, 0xffe08a, k);
        g.moveTo(px - ux * len * 0.5, py - uy * len * 0.5);
        g.lineTo(ex, ey);
        g.stroke({ width: 1.4, color: col, alpha: 0.55 });
        // Arrow head.
        g.moveTo(ex, ey);
        g.lineTo(ex - ux * 5 - uy * 3.2, ey - uy * 5 + ux * 3.2);
        g.moveTo(ex, ey);
        g.lineTo(ex - ux * 5 + uy * 3.2, ey - uy * 5 - ux * 3.2);
        g.stroke({ width: 1.4, color: col, alpha: 0.55 });
      }
    }
  }

  private drawParallax(
    g: Graphics, parallax: number, flatten: number, color: number, alpha: number,
    camX: number, camY: number, zoom: number, screenW: number, screenH: number,
  ): void {
    g.clear();
    const samples = 70;
    const span = screenW / zoom;
    const pts: number[] = [];
    // Distant terrain sits at roughly the *local* seabed depth with its relief
    // muted, not at a fraction of the absolute depth: scaling depth put the far
    // ridge 900 m above the camera in the canyon, i.e. off the top of the screen.
    const pivot = this.world.terrain.bed(Math.max(0, Math.min(this.world.width, camX)));
    for (let i = 0; i <= samples; i++) {
      // Sampling a *compressed* slice of the world is what produces parallax:
      // the distant ridge slides past more slowly than the foreground.
      const wx = camX * parallax + (i / samples - 0.5) * span;
      const bed = this.world.terrain.bed(Math.max(0, Math.min(this.world.width, wx)));
      const wy = pivot + (bed - pivot) * flatten;
      pts.push((i / samples) * screenW, (wy - camY) * zoom + screenH / 2);
    }
    g.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
    g.lineTo(screenW, screenH + 10);
    g.lineTo(0, screenH + 10);
    g.closePath();
    const depthFade = clamp01(1 - smoothstep(300, 2_000, camY));
    g.fill({ color: shadeHex(color, 0.5 + 0.5 * depthFade), alpha });
  }
}
