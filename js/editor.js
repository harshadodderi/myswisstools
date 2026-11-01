// Page-by-page placement surface behind Edit, Sign, Redact and Crop.
// Items are stored in display points (what the user sees, top-left origin).
import { UserError, loadPdfJs, openBytes, readBytes, renderPage, textToCanvas, canvasBytes } from './lib.js';
import { el, modal } from './ui.js';

const MIN = 6;
let nextId = 1;

export async function pageEditor(host, { files, shared = {} }, { mode }) {
  const doc = await loadPdfJs(await openBytes(files[0]));
  const items = [];
  const pagesState = [];
  let tool = { edit: 'text', sign: 'select', redact: 'redact', crop: 'crop' }[mode];
  let selected = null;
  const style = { color: '#111111', size: 14, font: 'Helvetica' };

  const bar = el('div', { class: 'editor-bar', role: 'toolbar', 'aria-label': 'Editing tools' });
  const pagesEl = el('div', { class: 'editor-pages' });
  host.append(bar, pagesEl);

  /* ----- toolbar ----- */

  const toolButtons = new Map();
  const toolButton = (id, label) => {
    const b = el('button', { type: 'button', class: 'ghost', 'data-tool': id, onclick: () => setTool(id) }, label);
    toolButtons.set(id, b);
    bar.append(b);
  };
  const setTool = (id) => {
    tool = id;
    toolButtons.forEach((b, key) => b.setAttribute('aria-pressed', key === id));
    host.dataset.tool = id;
  };

  if (mode === 'edit') {
    toolButton('select', 'Move');
    toolButton('text', 'Text');
    toolButton('whiteout', 'White-out');
    toolButton('box', 'Box');
    toolButton('highlight', 'Highlight');
    toolButton('ink', 'Draw');
    bar.append(el('button', { type: 'button', class: 'ghost', onclick: () => pickImage(false) }, 'Image'));
    bar.append(el('label', { class: 'inline' }, 'Color ', el('input', {
      type: 'color', value: style.color, oninput: (e) => { style.color = e.target.value; restyle(); },
    })));
    bar.append(el('label', { class: 'inline' }, 'Size ', el('input', {
      type: 'number', min: 6, max: 144, value: style.size, oninput: (e) => { style.size = +e.target.value || 14; restyle(); },
    })));
    bar.append(el('label', { class: 'inline' }, 'Font ', el('select', { oninput: (e) => { style.font = e.target.value; restyle(); } },
      [['Helvetica', 'Sans'], ['TimesRoman', 'Serif'], ['Courier', 'Mono'], ['HelveticaBold', 'Sans bold']].map(([v, t]) => el('option', { value: v }, t)))));
  }

  if (mode === 'sign') {
    bar.append(el('button', { type: 'button', class: 'primary', id: 'new-signature', onclick: createSignature }, 'Create signature'));
    bar.append(el('button', { type: 'button', class: 'ghost', onclick: () => pickImage(true) }, 'Upload signature'));
    bar.append(el('button', { type: 'button', class: 'ghost', onclick: addDate }, 'Add date'));
    bar.append(el('button', { type: 'button', class: 'ghost', id: 'sign-all', onclick: copyToAll }, 'Repeat on every page'));
    bar.append(el('span', { class: 'muted' }, 'Then click a page to place it.'));
  }

  const search = el('input', { type: 'search', placeholder: 'Find text to redact', 'aria-label': 'Find text to redact' });
  if (mode === 'redact') {
    bar.append(el('span', { class: 'muted' }, 'Drag over anything to black it out, or search:'));
    bar.append(search, el('button', { type: 'button', class: 'ghost', id: 'find-redact', onclick: redactMatches }, 'Mark all matches'));
  }

  const cropAll = el('input', { type: 'checkbox', checked: true });
  if (mode === 'crop') {
    bar.append(el('span', { class: 'muted' }, 'Drag the box edges to set the crop.'));
    bar.append(el('label', { class: 'inline' }, cropAll, ' Apply to every page'));
  }

  if (mode !== 'crop') {
    bar.append(el('button', { type: 'button', class: 'ghost', id: 'delete-item', onclick: () => selected && removeItem(selected) }, 'Delete selected'));
  }

  /* ----- pages ----- */

  const io = new IntersectionObserver((seen) => {
    for (const s of seen) if (s.isIntersecting) { io.unobserve(s.target); s.target.draw(); }
  }, { rootMargin: '600px' });

  for (let i = 0; i < doc.numPages; i++) {
    const page = await doc.getPage(i + 1);
    const vp = page.getViewport({ scale: 1, rotation: page.rotate });
    const width = vp.width, height = vp.height;
    const sheet = el('div', { class: 'sheet', 'data-page': i, style: `aspect-ratio:${width}/${height};max-width:${Math.max(width, 620)}px` });
    const layer = el('div', { class: 'layer' });
    sheet.append(layer);
    sheet.draw = async () => {
      const css = sheet.clientWidth || 700;
      const c = await renderPage(page, Math.min((css / width) * (devicePixelRatio || 1), 3));
      sheet.prepend(c);
    };
    pagesEl.append(el('div', { class: 'sheet-wrap' }, sheet, el('span', { class: 'page-label' }, `Page ${i + 1}`)));
    pagesState.push({ page, width, height, sheet, layer });
    io.observe(sheet);
    bindPage(i);
  }
  setTool(tool);

  const toPoints = (i, e) => {
    const s = pagesState[i], r = s.layer.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * s.width, y: ((e.clientY - r.top) / r.height) * s.height };
  };

  function bindPage(i) {
    const { layer } = pagesState[i];
    layer.addEventListener('pointerdown', (e) => {
      if (e.target !== layer || e.button) return;
      e.preventDefault();
      select(null);
      const start = toPoints(i, e);
      if (mode === 'sign' || tool === 'image') { if (shared.image) placeImage(i, start); return; }
      if (tool === 'select' || mode === 'crop') return;
      if (tool === 'text') { addText(i, start); return; }
      layer.setPointerCapture(e.pointerId);
      if (tool === 'ink') {
        const item = addItem({ type: 'ink', page: i, points: [start], color: style.color, width: Math.max(1, style.size / 7) });
        const move = (ev) => { item.points.push(toPoints(i, ev)); drawInk(item); };
        const up = () => { layer.removeEventListener('pointermove', move); layer.removeEventListener('pointerup', up); };
        layer.addEventListener('pointermove', move);
        layer.addEventListener('pointerup', up);
        return;
      }
      const item = addItem({ type: tool, page: i, x: start.x, y: start.y, w: 1, h: 1, color: style.color });
      const move = (ev) => {
        const p = toPoints(i, ev);
        item.x = Math.min(p.x, start.x); item.y = Math.min(p.y, start.y);
        item.w = Math.abs(p.x - start.x); item.h = Math.abs(p.y - start.y);
        position(item);
      };
      const up = () => {
        layer.removeEventListener('pointermove', move);
        layer.removeEventListener('pointerup', up);
        if (item.w < MIN || item.h < MIN) removeItem(item); else select(item);
      };
      layer.addEventListener('pointermove', move);
      layer.addEventListener('pointerup', up);
    });
  }

  /* ----- items ----- */

  function addItem(item) {
    item.id = nextId++;
    const node = el('div', { class: `item item-${item.type}`, 'data-id': item.id });
    item.node = node;
    items.push(item);
    pagesState[item.page].layer.append(node);
    if (item.type === 'ink') {
      node.innerHTML = `<svg viewBox="0 0 ${pagesState[item.page].width} ${pagesState[item.page].height}" preserveAspectRatio="none"><path fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      drawInk(item);
    } else {
      node.append(el('span', { class: 'handle', 'aria-hidden': 'true' }));
      bindItem(item);
      position(item);
    }
    return item;
  }

  function position(item) {
    const s = pagesState[item.page], n = item.node.style;
    n.left = `${(item.x / s.width) * 100}%`; n.top = `${(item.y / s.height) * 100}%`;
    n.width = `${(item.w / s.width) * 100}%`; n.height = `${(item.h / s.height) * 100}%`;
    if (item.type === 'box') n.borderColor = item.color;
    if (item.type === 'text') {
      const text = item.node.querySelector('.text-input');
      if (!text) return;
      text.style.color = item.color;
      text.style.fontSize = `${(item.size / s.width) * 100}cqw`;
      text.style.fontFamily = { TimesRoman: 'Times New Roman, serif', Courier: 'Courier New, monospace' }[item.font] || 'Arial, Helvetica, sans-serif';
      text.style.fontWeight = item.font === 'HelveticaBold' ? 700 : 400;
    }
  }

  function drawInk(item) {
    const path = item.node.querySelector('path');
    path.setAttribute('d', item.points.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' '));
    path.setAttribute('stroke', item.color);
    path.setAttribute('stroke-width', item.width);
  }

  function bindItem(item) {
    item.node.addEventListener('pointerdown', (e) => {
      if (e.button) return;
      select(item);
      const editing = e.target.closest('.text-input');
      if (editing && document.activeElement === editing) return;
      const resizing = e.target.classList.contains('handle');
      if (!resizing && editing && tool === 'text') return;
      e.preventDefault();
      const s = pagesState[item.page], start = toPoints(item.page, e), from = { ...item };
      const ratio = item.type === 'image' ? item.w / item.h : 0;
      item.node.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const p = toPoints(item.page, ev), dx = p.x - start.x, dy = p.y - start.y;
        if (resizing) {
          item.w = Math.max(MIN * 2, from.w + dx);
          item.h = ratio ? item.w / ratio : Math.max(MIN * 2, from.h + dy);
        } else {
          item.x = Math.min(Math.max(0, from.x + dx), s.width - item.w);
          item.y = Math.min(Math.max(0, from.y + dy), s.height - item.h);
        }
        position(item);
      };
      const up = () => { item.node.removeEventListener('pointermove', move); item.node.removeEventListener('pointerup', up); };
      item.node.addEventListener('pointermove', move);
      item.node.addEventListener('pointerup', up);
    });
  }

  function select(item) {
    selected?.node.classList.remove('selected');
    selected = item;
    item?.node.classList.add('selected');
  }

  function removeItem(item) {
    if (mode === 'crop') return;
    item.node.remove();
    items.splice(items.indexOf(item), 1);
    if (selected === item) selected = null;
  }

  function restyle() {
    if (!selected) return;
    if (selected.type === 'text') { Object.assign(selected, { color: style.color, size: style.size, font: style.font }); position(selected); }
    else if (selected.type === 'box') { selected.color = style.color; position(selected); }
  }

  document.addEventListener('keydown', (e) => {
    if (!host.isConnected || !selected) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && !e.target.closest('input, [contenteditable]')) removeItem(selected);
  });

  function addText(page, at) {
    const item = { type: 'text', page, x: at.x, y: at.y - style.size * 0.7, w: Math.max(160, style.size * 10), h: style.size * 1.6, ...style };
    addItemText(item);
    setTool('select');
    item.node.querySelector('.text-input').focus();
  }

  function addItemText(item) {
    addItem(item);
    const input = el('div', { class: 'text-input', contentEditable: 'true', spellcheck: false, 'aria-label': 'Text' });
    input.textContent = item.value || '';
    input.addEventListener('input', () => { item.value = input.innerText; });
    item.node.prepend(input);
    position(item);
    return item;
  }

  /* ----- images and signatures ----- */

  function pickImage(signature) {
    const input = el('input', { type: 'file', accept: 'image/png,image/jpeg', onchange: async () => {
      const file = input.files[0];
      if (!file) return;
      await armImage(await readBytes(file), file.type);
      if (!signature) setTool('image');
    } });
    input.click();
  }

  async function armImage(bytes, type) {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const img = new Image();
    img.src = url;
    await img.decode();
    shared.image = { bytes, type, url, ratio: img.naturalWidth / img.naturalHeight };
    host.dataset.armed = 'true';
  }

  function placeImage(page, at) {
    const { bytes, type, url, ratio } = shared.image;
    const w = Math.min(180, pagesState[page].width * 0.5), h = w / ratio;
    const item = addItem({ type: 'image', page, x: Math.max(0, at.x - w / 2), y: Math.max(0, at.y - h / 2), w, h, bytes, mime: type });
    item.node.prepend(el('img', { src: url, alt: '', draggable: false }));
    select(item);
    if (mode === 'edit') { shared.image = null; setTool('select'); }
  }

  async function createSignature() {
    const canvas = el('canvas', { class: 'sign-pad', width: 900, height: 300, 'aria-label': 'Draw your signature' });
    const ctx = canvas.getContext('2d');
    ctx.lineWidth = 6; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    let drew = false, last = null;
    const at = (e) => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * 900 / r.width, (e.clientY - r.top) * 300 / r.height]; };
    canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); last = at(e); });
    canvas.addEventListener('pointermove', (e) => {
      if (!last) return;
      const p = at(e);
      ctx.strokeStyle = ink.value;
      ctx.beginPath(); ctx.moveTo(...last); ctx.lineTo(...p); ctx.stroke();
      last = p; drew = true;
    });
    canvas.addEventListener('pointerup', () => { last = null; });
    const typed = el('input', { type: 'text', placeholder: 'Or type your name', id: 'typed-signature', 'aria-label': 'Typed signature' });
    const ink = el('input', { type: 'color', value: '#16213e', 'aria-label': 'Ink color' });
    const clear = el('button', { type: 'button', class: 'link', onclick: () => { ctx.clearRect(0, 0, 900, 300); drew = false; } }, 'Clear');
    const ok = await modal({
      title: 'Create signature', confirm: 'Use signature',
      body: el('div', { class: 'stack' }, canvas, el('div', { class: 'row' }, clear, ink), typed),
    });
    if (!ok) return;
    let source = canvas;
    if (typed.value.trim()) {
      source = textToCanvas(typed.value.trim(), { size: 44, color: ink.value, font: 'italic', scale: 3 }).canvas;
    } else if (!drew) return;
    await armImage(await canvasBytes(source, 'image/png'), 'image/png');
  }

  function addDate() {
    const value = new Date().toLocaleDateString();
    const item = { type: 'text', page: 0, x: 40, y: 40, w: 140, h: 22, color: '#111111', size: 12, font: 'Helvetica', value };
    addItemText(item);
    select(item);
  }

  function copyToAll() {
    const sign = selected?.type === 'image' ? selected : items.find((i) => i.type === 'image');
    if (!sign) throw new UserError('Place a signature first.');
    for (let p = 0; p < pagesState.length; p++) {
      if (p === sign.page) continue;
      const item = addItem({ ...sign, page: p, node: null, id: 0 });
      item.node.prepend(el('img', { src: sign.node.querySelector('img').src, alt: '', draggable: false }));
    }
  }

  /* ----- redaction search ----- */

  async function redactMatches() {
    const q = search.value.trim().toLowerCase();
    if (!q) return;
    let hits = 0;
    for (let i = 0; i < pagesState.length; i++) {
      const { page } = pagesState[i];
      const vp = page.getViewport({ scale: 1, rotation: page.rotate });
      const { items: textItems } = await page.getTextContent();
      for (const t of textItems) {
        const lower = t.str.toLowerCase();
        for (let at = lower.indexOf(q); at >= 0; at = lower.indexOf(q, at + q.length)) {
          const h = Math.hypot(t.transform[2], t.transform[3]) || t.height;
          const per = t.width / Math.max(1, t.str.length);
          const [x, y] = vp.convertToViewportPoint(t.transform[4], t.transform[5]);
          addItem({ type: 'redact', page: i, x: x + per * at - 1, y: y - h, w: per * q.length + 2, h: h * 1.3 });
          hits++;
        }
      }
    }
    search.value = '';
    search.placeholder = hits ? `${hits} marked` : 'No matches';
  }

  /* ----- crop box ----- */

  if (mode === 'crop') {
    const { width, height } = pagesState[0];
    const inset = Math.min(width, height) * 0.08;
    addItem({ type: 'crop', page: 0, x: inset, y: inset, w: width - inset * 2, h: height - inset * 2 });
  }

  return {
    pageCount: () => pagesState.length,
    items: () => items,
    sizes: () => pagesState,
    crop: () => {
      const r = items.find((i) => i.type === 'crop');
      return { rect: r && { page: r.page, x: r.x, y: r.y, w: r.w, h: r.h }, all: cropAll.checked };
    },
  };
}
