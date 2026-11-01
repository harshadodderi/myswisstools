// The image tools. Every one runs on the device, including the AI ones.
import { UserError, breathe, canvasBytes, formatSize, loadPdfJs, output, readBytes, renderPage, stem } from '../lib.js';
import {
  FILTERS, IMAGE_ACCEPT, adjust, aiKit, blurArea, cropped, drawFrame, drawMeme, drawWatermark, encodeGif, encodeImage,
  fitArea, imageKit, isTouch, loadImage, mapImage, maxArea, newCanvas, outputFormat, pixelateArea, scaled, turned, vignette,
} from '../images.js';
import { boxStage, fileTabs, livePreview, thumbCard } from '../imagestage.js';
import { htmlToPdf, measureHtml, sanitize } from '../htmlpdf.js';
import { el } from '../ui.js';

const accept = IMAGE_ACCEPT;
const root = new URL('../../', import.meta.url).href;
const reducedLine = 'Very large images are reduced to fit this device\'s memory.';

const save = async (image, name, format, quality) => {
  const { bytes, ext } = await encodeImage(image, format, quality);
  return output(`${name}.${ext}`, bytes);
};

/* ---------- compress ---------- */

const LEVELS = { light: { q: 0.86, colors: 256 }, balanced: { q: 0.72, colors: 180 }, strong: { q: 0.55, colors: 96 } };

async function compressSvg(file) {
  const { optimize } = await import(`${root}vendor/svgo.js`);
  return new TextEncoder().encode(optimize(await file.text(), { multipass: true }).data);
}

async function compressPng(canvas, colors) {
  const { UPNG } = await imageKit();
  const { width: w, height: h } = canvas;
  const { data } = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h);
  return new Uint8Array(UPNG.encode([data.buffer], w, h, colors));
}

/* ---------- AI: background removal ---------- */

let session = null;
async function cutoutSession() {
  if (session) return session;
  const ort = await import(`${root}vendor/ort/ort.wasm.min.mjs`);
  ort.env.wasm.wasmPaths = `${root}vendor/ort/`;
  ort.env.wasm.numThreads = 1;
  session = { ort, model: await ort.InferenceSession.create(`${root}models/u2netp.onnx`, { executionProviders: ['wasm'] }) };
  return session;
}

async function cutoutMask(canvas) {
  const { ort, model } = await cutoutSession();
  const SIZE = 320;
  const small = scaled(canvas, SIZE, SIZE);
  const { data } = small.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, SIZE, SIZE);
  let peak = 1;
  for (let i = 0; i < data.length; i += 4) peak = Math.max(peak, data[i], data[i + 1], data[i + 2]);
  const input = new Float32Array(3 * SIZE * SIZE);
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    for (let c = 0; c < 3; c++) input[c * SIZE * SIZE + p] = (data[i + c] / peak - mean[c]) / std[c];
  }
  const out = await model.run({ [model.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]) });
  const raw = out[model.outputNames[0]].data;
  let low = Infinity, high = -Infinity;
  for (const v of raw) { low = Math.min(low, v); high = Math.max(high, v); }
  const range = Math.max(1e-6, high - low);
  const mask = newCanvas(SIZE, SIZE), mx = mask.getContext('2d'), img = mx.createImageData(SIZE, SIZE);
  for (let p = 0; p < raw.length; p++) {
    // A steeper curve makes each area clearly kept or removed, so nothing ends up half see-through.
    const t = Math.min(1, Math.max(0, ((raw[p] - low) / range - 0.2) / 0.5));
    img.data[p * 4 + 3] = Math.round(t * t * (3 - 2 * t) * 255);
  }
  mx.putImageData(img, 0, 0);
  return mask;
}

/* ---------- AI: upscale ---------- */

const upscalers = new Map();
async function upscaleCanvas(canvas, scale, progress) {
  const { Upscaler, x2, x4, tf } = await aiKit();
  if (!upscalers.has(scale)) {
    upscalers.set(scale, new Upscaler({ model: { ...(scale === 4 ? x4 : x2), path: `${root}vendor/models/esrgan/x${scale}/model.json` } }));
  }
  const flat = newCanvas(canvas.width, canvas.height), fx = flat.getContext('2d');
  fx.fillStyle = '#fff';
  fx.fillRect(0, 0, flat.width, flat.height);
  fx.drawImage(canvas, 0, 0);
  const input = tf.browser.fromPixels(flat);
  const result = await upscalers.get(scale).execute(input, {
    output: 'tensor', patchSize: 64, padding: 4, awaitNextFrame: true, progress: (p) => progress(p),
  });
  const out = newCanvas(result.shape[1], result.shape[0]);
  const pixels = tf.tidy(() => result.clipByValue(0, 255).div(255));
  await tf.browser.toPixels(pixels, out);
  tf.dispose([input, result, pixels]);
  // The model has no alpha channel, so transparency is restored from the source.
  const ctx = out.getContext('2d');
  ctx.globalCompositeOperation = 'destination-in';
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  return out;
}

/* ---------- studios ---------- */

const RATIOS = [['0', 'Free'], ['1', 'Square 1:1'], ['1.3333', '4:3'], ['0.75', '3:4'], ['1.7778', '16:9'], ['0.5625', '9:16'], ['1.5', '3:2'], ['0.8', '4:5']];

async function cropStudio(host, { files, setValues }) {
  const image = await loadImage(files[0]);
  const { canvas } = image;
  const sync = (b) => setValues({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) });
  const stage = boxStage(host, canvas, { boxClass: 'box crop', onChange: sync });
  const m = Math.round(Math.min(canvas.width, canvas.height) * 0.1);
  const box = stage.add({ x: m, y: m, w: canvas.width - m * 2, h: canvas.height - m * 2 });
  sync(box);
  return {
    image,
    update(v) {
      const r = +v.ratio;
      if (r !== box.ratio) {
        box.ratio = r || undefined;
        stage.setRatio(r);
        if (r) {
          const fit = Math.min(canvas.width, canvas.height * r) * 0.9;
          box.w = fit; box.h = fit / r;
          box.x = (canvas.width - box.w) / 2; box.y = (canvas.height - box.h) / 2;
          stage.place(box);
          sync(box);
          return;
        }
      }
      const n = { x: +v.x, y: +v.y, w: +v.w, h: +v.h };
      if (Object.values(n).every(Number.isFinite) && n.w > 0 && n.h > 0 && Object.keys(n).some((k) => Math.round(box[k]) !== n[k])) {
        Object.assign(box, n);
        box.x = Math.min(box.x, canvas.width - 1); box.y = Math.min(box.y, canvas.height - 1);
        box.w = Math.min(box.w, canvas.width - box.x); box.h = Math.min(box.h, canvas.height - box.y);
        stage.place(box);
      }
    },
    rect: () => ({ x: box.x / canvas.width, y: box.y / canvas.height, w: box.w / canvas.width, h: box.h / canvas.height }),
  };
}

function rotateStudio(host, { files }) {
  const items = [];
  const grid = el('div', { class: 'page-grid' });
  const bar = el('div', { class: 'grid-tools' });
  let only = 'all';
  const matching = () => items.filter((i) => only === 'all' || (only === 'landscape') === (i.image.canvas.width >= i.image.canvas.height));
  const apply = (fn) => { for (const i of matching()) { fn(i); paint(i); } };
  const paint = (i) => {
    i.thumb.style.transform = `rotate(${i.turn}deg) scale(${i.flipX ? -1 : 1}, ${i.flipY ? -1 : 1})`;
  };
  bar.append(
    el('button', { type: 'button', class: 'ghost', id: 'rotate-left', onclick: () => apply((i) => { i.turn = (i.turn + 270) % 360; }) }, '↺ Left'),
    el('button', { type: 'button', class: 'ghost', id: 'rotate-right', onclick: () => apply((i) => { i.turn = (i.turn + 90) % 360; }) }, '↻ Right'),
    el('button', { type: 'button', class: 'ghost', id: 'flip-h', onclick: () => apply((i) => { i.flipX = !i.flipX; }) }, 'Flip horizontal'),
    el('button', { type: 'button', class: 'ghost', id: 'flip-v', onclick: () => apply((i) => { i.flipY = !i.flipY; }) }, 'Flip vertical'),
  );
  host.append(bar, grid);
  const ready = (async () => {
    for (const file of files) {
      const image = await loadImage(file);
      const { thumb, node } = thumbCard(image.canvas, file.name);
      const item = { file, image, thumb, turn: 0, flipX: false, flipY: false };
      items.push(item);
      node.append(el('div', { class: 'card-actions' },
        el('button', { type: 'button', 'aria-label': `Rotate ${file.name}`, onclick: () => { item.turn = (item.turn + 90) % 360; paint(item); } }, '↻')));
      grid.append(node);
      await breathe();
    }
  })();
  return ready.then(() => ({ items, update: (v) => { only = v.only; } }));
}

async function blurStudio(host, { files, shared }) {
  const add = el('button', { type: 'button', class: 'ghost', id: 'add-area', 'aria-pressed': 'false' }, '+ Add area');
  const del = el('button', { type: 'button', class: 'ghost', id: 'delete-area' }, 'Delete selected');
  const find = el('p', { class: 'muted', id: 'face-status', 'aria-live': 'polite' }, 'Looking for faces…');
  host.append(el('div', { class: 'grid-tools' }, add, del), find);
  let drawing = false, current = null;
  const { ready, opened } = fileTabs(host, files, async (panel, image) => {
    const stage = boxStage(panel, image.canvas, { boxClass: 'box redact-box', draw: drawing });
    current = stage;
    panel.addEventListener('pointerdown', () => { current = stage; });
    try {
      const { faceapi } = await aiKit();
      shared.ready ??= faceapi.nets.ssdMobilenetv1.loadFromUri(`${root}vendor/models/face`);
      await shared.ready;
      const found = await faceapi.detectAllFaces(image.canvas, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.35 }));
      const { width: W, height: H } = image.canvas;
      for (const { box: b } of found) {
        const grow = b.height * 0.18;
        stage.add({ x: Math.max(0, b.x - grow), y: Math.max(0, b.y - grow * 1.4), w: Math.min(W, b.width + grow * 2), h: Math.min(H, b.height + grow * 2.4) });
      }
      find.textContent = found.length ? `${found.length} ${found.length === 1 ? 'face' : 'faces'} found. Move, resize or add areas.` : 'No faces found. Use Add area to mark anything you want hidden.';
    } catch (e) {
      console.warn(e);
      find.textContent = 'Face detection is unavailable here. Use Add area to mark areas by hand.';
    }
    return stage;
  });
  add.addEventListener('click', () => {
    drawing = !drawing;
    add.setAttribute('aria-pressed', drawing);
    for (const { state } of opened.values()) state.setDraw(drawing);
  });
  del.addEventListener('click', () => current?.remove());
  await ready;
  return { opened };
}

const STICKERS = ['😀', '😂', '😍', '😎', '🥳', '🔥', '❤️', '⭐', '👍', '🎉', '💯', '🌈'];

async function editorStudio(host, { files, values }) {
  const image = await loadImage(files[0]);
  const { canvas } = image;
  const items = [];
  const wrap = el('div', { class: 'grid-tools editor-actions' });
  host.append(wrap);
  const canvasHost = el('div');
  host.append(canvasHost);
  const stage = boxStage(canvasHost, canvas, { boxClass: 'box overlay' });
  const view = stage.view, plain = newCanvas(view.width, view.height);
  plain.getContext('2d').drawImage(view, 0, 0);
  const font = (v) => ({ sans: '-apple-system, "Segoe UI", Roboto, "Noto Sans", Arial, sans-serif', serif: 'Georgia, "Times New Roman", serif', mono: 'ui-monospace, Menlo, Consolas, monospace', impact: 'Anton, Impact, sans-serif' }[v]);
  const measure = newCanvas(1, 1).getContext('2d');
  const addText = (text, kind) => {
    const h = canvas.height * (kind === 'sticker' ? 0.16 : 0.09);
    measure.font = `700 ${h * 0.8}px ${font(values.font)}`;
    const w = Math.min(canvas.width, Math.max(h, measure.measureText(text).width * 1.1));
    const label = el('span', { class: 'overlay-text' }, text);
    const item = stage.add({
      x: (canvas.width - w) / 2, y: (canvas.height - h) / 2, w, h, ratio: w / h, content: label, text, kind,
      color: values.color, font: values.font, onResize: (b) => {
        label.style.fontSize = `${((b.h * 0.8) / canvas.width) * 100}cqw`;
      },
    });
    label.style.color = item.color;
    label.style.fontFamily = font(item.font);
    stage.place(item);
    items.push(item);
    return item;
  };
  const textInput = el('input', { type: 'text', id: 'overlay-text', placeholder: 'Add text', 'aria-label': 'Text to add' });
  wrap.append(textInput,
    el('button', { type: 'button', class: 'ghost', id: 'add-text', onclick: () => { if (textInput.value.trim()) { addText(textInput.value.trim(), 'text'); textInput.value = ''; } } }, 'Add'),
    el('button', { type: 'button', class: 'ghost', id: 'delete-overlay', onclick: () => {
      const s = stage.selected();
      if (s) { items.splice(items.indexOf(s), 1); stage.remove(s); }
    } }, 'Delete selected'),
    el('div', { class: 'stickers', role: 'group', 'aria-label': 'Stickers' }, STICKERS.map((s) => el('button', { type: 'button', class: 'sticker', 'aria-label': `Add ${s}`, onclick: () => addText(s, 'sticker') }, s))));
  let queued = false, latest = values;
  const paint = () => {
    queued = false;
    const draft = newCanvas(plain.width, plain.height), ctx = draft.getContext('2d');
    ctx.drawImage(plain, 0, 0);
    finish(draft, latest);
    const v = view.getContext('2d');
    v.clearRect(0, 0, view.width, view.height);
    v.drawImage(draft, 0, 0);
  };
  return {
    image, items, font,
    update(v) {
      latest = v;
      const s = stage.selected();
      if (s?.kind === 'text') { s.color = v.color; s.font = v.font; const n = s.node.querySelector('.overlay-text'); n.style.color = v.color; n.style.fontFamily = font(v.font); }
      if (!queued) { queued = true; requestAnimationFrame(paint); }
    },
  };
}

const finish = (canvas, v) => {
  adjust(canvas, { ...FILTERS[v.filter] });
  adjust(canvas, { brightness: +v.brightness, contrast: +v.contrast, saturation: +v.saturation, warmth: +v.warmth });
  vignette(canvas, +v.vignette);
  drawFrame(canvas, v.frame, v.frameColor);
};

/* ---------- tools ---------- */

const POSITIONS = [['cc', 'Center'], ['tile', 'Tiled'], ['tl', 'Top left'], ['tc', 'Top center'], ['tr', 'Top right'], ['bl', 'Bottom left'], ['bc', 'Bottom center'], ['br', 'Bottom right']];

async function watermarkImage(v) {
  if (v.kind === 'image') {
    if (!v.image) return null;
    return (await loadImage(v.image)).canvas;
  }
  return null;
}

export default [
  {
    id: 'compress-image', name: 'Compress image', cat: 'optimize', icon: 'compress', accept, multiple: true, batch: true,
    desc: 'Make JPG, PNG, WebP, SVG and GIF files smaller.', action: 'Compress',
    note: 'Compressed images also lose location and camera details. If an image cannot get smaller, you get the original back unchanged.',
    fields: [{ key: 'level', label: 'Compression', type: 'select', default: 'balanced', options: [['light', 'Light — best quality'], ['balanced', 'Balanced — recommended'], ['strong', 'Strong — smallest file']] }],
    async run({ files, values, progress, report }) {
      const file = files[0], name = `${stem(file.name)}-compressed`, level = LEVELS[values.level];
      const original = await readBytes(file);
      const ext = file.name.split('.').pop().toLowerCase();
      progress(0.2, 'Compressing');
      let bytes, outExt;
      if (ext === 'svg') { bytes = await compressSvg(file); outExt = 'svg'; }
      else {
        const image = await loadImage(file);
        const format = outputFormat(file);
        if (format === 'png') { bytes = await compressPng(image.canvas, level.colors); outExt = 'png'; }
        else if (format === 'gif') { bytes = await encodeGif(image.frames ?? [{ canvas: image.canvas, delay: 100 }], level.colors); outExt = 'gif'; }
        else ({ bytes, ext: outExt } = await encodeImage(image, format, level.q));
      }
      const sameType = outExt === ext || (outExt === 'jpg' && ext === 'jpeg');
      if (bytes.length >= original.length && sameType) { bytes = original; outExt = ext; }
      const saved = 1 - bytes.length / original.length;
      report({ title: saved > 0.005 ? `Reduced by ${(saved * 100).toFixed(0)}%` : 'Already well optimized', lines: [`${formatSize(original.length)} → ${formatSize(bytes.length)}`] });
      return [output(`${name}.${outExt}`, bytes)];
    },
  },
  {
    id: 'upscale-image', name: 'Upscale image', cat: 'optimize', icon: 'expand', accept, multiple: true, batch: true,
    desc: 'Enlarge images with AI while keeping them sharp.', action: 'Upscale',
    note: 'The AI runs on your device, so large images take a while. Phones work best with smaller pictures, and oversized ones are reduced first.',
    fields: [{ key: 'scale', label: 'Enlarge', type: 'select', default: '2', options: [['2', '2×'], ['4', '4×']] }],
    async run({ files, values, progress, report }) {
      const scale = +values.scale;
      const image = await loadImage(files[0]);
      // Work is bounded by the result's size, not the source's.
      const budget = Math.min(maxArea(), isTouch() ? 6e6 : 40e6) / (scale * scale);
      const k = fitArea(image.canvas.width, image.canvas.height, budget);
      const source = k < 1 ? scaled(image.canvas, image.canvas.width * k, image.canvas.height * k) : image.canvas;
      progress(0.02, 'Loading AI model');
      const out = await upscaleCanvas(source, scale, (p) => progress(p * 0.95, `Enlarging ${(p * 100).toFixed(0)}%`));
      if (k < 1) report({ title: `Enlarged ${scale}×`, lines: ['The source was reduced first to fit this device.'] });
      return [await save({ canvas: out }, `${stem(files[0].name)}-${scale}x`, outputFormat(files[0]) === 'jpg' ? 'jpg' : 'png', 0.93)];
    },
  },
  {
    id: 'remove-background', name: 'Remove background', cat: 'optimize', icon: 'cutout', accept, multiple: true, batch: true,
    desc: 'Cut out the subject with AI, right on your device.', action: 'Remove background',
    note: 'Works best with one clear subject. Busy group photos can lose parts, and fine detail such as hair can come out soft.',
    fields: [
      { key: 'fill', label: 'New background', type: 'select', default: 'none', options: [['none', 'Transparent'], ['white', 'White'], ['color', 'Choose a color']] },
      { key: 'color', label: 'Color', type: 'color', default: '#0071e3', show: (v) => v.fill === 'color' },
    ],
    async run({ files, values, progress }) {
      const image = await loadImage(files[0]);
      progress(0.05, 'Loading AI model');
      const mask = await cutoutMask(image.canvas);
      progress(0.8, 'Cutting out');
      const { width: w, height: h } = image.canvas;
      const out = newCanvas(w, h), ctx = out.getContext('2d');
      ctx.drawImage(image.canvas, 0, 0);
      ctx.globalCompositeOperation = 'destination-in';
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(mask, 0, 0, w, h);
      if (values.fill !== 'none') {
        ctx.globalCompositeOperation = 'destination-over';
        ctx.fillStyle = values.fill === 'white' ? '#fff' : values.color;
        ctx.fillRect(0, 0, w, h);
      }
      return [output(`${stem(files[0].name)}-cutout.png`, await canvasBytes(out, 'image/png'))];
    },
  },
  {
    id: 'resize-image', name: 'Resize image', cat: 'edit', icon: 'expand', accept, multiple: true, batch: true,
    desc: 'Set exact dimensions, by pixels or by percent.', action: 'Resize',
    fields: [
      { key: 'mode', label: 'Resize by', type: 'select', default: 'pixels', options: [['pixels', 'Pixels'], ['percent', 'Percent']] },
      { key: 'width', label: 'Width (px)', type: 'number', default: 1200, min: 1, show: (v) => v.mode === 'pixels' },
      { key: 'height', label: 'Height (px)', type: 'number', default: '', min: 1, placeholder: 'Automatic', show: (v) => v.mode === 'pixels' },
      { key: 'percent', label: 'Size (%)', type: 'number', default: 50, min: 1, max: 1000, show: (v) => v.mode === 'percent' },
      { key: 'keep', label: 'Keep proportions', type: 'checkbox', default: true, show: (v) => v.mode === 'pixels' },
      { key: 'shrink', label: 'Never enlarge', type: 'checkbox', default: true },
    ],
    async run({ files, values }) {
      const file = files[0], image = await loadImage(file), { width: W, height: H } = image.canvas;
      let w, h;
      if (values.mode === 'percent') { w = (W * values.percent) / 100; h = (H * values.percent) / 100; }
      else {
        const tw = +values.width || 0, th = +values.height || 0;
        if (!tw && !th) throw new UserError('Enter a width or a height.');
        if (values.keep) {
          const k = Math.min(tw ? tw / W : Infinity, th ? th / H : Infinity);
          w = W * k; h = H * k;
        } else { w = tw || W; h = th || H; }
      }
      if (values.shrink && (w > W || h > H)) { const k = Math.min(W / w, H / h); w *= k; h *= k; }
      const k = fitArea(w, h);
      w = Math.max(1, Math.round(w * k)); h = Math.max(1, Math.round(h * k));
      if (image.svg) {
        const doc = new DOMParser().parseFromString(await file.text(), 'image/svg+xml');
        const svg = doc.documentElement;
        if (!svg.hasAttribute('viewBox')) svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
        svg.setAttribute('width', w); svg.setAttribute('height', h);
        return [output(`${stem(file.name)}-${w}x${h}.svg`, new TextEncoder().encode(new XMLSerializer().serializeToString(doc)))];
      }
      return [await save(mapImage(image, (c) => scaled(c, w, h)), `${stem(file.name)}-${w}x${h}`, outputFormat(file), 0.93)];
    },
  },
  {
    id: 'crop-image', name: 'Crop image', cat: 'edit', icon: 'crop', accept, multiple: true,
    desc: 'Drag to crop, or type exact pixels. Works on animated GIFs too.', action: 'Crop',
    note: 'With several images, each gets the same relative crop.',
    fields: [
      { key: 'ratio', label: 'Shape', type: 'select', default: '0', options: RATIOS },
      { key: 'x', label: 'Left (px)', type: 'number', default: 0, min: 0 },
      { key: 'y', label: 'Top (px)', type: 'number', default: 0, min: 0 },
      { key: 'w', label: 'Width (px)', type: 'number', default: 0, min: 1 },
      { key: 'h', label: 'Height (px)', type: 'number', default: 0, min: 1 },
    ],
    studio: cropStudio,
    async run({ files, studio, progress }) {
      const r = studio.rect(), results = [];
      for (const [i, file] of files.entries()) {
        progress(i / files.length, file.name);
        const image = await loadImage(file);
        const { width: W, height: H } = image.canvas;
        const out = mapImage(image, (c) => cropped(c, r.x * W, r.y * H, r.w * W, r.h * H));
        results.push(await save(out, `${stem(file.name)}-cropped`, outputFormat(file), 0.93));
      }
      return results;
    },
  },
  {
    id: 'rotate-image', name: 'Rotate image', cat: 'edit', icon: 'rotate', accept, multiple: true,
    desc: 'Turn or flip many images at once, or just the landscape or portrait ones.', action: 'Save',
    fields: [{ key: 'only', label: 'Apply buttons to', type: 'select', default: 'all', options: [['all', 'All images'], ['landscape', 'Landscape only'], ['portrait', 'Portrait only']] }],
    studio: rotateStudio,
    async run({ studio, progress }) {
      const changed = studio.items.filter((i) => i.turn || i.flipX || i.flipY);
      if (!changed.length) throw new UserError('Rotate or flip at least one image first.');
      const results = [];
      for (const [n, i] of changed.entries()) {
        progress(n / changed.length, i.file.name);
        const out = mapImage(i.image, (c) => turned(c, i.turn, i.flipX, i.flipY));
        results.push(await save(out, `${stem(i.file.name)}-rotated`, outputFormat(i.file), 0.95));
      }
      return results;
    },
  },
  {
    id: 'photo-editor', name: 'Photo editor', cat: 'edit', icon: 'pen', accept,
    desc: 'Add text, stickers, filters, adjustments and frames.', action: 'Save photo',
    fields: [
      { key: 'filter', label: 'Filter', type: 'select', default: 'none', options: Object.keys(FILTERS).map((k) => [k, k[0].toUpperCase() + k.slice(1)]) },
      { key: 'brightness', label: 'Brightness', type: 'range', default: 0, min: -60, max: 60, unit: '' },
      { key: 'contrast', label: 'Contrast', type: 'range', default: 0, min: -60, max: 60, unit: '' },
      { key: 'saturation', label: 'Saturation', type: 'range', default: 0, min: -100, max: 100, unit: '' },
      { key: 'warmth', label: 'Warmth', type: 'range', default: 0, min: -60, max: 60, unit: '' },
      { key: 'vignette', label: 'Vignette', type: 'range', default: 0, min: 0, max: 90, unit: '' },
      { key: 'frame', label: 'Frame', type: 'select', default: 'none', options: [['none', 'None'], ['simple', 'Thin'], ['thick', 'Thick'], ['polaroid', 'Polaroid'], ['rounded', 'Rounded corners']] },
      { key: 'frameColor', label: 'Frame color', type: 'color', default: '#ffffff', show: (v) => ['simple', 'thick', 'polaroid'].includes(v.frame) },
      { key: 'color', label: 'Text color', type: 'color', default: '#ffffff' },
      { key: 'font', label: 'Text font', type: 'select', default: 'sans', options: [['sans', 'Sans'], ['serif', 'Serif'], ['mono', 'Mono'], ['impact', 'Poster']] },
    ],
    studio: editorStudio, pinned: true,
    async run({ files, values, studio }) {
      const out = newCanvas(studio.image.canvas.width, studio.image.canvas.height), ctx = out.getContext('2d');
      ctx.drawImage(studio.image.canvas, 0, 0);
      adjust(out, { ...FILTERS[values.filter] });
      adjust(out, { brightness: +values.brightness, contrast: +values.contrast, saturation: +values.saturation, warmth: +values.warmth });
      vignette(out, +values.vignette);
      for (const it of studio.items) {
        ctx.save();
        ctx.font = `700 ${it.h * 0.8}px ${studio.font(it.font)}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = it.color;
        ctx.fillText(it.text, it.x + it.w / 2, it.y + it.h / 2);
        ctx.restore();
      }
      drawFrame(out, values.frame, values.frameColor);
      const format = values.frame === 'rounded' || outputFormat(files[0]) === 'png' ? 'png' : 'jpg';
      return [await save({ canvas: out }, `${stem(files[0].name)}-edited`, format, 0.93)];
    },
  },
  {
    id: 'meme-generator', name: 'Meme generator', cat: 'create', icon: 'meme', accept,
    desc: 'Add classic top and bottom captions to any picture.', action: 'Save meme',
    fields: [
      { key: 'top', label: 'Top text', type: 'text', default: 'Top text' },
      { key: 'bottom', label: 'Bottom text', type: 'text', default: 'Bottom text' },
      { key: 'size', label: 'Text size', type: 'range', default: 10, min: 4, max: 20, unit: '%' },
      { key: 'color', label: 'Text color', type: 'color', default: '#ffffff' },
      { key: 'outline', label: 'Outline color', type: 'color', default: '#000000' },
      { key: 'caps', label: 'All capitals', type: 'checkbox', default: true },
    ],
    studio: (host, { files, values }) => livePreview(host, files, values, drawMeme), pinned: true,
    async run({ files, values }) {
      const image = await loadImage(files[0]);
      const out = mapImage(image, (c) => { const n = newCanvas(c.width, c.height); n.getContext('2d').drawImage(c, 0, 0); return n; });
      for (const f of out.frames ?? [out]) await drawMeme(f.canvas, values);
      return [await save(out, `${stem(files[0].name)}-meme`, out.frames ? 'gif' : 'jpg', 0.92)];
    },
  },
  {
    id: 'watermark-image', name: 'Watermark image', cat: 'security', icon: 'drop', accept, multiple: true, batch: true, pinned: true,
    desc: 'Stamp text or a logo over many images at once.', action: 'Add watermark',
    fields: [
      { key: 'kind', label: 'Type', type: 'select', default: 'text', options: [['text', 'Text'], ['image', 'Image']] },
      { key: 'text', label: 'Text', type: 'text', default: '© My Name', show: (v) => v.kind === 'text' },
      { key: 'image', label: 'Logo', type: 'file', accept: 'image/*', show: (v) => v.kind === 'image' },
      { key: 'size', label: 'Text size', type: 'range', default: 6, min: 1, max: 24, unit: '%', show: (v) => v.kind === 'text' },
      { key: 'scale', label: 'Logo width', type: 'range', default: 30, min: 3, max: 100, unit: '%', show: (v) => v.kind === 'image' },
      { key: 'color', label: 'Color', type: 'color', default: '#ffffff', show: (v) => v.kind === 'text' },
      { key: 'opacity', label: 'Opacity', type: 'range', default: 60, min: 5, max: 100, unit: '%' },
      { key: 'turn', label: 'Rotation', type: 'range', default: 0, min: -90, max: 90, unit: '°' },
      { key: 'position', label: 'Position', type: 'select', default: 'br', options: POSITIONS },
    ],
    studio: (host, { files, values }) => {
      let logo = null, seen = null;
      return livePreview(host, files, values, async (c, v) => {
        if (v.image !== seen) { seen = v.image; logo = await watermarkImage(v); }
        drawWatermark(c, v, v.kind === 'image' ? logo : null);
      });
    },
    async run({ files, values, progress }) {
      if (values.kind === 'text' && !values.text.trim()) throw new UserError('Enter the watermark text.');
      if (values.kind === 'image' && !values.image) throw new UserError('Choose a logo image.');
      const mark = await watermarkImage(values);
      progress(0.3, 'Stamping');
      const image = await loadImage(files[0]);
      const out = mapImage(image, (c) => { const n = newCanvas(c.width, c.height); n.getContext('2d').drawImage(c, 0, 0); drawWatermark(n, values, mark); return n; });
      return [await save(out, `${stem(files[0].name)}-watermarked`, outputFormat(files[0]), 0.93)];
    },
  },
  {
    id: 'blur-face', name: 'Blur face', cat: 'security', icon: 'face', accept, multiple: true,
    desc: 'Find faces automatically, and hide plates or anything else by hand.', action: 'Apply',
    note: 'Always check the result. Automatic detection can miss small, turned or covered faces. Solid block hides most securely.',
    fields: [
      { key: 'style', label: 'Style', type: 'select', default: 'blur', options: [['blur', 'Blur'], ['pixel', 'Pixelate'], ['block', 'Solid block']] },
      { key: 'strength', label: 'Strength', type: 'range', default: 60, min: 20, max: 100, unit: '%', show: (v) => v.style !== 'block' },
    ],
    studio: (host, ctx) => blurStudio(host, { ...ctx, shared: {} }),
    async run({ studio, values, progress }) {
      const done = [...studio.opened].filter(([, o]) => o.state.boxes.length);
      if (!done.length) throw new UserError('Mark at least one area first.');
      const results = [];
      for (const [n, [file, { image, state }]] of done.entries()) {
        progress(n / done.length, file.name);
        const out = newCanvas(image.canvas.width, image.canvas.height), ctx = out.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(image.canvas, 0, 0);
        for (const b of state.boxes) {
          const size = Math.min(b.w, b.h) * (values.strength / 100);
          if (values.style === 'block') { ctx.fillStyle = '#000'; ctx.fillRect(b.x, b.y, b.w, b.h); }
          else if (values.style === 'pixel') pixelateArea(ctx, b.x, b.y, b.w, b.h, Math.max(4, size / 6));
          else blurArea(ctx, b.x, b.y, b.w, b.h, Math.max(3, size / 6));
        }
        results.push(await save({ canvas: out }, `${stem(file.name)}-blurred`, outputFormat(file) === 'png' ? 'png' : 'jpg', 0.93));
      }
      return results;
    },
  },
  {
    id: 'convert-to-jpg', name: 'Convert to JPG', cat: 'convert', icon: 'image', accept, multiple: true, batch: true,
    desc: 'Turn PNG, WebP, HEIC, TIFF, PSD, SVG, RAW and GIF into JPG.', action: 'Convert to JPG',
    note: 'RAW files use the full-size preview the camera stored in the file. Transparent areas become white.',
    fields: [
      { key: 'quality', label: 'Quality', type: 'range', default: 92, min: 30, max: 100, unit: '%' },
      { key: 'frames', label: 'Extract every frame of animated GIFs', type: 'checkbox', default: false },
    ],
    async run({ files, values, report }) {
      const file = files[0], image = await loadImage(file), name = stem(file.name), q = values.quality / 100;
      if (image.reduced) report({ title: 'Converted', lines: [reducedLine] });
      if (image.frames && values.frames) {
        const out = [];
        for (const [i, f] of image.frames.entries()) out.push(await save({ canvas: f.canvas }, `${name}-frame-${i + 1}`, 'jpg', q));
        return out;
      }
      return [await save({ canvas: image.canvas }, name, 'jpg', q)];
    },
  },
  {
    id: 'convert-from-jpg', name: 'Convert from JPG', cat: 'convert', icon: 'image-in', accept, multiple: true,
    desc: 'Turn JPGs into PNG, WebP or GIF, or combine several into an animated GIF.', action: 'Convert',
    fields: [
      { key: 'format', label: 'Convert to', type: 'select', default: 'png', options: [['png', 'PNG'], ['webp', 'WebP'], ['gif', 'GIF'], ['animated', 'Animated GIF']] },
      { key: 'delay', label: 'Seconds per frame', type: 'number', default: 0.5, min: 0.02, show: (v) => v.format === 'animated' },
      { key: 'width', label: 'GIF width (px)', type: 'number', default: 640, min: 16, show: (v) => v.format === 'animated' },
    ],
    async run({ files, values, progress }) {
      if (values.format !== 'animated') {
        const out = [];
        for (const [i, file] of files.entries()) {
          progress(i / files.length, file.name);
          out.push(await save(await loadImage(file), stem(file.name), values.format, 0.95));
        }
        return out;
      }
      if (files.length < 2) throw new UserError('Add at least two images to animate.');
      const frames = [], first = await loadImage(files[0]);
      const w = Math.min(+values.width || 640, first.canvas.width), h = Math.round(w * (first.canvas.height / first.canvas.width));
      for (const [i, file] of files.entries()) {
        progress((i / files.length) * 0.4, `Frame ${i + 1} of ${files.length}`);
        const { canvas } = await loadImage(file);
        const frame = newCanvas(w, h), ctx = frame.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        const k = Math.min(w / canvas.width, h / canvas.height);
        const small = scaled(canvas, canvas.width * k, canvas.height * k);
        ctx.drawImage(small, (w - small.width) / 2, (h - small.height) / 2);
        frames.push({ canvas: frame, delay: Math.max(20, values.delay * 1000) });
      }
      progress(0.5, 'Building GIF');
      return [output(`${stem(files[0].name)}-animated.gif`, await encodeGif(frames))];
    },
  },
  {
    id: 'html-to-image', name: 'HTML to image', cat: 'convert', icon: 'code', accept: '.html,.htm,text/html', optionalFiles: true,
    desc: 'Turn an HTML file or pasted markup into a JPG, PNG or SVG.', action: 'Convert',
    note: 'Web addresses cannot be fetched from a browser-only app, so open the page and save it as HTML, or paste its source. Scripts do not run, and remote images and stylesheets are removed.',
    fields: [
      { key: 'source', label: 'HTML', type: 'textarea', default: '', placeholder: '<h1>Hello</h1> … or add a file' },
      { key: 'format', label: 'Format', type: 'select', default: 'jpg', options: [['jpg', 'JPG'], ['png', 'PNG'], ['svg', 'SVG']] },
      { key: 'width', label: 'Page width (px)', type: 'number', default: 1200, min: 200, max: 3000 },
    ],
    async run({ files, values, progress }) {
      const html = files[0] ? await files[0].text() : values.source;
      if (!html.trim()) throw new UserError('Add an HTML file or paste some HTML.');
      const name = files[0] ? stem(files[0].name) : 'page', width = Math.max(200, +values.width || 1200);
      const css = 'body{padding:32px;box-sizing:border-box}';
      const height = await measureHtml(html, css, width);
      if (values.format === 'svg') {
        const { body, styles } = sanitize(html);
        const doc = new DOMParser().parseFromString(`<!doctype html><body>${body}`, 'text/html');
        const inner = new XMLSerializer().serializeToString(doc.body).replace(/^<body/, '<div').replace(/<\/body>$/, '</div>');
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%"><style xmlns="http://www.w3.org/1999/xhtml">${styles.replace(/</g, '&lt;')}body,div{font-family:Arial,sans-serif}</style>${inner}</foreignObject></svg>`;
        return [output(`${name}.svg`, new TextEncoder().encode(svg))];
      }
      progress(0.3, 'Laying out');
      const pdf = await htmlToPdf(html, { css, pageSize: [width, height], mode: 'fixed' });
      const view = await loadPdfJs(pdf);
      const k = Math.min(2 / 0.75, Math.sqrt(maxArea() / (width * height)) / 0.75);
      const canvas = await renderPage(await view.getPage(1), k);
      return [await save({ canvas }, name, values.format, 0.93)];
    },
  },
];
