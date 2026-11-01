// Edit, Sign, Redact, Compare.
import {
  UserError, breathe, canvasBytes, hexRgb, loadPdfJs, loadPdfLib, openBytes, output, pageFrame, pageLines, pdfLib,
  placeBox, renderPage, stampText, stem,
} from '../lib.js';
import { pageEditor } from '../editor.js';

const pdf = '.pdf,application/pdf';

async function applyItems(doc, items) {
  const lib = await pdfLib();
  const pages = doc.getPages();
  const cache = new Map();
  const embed = async (it) => {
    if (!cache.has(it.bytes)) cache.set(it.bytes, await (it.mime === 'image/png' ? doc.embedPng(it.bytes) : doc.embedJpg(it.bytes)));
    return cache.get(it.bytes);
  };
  for (const it of items) {
    const page = pages[it.page], f = pageFrame(page);
    if (it.type === 'image') {
      page.drawImage(await embed(it), placeBox(f, it.x, it.y, it.w, it.h, lib));
    } else if (it.type === 'whiteout') {
      page.drawRectangle({ ...placeBox(f, it.x, it.y, it.w, it.h, lib), color: lib.rgb(1, 1, 1) });
    } else if (it.type === 'highlight') {
      page.drawRectangle({ ...placeBox(f, it.x, it.y, it.w, it.h, lib), color: lib.rgb(1, 0.87, 0.2), blendMode: lib.BlendMode.Multiply, opacity: 0.8 });
    } else if (it.type === 'box') {
      const [r, g, b] = hexRgb(it.color);
      page.drawRectangle({ ...placeBox(f, it.x, it.y, it.w, it.h, lib), borderColor: lib.rgb(r, g, b), borderWidth: 1.5 });
    } else if (it.type === 'ink') {
      const [r, g, b] = hexRgb(it.color);
      for (let i = 1; i < it.points.length; i++) {
        page.drawLine({
          start: f.toUser(it.points[i - 1].x, it.points[i - 1].y), end: f.toUser(it.points[i].x, it.points[i].y),
          thickness: it.width, color: lib.rgb(r, g, b), lineCap: lib.LineCapStyle.Round,
        });
      }
    } else if (it.type === 'text') {
      const lines = (it.value || '').split('\n');
      for (const [i, line] of lines.entries()) {
        if (line.trim()) await stampText(doc, page, f, line, { left: it.x + 3, baseline: it.y + it.size * (1.05 + i * 1.2), size: it.size, color: it.color, font: it.font });
      }
    }
  }
}

async function diffWords(a, b) {
  // Trims the common ends, then runs a bounded LCS so huge documents stay responsive.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const x = a.slice(start, endA), y = b.slice(start, endB);
  if (x.length * y.length > 2e7) return { removed: x, added: y, approximate: true };
  const w = y.length + 1, t = new Uint32Array((x.length + 1) * w);
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      t[i * w + j] = x[i] === y[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    }
  }
  const removed = [], added = [];
  for (let i = 0, j = 0; i < x.length || j < y.length;) {
    if (i < x.length && j < y.length && x[i] === y[j]) { i++; j++; }
    else if (j < y.length && (i === x.length || t[i * w + j + 1] >= t[(i + 1) * w + j])) added.push(y[j++]);
    else removed.push(x[i++]);
  }
  return { removed, added };
}

export default [
  {
    id: 'edit', name: 'Edit PDF', cat: 'edit', icon: 'pen', accept: pdf,
    desc: 'Add text, images, highlights and drawings to any page.',
    note: 'White-out only covers content; the text underneath stays in the file. Use Redact PDF for anything sensitive.',
    action: 'Save edits', studio: (host, ctx) => pageEditor(host, ctx, { mode: 'edit' }),
    async run({ files, studio }) {
      const items = studio.items();
      if (!items.length) throw new UserError('Add something to a page first.');
      const doc = await loadPdfLib(await openBytes(files[0]));
      await applyItems(doc, items);
      return [output(`${stem(files[0].name)}-edited.pdf`, await doc.save())];
    },
  },
  {
    id: 'sign', name: 'Sign PDF', cat: 'edit', icon: 'sign', accept: pdf,
    desc: 'Draw, type or upload a signature and place it on the page.',
    note: 'This adds a visible signature. It is not a certificate-based digital signature.',
    action: 'Save signed PDF', studio: (host, ctx) => pageEditor(host, ctx, { mode: 'sign' }),
    async run({ files, studio }) {
      const items = studio.items();
      if (!items.length) throw new UserError('Place a signature on a page first.');
      const doc = await loadPdfLib(await openBytes(files[0]));
      await applyItems(doc, items);
      return [output(`${stem(files[0].name)}-signed.pdf`, await doc.save())];
    },
  },
  {
    id: 'redact', name: 'Redact PDF', cat: 'edit', icon: 'redact', accept: pdf,
    desc: 'Permanently destroy sensitive text and images, not just cover them.',
    note: 'Pages with redactions are rebuilt as images, so the hidden content is gone from the file. Text on those pages stops being selectable; other pages are untouched.',
    action: 'Redact',
    fields: [
      { key: 'dpi', label: 'Quality of redacted pages', type: 'select', default: '200', options: [['150', 'Standard (150 dpi)'], ['200', 'High (200 dpi)'], ['300', 'Print (300 dpi)']] },
      { key: 'scrub', label: 'Remove document metadata too', type: 'checkbox', default: true },
    ],
    studio: (host, ctx) => pageEditor(host, ctx, { mode: 'redact' }),
    async run({ files, studio, values, progress }) {
      const items = studio.items();
      if (!items.length) throw new UserError('Mark at least one area to redact.');
      const { PDFDocument } = await pdfLib();
      const bytes = await openBytes(files[0]);
      const src = await loadPdfLib(bytes), view = await loadPdfJs(bytes);
      const out = await PDFDocument.create();
      const byPage = new Map();
      for (const it of items) (byPage.get(it.page) ?? byPage.set(it.page, []).get(it.page)).push(it);
      const count = src.getPageCount(), scale = +values.dpi / 72;
      for (let i = 0; i < count; i++) {
        progress(i / count, `Page ${i + 1} of ${count}`);
        const boxes = byPage.get(i);
        if (!boxes) { const [p] = await out.copyPages(src, [i]); out.addPage(p); continue; }
        const page = await view.getPage(i + 1);
        const canvas = await renderPage(page, scale);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#000';
        for (const b of boxes) ctx.fillRect(b.x * scale, b.y * scale, b.w * scale, b.h * scale);
        const jpg = await out.embedJpg(await canvasBytes(canvas, 'image/jpeg', 0.9));
        const w = canvas.width / scale, h = canvas.height / scale;
        out.addPage([w, h]).drawImage(jpg, { x: 0, y: 0, width: w, height: h });
        await breathe();
      }
      if (!values.scrub) {
        const info = { Title: src.getTitle(), Author: src.getAuthor(), Subject: src.getSubject() };
        if (info.Title) out.setTitle(info.Title);
        if (info.Author) out.setAuthor(info.Author);
        if (info.Subject) out.setSubject(info.Subject);
      }
      return [output(`${stem(files[0].name)}-redacted.pdf`, await out.save())];
    },
  },
  {
    id: 'compare', name: 'Compare PDF', cat: 'edit', icon: 'compare', accept: pdf, multiple: true, minFiles: 2, maxFiles: 2,
    desc: 'See what changed between two versions, in the text and on the page.',
    action: 'Compare',
    async run({ files, progress, report }) {
      const { PDFDocument, rgb, StandardFonts } = await pdfLib();
      const [a, b] = await Promise.all(files.slice(0, 2).map(async (f) => loadPdfJs(await openBytes(f))));
      const pages = Math.max(a.numPages, b.numPages);
      const out = await PDFDocument.create();
      const font = await out.embedFont(StandardFonts.Helvetica);
      const wordsA = [], wordsB = [], changed = [];
      const scale = 1.5, GAP = 24, HEAD = 34;

      for (let i = 1; i <= pages; i++) {
        progress((i - 1) / pages, `Page ${i} of ${pages}`);
        const pa = i <= a.numPages ? await a.getPage(i) : null, pb = i <= b.numPages ? await b.getPage(i) : null;
        const ca = pa && await renderPage(pa, scale), cb = pb && await renderPage(pb, scale);
        if (pa) wordsA.push(...(await pageLines(pa)).flatMap((l) => l.text.split(/\s+/)));
        if (pb) wordsB.push(...(await pageLines(pb)).flatMap((l) => l.text.split(/\s+/)));
        const w = Math.max(ca?.width ?? 0, cb?.width ?? 0), h = Math.max(ca?.height ?? 0, cb?.height ?? 0);
        const blank = () => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); return c; };
        const fit = (c) => { const n = blank(); if (c) n.getContext('2d').drawImage(c, 0, 0); return n; };
        const left = fit(ca), right = fit(cb);
        const da = left.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h);
        const db = right.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h);
        const overlay = document.createElement('canvas');
        overlay.width = w; overlay.height = h;
        const oc = overlay.getContext('2d');
        const mark = oc.createImageData(w, h);
        let diff = 0;
        for (let p = 0; p < da.data.length; p += 4) {
          const d = Math.abs(da.data[p] - db.data[p]) + Math.abs(da.data[p + 1] - db.data[p + 1]) + Math.abs(da.data[p + 2] - db.data[p + 2]);
          if (d > 60) { mark.data[p] = 230; mark.data[p + 1] = 40; mark.data[p + 2] = 30; mark.data[p + 3] = 110; diff++; }
        }
        oc.putImageData(mark, 0, 0);
        const ratio = diff / (w * h);
        if (ratio > 0.00002 || !pa || !pb) changed.push(i);
        left.getContext('2d').drawImage(overlay, 0, 0);
        right.getContext('2d').drawImage(overlay, 0, 0);
        const pw = w / scale, ph = h / scale;
        const page = out.addPage([pw * 2 + GAP * 3, ph + HEAD + GAP]);
        page.drawText(`Page ${i}${changed.at(-1) === i ? ' — changes highlighted' : ' — no visible change'}`, { x: GAP, y: ph + GAP + 10, size: 13, font, color: rgb(0.1, 0.1, 0.1) });
        page.drawImage(await out.embedJpg(await canvasBytes(left, 'image/jpeg', 0.85)), { x: GAP, y: GAP / 2, width: pw, height: ph });
        page.drawImage(await out.embedJpg(await canvasBytes(right, 'image/jpeg', 0.85)), { x: GAP * 2 + pw, y: GAP / 2, width: pw, height: ph });
      }
      const { removed, added, approximate } = await diffWords(wordsA, wordsB);
      report({
        title: changed.length ? `Changes on ${changed.length} of ${pages} pages` : 'No visible differences',
        lines: [
          changed.length ? `Pages that differ: ${changed.join(', ')}` : 'The two documents render identically.',
          removed.length ? `Removed text: ${removed.slice(0, 80).join(' ')}${removed.length > 80 ? ' …' : ''}` : null,
          added.length ? `Added text: ${added.slice(0, 80).join(' ')}${added.length > 80 ? ' …' : ''}` : null,
          approximate ? 'These documents differ too much for an exact word list, so the text above is the whole changed span.' : null,
        ].filter(Boolean),
      });
      return [output('comparison.pdf', await out.save())];
    },
  },
];
