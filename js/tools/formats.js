// Ebooks, plain formats and open document formats.
import { UserError, jszip, loadPdfJs, marked, openBytes, output, pageLines, stem } from '../lib.js';
import {
  bookHtml, bookPdfCss, blockHtml, esc, loadBookFromPdf, pdfBlocks, readEpub, readKindle, writeAzw3, writeEpub,
} from '../books.js';
import { htmlToPdf, PAGE_SIZES } from '../htmlpdf.js';
import { flowFields, sizeOf, toGrid } from './convert.js';

const pdf = '.pdf,application/pdf';
const epub = '.epub,application/epub+zip';
const kindle = '.azw3,.azw,.mobi';
const ebookNote = 'DRM-protected books cannot be converted.';
const azwNote = 'Experimental: the file opens in independent AZW3 readers, but it has not been tried on a physical Kindle, and it has no table of contents menu. For Send to Kindle, EPUB is the safer choice.';

const encoder = new TextEncoder();
const bookPage = [{ key: 'page', label: 'Page size', type: 'select', default: 'A4', options: [['A4', 'A4'], ['Letter', 'US Letter']] }];

const bookToPdf = (read) => async ({ files, values, progress }) => {
  progress(0.05, 'Reading book');
  const book = await read(files[0]);
  progress(0.3, 'Laying out pages');
  const bytes = await htmlToPdf(bookHtml(book), {
    css: bookPdfCss, pageSize: PAGE_SIZES[values.page], margin: 64, progress: (p) => progress(0.3 + 0.7 * p, 'Writing PDF'),
  });
  return [output(`${stem(files[0].name)}.pdf`, bytes)];
};

const convertBook = (read, write, ext) => async ({ files, progress }) => {
  progress(0.1, 'Reading book');
  const book = await read(files[0]);
  progress(0.7, `Writing ${ext.toUpperCase()}`);
  return [output(`${stem(files[0].name)}.${ext}`, await write(book))];
};

const pdfToBook = (write, ext) => async ({ files, progress }) => {
  const book = await loadBookFromPdf(files[0], await openBytes(files[0]), (p, t) => progress(p * 0.9, t));
  progress(0.92, `Writing ${ext.toUpperCase()}`);
  return [output(`${stem(files[0].name)}.${ext}`, await write(book))];
};

const toMarkdown = (b) => {
  if (b.table) {
    const row = (r) => `| ${r.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`;
    return [row(b.rows[0]), `| ${b.rows[0].map(() => '---').join(' | ')} |`, ...b.rows.slice(1).map(row)].join('\n');
  }
  if (b.heading) return `${b.size > 18 ? '#' : '##'} ${b.text}`;
  return b.bold ? `**${b.text}**` : b.italic ? `*${b.text}*` : b.text;
};

/* ---------- ODT ---------- */

const NS = {
  text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0', table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  draw: 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0', style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  fo: 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0', xlink: 'http://www.w3.org/1999/xlink',
};

async function odtToHtml(file) {
  const JSZip = await jszip();
  let zip;
  try { zip = await JSZip.loadAsync(await file.arrayBuffer()); } catch { throw new UserError('This does not look like an ODT file.'); }
  const content = zip.file('content.xml');
  if (!content) throw new UserError('This does not look like an ODT file.');
  const doc = new DOMParser().parseFromString(await content.async('text'), 'application/xml');
  const styles = new Map();
  for (const s of doc.getElementsByTagNameNS(NS.style, 'style')) {
    const p = s.getElementsByTagNameNS(NS.style, 'text-properties')[0];
    if (!p) continue;
    const css = [];
    if (p.getAttributeNS(NS.fo, 'font-weight') === 'bold') css.push('font-weight:700');
    if (p.getAttributeNS(NS.fo, 'font-style') === 'italic') css.push('font-style:italic');
    const color = p.getAttributeNS(NS.fo, 'color');
    if (/^#[0-9a-f]{6}$/i.test(color || '')) css.push(`color:${color}`);
    const size = p.getAttributeNS(NS.fo, 'font-size');
    if (/^[\d.]+pt$/.test(size || '')) css.push(`font-size:${size}`);
    if (css.length) styles.set(s.getAttributeNS(NS.style, 'name'), css.join(';'));
  }
  const media = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif' };
  const walk = async (node) => {
    let out = '';
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { out += esc(n.data); continue; }
      if (n.nodeType !== 1) continue;
      const name = n.localName, ns = n.namespaceURI;
      const style = styles.get(n.getAttributeNS(NS.text, 'style-name'));
      const attr = style ? ` style="${style}"` : '';
      if (ns === NS.text) {
        if (name === 'p') out += `<p${attr}>${await walk(n) || '&nbsp;'}</p>`;
        else if (name === 'h') { const l = Math.min(+n.getAttributeNS(NS.text, 'outline-level') || 1, 6); out += `<h${l}${attr}>${await walk(n)}</h${l}>`; }
        else if (name === 'span') out += `<span${attr}>${await walk(n)}</span>`;
        else if (name === 'list') out += `<ul>${await walk(n)}</ul>`;
        else if (name === 'list-item') out += `<li>${await walk(n)}</li>`;
        else if (name === 's') out += ' ';
        else if (name === 'tab') out += '&emsp;';
        else if (name === 'line-break') out += '<br>';
        else if (name === 'a') out += await walk(n);
      } else if (ns === NS.table) {
        if (name === 'table') out += `<table>${await walk(n)}</table>`;
        else if (name === 'table-row') out += `<tr>${await walk(n)}</tr>`;
        else if (name === 'table-cell') out += `<td>${await walk(n)}</td>`;
      } else if (ns === NS.draw) {
        if (name === 'image') {
          const path = n.getAttributeNS(NS.xlink, 'href');
          const type = media[path?.split('.').pop().toLowerCase()];
          const f = path && zip.file(path);
          if (f && type) out += `<img src="data:${type};base64,${await f.async('base64')}" alt="">`;
        } else out += await walk(n);
      }
    }
    return out;
  };
  return walk(doc.getElementsByTagNameNS(NS.text ? 'urn:oasis:names:tc:opendocument:xmlns:office:1.0' : '', 'text')[0]);
}

/* ---------- RTF ---------- */

const SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'footer', 'footnote', 'themedata', 'latentstyles', 'datastore', 'generator']);

function rtfToHtml(src) {
  if (!src.startsWith('{\\rtf')) throw new UserError('This does not look like an RTF file.');
  const stack = [];
  let state = { b: false, i: false, skip: false, uc: 1 };
  let html = '', para = '';
  const put = (s) => {
    if (state.skip || !s) return;
    const text = esc(s);
    para += state.b ? `<b>${state.i ? `<i>${text}</i>` : text}</b>` : state.i ? `<i>${text}</i>` : text;
  };
  const flush = () => { html += `<p>${para || '&nbsp;'}</p>`; para = ''; };
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (c === '{') { stack.push({ ...state }); i++; }
    else if (c === '}') { state = stack.pop() ?? state; i++; }
    else if (c === '\\') {
      const next = src[i + 1];
      if (next === "'") { put(new TextDecoder('windows-1252').decode(Uint8Array.of(parseInt(src.substr(i + 2, 2), 16)))); i += 4; continue; }
      if (/[\\{}]/.test(next)) { put(next); i += 2; continue; }
      if (next === '*') { state.skip = true; i += 2; continue; }
      const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(src.slice(i, i + 40));
      if (!m) { i += 2; continue; }
      i += m[0].length;
      const [, word, arg] = m;
      if (SKIP.has(word)) state.skip = true;
      else if (word === 'par' || word === 'line') { if (!state.skip) flush(); }
      else if (word === 'tab') put('\t');
      else if (word === 'b') state.b = arg !== '0';
      else if (word === 'i') state.i = arg !== '0';
      else if (word === 'plain') { state.b = false; state.i = false; }
      else if (word === 'uc') state.uc = +arg;
      else if (word === 'u') { put(String.fromCodePoint((+arg + 65536) % 65536)); i += state.uc; }
    } else { if (c !== '\n' && c !== '\r') put(c); i++; }
  }
  if (para) flush();
  return html;
}

/* ---------- tools ---------- */

const docToPdf = (toHtml) => async ({ files, values, progress }) => {
  const html = await toHtml(files[0]);
  if (!html.replace(/<[^>]*>|&nbsp;/g, '').trim() && !html.includes('<img')) throw new UserError('This document appears to be empty.');
  progress(0.3, 'Laying out pages');
  const bytes = await htmlToPdf(html, { pageSize: sizeOf(values), margin: +values.margin, progress: (p) => progress(0.3 + 0.7 * p, 'Writing PDF') });
  return [output(`${stem(files[0].name)}.pdf`, bytes)];
};

const book = (id, name, accept, desc, run, extra = {}) => ({ id, name, cat: 'convert', icon: 'book', accept, desc, action: 'Convert', note: ebookNote, run, ...extra });

export default [
  book('epub-to-pdf', 'EPUB to PDF', epub, 'Turn an ebook into a PDF with chapters and images.', bookToPdf(readEpub), { fields: bookPage }),
  book('azw3-to-pdf', 'AZW3 to PDF', kindle, 'Turn a Kindle book (AZW3, AZW or MOBI) into a PDF.', bookToPdf(readKindle), { fields: bookPage }),
  book('pdf-to-epub', 'PDF to EPUB', pdf, 'Turn a PDF into a reflowable ebook with chapters.', pdfToBook(writeEpub, 'epub'), { note: 'Text is rebuilt so it can reflow. Multi-column pages and repeated headers can come out rough. Run OCR PDF on scans first.' }),
  book('pdf-to-azw3', 'PDF to AZW3', pdf, 'Turn a PDF into a Kindle-format ebook.', pdfToBook(writeAzw3, 'azw3'), { note: azwNote }),
  book('epub-to-azw3', 'EPUB to AZW3', epub, 'Convert an EPUB into Kindle format.', convertBook(readEpub, writeAzw3, 'azw3'), { note: `${azwNote} ${ebookNote}` }),
  book('azw3-to-epub', 'AZW3 to EPUB', kindle, 'Convert a Kindle book (AZW3, AZW or MOBI) into EPUB.', convertBook(readKindle, writeEpub, 'epub')),
  {
    id: 'pdf-to-text', name: 'PDF to Text', cat: 'convert', icon: 'text', accept: pdf,
    desc: 'Pull all the text out into a plain .txt file.', note: 'Works on PDFs with real text. Run OCR PDF on scans first.', action: 'Extract text',
    async run({ files, progress }) {
      const view = await loadPdfJs(await openBytes(files[0]));
      const pages = [];
      for (let n = 1; n <= view.numPages; n++) {
        progress((n - 1) / view.numPages, `Page ${n} of ${view.numPages}`);
        pages.push((await pageLines(await view.getPage(n))).map((l) => l.text).join('\n'));
      }
      const text = pages.join('\n\n');
      if (!text.trim()) throw new UserError('No text found. This looks like a scan; run OCR PDF first.');
      return [output(`${stem(files[0].name)}.txt`, encoder.encode(text))];
    },
  },
  {
    id: 'pdf-to-markdown', name: 'PDF to Markdown', cat: 'convert', icon: 'text', accept: pdf,
    desc: 'Get headings, paragraphs and tables as Markdown.', note: 'Pictures are left out. Run OCR PDF on scans first.', action: 'Convert',
    async run({ files, progress }) {
      const pages = await pdfBlocks(await loadPdfJs(await openBytes(files[0])), progress, { images: false });
      const text = pages.flat().map(toMarkdown).join('\n\n');
      if (!text.trim()) throw new UserError('No text found. This looks like a scan; run OCR PDF first.');
      return [output(`${stem(files[0].name)}.md`, encoder.encode(`${text}\n`))];
    },
  },
  {
    id: 'pdf-to-html', name: 'PDF to HTML', cat: 'convert', icon: 'code', accept: pdf,
    desc: 'Create one self-contained web page, images included.', action: 'Convert',
    async run({ files, progress }) {
      const pages = await pdfBlocks(await loadPdfJs(await openBytes(files[0])), progress);
      const body = pages.map((p) => `<section>${p.map(blockHtml).join('\n')}</section>`).join('\n<hr>\n');
      const title = esc(stem(files[0].name));
      const page = `<!doctype html>\n<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{max-width:760px;margin:2rem auto;padding:0 1rem;font:17px/1.6 system-ui,sans-serif}img{max-width:100%}table{border-collapse:collapse}td{border:1px solid #bbb;padding:4px 8px}</style></head><body>\n${body}\n</body></html>\n`;
      return [output(`${stem(files[0].name)}.html`, encoder.encode(page))];
    },
  },
  {
    id: 'pdf-to-csv', name: 'PDF to CSV', cat: 'convert', icon: 'sheet', accept: pdf,
    desc: 'Export tables as comma-separated values.', note: 'Works on PDFs with real text. Run OCR PDF on scans first.', action: 'Convert',
    async run({ files, progress }) {
      const view = await loadPdfJs(await openBytes(files[0]));
      const rows = [];
      for (let n = 1; n <= view.numPages; n++) {
        progress((n - 1) / view.numPages, `Page ${n} of ${view.numPages}`);
        rows.push(...toGrid(await pageLines(await view.getPage(n))));
      }
      if (!rows.length) throw new UserError('No text found. This looks like a scan; run OCR PDF first.');
      const cell = (c) => (c == null ? '' : /[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c));
      // The byte-order mark makes Excel read UTF-8 correctly.
      return [output(`${stem(files[0].name)}.csv`, encoder.encode(`﻿${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`))];
    },
  },
  {
    id: 'markdown-to-pdf', name: 'Markdown to PDF', cat: 'convert', icon: 'text', accept: '.md,.markdown,text/markdown', optionalFiles: true,
    desc: 'Turn a Markdown file or pasted text into a clean PDF.', note: 'Remote images are removed.', action: 'Convert to PDF',
    fields: [{ key: 'source', label: 'Markdown', type: 'textarea', default: '', placeholder: '# Title\n\nWrite here, or add a file.' }, ...flowFields],
    async run({ files, values, progress }) {
      const text = files[0] ? await files[0].text() : values.source;
      if (!text.trim()) throw new UserError('Add a Markdown file or paste some text.');
      const lib = await marked();
      const css = 'pre{background:#f3f3f3;padding:8px;white-space:pre-wrap;font-family:"Courier New",monospace}code{font-family:"Courier New",monospace}blockquote{border-left:3px solid #bbb;margin-left:0;padding-left:12px;color:#444}';
      const bytes = await htmlToPdf(lib.parse(text), { css, pageSize: sizeOf(values), margin: +values.margin, progress: (p) => progress(p, 'Writing PDF') });
      return [output(`${files[0] ? stem(files[0].name) : 'document'}.pdf`, bytes)];
    },
  },
  {
    id: 'text-to-pdf', name: 'Text to PDF', cat: 'convert', icon: 'text', accept: '.txt,.log,text/plain', optionalFiles: true,
    desc: 'Turn a text file or pasted text into a PDF.', action: 'Convert to PDF',
    fields: [
      { key: 'source', label: 'Text', type: 'textarea', default: '', placeholder: 'Paste text, or add a file.' },
      { key: 'mono', label: 'Use a fixed-width font', type: 'checkbox', default: false }, ...flowFields,
    ],
    async run({ files, values, progress }) {
      const text = files[0] ? await files[0].text() : values.source;
      if (!text.trim()) throw new UserError('Add a text file or paste some text.');
      const css = `pre{margin:0;white-space:pre-wrap;font:${values.mono ? '10pt/1.4 "Courier New",monospace' : '11pt/1.45 Arial,Helvetica,sans-serif'}}`;
      const bytes = await htmlToPdf(`<pre>${esc(text)}</pre>`, { css, pageSize: sizeOf(values), margin: +values.margin, progress: (p) => progress(p, 'Writing PDF') });
      return [output(`${files[0] ? stem(files[0].name) : 'text'}.pdf`, bytes)];
    },
  },
  {
    id: 'odt-to-pdf', name: 'ODT to PDF', cat: 'convert', icon: 'word', accept: '.odt,application/vnd.oasis.opendocument.text',
    desc: 'Convert LibreOffice and OpenOffice documents.', note: 'Text, basic styling, lists, tables and images are kept. Complex layouts are not.',
    action: 'Convert to PDF', fields: flowFields, run: docToPdf(odtToHtml),
  },
  {
    id: 'rtf-to-pdf', name: 'RTF to PDF', cat: 'convert', icon: 'word', accept: '.rtf,application/rtf,text/rtf',
    desc: 'Convert rich text documents.', note: 'Text, bold and italic are kept. Tables and images are not.',
    action: 'Convert to PDF', fields: flowFields, run: docToPdf(async (f) => rtfToHtml(await f.text())),
  },
];
