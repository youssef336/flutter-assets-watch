// Heavy-image analysis. Everything here is pure: byte sizes come from the git
// tree, pixel facts (when we fetched the image) from js/pixels.js.

import { basename, dirname, extname } from './util.js';

export const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const DENSITY_DIR = /^(\d+(?:\.\d+)?)x$/;

export const isImage = (p) => IMAGE_EXT.has(extname(p));

/**
 * Splits `assets/images/2.0x/logo.png` into its logical asset and density.
 * @returns {{base: string, density: number}} density 1 for the main asset.
 */
export function densityOf(path) {
  const dir = dirname(path);
  const last = basename(dir);
  const m = DENSITY_DIR.exec(last);
  if (!m) return { base: path, density: 1 };
  const parent = dirname(dir);
  return { base: parent ? `${parent}/${basename(path)}` : basename(path), density: Number(m[1]) };
}

/**
 * Groups images by logical asset and reports density-variant problems.
 * @param entries {{path, size, sha}[]}
 * @returns {Map<string, {base, variants: Map<number, entry>, missing: number[], noBase: boolean, sameAsBase: number[]}>}
 */
export function densityGroups(entries) {
  const groups = new Map();
  for (const e of entries) {
    const { base, density } = densityOf(e.path);
    if (!groups.has(base)) groups.set(base, { base, variants: new Map() });
    groups.get(base).variants.set(density, e);
  }
  // Densities used per directory: if siblings ship 2.0x and 3.0x, every image there should.
  const byDir = new Map();
  for (const g of groups.values()) {
    const set = byDir.get(dirname(g.base)) || new Set();
    for (const d of g.variants.keys()) if (d !== 1) set.add(d);
    byDir.set(dirname(g.base), set);
  }
  for (const g of groups.values()) {
    const wanted = [...(byDir.get(dirname(g.base)) || [])].sort((a, b) => a - b);
    const has = g.variants;
    const base = has.get(1);
    g.noBase = !base && has.size > 0;
    g.missing = wanted.filter((d) => !has.has(d));
    g.sameAsBase = base ? [...has.entries()].filter(([d, e]) => d !== 1 && e.sha && e.sha === base.sha).map(([d]) => d) : [];
  }
  return groups;
}

/**
 * Heuristic: does this bitmap look like a photo (many colours, smooth noise)
 * rather than flat UI art? `uniqueRatio` = distinct colours / sampled pixels.
 */
export function looksPhotographic({ bytes, width, height, uniqueRatio }) {
  if (uniqueRatio != null) {
    if (uniqueRatio >= 0.45) return true;
    if (uniqueRatio < 0.12) return false;
  }
  if (width && height && bytes) return bytes / (width * height) > 1.2;
  return false;
}

// Typical size of the WebP re-encode relative to the original (rough medians
// from public WebP studies; the UI always labels these as estimates).
const RATIO = {
  'jpeg->webp': 0.7, // lossy WebP ≈ 25–35% smaller than JPEG at the same quality
  'png-photo->webp': 0.25, // photographic PNG → lossy WebP q≈80
  'png-photo-alpha->webp': 0.32, // same, keeping the alpha channel
  'png->webp-lossless': 0.74, // lossless WebP ≈ 26% smaller than PNG
  'gif->webp': 0.5, // animated GIF → animated WebP
};

/**
 * Estimated size after converting to WebP (and resizing to `maxPx` when the
 * image is bigger than that). Pure guesswork by design — labelled as such.
 * @returns {{after: number, saved: number, how: string, resize: number}}
 */
export function estimateSavings({ format, bytes, photo, hasAlpha, width, height }, { maxPx = 1500 } = {}) {
  const f = format === 'jpg' ? 'jpeg' : format;
  let how;
  if (f === 'jpeg') how = 'jpeg->webp';
  else if (f === 'png' && photo) how = hasAlpha ? 'png-photo-alpha->webp' : 'png-photo->webp';
  else if (f === 'png') how = 'png->webp-lossless';
  else if (f === 'gif') how = 'gif->webp';
  else how = 'keep';
  const longest = Math.max(width || 0, height || 0);
  const resize = longest > maxPx ? (maxPx / longest) ** 2 : 1;
  const ratio = how === 'keep' ? 1 : RATIO[how];
  const after = Math.round(bytes * ratio * resize);
  return { after, saved: Math.max(0, bytes - after), how, resize };
}

/**
 * Flags for one image. `px` is optional ({width, height, hasAlpha, uniqueRatio}).
 * @returns {string[]} heavy | png-photo | oversized | missing-variant | no-base | same-as-base | duplicate
 */
export function imageFlags(entry, px, group, dupes, { thresholdKb = 200, maxPx = 1500 } = {}) {
  const flags = [];
  const format = extname(entry.path);
  if (entry.size > thresholdKb * 1024) flags.push('heavy');
  if (px && format === 'png' && looksPhotographic({ bytes: entry.size, ...px })) flags.push('png-photo');
  if (px && Math.max(px.width, px.height) > maxPx) flags.push('oversized');
  if (group) {
    const { density } = densityOf(entry.path);
    if ((density === 1 || group.noBase) && group.missing?.length) flags.push('missing-variant');
    if (group.noBase) flags.push('no-base');
    if (density !== 1 && group.sameAsBase?.includes(density)) flags.push('same-as-base');
  }
  if (dupes && dupes.length) flags.push('duplicate');
  return flags;
}

/** Paths sharing one blob sha (identical files), keyed by path → the other paths. */
export function duplicates(entries) {
  const bySha = new Map();
  for (const e of entries) {
    if (!e.sha) continue;
    if (!bySha.has(e.sha)) bySha.set(e.sha, []);
    bySha.get(e.sha).push(e.path);
  }
  const out = new Map();
  for (const paths of bySha.values()) {
    if (paths.length < 2) continue;
    for (const p of paths) {
      // Density variants identical to their base are reported as same-as-base instead.
      const others = paths.filter((o) => o !== p && densityOf(o).base !== densityOf(p).base);
      if (others.length) out.set(p, others);
    }
  }
  return out;
}
