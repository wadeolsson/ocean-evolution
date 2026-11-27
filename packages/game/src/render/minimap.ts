/** A world-wide cross-section strip at the foot of the screen, with a camera marker. */

import { Container, Graphics } from "pixi.js";
import { BIOME_COLOR, World, waterColor } from "@ocean/sim";

const H = 64;

export class Minimap {
  readonly container = new Container();
  private readonly base = new Graphics();
  private readonly marker = new Graphics();
  private builtW = -1;

  constructor(private readonly world: World) {
    this.container.addChild(this.base, this.marker);
  }

  update(camX: number, camY: number, screenW: number, screenH: number): void {
    const w = screenW - 24;
    if (w !== this.builtW) { this.build(w); this.builtW = w; }
    this.container.position.set(12, screenH - H - 12);

    const mx = (camX / this.world.width) * w;
    const my = (camY / this.world.maxDepth) * H;
    const m = this.marker;
    m.clear();
    m.moveTo(mx, 0); m.lineTo(mx, H);
    m.stroke({ width: 1, color: 0x6fd8ef, alpha: 0.5 });
    m.circle(mx, my, 3.5);
    m.fill({ color: 0xffffff });
    m.circle(mx, my, 6.5);
    m.stroke({ width: 1.2, color: 0x6fd8ef, alpha: 0.9 });
  }

  private build(w: number): void {
    const g = this.base;
    g.clear();
    g.roundRect(0, 0, w, H, 6);
    g.fill({ color: 0x03121e, alpha: 0.86 });

    const cols = Math.max(80, Math.floor(w));
    for (let i = 0; i < cols; i++) {
      const wx = (i / cols) * this.world.width;
      const bed = this.world.terrain.bed(wx);
      const by = (bed / this.world.maxDepth) * H;
      g.rect(i * (w / cols), 0, w / cols + 0.6, by);
      g.fill({ color: waterColor(bed * 0.5), alpha: 0.8 });
      // A band of habitat colour along the seabed makes the strip readable.
      g.rect(i * (w / cols), by, w / cols + 0.6, 3);
      g.fill({ color: BIOME_COLOR[this.world.biomeAt(wx, Math.max(1, bed - 2))] });
      g.rect(i * (w / cols), by + 3, w / cols + 0.6, H - by - 3);
      g.fill({ color: 0x1b1813 });
    }
    g.roundRect(0.5, 0.5, w - 1, H - 1, 6);
    g.stroke({ width: 1, color: 0x2a4b5e, alpha: 0.8 });
  }
}
