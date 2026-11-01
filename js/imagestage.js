// Interactive surfaces for the image tools. All sizes stay in image pixels; the screen
// is only a scaled view, so results are identical on a phone and a desktop.
import { loadImage, newCanvas, scaled } from './images.js';
import { el } from './ui.js';

const previewOf = (canvas, limit = 1400) => {
  const k = Math.min(1, limit / Math.max(canvas.width, canvas.height));
  return k < 1 ? scaled(canvas, canvas.width * k, canvas.height * k) : canvas;
};

// A picture with draggable, resizable boxes on top. The picture always fits the screen,
// so dragging on it never needs to double as page scrolling.
export function boxStage(host, canvas, { draw = false, ratio = 0, onChange = () => {}, boxClass = 'box', onAdd } = {}) {
  const W = canvas.width, H = canvas.height;
  const view = previewOf(canvas);
  const shown = view === canvas ? (() => { const c = newCanvas(W, H); c.getContext('2d').drawImage(canvas, 0, 0); return c; })() : view;
  const layer = el('div', { class: 'stage-layer' });
  const stage = el('div', { class: 'stage', style: `aspect-ratio:${W}/${H};--r:${W / H}` }, shown, layer);
  host.append(stage);
  const boxes = [];
  let selected = null, drawing = draw, lock = ratio;

  const at = (e) => {
    const r = layer.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  const place = (b) => {
    const s = b.node.style;
    s.left = `${(b.x / W) * 100}%`; s.top = `${(b.y / H) * 100}%`;
    s.width = `${(b.w / W) * 100}%`; s.height = `${(b.h / H) * 100}%`;
    b.onResize?.(b);
  };
  const select = (b) => {
    selected?.node.classList.remove('selected');
    selected = b;
    b?.node.classList.add('selected');
  };
  const clamp = (b) => {
    b.w = Math.min(b.w, W); b.h = Math.min(b.h, H);
    b.x = Math.min(Math.max(0, b.x), W - b.w);
    b.y = Math.min(Math.max(0, b.y), H - b.h);
  };

  function drag(e, b, corner) {
    e.preventDefault();
    e.stopPropagation();
    select(b);
    const from = { ...b }, start = at(e), right = from.x + from.w, bottom = from.y + from.h;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const min = Math.max(8, Math.min(W, H) * 0.02), keep = b.ratio ?? lock;
    const move = (ev) => {
      const p = at(ev), dx = p.x - start.x, dy = p.y - start.y;
      if (!corner) {
        b.x = from.x + dx; b.y = from.y + dy;
      } else {
        let nw = Math.max(min, from.w + (corner.includes('r') ? dx : -dx));
        let nh = Math.max(min, from.h + (corner.includes('b') ? dy : -dy));
        if (keep) nh = nw / keep;
        b.w = nw; b.h = nh;
        b.x = corner.includes('l') ? right - nw : from.x;
        b.y = corner.includes('t') ? bottom - nh : from.y;
      }
      clamp(b);
      place(b);
      onChange(b);
    };
    const up = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); target.removeEventListener('pointercancel', up); };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }

  function add(box) {
    const b = { ...box };
    b.node = el('div', { class: `${boxClass} ${box.class ?? ''}`, 'data-box': boxes.length },
      box.content, ...['tl', 'tr', 'bl', 'br'].map((c) => el('span', { class: `grip-${c}`, 'aria-hidden': 'true', onpointerdown: (e) => drag(e, b, c) })));
    b.node.addEventListener('pointerdown', (e) => drag(e, b, null));
    layer.append(b.node);
    boxes.push(b);
    clamp(b);
    place(b);
    select(b);
    return b;
  }

  function remove(b = selected) {
    if (!b) return;
    b.node.remove();
    boxes.splice(boxes.indexOf(b), 1);
    if (selected === b) selected = null;
  }

  layer.addEventListener('pointerdown', (e) => {
    if (e.target !== layer) return;
    select(null);
    if (!drawing) return;
    e.preventDefault();
    const start = at(e);
    layer.setPointerCapture(e.pointerId);
    const b = add({ x: start.x, y: start.y, w: 1, h: 1 });
    const move = (ev) => {
      const p = at(ev);
      b.x = Math.min(p.x, start.x); b.y = Math.min(p.y, start.y);
      b.w = Math.abs(p.x - start.x); b.h = Math.abs(p.y - start.y);
      place(b);
    };
    const up = () => {
      layer.removeEventListener('pointermove', move);
      layer.removeEventListener('pointerup', up);
      if (b.w < 6 || b.h < 6) remove(b); else onAdd?.(b);
    };
    layer.addEventListener('pointermove', move);
    layer.addEventListener('pointerup', up);
  });

  return {
    add, remove, boxes, place, width: W, height: H, layer, view: shown,
    setDraw: (on) => { drawing = on; },
    setRatio: (r) => { lock = r; },
    selected: () => selected,
  };
}

// One tab per file. Files load only when opened, which matters on a phone with 20 photos.
export function fileTabs(host, files, build) {
  const opened = new Map();
  const tabs = el('div', { class: 'doc-tabs', role: 'tablist', hidden: files.length < 2 });
  const stage = el('div');
  host.append(tabs, stage);
  const show = async (file, button) => {
    tabs.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', b === button));
    for (const v of opened.values()) v.panel.hidden = true;
    if (!opened.has(file)) {
      const panel = el('div');
      stage.append(panel);
      const image = await loadImage(file);
      opened.set(file, { panel, image, state: await build(panel, image, file) });
    }
    opened.get(file).panel.hidden = false;
  };
  files.forEach((file, i) => tabs.append(el('button', {
    type: 'button', role: 'tab', class: 'doc-tab', 'data-doc': i, 'aria-selected': 'false', onclick: (e) => show(file, e.currentTarget),
  }, file.name)));
  const ready = show(files[0], tabs.firstChild);
  return { ready, opened };
}

// A live preview redrawn from tool settings, shown at a size the phone can repaint quickly.
export async function livePreview(host, files, values, render, extra = '') {
  const image = await loadImage(files[0]);
  const base = previewOf(image.canvas, 1000);
  const out = newCanvas(base.width, base.height);
  const note = files.length > 1 ? el('p', { class: 'muted preview-note' }, `Preview of ${files[0].name}. Settings apply to all ${files.length} images.`) : null;
  host.append(...[el('div', { class: 'preview' }, out), note].filter(Boolean));
  if (extra) host.append(extra);
  let queued = false, latest = values;
  const paint = async () => {
    queued = false;
    const draft = newCanvas(base.width, base.height);
    draft.getContext('2d').drawImage(base, 0, 0);
    await render(draft, latest);
    const ctx = out.getContext('2d');
    ctx.clearRect(0, 0, out.width, out.height);
    ctx.drawImage(draft, 0, 0);
  };
  const update = (v) => {
    latest = v;
    if (queued) return;
    queued = true;
    requestAnimationFrame(paint);
  };
  update(values);
  return { update, image };
}

// Thumbnails for tools that act on many images, such as Rotate.
export function thumbCard(canvas, label) {
  const k = Math.min(1, 320 / Math.max(canvas.width, canvas.height));
  const small = scaled(canvas, canvas.width * k, canvas.height * k);
  const thumb = el('div', { class: 'thumb' }, small);
  return { thumb, node: el('div', { class: 'page-card' }, thumb, el('span', { class: 'page-label image-name' }, label)) };
}
