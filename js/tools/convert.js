// Everything that moves content into or out of PDF.
import {
  UserError, breathe, canvasBytes, docx, jszip, loadPdfJs, mammoth, openBytes, output, pageImages, pageLines,
  pdfLib, pdfjs, pptxgen, readBytes, renderPage, stem, xlsx,
} from '../lib.js';
import { PAGE_SIZES, htmlToPdf } from '../htmlpdf.js';
import { el } from '../ui.js';

const pdf = '.pdf,application/pdf';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- images to PDF (also used by Scan) ---------- */

const decodeFile = async (file) => {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
  if (!bitmap) throw new UserError(`${file.name} is not an image this browser can read.`);
  return bitmap;
};

async function imagesToPdf(sources, values, progress = () => {}) {
  const { PDFDocument } = await pdfLib();
  const out = await PDFDocument.create();
  const M = +values.margin || 0;
  for (let i = 0; i < sources.length; i++) {
    progress(i / sources.length, `Image ${i + 1} of ${sources.length}`);
    const source = sources[i];
    const bitmap = source instanceof Blob ? await decodeFile(source) : source;
    const c = document.createElement('canvas');
    c.width = bitmap.width; c.height = bitmap.height;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bitmap, 0, 0);
    const img = await out.embedJpg(await canvasBytes(c, 'image/jpeg', 0.92));
    let pw, ph;
    if (values.size === 'fit') { pw = c.width * 0.75 + M * 2; ph = c.height * 0.75 + M * 2; }
    else {
      [pw, ph] = values.size === 'Letter' ? [612, 792] : [595.28, 841.89];
      const wide = values.orient === 'landscape' || (values.orient === 'auto' && c.width > c.height);
      if (wide) [pw, ph] = [ph, pw];
    }
    const scale = Math.min((pw - M * 2) / c.width, (ph - M * 2) / c.height);
    const w = c.width * scale, h = c.height * scale;
    out.addPage([pw, ph]).drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
    await breathe();
  }
  return out.save();
}

const pageFields = [
  { key: 'size', label: 'Page size', type: 'select', default: 'A4', options: [['A4', 'A4'], ['Letter', 'US Letter'], ['fit', 'Same as image']] },
  { key: 'orient', label: 'Orientation', type: 'select', default: 'auto', options: [['auto', 'Automatic'], ['portrait', 'Portrait'], ['landscape', 'Landscape']], show: (v) => v.size !== 'fit' },
  { key: 'margin', label: 'Margin (pt)', type: 'number', default: 0, min: 0 },
];

/* ---------- PDF to Word ---------- */

// Groups lines into paragraphs and, where columns line up, tables.
function structure(lines, pageWidth) {
  const blocks = [];
  const sizes = lines.map((l) => l.size).sort((a, b) => a - b);
  const body = sizes[Math.floor(sizes.length / 2)] || 11;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], prev = lines[i - 1], last = blocks.at(-1);
    if (line.runs.length >= 2) {
      if (last?.table && last.columns === line.runs.length) last.rows.push(line.runs.map((r) => r.str.trim()));
      else blocks.push({ table: true, columns: line.runs.length, rows: [line.runs.map((r) => r.str.trim())], y: line.y });
      continue;
    }
    const heading = line.size > body * 1.15;
    const gap = prev ? line.y - prev.y : 1e9;
    const joins = last && !last.table && !heading && !last.heading
      && gap < line.size * 1.75 && Math.abs(line.x - last.x) < 18;
    if (joins) {
      last.text += (last.text.endsWith('-') ? '' : ' ') + line.text.trim();
      last.bold &&= line.bold;
    } else {
      blocks.push({
        text: line.text.trim(), heading, size: line.size, bold: line.bold, italic: line.italic, x: line.x, y: line.y,
        center: Math.abs(line.x * 2 + (line.runs[0].right - line.x) - pageWidth) < 12,
      });
    }
  }
  // A one-row "table" is just a line with a wide gap.
  return blocks.flatMap((b) => (b.table && b.rows.length < 2 ? [{ text: b.rows[0].join('\t'), y: b.y, size: body, x: 0 }] : [b]));
}

async function pdfToWord({ files, progress }) {
  const D = await docx();
  const lib = await pdfjs();
  const view = await loadPdfJs(await openBytes(files[0]));
  const sections = [];
  for (let n = 1; n <= view.numPages; n++) {
    progress((n - 1) / view.numPages, `Page ${n} of ${view.numPages}`);
    const page = await view.getPage(n);
    const vp = page.getViewport({ scale: 1, rotation: page.rotate });
    const lines = await pageLines(page);
    const images = await pageImages(page, lib);
    const children = [];
    const place = async (canvas, w, h) => {
      const fit = Math.min(1, 620 / w);
      children.push(new D.Paragraph({ children: [new D.ImageRun({
        type: 'png', data: await canvasBytes(canvas, 'image/png'), transformation: { width: w * fit, height: h * fit },
      })] }));
    };
    const blocks = structure(lines, vp.width).map((b) => ({ ...b, kind: 'text' }));
    const covers = (im) => im.width > vp.width * 0.85 && im.height > vp.height * 0.85;
    const pics = images.filter((im) => !(lines.length && covers(im))).map((im) => ({ kind: 'image', y: im.top, im }));
    for (const b of [...blocks, ...pics].sort((a, c) => a.y - c.y)) {
      if (b.kind === 'image') { await place(b.im.canvas, b.im.width * 1.33, b.im.height * 1.33); continue; }
      if (b.table) {
        children.push(new D.Table({
          width: { size: 100, type: D.WidthType.PERCENTAGE },
          rows: b.rows.map((row) => new D.TableRow({ children: row.map((cell) => new D.TableCell({ children: [new D.Paragraph(cell)] })) })),
        }));
        continue;
      }
      const run = new D.TextRun({ text: b.text, bold: b.bold, italics: b.italic, size: Math.round(b.size * 2) });
      children.push(new D.Paragraph({
        children: [run], spacing: { after: 120 },
        heading: b.heading ? (b.size > 18 ? D.HeadingLevel.HEADING_1 : D.HeadingLevel.HEADING_2) : undefined,
        alignment: b.center ? D.AlignmentType.CENTER : undefined,
      }));
    }
    if (!children.length) {
      // A scan with no text layer: keep the page visually.
      const c = await renderPage(page, 1.5);
      await place(c, 600, 600 * (c.height / c.width));
    }
    sections.push({
      properties: { page: { size: { width: Math.round(vp.width * 20), height: Math.round(vp.height * 20) }, margin: { top: 720, bottom: 720, left: 900, right: 900 } } },
      children,
    });
    await breathe();
  }
  const blob = await D.Packer.toBlob(new D.Document({ sections }));
  return [output(`${stem(files[0].name)}.docx`, await readBytes(blob))];
}

/* ---------- PDF to PowerPoint ---------- */

async function pdfToPpt({ files, values, progress }) {
  const Pptx = await pptxgen();
  const lib = await pdfjs();
  const view = await loadPdfJs(await openBytes(files[0]));
  const deck = new Pptx();
  const first = (await view.getPage(1)).getViewport({ scale: 1 });
  const W = 13.333, H = W * (first.height / first.width);
  deck.defineLayout({ name: 'DOC', width: W, height: H });
  deck.layout = 'DOC';
  for (let n = 1; n <= view.numPages; n++) {
    progress((n - 1) / view.numPages, `Page ${n} of ${view.numPages}`);
    const page = await view.getPage(n);
    const vp = page.getViewport({ scale: 1, rotation: page.rotate });
    const k = W / vp.width;
    const slide = deck.addSlide();
    const pngData = (c) => `data:image/png;base64,${c.toDataURL('image/png').split(',')[1]}`;
    const lines = values.mode === 'text' ? await pageLines(page) : [];
    if (values.mode === 'text' && lines.length) {
      for (const im of await pageImages(page, lib)) {
        if (im.width > vp.width * 0.9 && im.height > vp.height * 0.9) continue;
        slide.addImage({ data: pngData(im.canvas), x: im.left * k, y: im.top * k, w: im.width * k, h: im.height * k });
      }
      for (const line of lines) {
        for (const run of line.runs) {
          slide.addText(run.str.trim(), {
            x: run.x * k, y: (line.y - line.size) * k, w: Math.max((run.right - run.x) * k * 1.12, 0.2), h: line.size * 1.5 * k,
            fontSize: Math.max(6, line.size * k * 72), bold: line.bold, italic: line.italic, margin: 0, fit: 'none', wrap: false, valign: 'top',
          });
        }
      }
    } else {
      const c = await renderPage(page, 2);
      slide.addImage({ data: `data:image/jpeg;base64,${c.toDataURL('image/jpeg', 0.9).split(',')[1]}`, x: 0, y: 0, w: W, h: H });
    }
    await breathe();
  }
  const data = await deck.write({ outputType: 'arraybuffer' });
  return [output(`${stem(files[0].name)}.pptx`, new Uint8Array(data))];
}

/* ---------- PDF to Excel ---------- */

// Finds column boundaries from the gaps that run down the whole page.
function toGrid(lines) {
  // Titles and paragraphs span the page and would merge every column, so tabular lines decide.
  const tabular = lines.filter((l) => l.runs.length > 1);
  const spans = (tabular.length ? tabular : lines).flatMap((l) => l.runs.map((r) => [r.x, r.right])).sort((a, b) => a[0] - b[0]);
  const cols = [];
  for (const [a, b] of spans) {
    const last = cols.at(-1);
    if (last && a <= last[1] + 3) last[1] = Math.max(last[1], b);
    else cols.push([a, b]);
  }
  return lines.map((line) => {
    const row = new Array(cols.length).fill(null);
    for (const r of line.runs) {
      let c = cols.findIndex(([a, b]) => r.x >= a - 1 && r.x <= b + 1);
      if (c < 0) c = cols.reduce((best, [a], i) => (Math.abs(a - r.x) < Math.abs(cols[best][0] - r.x) ? i : best), 0);
      const text = r.str.trim();
      const number = /^[-(]?[\d,]*\.?\d+\)?%?$/.test(text) && /\d/.test(text)
        ? Number(text.replace(/[,()%]/g, '')) * (text.startsWith('(') ? -1 : 1) / (text.endsWith('%') ? 100 : 1) : null;
      row[c] = row[c] == null ? (number ?? text) : `${row[c]} ${text}`;
    }
    return row;
  });
}

/* ---------- PowerPoint to PDF ---------- */

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const EMU = 9525;

const parseXml = (s) => new DOMParser().parseFromString(s, 'application/xml');
const kids = (node, ns, name) => (node ? [...node.childNodes].filter((n) => n.localName === name && n.namespaceURI === ns) : []);
const first = (node, ns, name) => node?.getElementsByTagNameNS(ns, name)[0] ?? null;

async function readRels(zip, path) {
  const file = zip.file(path.replace(/([^/]+)$/, '_rels/$1.rels'));
  const map = {};
  if (!file) return map;
  for (const r of parseXml(await file.async('text')).getElementsByTagName('Relationship')) {
    const target = r.getAttribute('Target');
    map[r.getAttribute('Id')] = target.startsWith('/') ? target.slice(1)
      : new URL(target, `http://x/${path}`).pathname.slice(1);
  }
  return map;
}

function colorOf(node, theme) {
  if (!node) return null;
  const srgb = kids(node, NS_A, 'srgbClr')[0];
  if (srgb) return `#${srgb.getAttribute('val')}`;
  const scheme = kids(node, NS_A, 'schemeClr')[0];
  if (scheme) {
    const v = scheme.getAttribute('val');
    return theme[{ tx1: 'dk1', tx2: 'dk2', bg1: 'lt1', bg2: 'lt2' }[v] || v] || null;
  }
  return null;
}

async function pptxToHtml(bytes) {
  const JSZip = await jszip();
  const zip = await JSZip.loadAsync(bytes);
  const presPath = 'ppt/presentation.xml';
  if (!zip.file(presPath)) throw new UserError('This is not a PowerPoint .pptx file. Older .ppt files must be saved as .pptx first.');
  const pres = parseXml(await zip.file(presPath).async('text'));
  const size = pres.getElementsByTagNameNS(NS_P, 'sldSz')[0];
  const W = +size.getAttribute('cx') / EMU, H = +size.getAttribute('cy') / EMU;
  const rels = await readRels(zip, presPath);

  const theme = {};
  const themeFile = zip.file('ppt/theme/theme1.xml');
  if (themeFile) {
    const scheme = first(parseXml(await themeFile.async('text')), NS_A, 'clrScheme');
    for (const c of scheme?.children ?? []) {
      const val = c.firstElementChild;
      theme[c.localName] = `#${val?.getAttribute('val') || val?.getAttribute('lastClr') || '000000'}`;
    }
  }

  const xfrmOf = (sp) => {
    const x = first(sp, NS_A, 'xfrm');
    const off = kids(x, NS_A, 'off')[0], ext = kids(x, NS_A, 'ext')[0];
    if (!off || !ext) return null;
    return { x: +off.getAttribute('x') / EMU, y: +off.getAttribute('y') / EMU, w: +ext.getAttribute('cx') / EMU, h: +ext.getAttribute('cy') / EMU };
  };

  const textHtml = (body, defaults) => kids(body, NS_A, 'p').map((p) => {
    const pPr = kids(p, NS_A, 'pPr')[0];
    const algn = { ctr: 'center', r: 'right', just: 'justify' }[pPr?.getAttribute('algn')] || defaults.align || 'left';
    const bullet = pPr && kids(pPr, NS_A, 'buChar').length ? `${kids(pPr, NS_A, 'buChar')[0].getAttribute('char')} ` : '';
    const indent = (+(pPr?.getAttribute('lvl')) || 0) * 24;
    const runs = kids(p, NS_A, 'r').concat(kids(p, NS_A, 'fld')).map((r) => {
      const rPr = kids(r, NS_A, 'rPr')[0];
      const sz = rPr?.getAttribute('sz');
      const fill = colorOf(kids(rPr, NS_A, 'solidFill')[0], theme);
      const style = [
        `font-size:${sz ? (+sz / 100) * 1.333 : defaults.size}px`,
        fill || defaults.color ? `color:${fill || defaults.color}` : '',
        rPr?.getAttribute('b') === '1' || defaults.bold ? 'font-weight:700' : '',
        rPr?.getAttribute('i') === '1' ? 'font-style:italic' : '',
        rPr?.getAttribute('u') && rPr.getAttribute('u') !== 'none' ? 'text-decoration:underline' : '',
      ].filter(Boolean).join(';');
      return `<span style="${style}">${esc(kids(r, NS_A, 't')[0]?.textContent)}</span>`;
    }).join('');
    return `<p style="margin:0 0 4px ${indent}px;text-align:${algn};min-height:1em;line-height:1.15">${bullet ? esc(bullet) : ''}${runs}</p>`;
  }).join('');

  const media = async (path) => {
    const file = zip.file(path);
    if (!file) return null;
    const ext = path.split('.').pop().toLowerCase();
    const type = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' }[ext];
    return type ? `data:${type};base64,${await file.async('base64')}` : null;
  };

  const shapesHtml = async (tree, slideRels, skipPlaceholders) => {
    let out = '';
    for (const node of tree.children) {
      if (node.localName === 'grpSp') { out += await shapesHtml(node, slideRels, skipPlaceholders); continue; }
      const box = xfrmOf(node);
      if (!box && !(node.localName === 'sp')) continue;
      const pos = box ? `left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px` : `left:${W * 0.08}px;top:${H * 0.28}px;width:${W * 0.84}px;height:${H * 0.6}px`;
      if (node.localName === 'pic') {
        const embed = first(node, NS_A, 'blip')?.getAttributeNS(NS_R, 'embed');
        const src = embed && await media(slideRels[embed]);
        if (src) out += `<img src="${src}" alt="" style="position:absolute;${pos};max-width:none">`;
      } else if (node.localName === 'sp') {
        const ph = first(node, NS_P, 'ph');
        if (skipPlaceholders && ph) continue;
        const spPr = kids(node, NS_P, 'spPr')[0];
        const fill = colorOf(kids(spPr, NS_A, 'solidFill')[0], theme);
        const line = colorOf(kids(kids(spPr, NS_A, 'ln')[0], NS_A, 'solidFill')[0], theme);
        const round = first(spPr, NS_A, 'prstGeom')?.getAttribute('prst') === 'ellipse' ? 'border-radius:50%;' : '';
        const body = kids(node, NS_P, 'txBody')[0];
        const type = ph?.getAttribute('type');
        const title = type === 'title' || type === 'ctrTitle';
        const anchor = { ctr: 'center', b: 'flex-end' }[first(body, NS_A, 'bodyPr')?.getAttribute('anchor')] || (title ? 'center' : 'flex-start');
        const defaults = { size: title ? 44 : 24, color: theme.dk1, bold: false, align: type === 'ctrTitle' ? 'center' : 'left' };
        const titleBox = !box && title ? `left:${W * 0.07}px;top:${H * 0.05}px;width:${W * 0.86}px;height:${H * 0.2}px` : pos;
        out += `<div style="position:absolute;${titleBox};display:flex;flex-direction:column;justify-content:${anchor};padding:6px 10px;box-sizing:border-box;${fill ? `background:${fill};` : ''}${line ? `border:1px solid ${line};` : ''}${round}">${body ? textHtml(body, defaults) : ''}</div>`;
      } else if (node.localName === 'graphicFrame') {
        const table = first(node, NS_A, 'tbl');
        if (!table) continue;
        const rows = kids(table, NS_A, 'tr').map((tr) => `<tr>${kids(tr, NS_A, 'tc').map((tc) => `<td>${textHtml(kids(tc, NS_A, 'txBody')[0], { size: 18 })}</td>`).join('')}</tr>`).join('');
        out += `<table style="position:absolute;${pos}">${rows}</table>`;
      }
    }
    return out;
  };

  const background = async (path, slideXml, slideRels) => {
    const bg = first(slideXml, NS_P, 'bg');
    if (!bg) return '';
    const fill = colorOf(first(bg, NS_A, 'solidFill'), theme);
    if (fill) return `background:${fill};`;
    const embed = first(bg, NS_A, 'blip')?.getAttributeNS(NS_R, 'embed');
    const src = embed && await media(slideRels[embed]);
    return src ? `<img src="${src}" alt="" style="position:absolute;left:0;top:0;width:${W}px;height:${H}px;max-width:none">` : '';
  };

  const slides = [];
  const ids = [...pres.getElementsByTagNameNS(NS_P, 'sldId')];
  for (const id of ids) {
    const path = rels[id.getAttributeNS(NS_R, 'id')];
    const xml = parseXml(await zip.file(path).async('text'));
    const slideRels = await readRels(zip, path);
    let inner = '', style = '';
    const layoutPath = Object.values(slideRels).find((p) => /slideLayouts\//.test(p));
    const layers = [];
    if (layoutPath && zip.file(layoutPath)) {
      const layoutRels = await readRels(zip, layoutPath);
      const masterPath = Object.values(layoutRels).find((p) => /slideMasters\//.test(p));
      if (masterPath && zip.file(masterPath)) layers.push([parseXml(await zip.file(masterPath).async('text')), await readRels(zip, masterPath)]);
      layers.push([parseXml(await zip.file(layoutPath).async('text')), layoutRels]);
    }
    layers.push([xml, slideRels]);
    for (const [doc, r] of layers) {
      const bg = await background(path, doc, r);
      if (bg.startsWith('<')) inner += bg; else if (bg) style = bg;
      const tree = first(doc, NS_P, 'spTree');
      if (tree) inner += await shapesHtml(tree, r, doc !== xml);
    }
    slides.push(`<section class="slide" style="${style}">${inner}</section>`);
  }
  const css = `.slide{position:relative;width:${W}px;height:${H}px;overflow:hidden;background:#fff;font-family:Arial,Helvetica,sans-serif;}body{font-size:18px}`;
  return { html: slides.join(''), css, pageSize: [W, H] };
}

/* ---------- Excel to PDF ---------- */

function sheetsToHtml(X, wb) {
  return wb.SheetNames.map((name, i) => {
    const sheet = wb.Sheets[name];
    if (!sheet['!ref']) return '';
    const table = X.utils.sheet_to_html(sheet, { header: '', footer: '' })
      .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/ id="[^"]*"/g, '').replace(/ t="[^"]*"/g, '').replace(/ v="[^"]*"/g, '');
    return `<section ${i ? 'style="break-before:column"' : ''} class="sheet"><h2>${esc(name)}</h2>${table}</section>`;
  }).join('');
}

/* ---------- Scan ---------- */

function enhance(canvas, kind) {
  if (kind === 'none') return canvas;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height), d = img.data;
  // Stretch levels from the 2nd to 98th percentile, which lifts grey paper to white.
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) hist[(d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11) | 0]++;
  const total = d.length / 4;
  let low = 0, high = 255, sum = 0;
  while (low < 255 && (sum += hist[low]) < total * 0.02) low++;
  sum = 0;
  while (high > 0 && (sum += hist[high]) < total * 0.02) high--;
  const range = Math.max(1, high - low);
  for (let i = 0; i < d.length; i += 4) {
    if (kind === 'bw') {
      const lum = (d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11 - low) / range;
      d[i] = d[i + 1] = d[i + 2] = lum > 0.55 ? 255 : Math.max(0, lum * 180);
    } else for (let c = 0; c < 3; c++) d[i + c] = ((d[i + c] - low) / range) * 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function scanStudio(host, { files }) {
  const shots = [];
  const list = el('div', { class: 'page-grid' });
  const video = el('video', { playsInline: true, muted: true, class: 'scan-video', hidden: true });
  let stream = null;
  const stop = () => { stream?.getTracks().forEach((t) => t.stop()); stream = null; video.hidden = true; shootBtn.hidden = true; startBtn.hidden = false; };
  const add = (canvas) => {
    const entry = { canvas };
    shots.push(entry);
    const node = el('div', { class: 'page-card' }, el('div', { class: 'thumb' }, canvas),
      el('div', { class: 'card-actions' }, el('button', { type: 'button', 'aria-label': 'Delete scan', onclick: () => { node.remove(); shots.splice(shots.indexOf(entry), 1); } }, '×')));
    list.append(node);
  };
  const startBtn = el('button', { type: 'button', class: 'ghost', onclick: async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 2560 } } });
    } catch { throw new UserError('Camera access was blocked. You can add photos instead.'); }
    video.srcObject = stream; video.hidden = false; await video.play();
    startBtn.hidden = true; shootBtn.hidden = false;
  } }, 'Use camera');
  const shootBtn = el('button', { type: 'button', class: 'primary', hidden: true, onclick: () => {
    const c = document.createElement('canvas');
    c.width = video.videoWidth; c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0);
    add(c);
  } }, 'Capture page');
  host.append(el('div', { class: 'grid-tools' }, startBtn, shootBtn), video, list);
  (async () => {
    for (const f of files) {
      const b = await decodeFile(f);
      const c = document.createElement('canvas');
      c.width = b.width; c.height = b.height;
      c.getContext('2d').drawImage(b, 0, 0);
      add(c);
    }
  })();
  return { shots: () => shots.map((s) => s.canvas), stop };
}

/* ---------- tools ---------- */

const flowFields = [
  { key: 'page', label: 'Page size', type: 'select', default: 'A4', options: [['A4', 'A4'], ['Letter', 'US Letter'], ['Legal', 'Legal']] },
  { key: 'orient', label: 'Orientation', type: 'select', default: 'portrait', options: [['portrait', 'Portrait'], ['landscape', 'Landscape']] },
  { key: 'margin', label: 'Margin', type: 'select', default: '72', options: [['36', 'Narrow'], ['72', 'Normal'], ['108', 'Wide']] },
];
const sizeOf = (v) => {
  const [w, h] = PAGE_SIZES[v.page];
  return v.orient === 'landscape' ? [h, w] : [w, h];
};

export default [
  {
    id: 'pdf-to-word', name: 'PDF to Word', cat: 'convert', icon: 'word', accept: pdf,
    desc: 'Get an editable DOCX with paragraphs, headings, tables and images.',
    note: 'Complex layouts are rebuilt rather than copied exactly. Scanned pages come across as images; run OCR PDF first to make them editable.',
    action: 'Convert to Word', run: pdfToWord,
  },
  {
    id: 'pdf-to-ppt', name: 'PDF to PowerPoint', cat: 'convert', icon: 'slides', accept: pdf,
    desc: 'Turn each page into a slide, as an exact image or editable text.',
    action: 'Convert to PowerPoint',
    fields: [{ key: 'mode', label: 'Slides', type: 'select', default: 'text', options: [['text', 'Editable text and images'], ['image', 'Exact look (not editable)']] }],
    run: pdfToPpt,
  },
  {
    id: 'pdf-to-excel', name: 'PDF to Excel', cat: 'convert', icon: 'sheet', accept: pdf,
    desc: 'Pull tables into a spreadsheet, with numbers as real numbers.',
    note: 'Works on PDFs with real text. Run OCR PDF on scans first.',
    action: 'Convert to Excel',
    fields: [{ key: 'layout', label: 'Layout', type: 'select', default: 'pages', options: [['pages', 'One sheet per page'], ['single', 'Everything on one sheet']] }],
    async run({ files, values, progress }) {
      const X = await xlsx();
      const view = await loadPdfJs(await openBytes(files[0]));
      const wb = X.utils.book_new();
      const all = [];
      let found = 0;
      for (let n = 1; n <= view.numPages; n++) {
        progress((n - 1) / view.numPages, `Page ${n} of ${view.numPages}`);
        const grid = toGrid(await pageLines(await view.getPage(n)));
        found += grid.length;
        if (values.layout === 'single') all.push(...grid, []);
        else X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(grid), `Page ${n}`);
      }
      if (!found) throw new UserError('No text found. This looks like a scan; run OCR PDF first.');
      if (values.layout === 'single') X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(all), 'Document');
      return [output(`${stem(files[0].name)}.xlsx`, new Uint8Array(X.write(wb, { type: 'array', bookType: 'xlsx' })))];
    },
  },
  {
    id: 'pdf-to-jpg', name: 'PDF to JPG', cat: 'convert', icon: 'image', accept: pdf,
    desc: 'Save every page as an image, or pull out the pictures inside.',
    action: 'Convert',
    fields: [
      { key: 'mode', label: 'Export', type: 'select', default: 'pages', options: [['pages', 'Every page as an image'], ['images', 'Only the pictures inside']] },
      { key: 'format', label: 'Format', type: 'select', default: 'jpg', options: [['jpg', 'JPG'], ['png', 'PNG']] },
      { key: 'dpi', label: 'Resolution', type: 'select', default: '150', options: [['96', 'Screen (96 dpi)'], ['150', 'Standard (150 dpi)'], ['300', 'Print (300 dpi)']], show: (v) => v.mode === 'pages' },
    ],
    async run({ files, values, progress }) {
      const view = await loadPdfJs(await openBytes(files[0]));
      const lib = await pdfjs();
      const name = stem(files[0].name), ext = values.format, mime = ext === 'png' ? 'image/png' : 'image/jpeg';
      const results = [];
      for (let n = 1; n <= view.numPages; n++) {
        progress((n - 1) / view.numPages, `Page ${n} of ${view.numPages}`);
        const page = await view.getPage(n);
        if (values.mode === 'pages') {
          results.push(output(`${name}-page-${n}.${ext}`, await canvasBytes(await renderPage(page, +values.dpi / 72), mime, 0.92)));
        } else {
          const images = await pageImages(page, lib);
          for (const [i, im] of images.entries()) results.push(output(`${name}-p${n}-img${i + 1}.${ext}`, await canvasBytes(im.canvas, mime, 0.95)));
        }
        await breathe();
      }
      if (!results.length) throw new UserError('This PDF has no embedded pictures.');
      return results;
    },
  },
  {
    id: 'jpg-to-pdf', name: 'JPG to PDF', cat: 'convert', icon: 'image-in', accept: 'image/*', multiple: true,
    desc: 'Turn photos and images into a single PDF.',
    action: 'Create PDF', fields: pageFields,
    async run({ files, values, progress }) {
      return [output(`${stem(files[0].name)}.pdf`, await imagesToPdf(files, values, progress))];
    },
  },
  {
    id: 'word-to-pdf', name: 'Word to PDF', cat: 'convert', icon: 'word', accept: '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    desc: 'Turn a DOCX into a PDF with selectable text.',
    note: 'Documents are reflowed, so headers, footers and exact page breaks can differ from Word. Save old .doc files as .docx first.',
    action: 'Convert to PDF', fields: flowFields,
    async run({ files, values, progress }) {
      const M = await mammoth();
      const { value } = await M.convertToHtml({ arrayBuffer: await files[0].arrayBuffer() });
      if (!value.trim()) throw new UserError('This document appears to be empty.');
      progress(0.3, 'Laying out pages');
      const bytes = await htmlToPdf(value, { pageSize: sizeOf(values), margin: +values.margin, progress: (p) => progress(0.3 + 0.7 * p, 'Writing PDF') });
      return [output(`${stem(files[0].name)}.pdf`, bytes)];
    },
  },
  {
    id: 'ppt-to-pdf', name: 'PowerPoint to PDF', cat: 'convert', icon: 'slides', accept: '.pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation',
    desc: 'Turn slides into PDF pages, keeping text, images and shapes.',
    note: 'Text, pictures, tables and basic shapes are rebuilt. Charts, gradients, SmartArt and animations are not rendered.',
    action: 'Convert to PDF',
    async run({ files, progress }) {
      const { html, css, pageSize } = await pptxToHtml(await readBytes(files[0]));
      progress(0.3, 'Laying out slides');
      return [output(`${stem(files[0].name)}.pdf`, await htmlToPdf(html, { css, pageSize, mode: 'fixed', progress: (p) => progress(0.3 + 0.7 * p, 'Writing PDF') }))];
    },
  },
  {
    id: 'excel-to-pdf', name: 'Excel to PDF', cat: 'convert', icon: 'sheet', accept: '.xlsx,.xls,.csv,.ods',
    desc: 'Turn each sheet into neatly fitted PDF pages.',
    note: 'Cell values and table layout are kept. Charts and most cell colors are not.',
    action: 'Convert to PDF',
    fields: [
      { key: 'page', label: 'Page size', type: 'select', default: 'A4', options: [['A4', 'A4'], ['Letter', 'US Letter']] },
      { key: 'orient', label: 'Orientation', type: 'select', default: 'landscape', options: [['landscape', 'Landscape'], ['portrait', 'Portrait']] },
    ],
    async run({ files, values, progress }) {
      const X = await xlsx();
      const wb = X.read(await readBytes(files[0]), { type: 'array', dense: false });
      const html = sheetsToHtml(X, wb);
      if (!html.trim()) throw new UserError('This workbook has no data.');
      const pageSize = sizeOf(values), margin = 36;
      // Wide sheets scale the type down rather than spill off the page.
      const longest = Math.max(...wb.SheetNames.map((n) => { const r = wb.Sheets[n]['!ref']; return r ? X.utils.decode_range(r).e.c + 1 : 1; }));
      const font = Math.max(6, Math.min(11, ((pageSize[0] - margin * 2) / longest) / 7));
      const css = `body{font-size:${font}px;line-height:1.25}h2{font-size:${font + 4}px;margin:0 0 8px}table{width:100%;table-layout:auto}td{padding:2px 4px;overflow-wrap:anywhere}`;
      return [output(`${stem(files[0].name)}.pdf`, await htmlToPdf(html, { css, pageSize, margin, progress: (p) => progress(p, 'Writing PDF') }))];
    },
  },
  {
    id: 'html-to-pdf', name: 'HTML to PDF', cat: 'convert', icon: 'code', accept: '.html,.htm,text/html', optionalFiles: true,
    desc: 'Convert an HTML file or pasted markup into a PDF.',
    note: 'Web addresses cannot be fetched from a browser-only app, so open the page and save it as HTML, or paste its source. Remote images and stylesheets are blocked; scripts do not run.',
    action: 'Convert to PDF',
    fields: [{ key: 'source', label: 'HTML', type: 'textarea', default: '', placeholder: '<h1>Hello</h1> … or add a file above' }, ...flowFields],
    async run({ files, values, progress }) {
      const html = files[0] ? await files[0].text() : values.source;
      if (!html.trim()) throw new UserError('Add an HTML file or paste some HTML.');
      const bytes = await htmlToPdf(html, { pageSize: sizeOf(values), margin: +values.margin, progress: (p) => progress(p, 'Writing PDF') });
      return [output(`${files[0] ? stem(files[0].name) : 'page'}.pdf`, bytes)];
    },
  },
  {
    id: 'scan', name: 'Scan to PDF', cat: 'convert', icon: 'camera', accept: 'image/*', multiple: true, optionalFiles: true,
    desc: 'Capture paper with your camera, or clean up photos, into a crisp PDF.',
    action: 'Create PDF', studio: scanStudio,
    fields: [
      { key: 'filter', label: 'Clean-up', type: 'select', default: 'color', options: [['color', 'Bright color'], ['bw', 'Black and white'], ['none', 'Original']] },
      ...pageFields.filter((f) => f.key !== 'orient').map((f) => (f.key === 'margin' ? { ...f, default: 18 } : f)),
    ],
    async run({ values, studio, progress }) {
      const shots = studio.shots();
      if (!shots.length) throw new UserError('Capture or add at least one page.');
      studio.stop();
      const cleaned = shots.map((c) => {
        const copy = document.createElement('canvas');
        copy.width = c.width; copy.height = c.height;
        copy.getContext('2d').drawImage(c, 0, 0);
        return enhance(copy, values.filter);
      });
      return [output('scan.pdf', await imagesToPdf(cleaned, { ...values, orient: 'auto' }, progress))];
    },
  },
];
