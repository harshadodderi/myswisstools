// Shared helpers: lazy library loading, PDF open/render, qpdf, text stamping.
// Libraries load on first use so the home page stays fast.

const base = new URL('../vendor/', import.meta.url).href;
const cache = new Map();

const once = (key, fn) => {
  if (!cache.has(key)) cache.set(key, fn().catch((e) => { cache.delete(key); throw e; }));
  return cache.get(key);
};

const script = (path, global) => once(path, () => new Promise((resolve, reject) => {
  const el = document.createElement('script');
  el.src = base + path;
  el.onload = () => resolve(global ? window[global] : undefined);
  el.onerror = () => reject(new Error(`Could not load ${path}`));
  document.head.append(el);
}));

export const pdfLib = () => once('pdf-lib', () => import(base + 'pdf-lib.esm.min.js'));
export const jszip = () => script('jszip.min.js', 'JSZip');
export const mammoth = () => script('mammoth.browser.min.js', 'mammoth');
export const xlsx = () => script('xlsx.full.min.js', 'XLSX');
export const pptxgen = () => script('pptxgen.bundle.js', 'PptxGenJS');
export const docx = () => script('docx.iife.js', 'docx');
export const marked = () => script('marked.umd.js', 'marked');
export const mobi = () => once('mobi', () => import(base + 'foliate-mobi.js'));
export const fflate = () => once('fflate', () => import(base + 'fflate.js'));
export const tesseract = () => script('tesseract/tesseract.min.js', 'Tesseract');

export const pdfjs = () => once('pdfjs', async () => {
  const lib = await import(base + 'pdfjs/pdf.min.mjs');
  lib.GlobalWorkerOptions.workerSrc = base + 'pdfjs/pdf.worker.min.mjs';
  return lib;
});

export class UserError extends Error {}

/* ---------- bytes and files ---------- */

export const readBytes = async (file) => new Uint8Array(await file.arrayBuffer());
export const stem = (name) => name.replace(/\.[^.]+$/, '');

export const formatSize = (n) => {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(n < 104857600 ? 1 : 0)} MB`;
};

export const MIME = {
  pdf: 'application/pdf', jpg: 'image/jpeg', png: 'image/png', zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  epub: 'application/epub+zip', azw3: 'application/vnd.amazon.ebook', txt: 'text/plain', md: 'text/markdown', html: 'text/html', csv: 'text/csv',
};

export const output = (name, bytes) => ({ name, bytes, type: MIME[name.split('.').pop()] || 'application/octet-stream' });

// Lets the browser paint progress between heavy synchronous steps.
export const breathe = () => new Promise((r) => setTimeout(r));

/* ---------- qpdf ---------- */

// qpdf's main() tears the module down, so every call gets a fresh instance.
export async function qpdf(args, input) {
  const factory = await script('qpdf/qpdf.js', 'Module');
  const log = [];
  const q = await factory({
    noInitialRun: true,
    locateFile: () => base + 'qpdf/qpdf.wasm',
    print: (s) => log.push(s),
    printErr: (s) => log.push(s),
  });
  q.FS.writeFile('/in.pdf', input);
  let code;
  try { code = q.callMain(args); } catch (e) { code = typeof e?.status === 'number' ? e.status : 2; }
  let bytes = null;
  try { bytes = q.FS.readFile('/out.pdf'); } catch { /* no output on hard failure */ }
  // Exit code 3 means qpdf recovered from damage and did write a file.
  return { ok: (code === 0 || code === 3) && !!bytes, code, log: log.join('\n'), bytes };
}

const hasEncrypt = (bytes) => {
  const needle = [0x2f, 0x45, 0x6e, 0x63, 0x72, 0x79, 0x70, 0x74]; // "/Encrypt"
  for (let i = 0, end = bytes.length - needle.length; i < end; i++) {
    if (bytes[i] !== needle[0]) continue;
    let j = 1;
    while (j < needle.length && bytes[i + j] === needle[j]) j++;
    if (j === needle.length) return true;
  }
  return false;
};

/* ---------- opening PDFs, including protected ones ---------- */

let askPassword = async () => null;
export const setPasswordPrompt = (fn) => { askPassword = fn; };

const unlocked = new WeakMap();

// Returns plain bytes for any PDF the user is entitled to open, asking for a password if needed.
export async function openBytes(file, { password } = {}) {
  if (unlocked.has(file)) return unlocked.get(file);
  const bytes = await readBytes(file);
  if (!hasEncrypt(bytes)) return bytes;
  let attempt = password ?? '';
  for (let wrong = false; ;) {
    const res = await qpdf(['--decrypt', `--password=${attempt}`, '/in.pdf', '/out.pdf'], bytes);
    if (res.ok) { unlocked.set(file, res.bytes); return res.bytes; }
    // qpdf may write its reason straight to stderr, so an empty log still means a bad password.
    if (res.log && !/invalid password/i.test(res.log)) throw new UserError(`${file.name} could not be decrypted.`);
    if (password != null) throw new UserError(`Wrong password for ${file.name}.`);
    attempt = await askPassword(file.name, wrong);
    if (attempt == null) throw new UserError(`${file.name} needs its password.`);
    wrong = true;
  }
}

export async function loadPdfLib(bytes) {
  const { PDFDocument } = await pdfLib();
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    throw new UserError(`This PDF could not be read (${e.message}). Try the Repair PDF tool first.`);
  }
}

export async function loadPdfJs(bytes) {
  const lib = await pdfjs();
  return lib.getDocument({
    data: bytes.slice(), // pdf.js detaches the buffer it is given
    cMapUrl: base + 'pdfjs/cmaps/', cMapPacked: true,
    standardFontDataUrl: base + 'pdfjs/standard_fonts/',
    wasmUrl: base + 'pdfjs/wasm/', iccUrl: base + 'pdfjs/iccs/',
    isEvalSupported: false,
  }).promise;
}

export async function renderPage(page, scale, { rotate = 0, background = '#fff' } = {}) {
  const viewport = page.getViewport({ scale, rotation: (page.rotate + rotate) % 360 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  await page.render({ canvas, viewport, background }).promise;
  return canvas;
}

export const canvasBytes = (canvas, type = 'image/jpeg', quality = 0.9) => new Promise((resolve, reject) => {
  canvas.toBlob(async (blob) => {
    if (!blob) return reject(new Error('The page was too large to encode.'));
    resolve(new Uint8Array(await blob.arrayBuffer()));
  }, type, quality);
});

/* ---------- page ranges ---------- */

// "1-3, 7, 10-" -> [[0,1,2],[6],[9,...]] (zero-based). Each comma group stays together.
export function parseRanges(text, pageCount) {
  const groups = [];
  for (const part of text.split(/[,;]+/).map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d*)\s*(?:(-)\s*(\d*))?$/);
    if (!m || (!m[1] && !m[3])) throw new UserError(`"${part}" is not a page range. Try something like 1-3, 7.`);
    const from = m[1] ? +m[1] : 1;
    const to = m[2] ? (m[3] ? +m[3] : pageCount) : from;
    if (from < 1 || to < 1 || from > pageCount || to > pageCount) {
      throw new UserError(`"${part}" is outside this document, which has ${pageCount} pages.`);
    }
    const step = from <= to ? 1 : -1;
    const pages = [];
    for (let p = from; p !== to + step; p += step) pages.push(p - 1);
    groups.push(pages);
  }
  if (!groups.length) throw new UserError('Enter at least one page.');
  return groups;
}

/* ---------- placing things on pages ---------- */

// Everything the user positions is in "display" space: what they see, top-left origin, points.
// PDF drawing happens in unrotated user space, so this maps between the two.
export function pageFrame(page) {
  const box = page.getCropBox();
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  const swapped = rotation % 180 !== 0;
  return {
    box, rotation,
    width: swapped ? box.height : box.width,
    height: swapped ? box.width : box.height,
    toUser(dx, dy) {
      const { x, y, width: w, height: h } = box;
      if (rotation === 90) return { x: x + dy, y: y + dx };
      if (rotation === 180) return { x: x + w - dx, y: y + dy };
      if (rotation === 270) return { x: x + w - dy, y: y + h - dx };
      return { x: x + dx, y: y + h - dy };
    },
  };
}

// Options for drawImage/drawRectangle so a box given in display space appears upright there.
export function placeBox(frame, left, top, width, height, { degrees }, turn = 0) {
  const anchor = frame.toUser(left, top + height);
  return { ...anchor, width, height, rotate: degrees(frame.rotation + turn) };
}

const WIN_ANSI = /^[\x20-\x7e\xa0-\xff–—‘’“”•…€]*$/;
export const isWinAnsi = (s) => WIN_ANSI.test(s);

export function hexRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

// Scripts outside WinAnsi have no glyphs in PDF's standard fonts. The browser can shape them
// with system fonts, so they are drawn to a canvas and embedded as a transparent image.
export function textToCanvas(text, { font = '', size = 24, color = '#000', scale = 4 }) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const css = `${font || ''} ${size * scale}px system-ui, "Noto Sans", Arial, sans-serif`;
  ctx.font = css;
  const m = ctx.measureText(text);
  const ascent = Math.ceil(m.actualBoundingBoxAscent || size * scale);
  const descent = Math.ceil(m.actualBoundingBoxDescent || 0);
  c.width = Math.max(1, Math.ceil(m.width) + 2 * scale);
  c.height = Math.max(1, ascent + descent + 2 * scale);
  ctx.font = css;
  ctx.fillStyle = color;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, scale, ascent + scale);
  return { canvas: c, width: c.width / scale, height: c.height / scale, baseline: (descent + scale) / scale };
}

// Draws one line of text in any script. left/baseline are in display space.
export async function stampText(doc, page, frame, text, opts) {
  const lib = await pdfLib();
  const { left, baseline, size, color = '#000000', opacity = 1, font = 'Helvetica', turn = 0 } = opts;
  const [r, g, b] = hexRgb(color);
  if (isWinAnsi(text)) {
    const embedded = await doc.embedFont(lib.StandardFonts[font] || lib.StandardFonts.Helvetica);
    const at = frame.toUser(left, baseline);
    page.drawText(text, { ...at, size, font: embedded, color: lib.rgb(r, g, b), opacity, rotate: lib.degrees(frame.rotation + turn) });
    return;
  }
  const img = textToCanvas(text, { size, color, font: /Bold/.test(font) ? 'bold' : '' });
  const png = await doc.embedPng(await canvasBytes(img.canvas, 'image/png'));
  const place = placeBox(frame, left, baseline - img.height + img.baseline, img.width, img.height, lib, turn);
  page.drawImage(png, { ...place, opacity });
}

export async function measureText(doc, text, size, font = 'Helvetica') {
  if (isWinAnsi(text)) {
    const lib = await pdfLib();
    const embedded = await doc.embedFont(lib.StandardFonts[font] || lib.StandardFonts.Helvetica);
    return embedded.widthOfTextAtSize(text, size);
  }
  return textToCanvas(text, { size }).width;
}

/* ---------- text extraction shared by the converters and Compare ---------- */

// Returns reading-order lines: [{ y, x, size, bold, italic, runs:[{x, right, str}], text }], top-left origin.
export async function pageLines(page) {
  const viewport = page.getViewport({ scale: 1, rotation: page.rotate });
  const content = await page.getTextContent();
  const pieces = [];
  for (const item of content.items) {
    if (!item.str || !item.str.trim()) continue;
    const size = Math.hypot(item.transform[2], item.transform[3]) || Math.abs(item.height) || 10;
    const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
    const fontName = (content.styles[item.fontName]?.fontFamily || '') + ' ' + fontRealName(page, item.fontName);
    pieces.push({ x, y, size, str: item.str, width: item.width, font: fontName });
  }
  pieces.sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const p of pieces) {
    const row = rows.at(-1);
    if (row && Math.abs(row.y - p.y) < Math.max(2, p.size * 0.45)) row.items.push(p);
    else rows.push({ y: p.y, items: [p] });
  }
  return rows.map(({ y, items }) => {
    items.sort((a, b) => a.x - b.x);
    const runs = [];
    for (const it of items) {
      const last = runs.at(-1);
      const gap = last ? it.x - last.right : 0;
      if (last && gap < it.size * 1.2) {
        last.str += (gap > it.size * 0.15 && !/\s$/.test(last.str) && !/^\s/.test(it.str) ? ' ' : '') + it.str;
        last.right = Math.max(last.right, it.x + it.width);
      } else runs.push({ x: it.x, right: it.x + it.width, str: it.str });
    }
    const main = items.reduce((a, b) => (b.str.length > a.str.length ? b : a));
    return {
      y, x: runs[0].x, runs, size: main.size,
      bold: /bold|black|heavy/i.test(main.font), italic: /italic|oblique/i.test(main.font),
      text: runs.map((r) => r.str.trim()).join(' '),
    };
  });
}

function fontRealName(page, id) {
  try { return page.commonObjs.has(id) ? page.commonObjs.get(id)?.name || '' : ''; } catch { return ''; }
}

// Finds raster images on a page with their position in top-left points.
export async function pageImages(page, lib) {
  const viewport = page.getViewport({ scale: 1, rotation: page.rotate });
  const ops = await page.getOperatorList();
  const { OPS, Util } = lib;
  const stack = [];
  let ctm = viewport.transform;
  const found = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i], args = ops.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = Util.transform(ctm, args);
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
      const data = fn === OPS.paintImageXObject ? await pageObject(page, args[0]) : args[0];
      const canvas = data && imageToCanvas(data);
      if (!canvas) continue;
      const xs = [ctm[4], ctm[4] + ctm[0], ctm[4] + ctm[2], ctm[4] + ctm[0] + ctm[2]];
      const ys = [ctm[5], ctm[5] + ctm[1], ctm[5] + ctm[3], ctm[5] + ctm[1] + ctm[3]];
      const left = Math.min(...xs), top = Math.min(...ys);
      found.push({ canvas, left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top });
    }
  }
  return found;
}

const pageObject = (page, id) => new Promise((resolve) => {
  const store = id.startsWith('g_') ? page.commonObjs : page.objs;
  const timer = setTimeout(() => resolve(null), 5000);
  try { store.get(id, (v) => { clearTimeout(timer); resolve(v); }); } catch { clearTimeout(timer); resolve(null); }
});

function imageToCanvas(img) {
  const { width, height } = img;
  if (!width || !height) return null;
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  const ctx = c.getContext('2d');
  if (img.bitmap) { ctx.drawImage(img.bitmap, 0, 0); return c; }
  if (!img.data) return null;
  const out = ctx.createImageData(width, height), d = img.data, o = out.data;
  if (img.kind === 3) o.set(d.subarray(0, o.length));
  else if (img.kind === 2) {
    for (let i = 0, j = 0; i < o.length; i += 4, j += 3) { o[i] = d[j]; o[i + 1] = d[j + 1]; o[i + 2] = d[j + 2]; o[i + 3] = 255; }
  } else {
    const row = (width + 7) >> 3;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const v = d[y * row + (x >> 3)] >> (7 - (x & 7)) & 1 ? 255 : 0, i = (y * width + x) * 4;
      o[i] = o[i + 1] = o[i + 2] = v; o[i + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return c;
}
