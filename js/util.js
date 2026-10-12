// Small helpers shared by every module.

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Runs `fn` over `items` with at most `limit` in flight; keeps order. */
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** 1536 → "1.5 KB" (binary units, like `flutter build --analyze-size`). */
export function fmtBytes(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (abs < 1024) return `${n} B`;
  if (abs < 1024 * 1024) return `${(n / 1024).toFixed(abs < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(abs < 10 * 1024 * 1024 ? 2 : 1)} MB`;
}

export const basename = (p) => p.slice(p.lastIndexOf('/') + 1);
export const dirname = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
export const extname = (p) => {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i + 1).toLowerCase() : '';
};
export const stem = (p) => {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(0, i) : b;
};

/** flutter_gen style camelCase: "ic_home-page 2" → "icHomePage2". */
export function camel(s) {
  const words = String(s).split(/[^A-Za-z0-9]+/).filter(Boolean)
    .map((w) => (/[a-z]/.test(w) ? w : w.toLowerCase()));
  return words.map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1))).join('');
}
