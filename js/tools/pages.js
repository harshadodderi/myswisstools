// Tools that restructure documents or stamp every page.
import {
  UserError, loadPdfLib, measureText, openBytes, output, pageFrame, parseRanges, pdfLib,
  placeBox, readBytes, stampText, stem,
} from '../lib.js';
import { pageGrid } from '../pagegrid.js';
import { pageEditor } from '../editor.js';

const pdf = '.pdf,application/pdf';

async function subset(source, indices) {
  const { PDFDocument } = await pdfLib();
  const doc = await PDFDocument.create();
  (await doc.copyPages(source, indices)).forEach((p) => doc.addPage(p));
  return doc.save();
}

const targetPages = (text, count) => (text.trim() ? [...new Set(parseRanges(text, count).flat())] : [...Array(count).keys()]);

async function fromGrid({ files, studio, progress }, name) {
  const { PDFDocument, degrees } = await pdfLib();
  const pages = studio.pages();
  if (!pages.length) throw new UserError('Every page has been removed. Keep at least one.');
  const out = await PDFDocument.create();
  const sources = new Map();
  for (let i = 0; i < pages.length; i++) {
    const item = pages[i];
    progress(i / pages.length, `Page ${i + 1} of ${pages.length}`);
    if (item.blank) { out.addPage([item.width, item.height]); continue; }
    if (!sources.has(item.file)) sources.set(item.file, await loadPdfLib(await openBytes(item.file)));
    const [page] = await out.copyPages(sources.get(item.file), [item.index]);
    page.setRotation(degrees((page.getRotation().angle + item.rotate) % 360));
    out.addPage(page);
  }
  return [output(`${stem(files[0].name)}-${name}.pdf`, await out.save())];
}

export default [
  {
    id: 'merge', name: 'Merge PDF', cat: 'organize', icon: 'merge', accept: pdf, multiple: true, minFiles: 2,
    desc: 'Combine several PDFs into one, in the order you choose.',
    action: 'Merge',
    async run({ files, progress }) {
      const { PDFDocument } = await pdfLib();
      const out = await PDFDocument.create();
      for (let i = 0; i < files.length; i++) {
        progress(i / files.length, `Adding ${files[i].name}`);
        const src = await loadPdfLib(await openBytes(files[i]));
        (await out.copyPages(src, src.getPageIndices())).forEach((p) => out.addPage(p));
      }
      return [output('merged.pdf', await out.save())];
    },
  },
  {
    id: 'split', name: 'Split PDF', cat: 'organize', icon: 'split', accept: pdf,
    desc: 'Cut a PDF into separate files by range, by interval, or page by page.',
    action: 'Split',
    fields: [
      { key: 'mode', label: 'Split by', type: 'select', default: 'ranges', options: [['ranges', 'Custom ranges'], ['every', 'Every N pages'], ['all', 'Every page']] },
      { key: 'ranges', label: 'Ranges', type: 'text', default: '1-2, 3-', hint: 'Each comma-separated range becomes one file.', show: (v) => v.mode === 'ranges' },
      { key: 'every', label: 'Pages per file', type: 'number', default: 2, min: 1, show: (v) => v.mode === 'every' },
    ],
    async run({ files, values, progress }) {
      const src = await loadPdfLib(await openBytes(files[0]));
      const count = src.getPageCount(), name = stem(files[0].name);
      let groups;
      if (values.mode === 'ranges') groups = parseRanges(values.ranges, count);
      else {
        const size = values.mode === 'all' ? 1 : Math.max(1, +values.every || 1);
        groups = [];
        for (let i = 0; i < count; i += size) groups.push([...Array(Math.min(size, count - i)).keys()].map((k) => k + i));
      }
      const results = [];
      for (let i = 0; i < groups.length; i++) {
        progress(i / groups.length, `File ${i + 1} of ${groups.length}`);
        const g = groups[i];
        const label = g.length === 1 ? g[0] + 1 : `${g[0] + 1}-${g.at(-1) + 1}`;
        results.push(output(`${name}-p${label}.pdf`, await subset(src, g)));
      }
      return results;
    },
  },
  {
    id: 'remove', name: 'Remove pages', cat: 'organize', icon: 'trash', accept: pdf,
    desc: 'Click the pages you want gone and save the rest.',
    action: 'Remove pages', studio: (host, ctx) => pageGrid(host, ctx, { mode: 'select', selectLabel: 'Remove' }),
    async run({ files, studio }) {
      const src = await loadPdfLib(await openBytes(files[0]));
      const gone = studio.selected();
      if (!gone.size) throw new UserError('Select at least one page to remove.');
      const keep = src.getPageIndices().filter((i) => !gone.has(i));
      if (!keep.length) throw new UserError('That would remove every page. Keep at least one.');
      return [output(`${stem(files[0].name)}-trimmed.pdf`, await subset(src, keep))];
    },
  },
  {
    id: 'extract', name: 'Extract pages', cat: 'organize', icon: 'extract', accept: pdf,
    desc: 'Pull selected pages out into a new PDF.',
    action: 'Extract pages', studio: (host, ctx) => pageGrid(host, ctx, { mode: 'select', selectLabel: 'Keep' }),
    async run({ files, studio }) {
      const src = await loadPdfLib(await openBytes(files[0]));
      const keep = [...studio.selected()].sort((a, b) => a - b);
      if (!keep.length) throw new UserError('Select at least one page to extract.');
      return [output(`${stem(files[0].name)}-extract.pdf`, await subset(src, keep))];
    },
  },
  {
    id: 'organize', name: 'Organize PDF', cat: 'organize', icon: 'grid', accept: pdf, multiple: true,
    desc: 'Reorder, rotate, delete, and add blank pages across one or more PDFs.',
    action: 'Save order', studio: (host, ctx) => pageGrid(host, ctx, { mode: 'arrange' }),
    run: (ctx) => fromGrid(ctx, 'organized'),
  },
  {
    id: 'rotate', name: 'Rotate PDF', cat: 'organize', icon: 'rotate', accept: pdf,
    desc: 'Turn single pages or the whole document, then save it.',
    action: 'Save rotation', studio: (host, ctx) => pageGrid(host, ctx, { mode: 'rotate' }),
    run: (ctx) => fromGrid(ctx, 'rotated'),
  },
  {
    id: 'crop', name: 'Crop PDF', cat: 'edit', icon: 'crop', accept: pdf,
    desc: 'Trim the margins of one page or all of them.',
    action: 'Crop', studio: (host, ctx) => pageEditor(host, ctx, { mode: 'crop' }),
    async run({ files, studio }) {
      const doc = await loadPdfLib(await openBytes(files[0]));
      const { rect, all } = studio.crop();
      if (!rect) throw new UserError('Drag a crop area on the page first.');
      const pages = doc.getPages();
      for (const [i, page] of pages.entries()) {
        if (!all && i !== rect.page) continue;
        const f = pageFrame(page);
        const a = f.toUser(rect.x, rect.y), b = f.toUser(rect.x + rect.w, rect.y + rect.h);
        const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(a.x - b.x), h = Math.abs(a.y - b.y);
        page.setCropBox(x, y, w, h);
        page.setMediaBox(x, y, w, h);
      }
      return [output(`${stem(files[0].name)}-cropped.pdf`, await doc.save())];
    },
  },
  {
    id: 'watermark', name: 'Watermark', cat: 'edit', icon: 'drop', accept: pdf,
    desc: 'Stamp text or an image over your pages. Any language works.',
    action: 'Add watermark',
    fields: [
      { key: 'kind', label: 'Type', type: 'select', default: 'text', options: [['text', 'Text'], ['image', 'Image']] },
      { key: 'text', label: 'Text', type: 'text', default: 'CONFIDENTIAL', show: (v) => v.kind === 'text' },
      { key: 'image', label: 'Image', type: 'file', accept: 'image/png,image/jpeg', show: (v) => v.kind === 'image' },
      { key: 'size', label: 'Text size', type: 'number', default: 54, min: 6, show: (v) => v.kind === 'text' },
      { key: 'scale', label: 'Image width (% of page)', type: 'number', default: 40, min: 1, max: 100, show: (v) => v.kind === 'image' },
      { key: 'color', label: 'Color', type: 'color', default: '#c8391f', show: (v) => v.kind === 'text' },
      { key: 'opacity', label: 'Opacity', type: 'range', default: 25, min: 5, max: 100, unit: '%' },
      { key: 'turn', label: 'Rotation', type: 'range', default: 45, min: -90, max: 90, unit: '°' },
      { key: 'position', label: 'Position', type: 'select', default: 'center', options: [['center', 'Center'], ['tile', 'Tiled across page'], ['top', 'Top'], ['bottom', 'Bottom']] },
      { key: 'pages', label: 'Pages', type: 'text', default: '', placeholder: 'All pages', hint: 'Example: 1-3, 8' },
    ],
    async run({ files, values, progress }) {
      const lib = await pdfLib();
      const doc = await loadPdfLib(await openBytes(files[0]));
      const pages = doc.getPages();
      const targets = targetPages(values.pages, pages.length);
      const opacity = values.opacity / 100, turn = +values.turn;
      const t = turn * Math.PI / 180, cos = Math.cos(t), sin = Math.sin(t);

      let image = null;
      if (values.kind === 'image') {
        if (!values.image) throw new UserError('Choose an image for the watermark.');
        const bytes = await readBytes(values.image);
        image = values.image.type === 'image/png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
      } else if (!values.text.trim()) throw new UserError('Enter the watermark text.');

      for (let n = 0; n < targets.length; n++) {
        progress(n / targets.length, `Page ${n + 1} of ${targets.length}`);
        const page = pages[targets[n]], f = pageFrame(page);
        const w = image ? f.width * values.scale / 100 : await measureText(doc, values.text, +values.size, 'HelveticaBold');
        const h = image ? w * image.height / image.width : +values.size * 0.72;
        const centers = [];
        if (values.position === 'tile') {
          const stepX = Math.max(w * Math.abs(cos) + h * Math.abs(sin), 40) + 60;
          const stepY = Math.max(w * Math.abs(sin) + h * Math.abs(cos), 40) + 60;
          for (let y = stepY / 2, row = 0; y < f.height + stepY; y += stepY, row++) {
            for (let x = row % 2 ? 0 : stepX / 2; x < f.width + stepX; x += stepX) centers.push([x, y]);
          }
        } else {
          const y = { center: f.height / 2, top: h / 2 + 36, bottom: f.height - h / 2 - 36 }[values.position];
          centers.push([f.width / 2, y]);
        }
        for (const [cx, cy] of centers) {
          // Bottom-left of the box once it has been turned around its center.
          const left = cx - (w / 2) * cos + (h / 2) * sin;
          const base = cy + (w / 2) * sin + (h / 2) * cos;
          if (image) page.drawImage(image, { ...placeBox(f, left, base - h, w, h, lib, turn), opacity });
          else await stampText(doc, page, f, values.text, { left, baseline: base, size: +values.size, color: values.color, opacity, font: 'HelveticaBold', turn });
        }
      }
      return [output(`${stem(files[0].name)}-watermarked.pdf`, await doc.save())];
    },
  },
  {
    id: 'numbers', name: 'Page numbers', cat: 'edit', icon: 'hash', accept: pdf,
    desc: 'Number your pages, with control over position and format.',
    action: 'Add numbers',
    fields: [
      { key: 'position', label: 'Position', type: 'select', default: 'bc', options: [['bc', 'Bottom center'], ['bl', 'Bottom left'], ['br', 'Bottom right'], ['tc', 'Top center'], ['tl', 'Top left'], ['tr', 'Top right']] },
      { key: 'format', label: 'Format', type: 'text', default: '{n}', hint: 'Use {n} for the number and {total} for the page count. Example: Page {n} of {total}' },
      { key: 'start', label: 'First number', type: 'number', default: 1, min: 0 },
      { key: 'skip', label: 'Leave the first page unnumbered', type: 'checkbox', default: false },
      { key: 'size', label: 'Text size', type: 'number', default: 11, min: 5 },
      { key: 'color', label: 'Color', type: 'color', default: '#222222' },
      { key: 'margin', label: 'Distance from edge (pt)', type: 'number', default: 28, min: 0 },
    ],
    async run({ files, values, progress }) {
      const doc = await loadPdfLib(await openBytes(files[0]));
      const pages = doc.getPages(), size = +values.size, margin = +values.margin;
      const first = values.skip ? 1 : 0, total = pages.length - first + +values.start - 1;
      for (let i = first; i < pages.length; i++) {
        progress(i / pages.length, `Page ${i + 1} of ${pages.length}`);
        const text = values.format.replaceAll('{n}', i - first + +values.start).replaceAll('{total}', total);
        const f = pageFrame(pages[i]), w = await measureText(doc, text, size);
        const left = { l: margin, c: (f.width - w) / 2, r: f.width - w - margin }[values.position[1]];
        const baseline = values.position[0] === 't' ? margin + size : f.height - margin;
        await stampText(doc, pages[i], f, text, { left, baseline, size, color: values.color });
      }
      return [output(`${stem(files[0].name)}-numbered.pdf`, await doc.save())];
    },
  },
];

