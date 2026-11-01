// Compress, repair, OCR, PDF/A, encryption, metadata.
import {
  UserError, breathe, canvasBytes, formatSize, loadPdfJs, loadPdfLib, openBytes, output, pdfLib, qpdf, readBytes,
  renderPage, stem, tesseract,
} from '../lib.js';

const pdf = '.pdf,application/pdf';

/* ---------- compression ---------- */

const PRESETS = {
  light: { max: 2600, quality: 0.82 },
  balanced: { max: 1700, quality: 0.68 },
  strong: { max: 1100, quality: 0.5 },
};

function unpredict(data, columns, colors) {
  const rowBytes = columns * colors, rows = Math.floor(data.length / (rowBytes + 1));
  const out = new Uint8Array(rows * rowBytes);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowBytes + 1)], from = r * (rowBytes + 1) + 1, to = r * rowBytes, up = to - rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const raw = data[from + i];
      const a = i >= colors ? out[to + i - colors] : 0, b = r ? out[up + i] : 0, c = r && i >= colors ? out[up + i - colors] : 0;
      let v = raw;
      if (type === 1) v += a;
      else if (type === 2) v += b;
      else if (type === 3) v += (a + b) >> 1;
      else if (type === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[to + i] = v;
    }
  }
  return out;
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decodeImage(stream, dict, lib, doc) {
  const { PDFName, PDFNumber, PDFArray } = lib;
  const get = (k) => { const v = dict.get(PDFName.of(k)); return v && doc.context.lookup(v); };
  const filter = get('Filter');
  const filters = filter instanceof PDFArray ? filter.asArray().map((f) => doc.context.lookup(f)) : filter ? [filter] : [];
  if (filters.length !== 1) return null;
  const name = filters[0].toString();
  const width = get('Width')?.asNumber?.(), height = get('Height')?.asNumber?.();
  if (!width || !height) return null;
  const cs = get('ColorSpace');
  let channels = 0;
  if (cs instanceof PDFName) channels = { '/DeviceRGB': 3, '/DeviceGray': 1 }[cs.toString()] || 0;
  else if (cs instanceof PDFArray && cs.lookup(0)?.toString() === '/ICCBased') {
    const n = doc.context.lookup(cs.get(1))?.dict?.get(PDFName.of('N'));
    channels = n instanceof PDFNumber && [1, 3].includes(n.asNumber()) ? n.asNumber() : 0;
  }
  if (!channels || get('Mask') || get('Decode') || get('ImageMask')) return null;

  if (name === '/DCTDecode') {
    const bitmap = await createImageBitmap(new Blob([stream.contents], { type: 'image/jpeg' }), { imageOrientation: 'none' });
    return { bitmap, width, height, isJpeg: true };
  }
  if (name !== '/FlateDecode' || get('BitsPerComponent')?.asNumber?.() !== 8) return null;
  const parms = get('DecodeParms');
  let raw = await inflate(stream.contents);
  const pred = parms?.get?.(PDFName.of('Predictor'))?.asNumber?.() ?? 1;
  if (pred >= 10) raw = unpredict(raw, width, channels);
  else if (pred !== 1) return null;
  if (raw.length < width * height * channels) return null;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += channels) {
    rgba[i] = raw[j]; rgba[i + 1] = raw[channels === 3 ? j + 1 : j]; rgba[i + 2] = raw[channels === 3 ? j + 2 : j]; rgba[i + 3] = 255;
  }
  return { bitmap: await createImageBitmap(new ImageData(rgba, width, height)), width, height, isJpeg: false };
}

// Re-encodes only the images. Fonts, text and vectors are left alone, so text stays selectable.
async function shrinkImages(bytes, preset, progress) {
  const lib = await pdfLib();
  const { PDFName, PDFRawStream, PDFNumber } = lib;
  const doc = await loadPdfLib(bytes);
  const entries = doc.context.enumerateIndirectObjects();
  const images = entries.filter(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype'))?.toString() === '/Image');
  let swapped = 0;
  for (let n = 0; n < images.length; n++) {
    progress(0.1 + 0.7 * (n / images.length), `Optimizing image ${n + 1} of ${images.length}`);
    const [ref, obj] = images[n];
    let decoded;
    try { decoded = await decodeImage(obj, obj.dict, lib, doc); } catch { decoded = null; }
    if (!decoded) continue;
    const ratio = Math.min(1, preset.max / Math.max(decoded.width, decoded.height));
    const w = Math.max(1, Math.round(decoded.width * ratio)), h = Math.max(1, Math.round(decoded.height * ratio));
    if (decoded.isJpeg && ratio === 1 && obj.contents.length < w * h * 0.25) { decoded.bitmap.close(); continue; }
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(decoded.bitmap, 0, 0, w, h);
    decoded.bitmap.close();
    const jpeg = await canvasBytes(c, 'image/jpeg', preset.quality);
    if (jpeg.length >= obj.contents.length) continue;
    const dict = obj.dict.clone(doc.context);
    dict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
    dict.delete(PDFName.of('DecodeParms'));
    dict.set(PDFName.of('Width'), PDFNumber.of(w));
    dict.set(PDFName.of('Height'), PDFNumber.of(h));
    dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
    dict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
    dict.delete(PDFName.of('Length'));
    doc.context.assign(ref, PDFRawStream.of(dict, jpeg));
    swapped++;
    await breathe();
  }
  return { bytes: swapped ? await doc.save({ useObjectStreams: true }) : bytes, swapped, total: images.length };
}

/* ---------- PDF/A ---------- */

// Writes a minimal ICC v2 sRGB profile, required as the PDF/A output intent.
function srgbProfile() {
  const curve = new Array(1024);
  for (let i = 0; i < 1024; i++) {
    const v = i / 1023;
    curve[i] = Math.round((v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4) * 65535);
  }
  const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
  const u32 = (n) => [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255];
  const u16 = (n) => [n >> 8, n & 255];
  const s15 = (x) => u32(Math.round(x * 65536));
  const xyz = (x, y, z) => [...ascii('XYZ '), 0, 0, 0, 0, ...s15(x), ...s15(y), ...s15(z)];
  const desc = (s) => {
    const b = [...ascii('desc'), 0, 0, 0, 0, ...u32(s.length + 1), ...ascii(s), 0, ...new Array(12 + 67).fill(0)];
    return b.concat(new Array((4 - (b.length % 4)) % 4).fill(0));
  };
  const trc = [...ascii('curv'), 0, 0, 0, 0, ...u32(1024), ...curve.flatMap(u16)];
  const text = (s) => { const b = [...ascii('text'), 0, 0, 0, 0, ...ascii(s), 0]; return b.concat(new Array((4 - (b.length % 4)) % 4).fill(0)); };
  const tags = [
    ['desc', desc('sRGB')], ['cprt', text('Public domain')], ['wtpt', xyz(0.9642, 1, 0.8249)],
    ['rXYZ', xyz(0.4360, 0.2225, 0.0139)], ['gXYZ', xyz(0.3851, 0.7169, 0.0971)], ['bXYZ', xyz(0.1431, 0.0606, 0.7139)],
    ['rTRC', trc], ['gTRC', trc], ['bTRC', trc],
  ];
  const seen = new Map();
  let offset = 128 + 4 + tags.length * 12;
  const table = [...u32(tags.length)], body = [];
  for (const [sig, data] of tags) {
    if (!seen.has(data)) { seen.set(data, offset); body.push(data); offset += data.length; }
    table.push(...ascii(sig), ...u32(seen.get(data)), ...u32(data.length));
  }
  const header = new Array(128).fill(0);
  const put = (at, values) => values.forEach((v, i) => { header[at + i] = v; });
  put(0, u32(offset)); put(8, [2, 0x40, 0, 0]); put(12, ascii('mntr')); put(16, ascii('RGB ')); put(20, ascii('XYZ '));
  put(24, [...u16(2024), ...u16(1), ...u16(1), 0, 0, 0, 0, 0, 0]); put(36, ascii('acsp'));
  put(68, s15(0.9642)); put(72, s15(1)); put(76, s15(0.8249));
  return Uint8Array.from([...header, ...table, ...body.flat()]);
}

/* ---------- tools ---------- */

export default [
  {
    id: 'compress', name: 'Compress PDF', cat: 'optimize', icon: 'compress', accept: pdf,
    desc: 'Shrink the file by optimizing images and structure. Text stays real text.',
    action: 'Compress',
    fields: [{ key: 'level', label: 'Compression', type: 'select', default: 'balanced', options: [['light', 'Light — best quality'], ['balanced', 'Balanced — recommended'], ['strong', 'Strong — smallest file']] }],
    async run({ files, values, progress, report }) {
      const original = await openBytes(files[0]);
      progress(0.05, 'Reading document');
      const { bytes, swapped, total } = await shrinkImages(original, PRESETS[values.level], progress);
      progress(0.85, 'Optimizing structure');
      const res = await qpdf(['--object-streams=generate', '--recompress-flate', '--compression-level=9', '/in.pdf', '/out.pdf'], bytes);
      let best = res.ok && res.bytes.length < bytes.length ? res.bytes : bytes;
      const saved = 1 - best.length / original.length;
      if (best.length >= original.length) best = original;
      report({
        title: saved > 0.005 ? `Reduced by ${(saved * 100).toFixed(0)}%` : 'This file is already well optimized',
        lines: [
          `${formatSize(original.length)} → ${formatSize(best.length)}`,
          total ? `${swapped} of ${total} images re-encoded.` : 'No images to re-encode; only the file structure was optimized.',
        ],
      });
      return [output(`${stem(files[0].name)}-compressed.pdf`, best)];
    },
  },
  {
    id: 'repair', name: 'Repair PDF', cat: 'optimize', icon: 'wrench', accept: pdf,
    desc: 'Recover a damaged PDF that will not open properly.',
    action: 'Repair',
    async run({ files, progress, report }) {
      const bytes = await readBytes(files[0]);
      progress(0.2, 'Rebuilding file structure');
      const res = await qpdf(['/in.pdf', '/out.pdf'], bytes);
      if (res.ok) {
        const check = await loadPdfJs(res.bytes).catch(() => null);
        if (check) {
          report({ title: 'Structure rebuilt', lines: [`${check.numPages} pages recovered.`] });
          return [output(`${stem(files[0].name)}-repaired.pdf`, res.bytes)];
        }
      }
      progress(0.4, 'Rendering recoverable pages');
      const view = await loadPdfJs(bytes).catch(() => null);
      if (!view) throw new UserError('This file is too damaged to recover.');
      const { PDFDocument } = await pdfLib();
      const out = await PDFDocument.create();
      let saved = 0;
      for (let i = 1; i <= view.numPages; i++) {
        progress(0.4 + 0.6 * (i / view.numPages), `Page ${i}`);
        try {
          const page = await view.getPage(i);
          const c = await renderPage(page, 2);
          const img = await out.embedJpg(await canvasBytes(c, 'image/jpeg', 0.9));
          out.addPage([c.width / 2, c.height / 2]).drawImage(img, { x: 0, y: 0, width: c.width / 2, height: c.height / 2 });
          saved++;
        } catch { /* skip the unreadable page and keep going */ }
      }
      if (!saved) throw new UserError('No pages could be recovered.');
      report({ title: 'Recovered as images', lines: [`${saved} of ${view.numPages} pages recovered. Their text is no longer selectable; OCR PDF can restore it.`] });
      return [output(`${stem(files[0].name)}-repaired.pdf`, await out.save())];
    },
  },
  {
    id: 'ocr', name: 'OCR PDF', cat: 'optimize', icon: 'scan', accept: pdf,
    desc: 'Make scanned documents searchable and selectable.',
    note: 'OCR runs on your device, so large scans take a while. The first run also loads about 15 MB of language data.',
    action: 'Run OCR',
    fields: [
      { key: 'lang', label: 'Document language', type: 'select', default: 'eng', options: [['eng', 'English'], ['hin', 'Hindi'], ['spa', 'Spanish'], ['fra', 'French'], ['deu', 'German'], ['eng+hin', 'English + Hindi']] },
      { key: 'dpi', label: 'Scan quality', type: 'select', default: '200', options: [['150', 'Fast (150 dpi)'], ['200', 'Standard (200 dpi)'], ['300', 'Accurate (300 dpi)']] },
    ],
    async run({ files, values, progress }) {
      const T = await tesseract();
      const { PDFDocument } = await pdfLib();
      const bytes = await openBytes(files[0]);
      const view = await loadPdfJs(bytes);
      const root = new URL('../../vendor/tesseract/', import.meta.url).href;
      progress(0.02, 'Loading OCR engine');
      const worker = await T.createWorker(values.lang.split('+'), 1, {
        workerPath: root + 'worker.min.js', corePath: root + 'core/', langPath: root + 'lang', workerBlobURL: false, gzip: true,
      });
      try {
        await worker.setParameters({ user_defined_dpi: values.dpi });
        const out = await PDFDocument.create();
        const scale = +values.dpi / 72;
        for (let i = 1; i <= view.numPages; i++) {
          progress((i - 1) / view.numPages + 0.02, `Reading page ${i} of ${view.numPages}`);
          const page = await view.getPage(i);
          const canvas = await renderPage(page, scale);
          const { data } = await worker.recognize(canvas, { pdfTitle: files[0].name, pdfTextOnly: true }, { pdf: true, text: false, blocks: false });
          const layer = await PDFDocument.load(Uint8Array.from(data.pdf), { updateMetadata: false });
          const w = canvas.width / scale, h = canvas.height / scale;
          // Tesseract supplies the invisible text; the sharp page image goes beneath it.
          const [textPage] = await out.copyPages(layer, [0]);
          const sheet = out.addPage([w, h]);
          sheet.drawImage(await out.embedJpg(await canvasBytes(canvas, 'image/jpeg', 0.85)), { x: 0, y: 0, width: w, height: h });
          const overlay = await out.embedPage(textPage);
          sheet.drawPage(overlay, { x: 0, y: 0, width: w, height: h });
        }
        return [output(`${stem(files[0].name)}-ocr.pdf`, await out.save())];
      } finally {
        await worker.terminate();
      }
    },
  },
  {
    id: 'pdfa', name: 'PDF to PDF/A', cat: 'convert', icon: 'archive', accept: pdf,
    desc: 'Create an archival PDF/A-2B copy for long-term storage.',
    note: 'Pages are stored as images, so text in this copy is not selectable. If an archive or court requires PDF/A, check the file with their validator.',
    action: 'Convert to PDF/A',
    fields: [{ key: 'dpi', label: 'Quality', type: 'select', default: '200', options: [['150', 'Standard (150 dpi)'], ['200', 'High (200 dpi)'], ['300', 'Print (300 dpi)']] }],
    async run({ files, values, progress }) {
      const { PDFDocument, PDFName, PDFString } = await pdfLib();
      const view = await loadPdfJs(await openBytes(files[0]));
      const out = await PDFDocument.create({ updateMetadata: false });
      const scale = +values.dpi / 72;
      for (let i = 1; i <= view.numPages; i++) {
        progress((i - 1) / view.numPages * 0.9, `Page ${i} of ${view.numPages}`);
        const c = await renderPage(await view.getPage(i), scale);
        const img = await out.embedJpg(await canvasBytes(c, 'image/jpeg', 0.92));
        const w = c.width / scale, h = c.height / scale;
        out.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
      }
      const ctx = out.context;
      const icc = ctx.stream(srgbProfile(), { N: 3 });
      const iccRef = ctx.register(icc);
      const intent = ctx.obj({
        Type: 'OutputIntent', S: 'GTS_PDFA1', Info: PDFString.of('sRGB'),
        OutputConditionIdentifier: PDFString.of('sRGB'), DestOutputProfile: iccRef,
      });
      out.catalog.set(PDFName.of('OutputIntents'), ctx.obj([ctx.register(intent)]));
      const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
      const title = stem(files[0].name).replace(/[<>&]/g, '');
      const xmp = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
<pdfaid:part>2</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance>
<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${title}</rdf:li></rdf:Alt></dc:title>
<xmp:CreateDate>${now}</xmp:CreateDate><xmp:ModifyDate>${now}</xmp:ModifyDate>
</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
      const meta = ctx.stream(new TextEncoder().encode(xmp), { Type: 'Metadata', Subtype: 'XML' });
      out.catalog.set(PDFName.of('Metadata'), ctx.register(meta));
      progress(0.95, 'Finishing');
      const saved = await out.save({ useObjectStreams: false });
      // pdf-lib omits the trailer /ID that PDF/A requires; qpdf adds it.
      const res = await qpdf(['--object-streams=disable', '--deterministic-id', '/in.pdf', '/out.pdf'], saved);
      if (!res.ok) throw new Error('Could not finalize the PDF/A file.');
      return [output(`${stem(files[0].name)}-pdfa.pdf`, res.bytes)];
    },
  },
  {
    id: 'protect', name: 'Protect PDF', cat: 'security', icon: 'lock', accept: pdf,
    desc: 'Encrypt with a password using AES-256.',
    note: 'There is no way to recover a lost password. Keep it somewhere safe.',
    action: 'Encrypt',
    fields: [
      { key: 'password', label: 'Password to open', type: 'password', default: '', autocomplete: 'new-password' },
      { key: 'confirm', label: 'Repeat password', type: 'password', default: '', autocomplete: 'new-password' },
      { key: 'print', label: 'Allow printing', type: 'checkbox', default: true },
      { key: 'copy', label: 'Allow copying text', type: 'checkbox', default: true },
      { key: 'modify', label: 'Allow editing', type: 'checkbox', default: true },
    ],
    async run({ files, values }) {
      if (!values.password) throw new UserError('Enter a password.');
      if (values.password !== values.confirm) throw new UserError('The two passwords do not match.');
      const bytes = await openBytes(files[0]);
      // A random owner password means the restrictions cannot be lifted with the open password.
      const restricted = !values.print || !values.copy || !values.modify;
      const owner = restricted
        ? [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('')
        : values.password;
      const res = await qpdf([
        '--encrypt', `--user-password=${values.password}`, `--owner-password=${owner}`, '--bits=256',
        `--print=${values.print ? 'full' : 'none'}`, `--extract=${values.copy ? 'y' : 'n'}`,
        `--modify=${values.modify ? 'all' : 'none'}`, '--', '/in.pdf', '/out.pdf',
      ], bytes);
      if (!res.ok) throw new Error(res.log || 'Encryption failed.');
      return [output(`${stem(files[0].name)}-protected.pdf`, res.bytes)];
    },
  },
  {
    id: 'unlock', name: 'Unlock PDF', cat: 'security', icon: 'unlock', accept: pdf,
    desc: 'Remove the password from a PDF you are allowed to open.',
    action: 'Unlock',
    fields: [{ key: 'password', label: 'Password', type: 'password', default: '', hint: 'Leave blank if the PDF opens without one and only has restrictions.', autocomplete: 'off' }],
    async run({ files, values }) {
      const plain = await openBytes(files[0], { password: values.password });
      return [output(`${stem(files[0].name)}-unlocked.pdf`, plain)];
    },
  },
  {
    id: 'metadata', name: 'Edit metadata', cat: 'security', icon: 'tag', accept: pdf,
    desc: 'Change or wipe the title, author and other hidden document details.',
    action: 'Save metadata',
    fields: [
      { key: 'wipe', label: 'Remove all metadata', type: 'checkbox', default: false },
      { key: 'title', label: 'Title', type: 'text', default: '', show: (v) => !v.wipe },
      { key: 'author', label: 'Author', type: 'text', default: '', show: (v) => !v.wipe },
      { key: 'subject', label: 'Subject', type: 'text', default: '', show: (v) => !v.wipe },
      { key: 'keywords', label: 'Keywords', type: 'text', default: '', hint: 'Separate with commas.', show: (v) => !v.wipe },
    ],
    async init({ files, setValues }) {
      const doc = await loadPdfLib(await openBytes(files[0]));
      setValues({ title: doc.getTitle() ?? '', author: doc.getAuthor() ?? '', subject: doc.getSubject() ?? '', keywords: doc.getKeywords() ?? '' });
    },
    async run({ files, values }) {
      const { PDFName } = await pdfLib();
      const doc = await loadPdfLib(await openBytes(files[0]));
      if (values.wipe) {
        const info = doc.context.trailerInfo.Info;
        if (info) doc.context.delete(info);
        doc.context.trailerInfo.Info = undefined;
        doc.catalog.delete(PDFName.of('Metadata'));
      } else {
        doc.setTitle(values.title); doc.setAuthor(values.author); doc.setSubject(values.subject);
        doc.setKeywords(values.keywords.split(',').map((s) => s.trim()).filter(Boolean));
      }
      return [output(`${stem(files[0].name)}-metadata.pdf`, await doc.save({ updateFieldAppearances: false }))];
    },
  },
];
