// Plays the web package in Chrome on the machine's GPU (~/games/tools/
// gpu-chrome.mjs; GPU_ADAPTER=software for headless SwiftShader), the loader
// index.html that `npm run package` writes: at a desktop viewport, a phone
// (390×844, DPR 3) and a phone held sideways (844×390, DPR 3). Desktop: the
// title's Practice, Start, a hint placed with H and Enter, a piece dragged
// from the 3D offer row onto the board with the mouse, Escape pauses and
// resumes. Phones: Practice / Learn by finger (CDP touch), a tray piece and a
// board cell (by its screen-reader name) tapped, the info drawer, Pause.
// Buttons are found through the engine's accessibility mirror (getByRole /
// getByText). Fails on console errors or warnings or the runtime's error
// screen; look at the screenshots (nothing cut off on the phones).
//   node tools/browser-play.mjs [GAME_DIR] [--shots OUT_DIR]
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const args = process.argv.slice(2);
const dir = resolve(args[0] && !args[0].startsWith('--') ? args[0] : '.');
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const shots = opt('--shots', null);

function findPlaywright() {
  const roots = [dir, resolve(dir, '..'), ...readdirSync(resolve(dir, '..')).map((d) => resolve(dir, '..', d))];
  for (const r of roots) {
    const p = join(r, 'node_modules', 'playwright-core');
    if (existsSync(p)) return createRequire(join(r, 'package.json'))('playwright-core');
  }
  throw new Error('playwright-core not found');
}
const { chromium } = findPlaywright();

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/plain',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.md': 'text/plain' };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '') || 'index.html';
  if (path === 'api/v1/time') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ serverTime: Date.now(), serverTimeIso: new Date().toISOString() })); return; }
  const parts = path.split('/');
  if (parts.some((p) => p.startsWith('.') || p === '..') || ['tests', 'tools', 'node_modules'].includes(parts[0])) { res.writeHead(404).end(); return; }
  const file = join(dir, path);
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const { launchChrome } = await import('/home/albert/games/tools/gpu-chrome.mjs');
const { browser, gpu, close } = await launchChrome(chromium);
console.log(`# chrome on ${gpu}`);
let failed = false;
const views = [
  { name: 'desktop', viewport: { width: 1366, height: 768 }, touch: false },
  { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, touch: true },
  { name: 'landscape', viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, touch: true },
];
for (const v of views) {
  const ctx = await browser.newContext({ viewport: v.viewport, isMobile: v.isMobile, hasTouch: v.hasTouch, deviceScaleFactor: v.deviceScaleFactor });
  const page = await ctx.newPage();
  const problems = [];
  const environment = /^No available adapters\.$|GL Driver Message/;
  page.on('console', (m) => {
    const platformRoute = /\/api\//.test(m.location()?.url ?? '');
    if ((m.type() === 'error' || m.type() === 'warning') && !environment.test(m.text()) && !platformRoute) problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400 && !/\/api\//.test(r.url())) problems.push(`http ${r.status()}: ${r.url()}`); });
  const shot = async (n) => { if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: join(shots, `${v.name}-${n}.png`) }); } };
  const cdp = await ctx.newCDPSession(page);
  const touch = async (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  const press = async (name) => {
    const el = page.getByRole('button', { name }).first();
    await el.waitFor({ timeout: 20000 });
    if (!v.touch) { await el.click(); return; }
    const b = await el.boundingBox();
    await touch('touchStart', b.x + b.width / 2, b.y + b.height / 2); await page.waitForTimeout(80); await touch('touchEnd');
  };
  const key = async (k) => { await page.keyboard.down(k); await page.waitForTimeout(100); await page.keyboard.up(k); await page.waitForTimeout(500); };
  const tapAt = async (x, y) => { await touch('touchStart', x, y); await page.waitForTimeout(80); await touch('touchEnd'); };
  const tapText = async (text) => {
    const el = page.getByRole('button', { name: text, exact: true }).first();
    await el.waitFor({ timeout: 20000 });
    const b = await el.boundingBox();
    if (v.touch) await tapAt(b.x + b.width / 2, b.y + b.height / 2);
    else await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  };
  let ok = true;
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 120000 });
    const started = await page.waitForFunction(() => ['running', 'error'].includes(document.documentElement.dataset.starhermit), null, { timeout: 90000 }).then(() => true, () => false);
    if (!started) throw new Error('did not start');
    await page.waitForTimeout(4000);
    await shot('title');
    const w = v.viewport.width, h = v.viewport.height;
    if (v.name === 'landscape') {
      await press(/^Learn to Play$/); await page.waitForTimeout(3000); await shot('learn');
      await press(/^Select Twin Column, slot 1$/); await page.waitForTimeout(500);
      await tapText('Row 1 column 1, empty'); await page.waitForTimeout(1500); await shot('learn-2');
      await page.getByRole('button', { name: 'Row 1 column 1, occupied', exact: true }).first().waitFor({ timeout: 10000 });
    } else {
      await press(/^Practice$/); await page.waitForTimeout(1500); await shot('setup');
      await press(/^Start$/); await page.waitForTimeout(3500); await shot('game');
      if (!v.touch) {
        // drag the first 3D offer piece onto the middle of the board
        const pf = { x: 246, w: w - 492 };
        await page.mouse.move(pf.x + pf.w * 0.233, h * 0.706); await page.mouse.down();
        for (let i = 1; i <= 10; i++) { await page.mouse.move(pf.x + pf.w * (0.233 + 0.267 * i / 10), h * (0.706 - 0.406 * i / 10)); await page.waitForTimeout(30); }
        await page.mouse.up(); await page.waitForTimeout(1200); await shot('dragged');
        await page.getByRole('button', { name: /occupied$/ }).first().waitFor({ timeout: 10000 });
        await key('KeyH'); await key('Enter'); await page.waitForTimeout(800); await shot('hinted');
        await key('Escape'); await page.waitForTimeout(800); await shot('paused'); await key('Escape'); await page.waitForTimeout(800);
      } else {
        await press(/^Select .*slot 1$/); await page.waitForTimeout(500);
        await tapText('Row 5 column 5, empty'); await page.waitForTimeout(1500); await shot('placed');
        await page.getByRole('button', { name: /occupied$/ }).first().waitFor({ timeout: 10000 });
        await press(/^Open info panel$/); await page.waitForTimeout(1000); await shot('drawer'); await press(/^Open info panel$/); await page.waitForTimeout(500);
        await press(/^Pause$/); await page.waitForTimeout(800); await shot('paused'); await press(/^Resume$/); await page.waitForTimeout(800);
      }
      await page.getByRole('button', { name: /occupied$/ }).first().waitFor({ timeout: 10000 });
    }
    await shot('end');
  } catch (e) { ok = false; problems.push(`step: ${e.message.split('\n')[0]}`); }
  const state = await page.evaluate(() => document.documentElement.dataset.starhermit ?? '').catch(() => '');
  ok = ok && state === 'running' && problems.length === 0;
  failed ||= !ok;
  console.log(`${ok ? 'ok' : 'not ok'} - ${v.name} played: state=${state || '-'}`);
  for (const p of problems) console.log(`  ${p}`);
  await ctx.close();
}
await close();
server.close();
process.exit(failed ? 1 : 0);
