// Turns laid-out HTML into a real PDF: text stays text, boxes and images stay crisp.
// The browser does the layout in a sandboxed iframe; this walks the result and draws it.
// CSS columns give us pagination, so lines and images are never cut across pages.
import { canvasBytes, isWinAnsi, pdfLib, textToCanvas } from './lib.js';

const PX = 0.75; // CSS px to PDF points

const baseCss = `
  html,body{margin:0;padding:0;background:#fff;color:#111;}
  body{font:11pt/1.45 Arial,Helvetica,sans-serif;overflow-wrap:break-word;}
  img,svg,canvas{max-width:100%;break-inside:avoid;}
  table{border-collapse:collapse;max-width:100%;}
  td,th{border:1px solid #bbb;padding:4px 6px;vertical-align:top;}
  tr,img,figure{break-inside:avoid;}
  h1,h2,h3,h4{line-height:1.2;break-after:avoid;}
`;

export const PAGE_SIZES = { A4: [794, 1123], Letter: [816, 1056], Legal: [816, 1344] };

// Removes anything that could fetch from the network or run code before the HTML is rendered.
// The page's Content-Security-Policy is the second layer behind this.
export function sanitize(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, iframe, frame, object, embed, base, link, meta, audio, video, source, track, form').forEach((n) => n.remove());
  const remote = /^\s*(https?:|\/\/|ftp:)/i;
  for (const node of doc.querySelectorAll('*')) {
    for (const { name, value } of [...node.attributes]) {
      const attr = name.toLowerCase();
      if (attr.startsWith('on') || attr === 'srcset' || attr === 'ping' || attr === 'background') node.removeAttribute(name);
      else if ((attr === 'src' || attr === 'href' || attr === 'xlink:href' || attr === 'poster') && (remote.test(value) || /^\s*javascript:/i.test(value))) node.removeAttribute(name);
    }
  }
  const strip = (css) => css.replace(/@import[^;]*;?/gi, '').replace(/url\(\s*['"]?\s*(https?:|\/\/)[^)]*\)/gi, 'none');
  doc.querySelectorAll('[style]').forEach((n) => n.setAttribute('style', strip(n.getAttribute('style'))));
  const styles = [...doc.querySelectorAll('style')].map((n) => { const css = strip(n.textContent); n.remove(); return css; }).join('\n');
  return { body: doc.body.innerHTML, styles };
}

function makeFrame(rawHtml, css, width, height) {
  const { body, styles } = sanitize(rawHtml);
  const frame = document.createElement('iframe');
  // allow-same-origin lets us measure the document; without allow-scripts nothing inside can run.
  frame.setAttribute('sandbox', 'allow-same-origin');
  frame.style.cssText = `position:fixed;left:-20000px;top:0;width:${width}px;height:${height}px;border:0;background:#fff`;
  return new Promise((resolve) => {
    frame.onload = () => resolve(frame);
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>${baseCss}${styles}${css}</style></head><body>${body}</body></html>`;
    document.body.append(frame);
  });
}

const fontFor = (cs, lib) => {
  const bold = parseInt(cs.fontWeight, 10) >= 600, italic = cs.fontStyle !== 'normal';
  const family = cs.fontFamily.toLowerCase();
  const S = lib.StandardFonts;
  if (/courier|mono|consol/.test(family)) return S[`Courier${bold && italic ? 'BoldOblique' : bold ? 'Bold' : italic ? 'Oblique' : ''}`];
  if (/times|serif|georgia|cambria|garamond/.test(family) && !/sans/.test(family)) return S[`Times${bold && italic ? 'RomanBoldItalic' : bold ? 'RomanBold' : italic ? 'RomanItalic' : 'Roman'}`];
  return S[`Helvetica${bold && italic ? 'BoldOblique' : bold ? 'Bold' : italic ? 'Oblique' : ''}`];
};

const parseColor = (value) => {
  const m = value.match(/[\d.]+/g);
  if (!m || (m.length > 3 && +m[3] === 0)) return null;
  return { r: m[0] / 255, g: m[1] / 255, b: m[2] / 255, a: m.length > 3 ? +m[3] : 1 };
};

/**
 * mode 'flow': content is paginated into pages of pageWidth×pageHeight with margin.
 * mode 'fixed': each direct child of body is exactly one page, stacked vertically.
 */
export async function htmlToPdf(html, { css = '', pageSize = [794, 1123], margin = 72, mode = 'flow', progress = () => {} } = {}) {
  const lib = await pdfLib();
  const { PDFDocument, rgb } = lib;
  const [pageW, pageH] = pageSize;
  const innerW = mode === 'flow' ? pageW - margin * 2 : pageW;
  const innerH = mode === 'flow' ? pageH - margin * 2 : pageH;
  const layout = mode === 'flow'
    ? `body{width:${innerW}px;height:${innerH}px;column-width:${innerW}px;column-gap:0;column-fill:auto;}`
    : 'body{width:100%;}';
  const frame = await makeFrame(html, layout + css, innerW, innerH);
  const win = frame.contentWindow, idoc = frame.contentDocument;
  await Promise.all([...idoc.images].map((im) => im.decode().catch(() => {})));
  await idoc.fonts?.ready;

  const out = await PDFDocument.create();
  const pages = [];
  const pageAt = (i) => {
    while (pages.length <= i) pages.push(out.addPage([pageW * PX, pageH * PX]));
    return pages[i];
  };
  const locate = (x, y) => {
    if (mode === 'flow') {
      const i = Math.max(0, Math.floor((x + 1) / innerW));
      return { index: i, left: x - i * innerW + margin, top: y + margin };
    }
    const i = Math.max(0, Math.floor((y + 1) / innerH));
    return { index: i, left: x, top: y - i * innerH };
  };

  const fonts = new Map();
  const embedFont = async (name) => {
    if (!fonts.has(name)) fonts.set(name, await out.embedFont(name));
    return fonts.get(name);
  };

  const rect = (loc, w, h, color) => pageAt(loc.index).drawRectangle({
    x: loc.left * PX, y: (pageH - loc.top - h) * PX, width: w * PX, height: h * PX,
    color: rgb(color.r, color.g, color.b), opacity: color.a,
  });

  const drawBoxes = (node, cs) => {
    const bg = parseColor(cs.backgroundColor);
    const sides = ['Top', 'Right', 'Bottom', 'Left'].map((s) => ({
      w: parseFloat(cs[`border${s}Width`]) || 0, style: cs[`border${s}Style`], color: parseColor(cs[`border${s}Color`]),
    }));
    if (!bg && !sides.some((b) => b.w && b.style !== 'none' && b.color)) return;
    for (const r of node.getClientRects()) {
      if (r.width < 0.5 || r.height < 0.5) continue;
      const loc = locate(r.left, r.top);
      if (bg) rect(loc, r.width, r.height, bg);
      const [t, ri, bo, le] = sides;
      const on = (b) => b.w && b.style !== 'none' && b.style !== 'hidden' && b.color;
      if (on(t)) rect(loc, r.width, t.w, t.color);
      if (on(bo)) rect({ ...loc, top: loc.top + r.height - bo.w }, r.width, bo.w, bo.color);
      if (on(le)) rect(loc, le.w, r.height, le.color);
      if (on(ri)) rect({ ...loc, left: loc.left + r.width - ri.w }, ri.w, r.height, ri.color);
    }
  };

  const drawImage = async (node) => {
    const r = node.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    let w = node.naturalWidth || node.width?.baseVal?.value || node.width || r.width;
    let h = node.naturalHeight || node.height?.baseVal?.value || node.height || r.height;
    const limit = Math.min(1, 2400 / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * limit)); c.height = Math.max(1, Math.round(h * limit));
    try {
      c.getContext('2d').drawImage(node, 0, 0, c.width, c.height);
      const img = await out.embedPng(await canvasBytes(c, 'image/png'));
      const loc = locate(r.left, r.top);
      pageAt(loc.index).drawImage(img, { x: loc.left * PX, y: (pageH - loc.top - r.height) * PX, width: r.width * PX, height: r.height * PX });
    } catch { /* an undecodable image is skipped rather than failing the document */ }
  };

  const drawText = async (node, cs) => {
    const color = parseColor(cs.color) ?? { r: 0, g: 0, b: 0, a: 1 };
    const size = parseFloat(cs.fontSize) || 14;
    const underline = cs.textDecorationLine.includes('underline'), strike = cs.textDecorationLine.includes('line-through');
    const hex = `#${[color.r, color.g, color.b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;
    const font = await embedFont(fontFor(cs, lib));
    const range = idoc.createRange();
    const text = node.data;
    for (const m of text.matchAll(/\S+/g)) {
      range.setStart(node, m.index);
      range.setEnd(node, m.index + m[0].length);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0);
      if (!rects.length) continue;
      const r = rects[0];
      const loc = locate(r.left, r.top);
      const page = pageAt(loc.index);
      const ascent = (r.height - size) / 2 + size * 0.9;
      const word = cs.textTransform === 'uppercase' ? m[0].toUpperCase() : m[0];
      const x = loc.left * PX, y = (pageH - loc.top - ascent) * PX;
      if (isWinAnsi(word) && rects.length === 1) {
        page.drawText(word, { x, y, size: size * PX, font, color: rgb(color.r, color.g, color.b), opacity: color.a });
      } else {
        // Whole-node shaping keeps joined scripts such as Devanagari and Arabic correct.
        const shaped = textToCanvas(word, { size, color: hex, font: `${cs.fontStyle} ${cs.fontWeight}`, scale: 3 });
        const png = await out.embedPng(await canvasBytes(shaped.canvas, 'image/png'));
        const iw = shaped.width * PX, ih = shaped.height * PX;
        page.drawImage(png, { x, y: y - shaped.baseline * PX, width: iw, height: ih });
      }
      if (underline || strike) {
        const lineY = underline ? y - size * PX * 0.12 : y + size * PX * 0.28;
        page.drawLine({ start: { x, y: lineY }, end: { x: x + r.width * PX, y: lineY }, thickness: Math.max(0.5, size * PX * 0.06), color: rgb(color.r, color.g, color.b) });
      }
    }
  };

  // Two passes keep backgrounds beneath text, which matches CSS painting closely enough.
  const nodes = [];
  const walk = idoc.createTreeWalker(idoc.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let n = walk.currentNode; n; n = walk.nextNode()) {
    const elem = n.nodeType === 1 ? n : n.parentElement;
    const cs = win.getComputedStyle(elem);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    nodes.push([n, cs]);
  }
  for (const [n, cs] of nodes) if (n.nodeType === 1 && n !== idoc.body) drawBoxes(n, cs);
  for (let i = 0; i < nodes.length; i++) {
    const [n, cs] = nodes[i];
    if (i % 200 === 0) progress(i / nodes.length);
    if (n.nodeType === 3) await drawText(n, cs);
    else if (/^(IMG|CANVAS)$/.test(n.tagName)) await drawImage(n);
  }
  if (!pages.length) pageAt(0);
  frame.remove();
  return out.save();
}
