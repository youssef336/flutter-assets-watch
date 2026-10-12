// Squarified treemap layout (Bruls, Huizing & van Wijk, 2000). Pure.

/**
 * Lays `values` out inside the rectangle. Zero/negative values get no rect.
 * @param values {number[]}
 * @param rect {{x, y, w, h}}
 * @returns {{x, y, w, h, i}[]} one rect per positive value, `i` = its index in `values`.
 */
export function squarify(values, rect) {
  const total = values.reduce((s, v) => s + (v > 0 ? v : 0), 0);
  const area = rect.w * rect.h;
  if (!total || area <= 0) return [];
  const items = values
    .map((v, i) => ({ i, a: v > 0 ? (v / total) * area : 0 }))
    .filter((it) => it.a > 0)
    .sort((p, q) => q.a - p.a);

  const out = [];
  let { x, y, w, h } = rect;
  let row = [];

  const worst = (r, side) => {
    if (!r.length) return Infinity;
    let s = 0;
    let max = 0;
    let min = Infinity;
    for (const it of r) {
      s += it.a;
      if (it.a > max) max = it.a;
      if (it.a < min) min = it.a;
    }
    const s2 = s * s;
    const side2 = side * side;
    return Math.max((side2 * max) / s2, s2 / (side2 * min));
  };

  const place = (r) => {
    const s = r.reduce((n, it) => n + it.a, 0);
    if (w >= h) {
      // Column along the left edge.
      const cw = h ? s / h : 0;
      let cy = y;
      for (const it of r) {
        const ih = cw ? it.a / cw : 0;
        out.push({ x, y: cy, w: cw, h: ih, i: it.i });
        cy += ih;
      }
      x += cw;
      w -= cw;
    } else {
      // Row along the top edge.
      const rh = w ? s / w : 0;
      let cx = x;
      for (const it of r) {
        const iw = rh ? it.a / rh : 0;
        out.push({ x: cx, y, w: iw, h: rh, i: it.i });
        cx += iw;
      }
      y += rh;
      h -= rh;
    }
  };

  let k = 0;
  while (k < items.length) {
    const side = Math.min(w, h);
    const next = [...row, items[k]];
    if (!row.length || worst(next, side) <= worst(row, side)) {
      row = next;
      k++;
    } else {
      place(row);
      row = [];
    }
  }
  if (row.length) place(row);
  return out;
}
