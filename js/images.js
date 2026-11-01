// Image decoding, encoding and pixel work shared by the image tools.
import { UserError, canvasBytes, readBytes } from './lib.js';

const base = new URL('../vendor/', import.meta.url).href;
const cache = new Map();
const once = (key, fn) => {
  if (!cache.has(key)) cache.set(key, fn().catch((e) => { cache.delete(key); throw e; }));
  return cache.get(key);
};

export const imageKit = () => once('kit', () => import(`${base}imagekit.js`));
export const aiKit = () => once('ai', () => import(`${base}aikit.js`));

// Phones lose canvases silently past about 16 MP, so stay under what the device can hold.
export const isTouch = () => matchMedia('(pointer: coarse)').matches;
export const maxArea = () => (isTouch() ? 16e6 : 120e6);

export function newCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export const fitArea = (w, h, limit = maxArea()) => Math.min(1, Math.sqrt(limit / (w * h)));

function toCanvas(source, w, h) {
  const k = fitArea(w, h);
  const c = newCanvas(w * k, h * k);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, c.width, c.height);
  return { canvas: c, reduced: k < 1 };
}

const rgbaToCanvas = (data, w, h) => {
  const c = newCanvas(w, h);
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data.buffer ?? data, data.byteOffset ?? 0, w * h * 4), w, h), 0, 0);
  return c;
};

/* ---------- decoders ---------- */

const RAW = new Set(['cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'dng', 'orf', 'rw2', 'raf', 'pef', 'srw', 'raw']);
export const IMAGE_ACCEPT = `image/*,.heic,.heif,.avif,.tif,.tiff,.psd,.svg,${[...RAW].map((e) => `.${e}`).join(',')}`;

const extOf = (file) => (file.name.split('.').pop() || '').toLowerCase();

async function gifFrames(file) {
  const { parseGIF, decompressFrames } = await imageKit();
  const gif = parseGIF(await file.arrayBuffer());
  const raw = decompressFrames(gif, true);
  if (!raw.length) return [];
  const { width: W, height: H } = gif.lsd;
  const stage = newCanvas(W, H), ctx = stage.getContext('2d', { willReadFrequently: true });
  const frames = [];
  for (const f of raw) {
    const before = f.disposalType === 3 ? ctx.getImageData(0, 0, W, H) : null;
    const patch = rgbaToCanvas(f.patch, f.dims.width, f.dims.height);
    ctx.drawImage(patch, f.dims.left, f.dims.top);
    const copy = newCanvas(W, H);
    copy.getContext('2d').drawImage(stage, 0, 0);
    frames.push({ canvas: copy, delay: f.delay || 100 });
    if (f.disposalType === 2) ctx.clearRect(f.dims.left, f.dims.top, f.dims.width, f.dims.height);
    else if (before) ctx.putImageData(before, 0, 0);
  }
  return frames;
}

async function decodeTiff(file) {
  const { UTIF } = await imageKit();
  const buf = await file.arrayBuffer();
  const ifds = UTIF.decode(buf);
  const page = ifds.find((i) => i.t256 && i.t257) ?? ifds[0];
  UTIF.decodeImage(buf, page);
  return rgbaToCanvas(UTIF.toRGBA8(page), page.width, page.height);
}

async function decodePsd(file) {
  const { readPsd } = await imageKit();
  const psd = readPsd(await file.arrayBuffer(), { skipLayerImageData: true, skipThumbnail: true, useImageData: true });
  if (!psd.imageData) throw new UserError(`${file.name} has no flattened image. Save it from Photoshop with "Maximize compatibility" on.`);
  return rgbaToCanvas(psd.imageData.data, psd.width, psd.height);
}

async function decodeHeic(file) {
  const mod = await import(`${base}libheif-bundle.mjs`);
  const lib = (mod.default ?? mod)();
  const decoder = new lib.HeifDecoder();
  const [image] = decoder.decode(await readBytes(file));
  if (!image) throw new UserError(`${file.name} could not be decoded.`);
  const w = image.get_width(), h = image.get_height();
  const k = fitArea(w, h);
  const out = await new Promise((resolve, reject) => {
    image.display({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }, (d) => (d ? resolve(d) : reject(new Error('HEIC decode failed'))));
  });
  image.free?.();
  const full = rgbaToCanvas(out.data, w, h);
  return k < 1 ? toCanvas(full, w, h).canvas : full;
}

// Finds where a JPEG ends by walking its markers, so thumbnails nested in its header are skipped.
function jpegEnd(b, start) {
  let i = start + 2;
  while (i < b.length - 3) {
    if (b[i] !== 0xff) return -1;
    const m = b[i + 1];
    if (m === 0xda) {
      for (let j = i + 2; j < b.length - 1; j++) if (b[j] === 0xff && b[j + 1] === 0xd9) return j + 2;
      return -1;
    }
    if (m === 0xff) { i++; continue; }
    i += 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
  return -1;
}

// Camera RAW files carry a full-size JPEG rendered by the camera. Using it avoids demosaicing,
// which a browser cannot do well for hundreds of sensor models.
async function decodeRaw(file) {
  const b = await readBytes(file);
  const found = [];
  for (let i = 0; i < b.length - 3; i++) {
    if (b[i] !== 0xff || b[i + 1] !== 0xd8 || b[i + 2] !== 0xff) continue;
    const end = jpegEnd(b, i);
    if (end > 0) { found.push([i, end]); i = end; }
  }
  found.sort((p, q) => (q[1] - q[0]) - (p[1] - p[0]));
  for (const [from, to] of found.slice(0, 3)) {
    const bitmap = await createImageBitmap(new Blob([b.subarray(from, to)], { type: 'image/jpeg' })).catch(() => null);
    if (bitmap) return { bitmap };
  }
  throw new UserError(`${file.name} has no readable preview image.`);
}

/**
 * Returns { canvas, frames, reduced, name }. frames is set only for animated GIFs:
 * [{ canvas, delay }]. reduced means the picture was scaled to fit this device's memory.
 */
export async function loadImage(file) {
  const ext = extOf(file);
  const done = (canvas, extra = {}) => ({ canvas, frames: null, reduced: false, file, ...extra });
  if (ext === 'gif' || file.type === 'image/gif') {
    const frames = await gifFrames(file);
    if (frames.length > 1) return done(frames[0].canvas, { frames });
    if (frames.length) return done(frames[0].canvas);
  }
  if (ext === 'tif' || ext === 'tiff' || file.type === 'image/tiff') {
    const c = await decodeTiff(file);
    return done(c);
  }
  if (ext === 'psd') return done(await decodePsd(file));
  if (RAW.has(ext)) {
    const { bitmap } = await decodeRaw(file);
    const r = toCanvas(bitmap, bitmap.width, bitmap.height);
    bitmap.close();
    return done(r.canvas, { reduced: r.reduced });
  }
  if (ext === 'svg' || file.type === 'image/svg+xml') {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const w = img.naturalWidth || 1200, h = img.naturalHeight || 1200;
      const r = toCanvas(img, w, h);
      return done(r.canvas, { reduced: r.reduced, svg: true });
    } catch {
      throw new UserError(`${file.name} could not be read as an SVG.`);
    } finally { URL.revokeObjectURL(url); }
  }
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
  if (bitmap) {
    const r = toCanvas(bitmap, bitmap.width, bitmap.height);
    bitmap.close();
    return done(r.canvas, { reduced: r.reduced });
  }
  if (ext === 'heic' || ext === 'heif' || /hei[cf]/.test(file.type)) return done(await decodeHeic(file));
  throw new UserError(`${file.name} is not an image this browser can read.`);
}

/* ---------- encoders ---------- */

export function outputFormat(file) {
  const ext = extOf(file);
  if (ext === 'jpg' || ext === 'jpeg') return 'jpg';
  if (ext === 'png' || ext === 'gif' || ext === 'webp') return ext;
  return 'png';
}

export async function encodeCanvas(canvas, format, quality = 0.92) {
  if (format === 'jpg') {
    const flat = newCanvas(canvas.width, canvas.height), ctx = flat.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, flat.width, flat.height);
    ctx.drawImage(canvas, 0, 0);
    return { bytes: await canvasBytes(flat, 'image/jpeg', quality), ext: 'jpg' };
  }
  if (format === 'webp') {
    const bytes = await canvasBytes(canvas, 'image/webp', quality);
    // Safari cannot write WebP and quietly returns PNG, so name the file for what it is.
    return { bytes, ext: bytes[0] === 0x52 ? 'webp' : 'png' };
  }
  if (format === 'gif') return { bytes: await encodeGif([{ canvas, delay: 100 }]), ext: 'gif' };
  return { bytes: await canvasBytes(canvas, 'image/png'), ext: 'png' };
}

export async function encodeGif(frames, colors = 256) {
  const { GIFEncoder, quantize, applyPalette } = await imageKit();
  const gif = GIFEncoder();
  for (const { canvas, delay } of frames) {
    const { width: w, height: h } = canvas;
    const { data } = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h);
    const palette = quantize(data, colors, { format: 'rgba4444', oneBitAlpha: true });
    const index = applyPalette(data, palette, 'rgba4444');
    const clear = palette.findIndex((p) => p[3] === 0);
    gif.writeFrame(index, w, h, { palette, delay, transparent: clear >= 0, transparentIndex: Math.max(clear, 0) });
    await new Promise((r) => setTimeout(r));
  }
  gif.finish();
  return gif.bytes();
}

export async function encodeImage(image, format, quality) {
  if (image.frames && format === 'gif') return { bytes: await encodeGif(image.frames), ext: 'gif' };
  return encodeCanvas(image.canvas, format, quality);
}

// Applies a canvas transform to a still image or to every frame of an animation.
export function mapImage(image, fn) {
  if (!image.frames) return { ...image, canvas: fn(image.canvas) };
  const frames = image.frames.map((f) => ({ canvas: fn(f.canvas), delay: f.delay }));
  return { ...image, frames, canvas: frames[0].canvas };
}

/* ---------- geometry ---------- */

export function scaled(source, w, h) {
  // Halving in steps keeps large reductions sharp.
  let from = source;
  while (from.width / 2 > w && from.height / 2 > h) {
    const half = newCanvas(from.width / 2, from.height / 2), ctx = half.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(from, 0, 0, half.width, half.height);
    from = half;
  }
  const out = newCanvas(w, h), ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(from, 0, 0, out.width, out.height);
  return out;
}

export function turned(source, degrees, flipX = false, flipY = false) {
  const swap = degrees % 180 !== 0;
  const c = newCanvas(swap ? source.height : source.width, swap ? source.width : source.height);
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((degrees * Math.PI) / 180);
  ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
  ctx.drawImage(source, -source.width / 2, -source.height / 2);
  return c;
}

export function cropped(source, x, y, w, h) {
  const c = newCanvas(w, h);
  c.getContext('2d').drawImage(source, Math.round(-x), Math.round(-y));
  return c;
}

/* ---------- pixel effects ---------- */

// Three box passes approximate a Gaussian. Written by hand because Safari has no canvas filter.
export function blurArea(ctx, x, y, w, h, radius) {
  x = Math.max(0, Math.round(x)); y = Math.max(0, Math.round(y));
  w = Math.min(ctx.canvas.width - x, Math.round(w)); h = Math.min(ctx.canvas.height - y, Math.round(h));
  if (w < 1 || h < 1) return;
  const img = ctx.getImageData(x, y, w, h), d = img.data, r = Math.max(1, Math.round(radius));
  const line = new Float64Array(Math.max(w, h) * 4);
  const pass = (count, length, at) => {
    for (let n = 0; n < count; n++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let i = 0; i < length; i++) line[i] = d[at(n, i) + c];
        for (let i = -r; i <= r; i++) sum += line[Math.min(length - 1, Math.max(0, i))];
        for (let i = 0; i < length; i++) {
          d[at(n, i) + c] = sum / (2 * r + 1);
          sum += line[Math.min(length - 1, i + r + 1)] - line[Math.max(0, i - r)];
        }
      }
    }
  };
  for (let p = 0; p < 3; p++) {
    pass(h, w, (row, i) => (row * w + i) * 4);
    pass(w, h, (col, i) => (i * w + col) * 4);
  }
  ctx.putImageData(img, x, y);
}

export function pixelateArea(ctx, x, y, w, h, block) {
  const small = newCanvas(Math.max(1, w / block), Math.max(1, h / block));
  small.getContext('2d').drawImage(ctx.canvas, x, y, w, h, 0, 0, small.width, small.height);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, x, y, w, h);
  ctx.restore();
}

export const FILTERS = {
  none: {},
  mono: { saturation: -100 },
  sepia: { sepia: 100 },
  vivid: { saturation: 40, contrast: 12 },
  warm: { warmth: 30, saturation: 8 },
  cool: { warmth: -30 },
  fade: { contrast: -18, brightness: 8, saturation: -18 },
  noir: { saturation: -100, contrast: 34 },
};

export function adjust(canvas, { brightness = 0, contrast = 0, saturation = 0, warmth = 0, sepia = 0 } = {}) {
  if (!brightness && !contrast && !saturation && !warmth && !sepia) return;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height), d = img.data;
  const lift = brightness * 2.55, tone = (259 * (contrast * 2.55 + 255)) / (255 * (259 - contrast * 2.55));
  const sat = 1 + saturation / 100, shift = warmth * 0.6, mix = sepia / 100;
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i], g = d[i + 1], b = d[i + 2];
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r = lum + (r - lum) * sat; g = lum + (g - lum) * sat; b = lum + (b - lum) * sat;
    r = (r - 128) * tone + 128 + lift + shift; g = (g - 128) * tone + 128 + lift; b = (b - 128) * tone + 128 + lift - shift;
    if (mix) {
      const sr = 0.393 * r + 0.769 * g + 0.189 * b, sg = 0.349 * r + 0.686 * g + 0.168 * b, sb = 0.272 * r + 0.534 * g + 0.131 * b;
      r += (sr - r) * mix; g += (sg - g) * mix; b += (sb - b) * mix;
    }
    d[i] = r; d[i + 1] = g; d[i + 2] = b;
  }
  ctx.putImageData(img, 0, 0);
}

export function vignette(canvas, amount) {
  if (!amount) return;
  const ctx = canvas.getContext('2d'), { width: w, height: h } = canvas;
  const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) / 2);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, `rgba(0,0,0,${amount / 100})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

// Frames sit inside the picture so text and stickers keep their positions.
export function drawFrame(canvas, kind, color) {
  if (kind === 'none') return;
  const ctx = canvas.getContext('2d'), { width: w, height: h } = canvas, unit = Math.min(w, h);
  ctx.save();
  ctx.fillStyle = color;
  if (kind === 'simple' || kind === 'thick') {
    const t = unit * (kind === 'simple' ? 0.025 : 0.06);
    ctx.fillRect(0, 0, w, t); ctx.fillRect(0, h - t, w, t); ctx.fillRect(0, 0, t, h); ctx.fillRect(w - t, 0, t, h);
  } else if (kind === 'polaroid') {
    const t = unit * 0.05, b = unit * 0.18;
    ctx.fillRect(0, 0, w, t); ctx.fillRect(0, h - b, w, b); ctx.fillRect(0, 0, t, h); ctx.fillRect(w - t, 0, t, h);
  } else if (kind === 'rounded') {
    const r = unit * 0.08;
    ctx.globalCompositeOperation = 'destination-in';
    ctx.beginPath();
    ctx.moveTo(r, 0); ctx.arcTo(w, 0, w, h, r); ctx.arcTo(w, h, 0, h, r); ctx.arcTo(0, h, 0, 0, r); ctx.arcTo(0, 0, w, 0, r);
    ctx.fillStyle = '#000';
    ctx.fill();
  }
  ctx.restore();
}

/* ---------- composition ---------- */

export function drawWatermark(canvas, v, mark) {
  const ctx = canvas.getContext('2d'), { width: W, height: H } = canvas;
  const turn = (v.turn * Math.PI) / 180;
  ctx.save();
  ctx.globalAlpha = v.opacity / 100;
  let w, h, paint;
  if (mark) {
    w = W * (v.scale / 100); h = w * (mark.height / mark.width);
    paint = () => ctx.drawImage(mark, -w / 2, -h / 2, w, h);
  } else {
    const size = W * (v.size / 100);
    ctx.font = `700 ${size}px -apple-system, "Segoe UI", Roboto, "Noto Sans", Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = v.color;
    w = ctx.measureText(v.text).width; h = size;
    paint = () => ctx.fillText(v.text, 0, 0);
  }
  const pad = Math.min(W, H) * 0.05;
  const spots = [];
  if (v.position === 'tile') {
    const sx = w * Math.abs(Math.cos(turn)) + h * Math.abs(Math.sin(turn)) + W * 0.08;
    const sy = w * Math.abs(Math.sin(turn)) + h * Math.abs(Math.cos(turn)) + W * 0.08;
    for (let y = sy / 2, row = 0; y < H + sy; y += sy, row++) for (let x = row % 2 ? 0 : sx / 2; x < W + sx; x += sx) spots.push([x, y]);
  } else {
    const [py, px] = v.position;
    spots.push([
      { l: pad + w / 2, c: W / 2, r: W - pad - w / 2 }[px],
      { t: pad + h / 2, c: H / 2, b: H - pad - h / 2 }[py],
    ]);
  }
  for (const [x, y] of spots) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-turn);
    paint();
    ctx.restore();
  }
  ctx.restore();
}

function wrapped(ctx, text, width) {
  const lines = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width > width && line) { lines.push(line); line = word; } else line = next;
    }
    if (line) lines.push(line);
  }
  return lines;
}

export async function drawMeme(canvas, v) {
  const ctx = canvas.getContext('2d'), { width: W, height: H } = canvas;
  const size = W * (v.size / 100);
  const font = `${size}px Anton, Impact, "Arial Black", -apple-system, "Noto Sans", sans-serif`;
  await document.fonts?.load(`40px Anton`).catch(() => {});
  ctx.save();
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.lineJoin = 'round';
  ctx.lineWidth = size / 7;
  ctx.strokeStyle = v.outline;
  ctx.fillStyle = v.color;
  const place = (text, top) => {
    const lines = wrapped(ctx, v.caps ? text.toUpperCase() : text, W * 0.92);
    const step = size * 1.14;
    let y = top ? H * 0.03 + size : H * 0.97 - (lines.length - 1) * step;
    for (const line of lines) { ctx.strokeText(line, W / 2, y); ctx.fillText(line, W / 2, y); y += step; }
  };
  place(v.top, true);
  place(v.bottom, false);
  ctx.restore();
}
