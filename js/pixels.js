// In-browser pixel facts and WebP re-encoding. Needs a real browser (canvas).

const SAMPLE = 64;

function canvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

async function decode(blob) {
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob);
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** `{width, height, hasAlpha, uniqueRatio}` for an image blob (first frame of a GIF). */
export async function inspect(blob) {
  const bmp = await decode(blob);
  const width = bmp.width;
  const height = bmp.height;
  const sw = Math.max(1, Math.min(SAMPLE, width));
  const sh = Math.max(1, Math.min(SAMPLE, height));
  const c = canvas(sw, sh);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, sw, sh);
  bmp.close?.();
  const data = ctx.getImageData(0, 0, sw, sh).data;
  const colours = new Set();
  let hasAlpha = false;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 250) hasAlpha = true;
    // 5 bits per channel: ignores dithering noise, keeps real colour variety.
    colours.add(((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3));
  }
  return { width, height, hasAlpha, uniqueRatio: colours.size / (sw * sh) };
}

/**
 * Re-encodes an image as WebP in the browser. Downscales to `maxPx` on the
 * longest side when asked. Resolves `{blob, width, height, webp}`; `webp` is
 * false when the browser silently fell back to PNG (older Safari).
 */
export async function toWebp(blob, { quality = 0.8, maxPx = 0 } = {}) {
  const bmp = await decode(blob);
  let { width, height } = bmp;
  const longest = Math.max(width, height);
  if (maxPx && longest > maxPx) {
    const k = maxPx / longest;
    width = Math.round(width * k);
    height = Math.round(height * k);
  }
  const c = canvas(width, height);
  const ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0, width, height);
  bmp.close?.();
  let out;
  if (c.convertToBlob) out = await c.convertToBlob({ type: 'image/webp', quality });
  else out = await new Promise((resolve) => c.toBlob(resolve, 'image/webp', quality));
  return { blob: out, width, height, webp: out?.type === 'image/webp' };
}
