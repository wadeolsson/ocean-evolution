/** A tiny RGB raster with alpha blending and line/disc drawing. */

export class Raster {
  readonly data: Uint8Array;

  constructor(readonly width: number, readonly height: number) {
    this.data = new Uint8Array(width * height * 3);
  }

  set(x: number, y: number, hex: number): void {
    const xi = x | 0, yi = y | 0;
    if (xi < 0 || yi < 0 || xi >= this.width || yi >= this.height) return;
    const i = (yi * this.width + xi) * 3;
    this.data[i] = (hex >> 16) & 255;
    this.data[i + 1] = (hex >> 8) & 255;
    this.data[i + 2] = hex & 255;
  }

  blend(x: number, y: number, hex: number, a: number): void {
    if (a <= 0) return;
    const xi = x | 0, yi = y | 0;
    if (xi < 0 || yi < 0 || xi >= this.width || yi >= this.height) return;
    const k = a > 1 ? 1 : a;
    const i = (yi * this.width + xi) * 3;
    this.data[i] += ((((hex >> 16) & 255) - this.data[i]) * k) | 0;
    this.data[i + 1] += ((((hex >> 8) & 255) - this.data[i + 1]) * k) | 0;
    this.data[i + 2] += (((hex & 255) - this.data[i + 2]) * k) | 0;
  }

  /** Multiply a pixel's brightness in place. */
  shade(x: number, y: number, f: number): void {
    const xi = x | 0, yi = y | 0;
    if (xi < 0 || yi < 0 || xi >= this.width || yi >= this.height) return;
    const i = (yi * this.width + xi) * 3;
    for (let c = 0; c < 3; c++) {
      const v = this.data[i + c] * f;
      this.data[i + c] = v > 255 ? 255 : v < 0 ? 0 : v | 0;
    }
  }

  disc(cx: number, cy: number, r: number, hex: number, a = 1): void {
    const r2 = r * r;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const d2 = (x - cx) ** 2 + (y - cy) ** 2;
        if (d2 > r2) continue;
        const edge = 1 - Math.max(0, Math.sqrt(d2) - (r - 1));
        this.blend(x, y, hex, a * Math.max(0, Math.min(1, edge)));
      }
    }
  }

  line(x0: number, y0: number, x1: number, y1: number, hex: number, w = 1, a = 1): void {
    const dx = x1 - x0, dy = y1 - y0;
    const n = Math.max(1, Math.ceil(Math.hypot(dx, dy) * 1.5));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = x0 + dx * t, y = y0 + dy * t;
      if (w <= 1) this.blend(x, y, hex, a * w);
      else this.disc(x, y, w * 0.5, hex, a);
    }
  }
}
