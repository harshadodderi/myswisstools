// Runs the app the way a phone does: real touch emulation, small screens, no mouse.
import { spawn } from 'node:child_process';
import { chromium, webkit, devices } from 'playwright';

const PORT = 8138, BASE = `http://localhost:${PORT}/`, F = 'tests/output/fixtures/';
const server = spawn('node', ['scripts/serve.mjs', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 500));
let passed = 0;
const failures = [];
const check = (ok, msg) => { if (!ok) throw new Error(msg); };

async function suite(label, launcher, device, launchOptions = {}) {
  const browser = await launcher.launch({ headless: true, ...launchOptions });
  const context = await browser.newContext(device);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const test = async (id, fn) => {
    try { await fn(); passed++; console.log(`  ok   ${label} ${id}`); } catch (e) {
      failures.push(`${label} ${id}`);
      console.log(`  FAIL ${label} ${id}: ${String(e.message).split('\n')[0]}`);
      await page.screenshot({ path: `tests/output/fail-mobile-${label}-${id}.png` }).catch(() => {});
    }
  };
  const go = async (hash, files) => {
    await page.goto(BASE + hash);
    await page.reload();
    if (files) await page.setInputFiles('#file-input', files.map((f) => F + f));
  };
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  const runIt = async (timeout = 90000) => {
    await page.waitForFunction(() => !document.querySelector('#run').disabled);
    await page.tap('#run');
    await page.waitForSelector('#results', { timeout });
    return page.locator('#results a.download').count();
  };

  console.log(`${label} (${page.viewportSize().width}×${page.viewportSize().height}, coarse pointer: ${await page.evaluate(() => matchMedia('(pointer: coarse)').matches)})`);
  await page.goto(BASE);

  await test('pill-by-touch', async () => {
    await page.tap('.space-pill a[data-space="img"]');
    await page.waitForFunction(() => document.querySelector('h1').textContent.includes('Image'));
    check(await page.locator('.tool-card').count() === 13, 'image tools missing');
    await page.tap('.space-pill a[data-space="pdf"]');
    await page.waitForFunction(() => document.querySelector('h1').textContent.includes('PDF'));
  });

  const ids = [];
  for (const hash of ['#/', '#/img']) {
    await page.goto(BASE + hash);
    await page.waitForSelector('.tool-card');
    ids.push(...await page.$$eval('.tool-card', (a) => a.map((n) => n.getAttribute('href'))));
    await test(`no-overflow-home-${hash}`, async () => check(await overflow() <= 0, `overflow ${await overflow()}`));
    await test(`tap-size-home-${hash}`, async () => {
      const small = await page.$$eval('.tool-card, .space-pill a, .source', (n) => n.filter((e) => e.getBoundingClientRect().height < 36).length);
      check(!small, `${small} targets under 36px`);
    });
  }

  await test('every-tool-fits', async () => {
    const bad = [];
    for (const href of ids) {
      await page.goto(BASE + href);
      await page.waitForSelector('.tool-title');
      if (await overflow() > 0) bad.push(href);
    }
    check(!bad.length, bad.join(' '));
  });

  const samples = (href) => {
    if (/merge|compare/.test(href)) return ['text.pdf', 'table.pdf'];
    if (/-image|photo-|blur-|meme-|remove-background|convert-/.test(href)) return ['small.jpg'];
    if (/-to-pdf|html|markdown-|text-to|scan/.test(href) && !/pdf-to/.test(href)) return null;
    return ['text.pdf'];
  };
  await test('open-tools-fit-and-action-reachable', async () => {
    const bad = [];
    for (const href of ids) {
      const files = samples(href);
      if (!files) continue;
      await go(href, files);
      try { await page.waitForFunction(() => { const r = document.querySelector('#run'); return r && !r.disabled; }, null, { timeout: 45000 }); } catch {
        bad.push(`${href} never ready: ${(await page.textContent('#toast')).slice(0, 60)}`);
        continue;
      }
      const box = await page.locator('#run').boundingBox();
      const vh = page.viewportSize().height;
      if (await overflow() > 0) bad.push(`${href} overflow`);
      if (!box || box.y < 0 || box.y + box.height > vh) bad.push(`${href} button off screen`);
      if (box && box.height < 44) bad.push(`${href} button short`);
    }
    check(!bad.length, bad.join(', '));
  });

  await test('compress-photo', async () => {
    await go('#/compress-image', ['small.jpg']);
    check(await runIt() === 1, 'no result');
    check(await overflow() <= 0, 'results overflow');
  });

  await test('merge-with-reorder', async () => {
    await go('#/merge', ['text.pdf', 'table.pdf']);
    await page.tap('[aria-label="Move table.pdf up"]');
    check((await page.textContent('.file-row')).includes('table.pdf'), 'reorder failed');
    await runIt();
  });

  await test('edit-tap-adds-text', async () => {
    await go('#/edit', ['text.pdf']);
    await page.waitForSelector('.sheet canvas');
    const b = await page.locator('.sheet[data-page="0"] .layer').boundingBox();
    await page.touchscreen.tap(b.x + b.width / 2, Math.min(b.y + 120, 600));
    await page.waitForSelector('.item-text');
    await page.keyboard.type('Phone');
    check((await page.textContent('.text-input')).includes('Phone'), 'typing failed');
    await runIt();
  });

  await test('sign-by-tap', async () => {
    await go('#/sign', ['text.pdf']);
    await page.waitForSelector('.sheet canvas');
    await page.locator('#new-signature').scrollIntoViewIfNeeded();
    await page.tap('#new-signature');
    await page.fill('#typed-signature', 'A Rao');
    await page.tap('dialog button[type=submit]');
    await page.waitForFunction(() => document.querySelector('[data-armed]'));
    const b = await page.locator('.sheet[data-page="0"] .layer').boundingBox();
    await page.touchscreen.tap(b.x + b.width / 2, Math.min(b.y + 140, 600));
    await page.waitForSelector('.item-image');
    await runIt();
  });

  await test('photo-editor-sticker', async () => {
    await go('#/photo-editor', ['small.jpg']);
    await page.waitForSelector('.sticker');
    await page.tap('.sticker');
    check(await page.locator('.box.overlay').count() === 1, 'no sticker');
    const box = await page.locator('.stage').boundingBox();
    check(box.height <= page.viewportSize().height * 0.5, `preview too tall ${box.height}`);
    await page.locator('#f-contrast').scrollIntoViewIfNeeded();
    const pinned = await page.locator('.stage').boundingBox();
    check(pinned.y >= 0 && pinned.y < page.viewportSize().height * 0.5, 'preview scrolled away while adjusting');
    await runIt();
  });

  await test('watermark-preview-stays-visible', async () => {
    await go('#/watermark-image', ['small.jpg']);
    await page.waitForSelector('.preview canvas');
    await page.locator('#f-position').scrollIntoViewIfNeeded();
    const b = await page.locator('.preview canvas').boundingBox();
    check(b.y >= 0 && b.y < page.viewportSize().height * 0.5, `preview gone ${b.y}`);
  });

  await test('heic-on-phone', async () => {
    await go('#/convert-to-jpg', ['small.heic']);
    await runIt();
  });

  await test('text-fields-do-not-zoom', async () => {
    await go('#/html-to-image');
    const small = await page.$$eval('input:not([type=checkbox]):not([type=range]):not([type=color]):not([type=file]), select, textarea', (n) => n.filter((e) => parseFloat(getComputedStyle(e).fontSize) < 16).length);
    check(!small, `${small} fields under 16px trigger iOS zoom`);
  });

  if (label.startsWith('android')) {
    const cdp = await context.newCDPSession(page);
    const swipe = (x, y, dist) => cdp.send('Input.synthesizeScrollGesture', { x, y, yDistance: -dist, gestureSourceType: 'touch', speed: 1600 });
    const drag = async (x1, y1, x2, y2) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x1, y: y1 }] });
      for (let i = 1; i <= 6; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x1 + ((x2 - x1) * i) / 6, y: y1 + ((y2 - y1) * i) / 6 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    await test('swipe-on-pdf-page-scrolls', async () => {
      await go('#/edit', ['text.pdf']);
      await page.waitForSelector('.sheet canvas');
      const b = await page.locator('.sheet[data-page="0"] .layer').boundingBox();
      const before = await page.evaluate(() => scrollY);
      await swipe(b.x + b.width / 2, Math.min(b.y + 150, 600), 300);
      await page.waitForTimeout(250);
      check(await page.evaluate(() => scrollY) > before + 100, 'page did not scroll');
      check(await page.locator('.item').count() === 0, 'swipe dropped text on the page');
    });
    await test('redact-scroll-then-mark', async () => {
      await go('#/redact', ['text.pdf']);
      await page.waitForSelector('.sheet canvas');
      const b = await page.locator('.sheet[data-page="0"] .layer').boundingBox();
      await swipe(b.x + b.width / 2, Math.min(b.y + 150, 600), 200);
      await page.waitForTimeout(250);
      check(await page.locator('.item-redact').count() === 0, 'swipe marked the page');
      await page.tap('button[data-tool="redact"]');
      const c = await page.locator('.sheet[data-page="0"] .layer').boundingBox();
      const y = Math.max(c.y + 30, 180);
      await drag(c.x + 40, y, c.x + 240, y + 70);
      await page.waitForTimeout(100);
      check(await page.locator('.item-redact').count() === 1, 'drag did not mark');
    });
    await test('crop-corner-by-touch', async () => {
      await go('#/crop-image', ['small.jpg']);
      await page.waitForSelector('.box.crop .grip-br');
      const g = await page.locator('.box.crop .grip-br').boundingBox();
      await drag(g.x + 8, g.y + 8, g.x - 60, g.y - 40);
      await page.waitForTimeout(100);
      check(+(await page.inputValue('#f-w')) < 640, 'touch resize ignored');
    });
    await test('pdf-thumbnail-page-swipe', async () => {
      await go('#/organize', ['text.pdf']);
      await page.waitForSelector('.page-card');
      const before = await page.evaluate(() => scrollY);
      await swipe(200, 500, 150);
      await page.waitForTimeout(250);
      check(await page.evaluate(() => scrollY) >= before, 'no scroll');
    });
  }
  await test('no-page-errors', async () => check(!errors.length, errors.slice(0, 2).join(' | ')));
  await browser.close();
}

await suite('android', chromium, devices['Pixel 7'], { channel: 'chrome' });
await suite('iphone', webkit, devices['iPhone 13']);
await suite('small-android', chromium, { ...devices['Galaxy S5'] }, { channel: 'chrome' });

console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? `:\n  ${failures.join('\n  ')}` : ''}`);
server.kill();
process.exit(failures.length ? 1 : 0);
