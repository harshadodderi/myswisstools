// Ebook conversion. Every format reads into and writes from one simple model:
// { title, author, language, chapters: [{ title, html }] } with images inlined as data: URLs.
import { UserError, breathe, canvasBytes, fflate, jszip, loadPdfJs, mobi, pageImages, pageLines, pdfjs, renderPage, stem } from './lib.js';
import { sanitize } from './htmlpdf.js';
import { structure } from './tools/convert.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const parseHtml = (s) => new DOMParser().parseFromString(s, 'text/html');
const parseXml = (s) => new DOMParser().parseFromString(s, 'application/xml');
const encoder = new TextEncoder();

const toDataUrl = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = reject;
  r.readAsDataURL(blob);
});

const dataUrlBytes = (url) => {
  const [head, body] = url.split(',', 2);
  const type = head.match(/^data:([^;,]+)/)?.[1] ?? 'application/octet-stream';
  const bytes = /;base64$/.test(head) ? Uint8Array.from(atob(body), (c) => c.charCodeAt(0)) : encoder.encode(decodeURIComponent(body));
  return { type, bytes };
};

// Kindle and EPUB readers only promise JPEG, PNG and GIF, so anything else becomes PNG.
async function portableImage(url) {
  const { type, bytes } = dataUrlBytes(url);
  if (/^image\/(jpeg|png|gif)$/.test(type)) return { type, bytes };
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth || 600; c.height = img.naturalHeight || 800;
  c.getContext('2d').drawImage(img, 0, 0);
  return { type: 'image/png', bytes: await canvasBytes(c, 'image/png') };
}

// Wrapped cover pages use <svg><image>; a plain <img> survives every format.
function liftSvgImages(doc) {
  for (const svg of doc.querySelectorAll('svg')) {
    const image = svg.querySelector('image');
    if (!image) continue;
    const img = doc.createElement('img');
    img.setAttribute('src', image.getAttribute('href') || image.getAttribute('xlink:href') || '');
    img.setAttribute('alt', '');
    svg.replaceWith(img);
  }
}

const chapterTitle = (doc, fallback) => doc.querySelector('h1, h2, h3, title')?.textContent.trim() || fallback;

/* ---------- reading ---------- */

export async function readEpub(file) {
  const JSZip = await jszip();
  let zip;
  try { zip = await JSZip.loadAsync(await file.arrayBuffer()); } catch { throw new UserError('This does not look like a valid EPUB file.'); }
  const read = (p) => zip.file(p)?.async('text');
  const container = await read('META-INF/container.xml');
  if (!container) throw new UserError('This does not look like a valid EPUB file.');
  const encryption = await read('META-INF/encryption.xml');
  if (encryption && [...parseXml(encryption).getElementsByTagName('*')].some((n) => n.localName === 'EncryptionMethod'
    && !/font|embedding/i.test(n.getAttribute('Algorithm') || ''))) {
    throw new UserError('This EPUB is DRM-protected, so it cannot be converted.');
  }
  const opfPath = parseXml(container).querySelector('rootfile')?.getAttribute('full-path');
  const opf = parseXml(await read(opfPath));
  const dir = opfPath.includes('/') ? opfPath.replace(/[^/]+$/, '') : '';
  const resolve = (from, href) => decodeURIComponent(new URL(href, `http://x/${from}`).pathname.slice(1));
  const manifest = new Map([...opf.getElementsByTagName('item')].map((i) => [i.getAttribute('id'), i]));
  const meta = (name) => opf.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', name)[0]?.textContent.trim();

  const chapters = [];
  for (const ref of opf.getElementsByTagName('itemref')) {
    const item = manifest.get(ref.getAttribute('idref'));
    if (!item) continue;
    const path = resolve(dir, item.getAttribute('href'));
    const source = await read(path);
    if (source == null) continue;
    const doc = parseHtml(source);
    liftSvgImages(doc);
    for (const img of doc.querySelectorAll('img[src]')) {
      const src = img.getAttribute('src');
      if (/^(data|https?):/i.test(src)) continue;
      const target = zip.file(resolve(path, src));
      const type = manifest.size && [...manifest.values()].find((i) => resolve(dir, i.getAttribute('href')) === resolve(path, src))?.getAttribute('media-type');
      if (target) img.setAttribute('src', await toDataUrl(new Blob([await target.async('uint8array')], { type: type || 'image/jpeg' })));
      else img.remove();
    }
    if (doc.body?.textContent.trim() || doc.body?.querySelector('img')) {
      chapters.push({ title: chapterTitle(doc, `Chapter ${chapters.length + 1}`), html: doc.body.innerHTML });
    }
  }
  if (!chapters.length) throw new UserError('No readable chapters were found in this EPUB.');
  return { title: meta('title') || stem(file.name), author: meta('creator') || '', language: meta('language') || 'en', chapters };
}

export async function readKindle(file) {
  const head = new Uint8Array(await file.slice(0, 2048).arrayBuffer());
  const view = new DataView(head.buffer);
  if (String.fromCharCode(...head.subarray(0, 4)) === 'CONT' || String.fromCharCode(...head.subarray(0, 4)) === '\xeaDRM') {
    throw new UserError('KFX files are not supported. Only AZW3, AZW and MOBI can be read.');
  }
  if (String.fromCharCode(...head.subarray(60, 68)) !== 'BOOKMOBI') throw new UserError('This does not look like an AZW3 or MOBI file.');
  const first = view.getUint32(78);
  if (first + 14 <= head.length && view.getUint16(first + 12) !== 0) {
    throw new UserError('This Kindle book is DRM-protected, so it cannot be converted.');
  }
  const [{ MOBI }, { unzlibSync }] = await Promise.all([mobi(), fflate()]);
  const reader = new MOBI({ unzlib: unzlibSync });
  const book = await reader.open(file);
  if (reader.headers?.palmdoc?.encryption) throw new UserError('This Kindle book is DRM-protected, so it cannot be converted.');

  const chapters = [];
  for (const section of book.sections) {
    if (!section.load) continue;
    const url = await section.load();
    const doc = parseHtml(await (await fetch(url)).text());
    liftSvgImages(doc);
    for (const img of doc.querySelectorAll('img[src]')) {
      const src = img.getAttribute('src');
      if (src.startsWith('blob:')) img.setAttribute('src', await toDataUrl(await (await fetch(src)).blob()));
    }
    if (doc.body?.textContent.trim() || doc.body?.querySelector('img')) {
      chapters.push({ title: chapterTitle(doc, `Chapter ${chapters.length + 1}`), html: doc.body.innerHTML });
    }
    section.unload?.();
  }
  if (!chapters.length) throw new UserError('No readable text was found in this book.');
  const { title, author, language } = book.metadata;
  return { title: title || stem(file.name), author: [].concat(author ?? []).join(', '), language: language || 'en', chapters };
}

export async function pdfBlocks(view, progress = () => {}, { images = true } = {}) {
  const lib = await pdfjs();
  const pages = [];
  for (let n = 1; n <= view.numPages; n++) {
    progress((n - 1) / view.numPages, `Page ${n} of ${view.numPages}`);
    const page = await view.getPage(n);
    const vp = page.getViewport({ scale: 1, rotation: page.rotate });
    const lines = await pageLines(page);
    const blocks = structure(lines, vp.width);
    if (images) {
      for (const im of await pageImages(page, lib)) {
        if (lines.length && im.width > vp.width * 0.85 && im.height > vp.height * 0.85) continue;
        blocks.push({ image: im.canvas, y: im.top });
      }
      if (!blocks.length) blocks.push({ image: await renderPage(page, 1.5), y: 0 });
    }
    pages.push(blocks.sort((a, b) => a.y - b.y));
    await breathe();
  }
  return pages;
}

const canvasUrl = (c) => (c.width * c.height > 600000 ? c.toDataURL('image/jpeg', 0.85) : c.toDataURL('image/png'));

export function blockHtml(b) {
  if (b.image) return `<p><img src="${canvasUrl(b.image)}" alt=""/></p>`;
  if (b.table) return `<table>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table>`;
  if (b.heading) { const h = b.size > 18 ? 'h1' : 'h2'; return `<${h}>${esc(b.text)}</${h}>`; }
  const text = esc(b.text);
  return `<p>${b.bold ? `<b>${text}</b>` : b.italic ? `<i>${text}</i>` : text}</p>`;
}

export async function readPdfBook(view, name, progress) {
  const pages = await pdfBlocks(view, progress);
  const info = (await view.getMetadata().catch(() => null))?.info ?? {};
  const chapters = [];
  let current = null;
  for (const b of pages.flat()) {
    // A top-level heading starts a chapter, so long PDFs become navigable books.
    if (!current || (b.heading && b.size > 18)) {
      current = { title: b.heading ? b.text : info.Title || name, html: '' };
      chapters.push(current);
    }
    current.html += blockHtml(b);
  }
  if (!chapters.length) throw new UserError('No content was found in this PDF.');
  return { title: info.Title || name, author: info.Author || '', language: 'en', chapters };
}

/* ---------- XHTML shared by EPUB and AZW3 ---------- */

// Parses, cleans and re-serializes so the strict XML readers in ebook apps accept it.
async function cleanChapter(html, onImage) {
  const { body } = sanitize(html);
  const doc = parseHtml(body);
  for (const img of [...doc.querySelectorAll('img')]) {
    const src = img.getAttribute('src') || '';
    if (!src.startsWith('data:')) { img.remove(); continue; }
    img.setAttribute('src', await onImage(src));
    if (!img.hasAttribute('alt')) img.setAttribute('alt', '');
  }
  for (const a of doc.querySelectorAll('a[href]')) if (!/^https?:/i.test(a.getAttribute('href'))) a.removeAttribute('href');
  const serializer = new XMLSerializer();
  return [...doc.body.childNodes].map((n) => serializer.serializeToString(n)).join('')
    .replaceAll(' xmlns="http://www.w3.org/1999/xhtml"', '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif' };

/* ---------- EPUB writer ---------- */

export async function writeEpub(book) {
  const JSZip = await jszip();
  const zip = new JSZip();
  // EPUB requires this entry first and uncompressed.
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  const items = [], images = new Map();
  const addImage = async (url) => {
    if (!images.has(url)) {
      const { type, bytes } = await portableImage(url);
      const name = `images/img${images.size + 1}.${EXT[type]}`;
      images.set(url, name);
      zip.file(`OEBPS/${name}`, bytes);
      items.push(`<item id="img${images.size}" href="${name}" media-type="${type}"/>`);
    }
    return images.get(url);
  };
  const spine = [], nav = [];
  for (const [i, ch] of book.chapters.entries()) {
    const file = `chapter${i + 1}.xhtml`;
    const body = await cleanChapter(ch.html, addImage);
    zip.file(`OEBPS/${file}`, `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${esc(ch.title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body>${body}</body></html>`);
    items.push(`<item id="c${i + 1}" href="${file}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="c${i + 1}"/>`);
    nav.push(`<li><a href="${file}">${esc(ch.title)}</a></li>`);
  }
  zip.file('OEBPS/style.css', 'body{line-height:1.5}img{max-width:100%}table{border-collapse:collapse}td{border:1px solid #999;padding:4px}');
  zip.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><h1>Contents</h1><ol>${nav.join('')}</ol></nav></body></html>`);
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:uuid:${crypto.randomUUID()}</dc:identifier><dc:title>${esc(book.title)}</dc:title>${book.author ? `<dc:creator>${esc(book.author)}</dc:creator>` : ''}<dc:language>${esc(book.language)}</dc:language><meta property="dcterms:modified">${stamp}</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="style.css" media-type="text/css"/>${items.join('')}</manifest><spine>${spine.join('')}</spine></package>`);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', mimeType: 'application/epub+zip' });
}

/* ---------- AZW3 (KF8) writer ---------- */

const RECORD = 4096;

function bytesOf(...parts) {
  const chunks = parts.map((p) => (typeof p === 'string' ? Uint8Array.from(p, (c) => c.charCodeAt(0)) : p));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}
const u32 = (...ns) => { const b = new Uint8Array(ns.length * 4), v = new DataView(b.buffer); ns.forEach((n, i) => v.setUint32(i * 4, n >>> 0)); return b; };
const u16 = (...ns) => { const b = new Uint8Array(ns.length * 2), v = new DataView(b.buffer); ns.forEach((n, i) => v.setUint16(i * 2, n)); return b; };
const pad4 = (b) => (b.length % 4 ? bytesOf(b, new Uint8Array(4 - (b.length % 4))) : b);

// Forward variable-width integer: 7 bits per byte, high bit marks the last byte.
function vint(n) {
  const out = [n & 0x7f | 0x80];
  for (n = Math.floor(n / 128); n > 0; n = Math.floor(n / 128)) out.unshift(n & 0x7f);
  return Uint8Array.from(out);
}

function indxHeader(kind, idxtAt, entries, { total = 0, cncx = 0 } = {}) {
  const b = new Uint8Array(192), v = new DataView(b.buffer);
  b.set(bytesOf('INDX'));
  v.setUint32(4, 192);
  v.setUint32(12, kind);
  v.setUint32(20, idxtAt);
  v.setUint32(24, entries);
  v.setUint32(28, 65001);
  v.setUint32(32, 0xffffffff);
  v.setUint32(36, total);
  v.setUint32(52, cncx);
  if (kind === 2) v.setUint32(180, 192);
  return b;
}

// Returns the meta record, one data record and optional string table.
function buildIndex(tagTable, controlByte, rows, cncx) {
  const body = [], offsets = [];
  let at = 192;
  for (const [name, values] of rows) {
    const entry = bytesOf(Uint8Array.of(name.length), name, Uint8Array.of(controlByte), ...values.map(vint));
    offsets.push(at);
    at += entry.length;
    body.push(entry);
  }
  const content = pad4(bytesOf(...body));
  const idxtAt = 192 + content.length;
  const data = bytesOf(indxHeader(1, idxtAt, rows.length), content, pad4(bytesOf('IDXT', u16(...offsets))));

  const tagx = bytesOf('TAGX', u32(12 + tagTable.length * 4, 1), ...tagTable.map((t) => Uint8Array.from(t)));
  const lastName = rows.at(-1)[0];
  const geometry = pad4(bytesOf(tagx, Uint8Array.of(lastName.length), lastName, u16(rows.length)));
  const metaIdxt = 192 + geometry.length;
  const meta = bytesOf(indxHeader(2, metaIdxt, 1, { total: rows.length, cncx: cncx ? 1 : 0 }), geometry, pad4(bytesOf('IDXT', u16(192 + tagx.length))));
  return cncx ? [meta, data, cncx] : [meta, data];
}

const kindleId = (n) => n.toString(32).toUpperCase().padStart(4, '0');
const FLIS = Uint8Array.from('FLIS\0\0\0\x08\0\x41\0\0\0\0\0\0\xff\xff\xff\xff\0\x01\0\x03\0\0\0\x03\0\0\0\x01\xff\xff\xff\xff', (c) => c.charCodeAt(0));

export async function writeAzw3(book) {
  const images = new Map(), resources = [];
  const addImage = async (url) => {
    if (!images.has(url)) {
      const { type, bytes } = await portableImage(url);
      resources.push(bytes);
      images.set(url, `kindle:embed:${kindleId(resources.length)}?mime=${type}`);
    }
    return images.get(url);
  };

  // Each chapter is a skeleton (the page shell) with one fragment (the body) inserted into it.
  const flow = [], skeletons = [], fragments = [], names = [];
  let cursor = 0;
  const lang = esc(book.language);
  for (const [i, ch] of book.chapters.entries()) {
    const body = await cleanChapter(ch.html, addImage);
    const open = encoder.encode(`<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${lang}"><head><title>${esc(ch.title)}</title></head><body aid="${kindleId(i)}">`);
    const close = encoder.encode('</body></html>');
    const part = encoder.encode(`<div aid="${kindleId(i + 1000)}">${body}</div>`);
    flow.push(open, close, part);
    skeletons.push({ start: cursor, length: open.length + close.length, frags: 1 });
    fragments.push({ insert: cursor + open.length, file: i, offset: 0, length: part.length, selector: `P-//*[@aid='${kindleId(i)}']` });
    cursor += open.length + close.length + part.length;
    names.push(ch.title);
  }
  const text = bytesOf(...flow);

  const textRecords = [];
  for (let at = 0; at < text.length; at += RECORD) {
    const end = Math.min(at + RECORD, text.length);
    // Readers decode records independently, so finish any split UTF-8 character after the record.
    let extra = 0;
    while (end + extra < text.length && extra < 3 && (text[end + extra] & 0xc0) === 0x80) extra++;
    textRecords.push(bytesOf(text.subarray(at, end), text.subarray(end, end + extra), Uint8Array.of(extra)));
  }

  const fdst = bytesOf('FDST', u32(12, 1, 0, text.length));
  const skel = buildIndex([[1, 1, 3, 0], [6, 2, 12, 0], [0, 0, 0, 1]], 0x0a,
    skeletons.map((s, i) => [`SKEL${String(i).padStart(10, '0')}`, [s.frags, s.frags, s.start, s.length, s.start, s.length]]), null);
  const strings = [];
  const cncxAt = [];
  let cncxLength = 0;
  for (const f of fragments) {
    const s = bytesOf(vint(f.selector.length), f.selector);
    cncxAt.push(cncxLength);
    cncxLength += s.length;
    strings.push(s);
  }
  const frag = buildIndex([[2, 1, 1, 0], [3, 1, 2, 0], [4, 1, 4, 0], [6, 2, 8, 0], [0, 0, 0, 1]], 0x0f,
    fragments.map((f, i) => [String(f.insert).padStart(10, '0'), [cncxAt[i], f.file, i, f.offset, f.length]]), pad4(bytesOf(...strings)));

  const fcis = bytesOf('FCIS', u32(0x14, 0x10, 2, 0, text.length, 0, 0x28, 0, 0x28, 8), u16(1, 1), u32(0));
  const eof = u32(0xe98e0d0a);

  const firstResource = textRecords.length + 1;
  const records = [...textRecords, ...resources];
  const fdstIndex = firstResource + resources.length;
  records.push(fdst);
  const skelIndex = fdstIndex + 1;
  records.push(...skel);
  const fragIndex = skelIndex + skel.length;
  records.push(...frag);
  const flisIndex = fragIndex + frag.length;
  records.push(FLIS, fcis, eof);

  const title = encoder.encode(book.title);
  const exthRecord = (type, value) => {
    const data = typeof value === 'number' ? u32(value) : encoder.encode(value);
    return bytesOf(u32(type, data.length + 8), data);
  };
  const exthItems = [exthRecord(503, book.title), exthRecord(501, 'EBOK'), exthRecord(524, book.language), exthRecord(125, resources.length)];
  if (book.author) exthItems.push(exthRecord(100, book.author));
  const exthBody = bytesOf(...exthItems);
  const exth = pad4(bytesOf('EXTH', u32(12 + exthBody.length, exthItems.length), exthBody));

  const HEADER = 280; // 16 PalmDOC + 264 MOBI
  const head = new Uint8Array(HEADER), v = new DataView(head.buffer);
  v.setUint16(0, 1); // no compression, which every reader supports
  v.setUint32(4, text.length);
  v.setUint16(8, textRecords.length);
  v.setUint16(10, RECORD);
  head.set(bytesOf('MOBI'), 16);
  v.setUint32(20, 264);
  v.setUint32(24, 2);
  v.setUint32(28, 65001);
  v.setUint32(32, crypto.getRandomValues(new Uint32Array(1))[0]);
  v.setUint32(36, 8);
  for (let at = 40; at < 80; at += 4) v.setUint32(at, 0xffffffff);
  v.setUint32(80, firstResource);
  v.setUint32(84, HEADER + exth.length);
  v.setUint32(88, title.length);
  v.setUint32(92, 9);
  v.setUint32(104, 8);
  v.setUint32(108, firstResource);
  v.setUint32(128, 0x50);
  v.setUint32(168, 0xffffffff);
  v.setUint32(172, 0xffffffff);
  v.setUint32(192, fdstIndex);
  v.setUint32(196, 1);
  v.setUint32(200, flisIndex + 1);
  v.setUint32(204, 1);
  v.setUint32(208, flisIndex);
  v.setUint32(212, 1);
  v.setUint32(240, 1); // bit 0: records end with a multibyte-overlap count
  v.setUint32(244, 0xffffffff);
  v.setUint32(248, fragIndex);
  v.setUint32(252, skelIndex);
  v.setUint32(256, 0xffffffff);
  v.setUint32(260, 0xffffffff);
  const record0 = bytesOf(head, exth, title, new Uint8Array(8192));

  const all = [record0, ...records];
  const pdb = new Uint8Array(78), p = new DataView(pdb.buffer);
  pdb.set(encoder.encode(book.title.replace(/[^\x20-\x7e]/g, '').slice(0, 31) || 'Book'));
  const now = Math.floor(Date.now() / 1000) + 2082844800;
  p.setUint32(36, now); p.setUint32(40, now);
  pdb.set(bytesOf('BOOKMOBI'), 60);
  p.setUint32(68, all.length * 2 - 1);
  p.setUint16(76, all.length);
  const list = new Uint8Array(all.length * 8 + 2), l = new DataView(list.buffer);
  let offset = 78 + list.length;
  all.forEach((r, i) => { l.setUint32(i * 8, offset); l.setUint32(i * 8 + 4, i * 2); offset += r.length; });
  return bytesOf(pdb, list, ...all);
}

/* ---------- to PDF ---------- */

export const bookPdfCss = `body{font:11.5pt/1.5 "Times New Roman",Times,serif}img{max-height:900px}
h1,h2,h3{font-family:Arial,Helvetica,sans-serif}a{color:inherit}section{break-before:column}section:first-child{break-before:auto}`;

export const bookHtml = (book) => book.chapters.map((c) => `<section>${c.html}</section>`).join('');

export const loadBookFromPdf = async (file, bytes, progress) => readPdfBook(await loadPdfJs(bytes), stem(file.name), progress);
