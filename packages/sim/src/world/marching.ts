/**
 * Marching squares over the density field, used only for the crisp rock outline.
 *
 * Filled rock is drawn from `Terrain.columnSpans` instead: spans handle caves and
 * overhangs with no stitching and cannot produce a self-intersecting polygon.
 * Contours are purely cosmetic here, which means a dropped segment is a cosmetic
 * bug rather than a hole in the world.
 */

import { lerp } from "../core/math";

export type Polyline = number[]; // flat [x0,y0,x1,y1,...]

interface Seg { ax: number; ay: number; bx: number; by: number; }

/** Zero-crossing contour of `sample` over the given box, as chained polylines. */
export function contour(
  sample: (x: number, y: number) => number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  cell: number,
): Polyline[] {
  const segs: Seg[] = [];
  const cols = Math.max(1, Math.ceil((x1 - x0) / cell));
  const rows = Math.max(1, Math.ceil((y1 - y0) / cell));

  // Cache one row of samples at a time: each value is used by two rows of cells.
  let top = new Float64Array(cols + 1);
  let bot = new Float64Array(cols + 1);
  for (let i = 0; i <= cols; i++) top[i] = sample(x0 + i * cell, y0);

  for (let j = 0; j < rows; j++) {
    const ya = y0 + j * cell;
    const yb = ya + cell;
    for (let i = 0; i <= cols; i++) bot[i] = sample(x0 + i * cell, yb);

    for (let i = 0; i < cols; i++) {
      const xa = x0 + i * cell;
      const xb = xa + cell;
      const v00 = top[i], v10 = top[i + 1], v01 = bot[i], v11 = bot[i + 1];
      let mask = 0;
      if (v00 > 0) mask |= 1;
      if (v10 > 0) mask |= 2;
      if (v11 > 0) mask |= 4;
      if (v01 > 0) mask |= 8;
      if (mask === 0 || mask === 15) continue;

      const tTop = () => ({ x: lerp(xa, xb, v00 / (v00 - v10)), y: ya });
      const tBot = () => ({ x: lerp(xa, xb, v01 / (v01 - v11)), y: yb });
      const tLeft = () => ({ x: xa, y: lerp(ya, yb, v00 / (v00 - v01)) });
      const tRight = () => ({ x: xb, y: lerp(ya, yb, v10 / (v10 - v11)) });

      const push = (a: { x: number; y: number }, b: { x: number; y: number }) =>
        segs.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y });

      switch (mask) {
        case 1: case 14: push(tLeft(), tTop()); break;
        case 2: case 13: push(tTop(), tRight()); break;
        case 3: case 12: push(tLeft(), tRight()); break;
        case 4: case 11: push(tRight(), tBot()); break;
        case 6: case 9:  push(tTop(), tBot()); break;
        case 7: case 8:  push(tLeft(), tBot()); break;
        case 5: push(tLeft(), tTop()); push(tRight(), tBot()); break;
        case 10: push(tTop(), tRight()); push(tLeft(), tBot()); break;
      }
    }
    const swap = top; top = bot; bot = swap;
  }

  return chain(segs, cell * 0.35);
}

/** Greedily chain segments into polylines so they can be stroked as one path. */
function chain(segs: Seg[], tol: number): Polyline[] {
  const key = (x: number, y: number) => `${Math.round(x / tol)}:${Math.round(y / tol)}`;
  const starts = new Map<string, number[]>();
  for (let i = 0; i < segs.length; i++) {
    const k = key(segs[i].ax, segs[i].ay);
    const list = starts.get(k);
    if (list) list.push(i); else starts.set(k, [i]);
  }
  const used = new Uint8Array(segs.length);
  const out: Polyline[] = [];

  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const line: Polyline = [segs[i].ax, segs[i].ay, segs[i].bx, segs[i].by];
    let ex = segs[i].bx, ey = segs[i].by;
    for (let guard = 0; guard < 20_000; guard++) {
      const cands = starts.get(key(ex, ey));
      if (!cands) break;
      let nxt = -1;
      for (const c of cands) if (!used[c]) { nxt = c; break; }
      if (nxt < 0) break;
      used[nxt] = 1;
      ex = segs[nxt].bx; ey = segs[nxt].by;
      line.push(ex, ey);
    }
    if (line.length >= 4) out.push(line);
  }
  return out;
}
