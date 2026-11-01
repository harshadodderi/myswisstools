// Drives every tool through the real UI in Chrome, then re-opens each output independently.
// Usage: npm test            (all tools)
//        npm test -- ocr sign (only tools whose id matches)
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, firefox, webkit } from 'playwright';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { Document, Packer, Paragraph, HeadingLevel, TextRun, Table, TableRow, TableCell } from 'docx';
import PptxGen from 'pptxgenjs';
import XLSX from 'xlsx';
import JSZip from 'jszip';

const PORT = 8137, BASE = `http://localhost:${PORT}/`;
const dir = 'tests/output', fx = (n) => join(dir, 'fixtures', n);
mkdirSync(join(dir, 'fixtures'), { recursive: true });
const only = process.argv.slice(2);

const openPdf = (bytes, password) => pdfjs.getDocument({ data: Uint8Array.from(bytes), password, verbosity: 0 }).promise;
async function pdfText(bytes, password) {
  const doc = await openPdf(bytes, password);
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const c = await (await doc.getPage(i)).getTextContent();
    pages.push(c.items.map((t) => t.str).join(' '));
  }
  return { pages, count: doc.numPages, doc };
}

/* ---------- fixtures ---------- */

async function makeFixtures(page) {
  const write = (n, b) => writeFileSync(fx(n), b);

  const text = await PDFDocument.create();
  text.setTitle('Original title'); text.setAuthor('Fixture Author');
  const font = await text.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 5; i++) {
    const p = text.addPage([595, 842]);
    p.drawText(`Page marker ${i}`, { x: 60, y: 760, size: 24, font });
    p.drawText('The account number is SECRET-4471 for this person.', { x: 60, y: 700, size: 12, font });
  }
  text.getPage(2).setRotation(degrees(90));
  write('text.pdf', await text.save());

  const changed = await PDFDocument.load(await text.save());
  const f2 = await changed.embedFont(StandardFonts.Helvetica);
  changed.getPage(1).drawText('Inserted sentence here', { x: 60, y: 640, size: 12, font: f2 });
  write('text-v2.pdf', await changed.save());

  const table = await PDFDocument.create();
  const f3 = await table.embedFont(StandardFonts.Helvetica);
  const tp = table.addPage([595, 842]);
  tp.drawText('Quarterly Report', { x: 60, y: 780, size: 26, font: f3 });
  tp.drawText('This summary paragraph describes the numbers below in plain words.', { x: 60, y: 745, size: 11, font: f3 });
  [['Item', 'Units', 'Price'], ['Apples', '120', '3.50'], ['Pears', '75', '4.25'], ['Plums', '1,300', '0.80']].forEach((row, r) => {
    row.forEach((cell, c) => tp.drawText(cell, { x: 60 + c * 170, y: 700 - r * 22, size: 11, font: f3 }));
  });
  write('table.pdf', await table.save());

  // Pixels come from a real browser canvas, giving true JPEG photo-like and text-like scans.
  const jpeg = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 2800; c.height = 2000;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 2800, 2000); g.addColorStop(0, '#d33'); g.addColorStop(1, '#27c'); x.fillStyle = g; x.fillRect(0, 0, 2800, 2000);
    for (let i = 0; i < 6000; i++) { x.fillStyle = `hsl(${i % 360} 70% ${30 + i % 50}%)`; x.fillRect((i * 7919) % 2800, (i * 104729) % 2000, 9, 9); }
    return [...atob(c.toDataURL('image/jpeg', 0.97).split(',')[1])].map((ch) => ch.charCodeAt(0));
  });
  const heavy = await PDFDocument.create();
  const f4 = await heavy.embedFont(StandardFonts.Helvetica);
  const img = await heavy.embedJpg(Uint8Array.from(jpeg));
  const hp = heavy.addPage([595, 842]);
  hp.drawImage(img, { x: 40, y: 300, width: 515, height: 368 });
  hp.drawText('Selectable caption survives compression', { x: 60, y: 780, size: 14, font: f4 });
  write('heavy.pdf', await heavy.save());
  write('photo.jpg', Uint8Array.from(jpeg));

  const scanImg = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 1240; c.height = 1754;
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 1240, 1754);
    x.fillStyle = '#000'; x.font = '64px Arial';
    x.fillText('Invoice Number 88213', 120, 240); x.fillText('Total payable amount', 120, 340);
    return [...atob(c.toDataURL('image/png').split(',')[1])].map((ch) => ch.charCodeAt(0));
  });
  const scan = await PDFDocument.create();
  const si = await scan.embedPng(Uint8Array.from(scanImg));
  scan.addPage([595, 842]).drawImage(si, { x: 0, y: 0, width: 595, height: 842 });
  write('scan.pdf', await scan.save());
  write('scan.png', Uint8Array.from(scanImg));

  const good = Buffer.from(await text.save({ useObjectStreams: false }));
  write('broken.pdf', good.subarray(0, good.lastIndexOf(Buffer.from('xref'))));

  const docx = new Document({ sections: [{ children: [
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Project Charter')] }),
    new Paragraph({ children: [new TextRun({ text: 'Bold opening ', bold: true }), new TextRun('followed by normal words. '.repeat(120))] }),
    ...Array.from({ length: 60 }, (_, i) => new Paragraph(`Numbered line ${i + 1} of the long document.`)),
    new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph('CellOne')] }), new TableCell({ children: [new Paragraph('CellTwo')] })] })] }),
    new Paragraph('हिन्दी पाठ यहाँ है'),
  ] }] });
  write('doc.docx', await Packer.toBuffer(docx));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Name', 'Score'], ['Asha', 91], ['Ben', 78]]), 'Scores');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Region'], ['North']]), 'Regions');
  write('book.xlsx', XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));

  const deck = new PptxGen();
  const s1 = deck.addSlide();
  s1.addText('Launch Plan', { x: 1, y: 1, w: 8, h: 1, fontSize: 36, bold: true, color: 'C8391F' });
  s1.addShape(deck.ShapeType.rect, { x: 1, y: 2.5, w: 3, h: 1, fill: { color: '2A5BB0' } });
  s1.addImage({ data: `image/png;base64,${Buffer.from(scanImg).toString('base64')}`, x: 6, y: 2, w: 2, h: 2.8 });
  deck.addSlide().addText('Second slide body', { x: 1, y: 1, w: 8, h: 1, fontSize: 20 });
  write('deck.pptx', Buffer.from(await deck.write({ outputType: 'arraybuffer' })));

  // Chrome's print engine gives a real-world PDF: subset fonts, links, images, tagged structure.
  await page.setContent(`<h1>Real World Heading</h1><p>Paragraph with <a href="https://example.com">a link</a> and Unicode: café naïve Ωμέγα हिन्दी.</p>
    <table border="1"><tr><th>Name</th><th>Qty</th></tr><tr><td>Widget</td><td>42</td></tr></table>
    <img width="320" src="data:image/png;base64,${Buffer.from(scanImg).toString('base64')}"><div style="break-before:page">Second page text</div>`);
  write('real.pdf', await page.pdf({ format: 'A4', printBackground: true, tagged: true }));
  await page.goto(BASE);

  const book = new JSZip();
  book.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  book.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/c.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  book.file('OEBPS/c.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Sea Tales</dc:title><dc:creator>Asha Rao</dc:creator><dc:language>en</dc:language></metadata><manifest><item id="a" href="text/one.xhtml" media-type="application/xhtml+xml"/><item id="b" href="text/two.xhtml" media-type="application/xhtml+xml"/><item id="i" href="img/pic.png" media-type="image/png"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>');
  book.file('OEBPS/text/one.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title></head><body><h1>First Voyage</h1><p>Café words with <b>bold</b> and हिन्दी.</p><img src="../img/pic.png" alt="x"/></body></html>');
  book.file('OEBPS/text/two.xhtml', `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Two</title></head><body><h1>Second Voyage</h1>${'<p>The long tide turned over the harbour wall again. </p>'.repeat(400)}<p>Final line of the book.</p></body></html>`);
  book.file('OEBPS/img/pic.png', Uint8Array.from(scanImg));
  write('book.epub', await book.generateAsync({ type: 'nodebuffer' }));

  const locked = new JSZip();
  locked.file('META-INF/container.xml', '<container/>');
  locked.file('META-INF/encryption.xml', '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#"><EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/></EncryptedData></encryption>');
  write('drm.epub', await locked.generateAsync({ type: 'nodebuffer' }));

  const odt = new JSZip();
  odt.file('content.xml', '<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"><office:automatic-styles><style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style></office:automatic-styles><office:body><office:text><text:h text:outline-level="1">Open Heading</text:h><text:p>Plain <text:span text:style-name="T1">strong</text:span> text.</text:p><table:table><table:table-row><table:table-cell><text:p>OdtCell</text:p></table:table-cell></table:table-row></table:table></office:text></office:body></office:document-content>');
  write('doc.odt', await odt.generateAsync({ type: 'nodebuffer' }));

  write('doc.rtf', String.raw`{\rtf1\ansi{\fonttbl{\f0 Times;}}\f0 Hello {\b Bold} caf\'e9 \u2713?\par Second para\par}`);
  write('note.md', '# Big Title\n\nSome **strong** text.\n\n- item one\n- item two\n\n```\ncode line\n```\n');
  write('note.txt', 'Plain line one\nPlain line two\n');

  write('page.html', '<html><head><title>x</title><script>document.title="pwned"</script></head><body><h1 style="color:#c00">Web Heading</h1><p>Body paragraph with <b>bold</b> words.</p><img src="https://example.com/track.png"><div style="background:url(https://example.com/bg.png)">styled</div><style>@import "https://example.com/a.css";</style><link rel="stylesheet" href="https://example.com/b.css"></body></html>');
}

/* ---------- harness ---------- */

const server = spawn('node', ['scripts/serve.mjs', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 500));
const engine = process.env.BROWSER || 'chrome';
const browser = await ({ chrome: chromium, firefox, webkit }[engine]).launch(engine === 'chrome' ? { channel: 'chrome', headless: true } : { headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: [] });
const page = await context.newPage();

const external = [], problems = [];
page.on('request', (r) => { const u = new URL(r.url()); if (!['localhost'].includes(u.hostname) && !/^(data|blob):/.test(r.url())) external.push(r.url()); });
page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text()) ) problems.push(m.text()); });
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

await page.goto(BASE);
if (engine === 'chrome') await makeFixtures(page);

let passed = 0;
const failures = [];
async function test(id, fn) {
  if (only.length && !only.some((o) => id.includes(o))) return;
  const t0 = Date.now();
  try {
    await fn();
    passed++;
    console.log(`  ok   ${id} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    failures.push(id);
    console.log(`  FAIL ${id}: ${String(e.message).split('\n')[0]}`);
    await page.screenshot({ path: join(dir, `fail-${id}.png`) }).catch(() => {});
  }
}
const check = (ok, msg) => { if (!ok) throw new Error(msg); };

async function open(id, files) {
  await page.goto(`${BASE}#/${id}`);
  await page.reload();
  if (files) await page.setInputFiles('#file-input', files.map(fx));
}

const setField = async (key, value) => {
  const loc = page.locator(`#f-${key}`);
  if (typeof value === 'boolean') await loc.setChecked(value);
  else if ((await loc.evaluate((n) => n.tagName)) === 'SELECT') await loc.selectOption(value);
  else await loc.fill(String(value));
};

async function run(timeout = 60000) {
  await page.waitForFunction(() => !document.querySelector('#run')?.disabled);
  await page.evaluate(() => document.getElementById('results')?.remove());
  const done = page.waitForSelector('#results', { timeout });
  await page.click('#run');
  const toastFail = page.waitForFunction(() => document.getElementById('toast').classList.contains('show'), null, { timeout })
    .then(async () => { throw new Error(`toast: ${await page.textContent('#toast')}`); });
  await Promise.race([done, toastFail]);
  toastFail.catch(() => {});
  return page.evaluate(async () => Promise.all([...document.querySelectorAll('#results a.download')].map(async (a) => ({
    name: a.download, bytes: [...new Uint8Array(await (await fetch(a.href)).arrayBuffer())],
  }))));
}
const expectToast = async (text) => {
  await page.waitForFunction((t) => document.getElementById('toast').textContent.includes(t), text, { timeout: 15000 });
};
const save = (o) => { writeFileSync(join(dir, o.name), Uint8Array.from(o.bytes)); return o; };

// Drags on a page sheet using fractions of its size.
async function dragOn(index, from, to) {
  const sheet = page.locator(`.sheet[data-page="${index}"] .layer`);
  await sheet.scrollIntoViewIfNeeded();
  const b = await sheet.boundingBox();
  await page.mouse.move(b.x + b.width * from[0], b.y + b.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * to[0], b.y + b.height * to[1], { steps: 6 });
  await page.mouse.up();
}

const inkAt = async (bytes, pageNo, fx1, fy1) => {
  // Colour of one display point in an independent render, for checking placement on rotated pages.
  return page.evaluate(async ({ bytes, pageNo, fx1, fy1 }) => {
    const lib = await import('/vendor/pdfjs/pdf.min.mjs');
    lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
    const doc = await lib.getDocument({ data: Uint8Array.from(bytes) }).promise;
    const p = await doc.getPage(pageNo), vp = p.getViewport({ scale: 1 });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    await p.render({ canvas: c, viewport: vp }).promise;
    return [...c.getContext('2d').getImageData(vp.width * fx1, vp.height * fy1, 1, 1).data];
  }, { bytes, pageNo, fx1, fy1 });
};

const darkestAcross = (bytes, pageNo, fx1, fy1, reach) => page.evaluate(async ({ bytes, pageNo, fx1, fy1, reach }) => {
  const lib = await import('/vendor/pdfjs/pdf.min.mjs');
  lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
  const doc = await lib.getDocument({ data: Uint8Array.from(bytes) }).promise;
  const p = await doc.getPage(pageNo), vp = p.getViewport({ scale: 1 });
  const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
  await p.render({ canvas: c, viewport: vp }).promise;
  const x = Math.round(vp.width * fx1), y = Math.round(vp.height * fy1);
  const { data } = c.getContext('2d').getImageData(x, y - reach, 1, reach * 2 + 1);
  let low = 255;
  for (let i = 0; i < data.length; i += 4) low = Math.min(low, data[i]);
  return low;
}, { bytes, pageNo, fx1, fy1, reach });

/* ---------- tests ---------- */

console.log('Tools:');

await test('home', async () => {
  await page.goto(BASE);
  const n = await page.locator('.tool-card').count();
  check(n >= 44, `only ${n} tools listed`);
  await page.fill('#tool-search', 'water');
  check(await page.locator('.tool-card').count() === 1, 'search did not filter');
});

await test('merge', async () => {
  await open('merge', ['text.pdf', 'table.pdf']);
  await page.click('[aria-label="Move table.pdf up"]');
  const [o] = await run(); save(o);
  const { pages, count } = await pdfText(o.bytes);
  check(count === 6, `pages ${count}`);
  check(pages[0].includes('Quarterly'), 'reorder ignored');
});

await test('split-ranges', async () => {
  await open('split', ['text.pdf']);
  await setField('ranges', '1-2, 4-');
  const out = await run();
  check(out.length === 2, `files ${out.length}`);
  check((await pdfText(out[1].bytes)).count === 2, 'range 4- wrong');
});

await test('split-every', async () => {
  await open('split', ['text.pdf']);
  await setField('mode', 'all');
  const out = await run();
  check(out.length === 5, `files ${out.length}`);
  check(await page.locator('#zip-all').count() === 1, 'no zip button');
});

await test('split-bad-range', async () => {
  await open('split', ['text.pdf']);
  await setField('ranges', '9-12');
  await page.click('#run');
  await expectToast('outside this document');
});

await test('remove', async () => {
  await open('remove', ['text.pdf']);
  await page.waitForSelector('.page-card');
  await page.click('.page-card[data-page="1"]');
  const [o] = await run(); save(o);
  const { pages, count } = await pdfText(o.bytes);
  check(count === 4 && !pages.join().includes('marker 2'), 'page 2 still present');
});

await test('extract', async () => {
  await open('extract', ['text.pdf']);
  await page.waitForSelector('.page-card');
  await page.click('.page-card[data-page="3"]');
  const [o] = await run();
  const { pages, count } = await pdfText(o.bytes);
  check(count === 1 && pages[0].includes('marker 4'), 'wrong page');
});

await test('organize', async () => {
  await open('organize', ['text.pdf']);
  await page.waitForSelector('.page-card');
  await page.click('.page-card[data-page="0"] .move-next');
  await page.click('.page-card[data-page="4"] .delete-page');
  await page.click('.page-card[data-page="1"] .turn-right');
  await page.click('#add-blank');
  const [o] = await run(); save(o);
  const { pages, count, doc } = await pdfText(o.bytes);
  check(count === 5, `count ${count}`);
  check(pages[0].includes('marker 2') && pages[1].includes('marker 1'), 'order wrong');
  check((await doc.getPage(1)).rotate === 90, 'rotation lost');
  check(!pages[4].trim(), 'blank missing');
});

await test('rotate', async () => {
  await open('rotate', ['text.pdf']);
  await page.waitForSelector('.page-card');
  await page.click('#rotate-all');
  const [o] = await run();
  const { doc } = await pdfText(o.bytes);
  check((await doc.getPage(1)).rotate === 90 && (await doc.getPage(3)).rotate === 180, 'rotation wrong');
});

await test('crop', async () => {
  await open('crop', ['text.pdf']);
  await page.waitForSelector('.item-crop');
  const [o] = await run(); save(o);
  const { doc } = await pdfText(o.bytes);
  const v = (await doc.getPage(1)).getViewport({ scale: 1 });
  check(Math.abs(v.width - 595 * 0.84) < 2, `width ${v.width}`);
});

await test('watermark', async () => {
  await open('watermark', ['text.pdf']);
  await setField('text', 'DRAFT COPY');
  const [o] = await run(); save(o);
  check((await pdfText(o.bytes)).pages.every((p) => p.includes('DRAFT COPY')), 'missing');
});

await test('watermark-unicode', async () => {
  await open('watermark', ['text.pdf']);
  await setField('text', 'गोपनीय 机密');
  await setField('pages', '1');
  await setField('turn', 0);
  await setField('opacity', 100);
  const [o] = await run(); save(o);
  const px = await inkAt(o.bytes, 1, 0.5, 0.5);
  check(px[3] === 255, 'not rendered');
  const before = await inkAt([...(await import('node:fs')).readFileSync(fx('text.pdf'))], 1, 0.5, 0.5);
  check((await pdfText(o.bytes)).count === 5 && before.length === 4, 'bad output');
});

await test('numbers', async () => {
  await open('numbers', ['text.pdf']);
  await setField('format', 'Page {n} of {total}');
  await setField('skip', true);
  const [o] = await run(); save(o);
  const { pages } = await pdfText(o.bytes);
  check(!pages[0].includes('Page 1 of') && pages[1].includes('Page 1 of 4') && pages[4].includes('Page 4 of 4'), pages[1]);
});

await test('edit', async () => {
  await open('edit', ['text.pdf']);
  await page.waitForSelector('.sheet canvas');
  const b = await page.locator('.sheet[data-page="0"] .layer').boundingBox();
  await page.mouse.click(b.x + b.width * 0.2, b.y + b.height * 0.5);
  await page.keyboard.type('Typed by test');
  await page.click('[data-tool="highlight"]');
  await dragOn(0, [0.1, 0.1], [0.5, 0.2]);
  await page.click('[data-tool="ink"]');
  await dragOn(0, [0.2, 0.7], [0.6, 0.8]);
  const [o] = await run(); save(o);
  check((await pdfText(o.bytes)).pages[0].includes('Typed by test'), 'text missing');
});

await test('edit-rotated-page', async () => {
  // Page 3 has /Rotate 90; a white-out must land where the user drew it.
  await open('edit', ['text.pdf']);
  await page.waitForSelector('.sheet[data-page="2"]');
  await page.locator('.sheet[data-page="2"]').scrollIntoViewIfNeeded();
  await page.waitForSelector('.sheet[data-page="2"] canvas');
  await page.click('[data-tool="box"]');
  await page.fill('.editor-bar input[type=number]', '14');
  await dragOn(2, [0.2, 0.2], [0.6, 0.6]);
  const [o] = await run(); save(o);
  // Lines are thin and anti-aliased, so scan every pixel across the drawn edge.
  const edge = await darkestAcross(o.bytes, 3, 0.4, 0.2, 8);
  const away = await inkAt(o.bytes, 3, 0.9, 0.9);
  check(edge < 170, `box not at drawn position ${edge}`);
  check(away[0] > 240, 'box in wrong place');
});

await test('sign', async () => {
  await open('sign', ['text.pdf']);
  await page.waitForSelector('.sheet canvas');
  await page.click('#new-signature');
  await page.fill('#typed-signature', 'Asha Rao');
  await page.click('dialog button[type=submit]');
  await page.waitForFunction(() => document.querySelector('[data-armed]'));
  const b = await page.locator('.sheet[data-page="0"] .layer').boundingBox();
  await page.mouse.click(b.x + b.width * 0.5, b.y + b.height * 0.5);
  await page.click('#sign-all');
  check(await page.locator('.item-image').count() === 5, 'not repeated');
  const [o] = await run(); save(o);
  const full = await PDFDocument.load(Uint8Array.from(o.bytes));
  check(full.getPageCount() === 5, 'pages');
  const dark = await inkAt(o.bytes, 1, 0.5, 0.5);
  check(dark[3] === 255, 'no render');
});

await test('redact', async () => {
  await open('redact', ['text.pdf']);
  await page.waitForSelector('.sheet canvas');
  await page.fill('.editor-bar input[type=search]', 'SECRET-4471');
  await page.click('#find-redact');
  await page.waitForFunction(() => document.querySelectorAll('.item-redact').length === 5);
  await page.locator('.sheet[data-page="0"]').scrollIntoViewIfNeeded();
  await dragOn(0, [0.05, 0.05], [0.9, 0.12]);
  const [o] = await run(); save(o);
  const { pages } = await pdfText(o.bytes);
  check(!pages.join().includes('SECRET'), 'redacted text still extractable');
  const raw = Buffer.from(o.bytes).toString('latin1');
  check(!raw.includes('SECRET') && !raw.includes('Fixture Author'), 'bytes still contain secret');
});

await test('compare', async () => {
  await open('compare', ['text.pdf', 'text-v2.pdf']);
  save((await run())[0]);
  const t = await page.textContent('#results');
  check(t.includes('Changes on 1 of 5') && t.includes('Inserted'), t.slice(0, 200));
});

await test('compress', async () => {
  await open('compress', ['heavy.pdf']);
  const original = (await import('node:fs')).readFileSync(fx('heavy.pdf')).length;
  const [o] = await run(); save(o);
  check(o.bytes.length < original * 0.7, `${original} -> ${o.bytes.length}`);
  check((await pdfText(o.bytes)).pages[0].includes('Selectable caption'), 'text lost');
  const px = await inkAt(o.bytes, 1, 0.5, 0.5);
  check(px[0] + px[1] + px[2] > 30, 'image gone');
});

await test('compress-textonly', async () => {
  await open('compress', ['text.pdf']);
  const [o] = await run();
  check((await pdfText(o.bytes)).pages[0].includes('marker 1'), 'text lost');
});

await test('repair', async () => {
  await open('repair', ['broken.pdf']);
  const [o] = await run(); save(o);
  check((await pdfText(o.bytes)).count === 5, 'pages not recovered');
});

await test('ocr', async () => {
  await open('ocr', ['scan.pdf']);
  const [o] = await run(180000); save(o);
  const { pages } = await pdfText(o.bytes);
  check(/Invoice/.test(pages[0]) && /88213/.test(pages[0]), `read: ${pages[0].slice(0, 120)}`);
  const px = await inkAt(o.bytes, 1, 0.5, 0.95);
  check(px[0] > 200, 'page image missing');
});

await test('ocr-two-languages', async () => {
  await open('ocr', ['scan.pdf']);
  await setField('lang', 'eng+hin');
  await setField('dpi', '150');
  const [o] = await run(180000);
  check(/Invoice/.test((await pdfText(o.bytes)).pages[0]), 'eng+hin failed');
});

for (const lang of ['spa', 'fra', 'deu']) {
  await test(`ocr-data-${lang}`, async () => {
    const res = await page.request.get(`${BASE}vendor/tesseract/lang/${lang}.traineddata.gz`);
    check(res.ok() && (await res.body()).length > 1e6, 'language data missing');
  });
}

await test('real-merge', async () => {
  await open('merge', ['real.pdf', 'text.pdf']);
  const [o] = await run();
  const { pages, count } = await pdfText(o.bytes);
  check(count === 7 && pages[0].includes('Real World'), `${count}`);
  check(pages[1].includes('Second page'), 'page 2');
});

await test('real-compress', async () => {
  await open('compress', ['real.pdf']);
  const [o] = await run();
  check((await pdfText(o.bytes)).pages[0].includes('Real World'), 'text lost');
});

await test('real-watermark', async () => {
  await open('watermark', ['real.pdf']);
  const [o] = await run();
  const { pages } = await pdfText(o.bytes);
  check(pages[0].includes('Real World') && pages[0].includes('CONFIDENTIAL'), pages[0].slice(0, 100));
});

await test('real-to-word', async () => {
  await open('pdf-to-word', ['real.pdf']);
  const [o] = await run();
  const zip = await JSZip.loadAsync(Uint8Array.from(o.bytes));
  const xml = await zip.file('word/document.xml').async('text');
  check(xml.includes('Real World Heading') && xml.includes('Widget') && xml.includes('Second page'), 'content missing');
  check(Object.keys(zip.files).some((f) => f.startsWith('word/media/')), 'image dropped');
});

await test('real-repair-and-redact', async () => {
  await open('redact', ['real.pdf']);
  await page.waitForSelector('.sheet canvas');
  await page.fill('.editor-bar input[type=search]', 'Widget');
  await page.click('#find-redact');
  await page.waitForFunction(() => document.querySelectorAll('.item-redact').length >= 1);
  const [o] = await run();
  check(!(await pdfText(o.bytes)).pages.join().includes('Widget'), 'still extractable');
});

const pdfOf = async (id, file, opts) => {
  await open(id, [file]);
  if (opts) for (const [k, v] of Object.entries(opts)) await setField(k, v);
  return (await run())[0];
};
const textOfZip = async (bytes, match) => {
  const zip = await JSZip.loadAsync(Uint8Array.from(bytes));
  const parts = await Promise.all(Object.keys(zip.files).filter((n) => match.test(n)).map((n) => zip.file(n).async('text')));
  return { zip, text: parts.join('\n') };
};

await test('epub-to-pdf', async () => {
  const o = save(await pdfOf('epub-to-pdf', 'book.epub'));
  const { pages, count } = await pdfText(o.bytes);
  const all = pages.join(' ');
  check(count >= 3 && pages[0].includes('First') && all.includes('Second') && all.includes('Final line'), `${count} pages`);
  check(all.includes('Café'), 'accent lost');
});

await test('epub-drm-refused', async () => {
  await open('epub-to-pdf', ['drm.epub']);
  await page.click('#run');
  await expectToast('DRM-protected');
});

let azw;
await test('epub-to-azw3', async () => {
  const o = save(await pdfOf('epub-to-azw3', 'book.epub'));
  azw = o;
  writeFileSync(fx('made.azw3'), Uint8Array.from(o.bytes));
  check(Buffer.from(o.bytes.slice(60, 68)).toString() === 'BOOKMOBI', 'bad magic');
});

await test('azw3-to-epub-roundtrip', async () => {
  if (!azw) throw new Error('needs epub-to-azw3');
  const o = save(await pdfOf('azw3-to-epub', 'made.azw3'));
  o.name = 'roundtrip.epub';
  const { zip, text } = await textOfZip(o.bytes, /\.(xhtml|opf)$/);
  check(zip.file('mimetype') && Object.keys(zip.files)[0] === 'mimetype', 'mimetype not first');
  check(text.includes('Sea Tales') && text.includes('Asha Rao'), 'metadata lost');
  check(text.includes('First Voyage') && text.includes('Café') && text.includes('Final line of the book'), 'text lost');
  check(text.includes('हिन्दी'), 'unicode lost');
  check(Object.keys(zip.files).some((f) => /images\/img1\.png/.test(f)), 'image lost');
});

await test('azw3-to-pdf', async () => {
  if (!azw) throw new Error('needs epub-to-azw3');
  const o = await pdfOf('azw3-to-pdf', 'made.azw3');
  check((await pdfText(o.bytes)).pages.join(' ').includes('Final line'), 'text lost');
});

await test('azw3-rejects-other-files', async () => {
  await open('azw3-to-pdf', ['note.txt']);
  await page.click('#run');
  await expectToast('does not look like');
});

await test('pdf-to-epub', async () => {
  const o = save(await pdfOf('pdf-to-epub', 'table.pdf'));
  const { text } = await textOfZip(o.bytes, /chapter\d+\.xhtml$/);
  check(text.includes('Quarterly Report') && text.includes('<table') && text.includes('Plums'), 'content missing');
  const bad = await page.evaluate((t) => new DOMParser().parseFromString(t, 'application/xml').querySelector('parsererror')?.textContent, text.split('\n<?xml')[0]);
  check(!bad, `invalid XHTML: ${bad}`);
});

await test('pdf-to-azw3', async () => {
  const o = save(await pdfOf('pdf-to-azw3', 'heavy.pdf'));
  writeFileSync(fx('fromPdf.azw3'), Uint8Array.from(o.bytes));
  const back = await pdfOf('azw3-to-epub', 'fromPdf.azw3');
  const { zip, text } = await textOfZip(back.bytes, /\.xhtml$/);
  check(text.includes('Selectable caption'), 'text lost');
  check(Object.keys(zip.files).some((f) => f.includes('images/')), 'image lost');
});

await test('pdf-to-text', async () => {
  const o = save(await pdfOf('pdf-to-text', 'text.pdf'));
  const t = Buffer.from(o.bytes).toString();
  check(t.includes('Page marker 1') && t.includes('Page marker 5'), t.slice(0, 80));
});

await test('pdf-to-markdown', async () => {
  const o = save(await pdfOf('pdf-to-markdown', 'table.pdf'));
  const t = Buffer.from(o.bytes).toString();
  check(/^#+ Quarterly Report/m.test(t) && t.includes('| Plums | 1,300 | 0.80 |'), t);
});

await test('pdf-to-html', async () => {
  const o = save(await pdfOf('pdf-to-html', 'heavy.pdf'));
  const t = Buffer.from(o.bytes).toString();
  check(t.includes('Selectable caption') && t.includes('src="data:image/'), 'html incomplete');
});

await test('pdf-to-csv', async () => {
  const o = save(await pdfOf('pdf-to-csv', 'table.pdf'));
  const t = Buffer.from(o.bytes).toString();
  check(t.includes('Plums,1300,0.8'), t);
});

await test('markdown-to-pdf', async () => {
  const o = await pdfOf('markdown-to-pdf', 'note.md');
  const { pages } = await pdfText(o.bytes);
  check(pages[0].includes('Title') && pages[0].includes('strong') && pages[0].includes('item') && pages[0].includes('code'), pages[0]);
});

await test('text-to-pdf', async () => {
  const o = await pdfOf('text-to-pdf', 'note.txt');
  check((await pdfText(o.bytes)).pages[0].includes('line two'), 'text missing');
});

await test('odt-to-pdf', async () => {
  const o = await pdfOf('odt-to-pdf', 'doc.odt');
  const p = (await pdfText(o.bytes)).pages[0];
  check(p.includes('Open') && p.includes('strong') && p.includes('OdtCell'), p);
});

await test('rtf-to-pdf', async () => {
  const o = await pdfOf('rtf-to-pdf', 'doc.rtf');
  const p = (await pdfText(o.bytes)).pages[0];
  check(p.includes('Hello') && p.includes('Bold') && p.includes('café') && p.includes('Second') && !p.includes('Times'), p);
});

await test('multi-edit', async () => {
  await open('edit', ['text.pdf', 'table.pdf']);
  await page.waitForSelector('.doc-tab');
  check(await page.locator('.doc-tab').count() === 2, 'no tabs');
  await page.waitForSelector('.sheet canvas');
  const click = async () => {
    const b = await page.locator('.sheet:visible').first().locator('.layer').boundingBox();
    await page.mouse.click(b.x + b.width * 0.2, b.y + b.height * 0.5);
  };
  await click();
  await page.keyboard.type('Edit in first');
  await page.click('[data-doc="1"]');
  await page.waitForFunction(() => [...document.querySelectorAll('.sheet canvas')].some((c) => c.offsetParent));
  await page.locator('button[data-tool="text"]:visible').click();
  await click();
  await page.keyboard.type('Edit in second');
  const out = await run();
  check(out.length === 2, `files ${out.length}`);
  check((await pdfText(out[0].bytes)).pages[0].includes('Edit in first'), 'first lost');
  check((await pdfText(out[1].bytes)).pages[0].includes('Edit in second'), 'second lost');
  check(!(await pdfText(out[1].bytes)).pages[0].includes('Edit in first'), 'edits leaked between documents');
});

await test('multi-sign-shares-signature', async () => {
  await open('sign', ['text.pdf', 'table.pdf']);
  await page.waitForSelector('.sheet canvas');
  await page.locator('#new-signature:visible').click();
  await page.fill('#typed-signature', 'Asha Rao');
  await page.click('dialog button[type=submit]');
  await page.waitForFunction(() => document.querySelector('[data-armed]'));
  const place = async () => {
    const b = await page.locator('.sheet:visible').first().locator('.layer').boundingBox();
    await page.mouse.click(b.x + b.width * 0.5, b.y + b.height * 0.5);
  };
  await place();
  await page.click('[data-doc="1"]');
  await page.waitForFunction(() => [...document.querySelectorAll('.sheet canvas')].some((c) => c.offsetParent));
  await place();
  check(await page.locator('.item-image').count() === 2, 'signature not reused');
  const out = await run();
  check(out.length === 2, `files ${out.length}`);
});

await test('multi-redact', async () => {
  await open('redact', ['text.pdf', 'real.pdf']);
  await page.waitForSelector('.sheet canvas');
  await page.locator('.editor-bar input[type=search]:visible').fill('SECRET-4471');
  await page.locator('#find-redact:visible').click();
  await page.waitForFunction(() => document.querySelectorAll('.item-redact').length === 5);
  await page.click('[data-doc="1"]');
  await page.waitForFunction(() => [...document.querySelectorAll('.sheet canvas')].some((c) => c.offsetParent));
  await page.locator('.editor-bar input[type=search]:visible').fill('Widget');
  await page.locator('#find-redact:visible').click();
  await page.waitForFunction(() => document.querySelectorAll('.item-redact').length >= 6);
  const out = await run();
  check(out.length === 2, `files ${out.length}`);
  check(!(await pdfText(out[0].bytes)).pages.join().includes('SECRET'), 'first not redacted');
  check(!(await pdfText(out[1].bytes)).pages.join().includes('Widget'), 'second not redacted');
});

await test('batch-watermark', async () => {
  await open('watermark', ['text.pdf', 'table.pdf']);
  await setField('text', 'BATCHED');
  const out = await run();
  check(out.length === 2, `files ${out.length}`);
  for (const o of out) check((await pdfText(o.bytes)).pages[0].includes('BATCHED'), `${o.name} missing`);
  check(await page.locator('#zip-all').count() === 1, 'no zip');
});

await test('batch-compress-report', async () => {
  await open('compress', ['heavy.pdf', 'text.pdf']);
  const out = await run();
  check(out.length === 2 && (await page.textContent('#results')).includes('heavy.pdf'), 'batch summary missing');
});

await test('pdfa', async () => {
  await open('pdfa', ['text.pdf']);
  const [o] = await run(); save(o);
  const raw = Buffer.from(o.bytes).toString('latin1');
  check(raw.includes('pdfaid:part') && raw.includes('GTS_PDFA1') && /\/ID\s*\[/.test(raw), 'PDF/A markers missing');
  check((await pdfText(o.bytes)).count === 5, 'pages');
});

let encrypted;
await test('protect', async () => {
  await open('protect', ['text.pdf']);
  await setField('password', 'hunter22');
  await setField('confirm', 'hunter22');
  const [o] = await run(); save(o);
  encrypted = o;
  writeFileSync(fx('locked.pdf'), Uint8Array.from(o.bytes));
  let refused = false;
  try { await openPdf(o.bytes); } catch (e) { refused = e.name === 'PasswordException'; }
  check(refused, 'opened without password');
  check(!Buffer.from(o.bytes).toString('latin1').includes('Page marker'), 'content not encrypted');
  check(/\/V 5/.test(Buffer.from(o.bytes).toString('latin1')), 'not AES-256');
  check((await pdfText(o.bytes, 'hunter22')).count === 5, 'correct password failed');
});

await test('protect-restricted', async () => {
  await open('protect', ['text.pdf']);
  await setField('password', 'open-me');
  await setField('confirm', 'open-me');
  await setField('print', false);
  await setField('copy', false);
  await setField('modify', false);
  const [o] = await run();
  const { doc } = await pdfText(o.bytes, 'open-me');
  const perms = await doc.getPermissions();
  check(perms instanceof Set && !perms.has(pdfjs.PermissionFlag.PRINT) && !perms.has(pdfjs.PermissionFlag.COPY) && !perms.has(pdfjs.PermissionFlag.MODIFY_CONTENTS), `perms ${[...perms]}`);
});

await test('protect-unicode-password', async () => {
  await open('protect', ['text.pdf']);
  await setField('password', 'pässwörd-गुप्त');
  await setField('confirm', 'pässwörd-गुप्त');
  const [o] = await run();
  check((await pdfText(o.bytes, 'pässwörd-गुप्त')).count === 5, 'unicode password failed');
});

await test('protect-mismatch', async () => {
  await open('protect', ['text.pdf']);
  await setField('password', 'a');
  await setField('confirm', 'b');
  await page.click('#run');
  await expectToast('do not match');
});

await test('unlock', async () => {
  if (!encrypted) throw new Error('needs protect');
  await open('unlock', ['locked.pdf']);
  await setField('password', 'hunter22');
  const [o] = await run();
  check((await pdfText(o.bytes)).pages[0].includes('marker 1'), 'still locked');
});

await test('unlock-wrong', async () => {
  await open('unlock', ['locked.pdf']);
  await setField('password', 'nope');
  await page.click('#run');
  await expectToast('Wrong password');
});

await test('password-prompt-any-tool', async () => {
  if (!encrypted) throw new Error('needs protect');
  await open('split', ['locked.pdf']);
  await setField('mode', 'all');
  await page.click('#run');
  await page.fill('#pdf-password', 'wrong');
  await page.click('dialog button[type=submit]');
  await page.waitForFunction(() => document.querySelector('dialog h2')?.textContent.includes('wrong'));
  await page.fill('#pdf-password', 'hunter22');
  await page.click('dialog button[type=submit]');
  await page.waitForSelector('#results');
  check(await page.locator('#results a.download').count() === 5, 'split failed');
});

await test('metadata', async () => {
  await open('metadata', ['text.pdf']);
  await page.waitForFunction(() => document.querySelector('#f-title').value === 'Original title');
  await setField('title', 'New Title');
  const [o] = await run();
  const d = await PDFDocument.load(Uint8Array.from(o.bytes), { updateMetadata: false });
  check(d.getTitle() === 'New Title' && d.getAuthor() === 'Fixture Author', d.getTitle());
});

await test('metadata-wipe', async () => {
  await open('metadata', ['text.pdf']);
  await setField('wipe', true);
  const [o] = await run();
  const raw = Buffer.from(o.bytes).toString('latin1');
  check(!raw.includes('Fixture Author'), 'author still in file');
  check((await pdfText(o.bytes)).count === 5, 'broken file');
});

await test('pdf-to-word', async () => {
  await open('pdf-to-word', ['table.pdf']);
  const [o] = await run(); save(o);
  const zip = await JSZip.loadAsync(Uint8Array.from(o.bytes));
  const xml = await zip.file('word/document.xml').async('text');
  check(xml.includes('Quarterly Report') && xml.includes('Heading') && xml.includes('<w:tbl>') && xml.includes('Plums'), 'structure missing');
});

await test('pdf-to-word-images', async () => {
  await open('pdf-to-word', ['heavy.pdf']);
  const [o] = await run();
  const zip = await JSZip.loadAsync(Uint8Array.from(o.bytes));
  check(Object.keys(zip.files).some((f) => f.startsWith('word/media/')), 'image dropped');
});

await test('pdf-to-ppt', async () => {
  await open('pdf-to-ppt', ['heavy.pdf']);
  const [o] = await run(); save(o);
  const zip = await JSZip.loadAsync(Uint8Array.from(o.bytes));
  const xml = await zip.file('ppt/slides/slide1.xml').async('text');
  check(xml.includes('Selectable caption') && Object.keys(zip.files).some((f) => f.startsWith('ppt/media/')), 'slide content missing');
});

await test('pdf-to-excel', async () => {
  await open('pdf-to-excel', ['table.pdf']);
  const [o] = await run(); save(o);
  const wb = XLSX.read(Uint8Array.from(o.bytes), { type: 'array' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['Page 1'], { header: 1 }).map((r) => r.filter((c) => c != null));
  const plums = rows.find((r) => r[0] === 'Plums');
  check(plums?.[1] === 1300 && plums?.[2] === 0.8, JSON.stringify(rows));
});

await test('pdf-to-jpg', async () => {
  await open('pdf-to-jpg', ['text.pdf']);
  const out = await run();
  check(out.length === 5 && out[0].bytes[0] === 0xff, 'not JPEG');
});

await test('pdf-to-jpg-images', async () => {
  await open('pdf-to-jpg', ['heavy.pdf']);
  await setField('mode', 'images');
  await setField('format', 'png');
  const out = await run();
  check(out.length === 1 && out[0].bytes[0] === 0x89, `got ${out.length}`);
});

await test('jpg-to-pdf', async () => {
  await open('jpg-to-pdf', ['photo.jpg', 'scan.png']);
  const [o] = await run(); save(o);
  const { doc, count } = await pdfText(o.bytes);
  check(count === 2, 'pages');
  const v = (await doc.getPage(1)).getViewport({ scale: 1 });
  check(v.width > v.height, 'landscape photo not auto-rotated page');
});

await test('word-to-pdf', async () => {
  await open('word-to-pdf', ['doc.docx']);
  const [o] = await run(); save(o);
  const { pages, count } = await pdfText(o.bytes);
  check(count >= 2, `pages ${count}`);
  const all = pages.join(' ');
  check(all.includes('Project') && all.includes('Charter') && all.includes('CellOne'), 'text missing');
  check(all.includes('line 60'), 'content lost across pages');
});

await test('excel-to-pdf', async () => {
  await open('excel-to-pdf', ['book.xlsx']);
  const [o] = await run(); save(o);
  const { pages, count } = await pdfText(o.bytes);
  check(count === 2, `pages ${count}`);
  check(pages[0].includes('Asha') && pages[1].includes('North'), 'cells missing');
});

await test('ppt-to-pdf', async () => {
  await open('ppt-to-pdf', ['deck.pptx']);
  const [o] = await run(); save(o);
  const { pages, count, doc } = await pdfText(o.bytes);
  check(count === 2, `pages ${count}`);
  check(pages[0].includes('Launch') && pages[1].includes('Second'), pages.join('|'));
  const v = (await doc.getPage(1)).getViewport({ scale: 1 });
  check(v.width > v.height, 'not slide-shaped');
  const blue = await inkAt(o.bytes, 1, 0.2, 0.5);
  check(blue[2] > 130 && blue[0] < 90, `shape missing ${blue}`);
});

await test('html-to-pdf', async () => {
  await open('html-to-pdf', ['page.html']);
  const [o] = await run(); save(o);
  const { pages } = await pdfText(o.bytes);
  check(pages[0].includes('Web') && pages[0].includes('bold'), pages[0]);
});

await test('html-to-pdf-paste', async () => {
  await open('html-to-pdf');
  await setField('source', '<p>Pasted words</p>');
  const [o] = await run();
  check((await pdfText(o.bytes)).pages[0].includes('Pasted'), 'paste failed');
});

await test('scan', async () => {
  await open('scan', ['scan.png']);
  await page.waitForSelector('.page-card canvas');
  await setField('filter', 'bw');
  const [o] = await run(); save(o);
  check((await pdfText(o.bytes)).count === 1, 'no page');
});

await test('handoff', async () => {
  await open('merge', ['text.pdf', 'table.pdf']);
  await run();
  await page.selectOption('.next select', 'split');
  await page.click('.next button');
  await page.waitForSelector('#f-mode');
  await setField('mode', 'all');
  const out = await run();
  check(out.length === 6, `handoff produced ${out.length}`);
});

await test('offline-privacy', async () => {
  check(!external.length, `requests left the machine: ${external.join(' ')}`);
});

await test('works-offline', async () => {
  await page.goto(BASE);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  await open('merge', ['text.pdf', 'table.pdf']);
  await run();
  await context.setOffline(true);
  await open('merge', ['text.pdf', 'table.pdf']);
  const [o] = await run();
  await context.setOffline(false);
  check((await pdfText(o.bytes)).count === 6, 'merge failed offline');
});

console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? `: ${failures.join(', ')}` : ''}`);
if (problems.length) console.log(`Page problems:\n  ${[...new Set(problems)].slice(0, 12).join('\n  ')}`);
await browser.close();
server.kill();
process.exit(failures.length || problems.length ? 1 : 0);
