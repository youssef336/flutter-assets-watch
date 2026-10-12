// The APK / IPA size panel: breakdown bar, drill-down treemap, top-20 table.

import { KIND } from './labels.js';
import { SIZE_KINDS, topContributors } from './sizes.js';
import { squarify } from './treemap.js';
import { esc, fmtBytes } from './util.js';

const MAX_TILES = 60;

/** Renders `parsed` into `box`; returns a function to re-layout (on resize). */
export function renderSize(box, parsed) {
  const stack = [parsed.root];
  const pct = (n) => (parsed.total ? ((n / parsed.total) * 100).toFixed(1) : '0');
  const kinds = SIZE_KINDS.filter((k) => parsed.byKind[k] > 0);
  box.innerHTML = `
    <div class="size-head">
      <h3>${esc(parsed.type.toUpperCase())}</h3>
      <span class="size-total">${esc(fmtBytes(parsed.total))}</span>
    </div>
    <div class="bar" role="img" aria-label="التقسيم">${kinds.map((k) =>
      `<span style="--c: var(--k-${k}); width: ${pct(parsed.byKind[k])}%" title="${esc(KIND[k])} ${esc(fmtBytes(parsed.byKind[k]))}"></span>`).join('')}</div>
    <ul class="legend">${kinds.map((k) =>
      `<li style="--c: var(--k-${k})">${esc(KIND[k])} <b>${esc(fmtBytes(parsed.byKind[k]))}</b> <span class="muted">${pct(parsed.byKind[k])}%</span></li>`).join('')}</ul>
    <div class="crumbs" id="tm-crumbs"></div>
    <div class="treemap" id="tm"></div>
    <p class="muted small">دوس على أي مربع فيه حاجات جواه عشان تدخل فيه. أحجام كود Dart (جوه <code dir="ltr">libapp.so</code> / <code dir="ltr">App.framework</code>) هي حجم الـ snapshot من غير ضغط.</p>
    <h3>أكبر 20 حاجة</h3>
    <div class="table-wrap"><table class="top">
      <thead><tr><th>#</th><th>إيه</th><th>نوعها</th><th>الحجم</th><th>%</th></tr></thead>
      <tbody>${topContributors(parsed, 20).map((c, i) => `
        <tr><td class="n">${i + 1}</td><td class="name">${esc(c.name)}</td>
          <td><span class="kind-dot" style="--c: var(--k-${c.kind})"></span>${esc(KIND[c.kind])}</td>
          <td class="n">${esc(fmtBytes(c.size))}${c.uncompressed ? '*' : ''}</td>
          <td class="n">${c.uncompressed ? '—' : pct(c.size)}</td></tr>`).join('')}
      </tbody></table></div>
    <p class="muted small">* حجم Dart من غير ضغط، فمش بيتجمع مع باقي الملفات.</p>`;

  const tm = box.querySelector('#tm');
  const crumbs = box.querySelector('#tm-crumbs');

  const draw = () => {
    const node = stack[stack.length - 1];
    crumbs.innerHTML = stack.map((n, i) => `<button type="button" data-depth="${i}">${esc(i === 0 ? parsed.type : n.name)}</button>`).join('<span>/</span>');
    const kids = [...node.children].sort((a, b) => b.size - a.size);
    let shown = kids.slice(0, MAX_TILES);
    const rest = kids.slice(MAX_TILES);
    if (rest.length) shown = [...shown, { name: `+${rest.length} تاني`, size: rest.reduce((n, c) => n + c.size, 0), kind: 'other', children: [], rest: true }];
    const w = tm.clientWidth;
    const h = tm.clientHeight;
    if (!shown.length) {
      tm.innerHTML = `<div class="tm" style="--c: var(--k-${node.kind}); inset: 0">${esc(node.name)}<small>${esc(fmtBytes(node.size))}</small></div>`;
      return;
    }
    const rects = squarify(shown.map((c) => c.size), { x: 0, y: 0, w, h });
    tm.innerHTML = rects.map((r) => {
      const c = shown[r.i];
      const label = r.w > 56 && r.h > 26;
      const drill = c.children.length > 0;
      return `<div class="tm${drill ? ' drill' : ''}" data-i="${r.i}" style="--c: var(--k-${c.kind}); left:${r.x}px; top:${r.y}px; width:${r.w}px; height:${r.h}px"
        title="${esc(`${c.name} — ${fmtBytes(c.size)}`)}">${label ? `${esc(c.name)}<small>${esc(fmtBytes(c.size))}</small>` : ''}</div>`;
    }).join('');
    tm.onclick = (e) => {
      const i = e.target.closest('[data-i]')?.dataset.i;
      const c = i != null ? shown[Number(i)] : null;
      if (c && c.children.length && !c.rest) {
        stack.push(c);
        draw();
      }
    };
  };
  crumbs.onclick = (e) => {
    const d = e.target.closest('[data-depth]')?.dataset.depth;
    if (d == null) return;
    stack.length = Number(d) + 1;
    draw();
  };
  draw();
  return draw;
}
