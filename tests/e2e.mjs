/**
 * Prism Parcel — end-to-end playthrough (dev only, not shipped).
 *
 * Drives the real visible UI in headless Chrome (playwright-core + system
 * Chrome): title → settings → journey stage 1 → play a full round via the
 * on-screen Hint button + keyboard placement → results → practice round with
 * pause/resume/undo → help overlay. Runs twice: desktop 1280x800 and a fresh
 * mobile context at 390x844 with touch.
 *
 * The repo's server.js is the StarHermit authoritative game server (writes to
 * data/), so this test embeds its own minimal static file server on an
 * ephemeral port. The game is fully playable offline; the platform adapter
 * treats the missing /api routes as "offline mode", which produces one benign
 * console resource error for /api/v1/time that is filtered out explicitly.
 *
 * Gameplay is keyboard-driven (documented on-screen controls): the visible
 * Hint button selects a legal placement and moves the cursor there, then
 * Enter places the piece. No internal game APIs are used for actions.
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2', '.ts': 'video/mp2t'
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    if (!path || path.endsWith('/')) path = join(path, 'index.html');
    const file = join(ROOT, path);
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(body);
  } catch (e) {
    res.writeHead(404); res.end('not found');
  }
});

const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions/i;

const errors = [];
function watchPage(page) {
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (browserNoise.test(text)) return;
    // Offline mode by design: the static test server has no /api routes.
    if (text.includes('Failed to load resource') && (m.location()?.url || '').includes('/api/')) return;
    errors.push(`console: ${text}`);
  });
}

const shot = (stage, vp) => `/tmp/prism-parcel-e2e-${stage}-${vp}.png`;
const step = async (name, fn) => { await fn(); console.log(`ok - ${name}`); };

async function placeViaHint(page) {
  await page.click('#btn-hint');
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('Enter');
}

async function playUntilResults(page, maxMoves = 300) {
  for (let i = 0; i < maxMoves; i++) {
    if (await page.locator('#results-screen:not([hidden])').count()) return i;
    if (await page.locator('#btn-hint').isDisabled()) {
      // Round just ended; the results screen appears after a short settle delay.
      await page.waitForSelector('#results-screen:not([hidden])', { timeout: 5000 });
      return i;
    }
    await placeViaHint(page);
    await page.waitForTimeout(90);
  }
  await page.waitForSelector('#results-screen:not([hidden])', { timeout: 5000 });
  return maxMoves;
}

async function runPass(vpName, viewport, hasTouch, baseURL) {
  const browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  });
  try {
    const context = await browser.newContext({ viewport, hasTouch });
    const page = await context.newPage();
    watchPage(page);

    await step(`${vpName}: load + title visible`, async () => {
      await page.goto(baseURL, { waitUntil: 'load' });
      await page.waitForSelector('#title-screen:not([hidden])', { timeout: 15000 });
      await page.waitForSelector('#btn-play');
      await page.screenshot({ path: shot('title', vpName) });
    });

    await step(`${vpName}: settings open/apply/close`, async () => {
      await page.click('#btn-settings');
      await page.waitForSelector('#settings-overlay:not([hidden])');
      const hc = page.locator('#settings-body label', { hasText: 'High contrast' }).locator('input');
      await hc.check();
      const applied = await page.evaluate(() => document.body.classList.contains('high-contrast'));
      if (!applied) throw new Error('high-contrast class not applied');
      await page.screenshot({ path: shot('settings', vpName) });
      await page.click('#btn-settings-close');
      await page.waitForSelector('#settings-overlay', { state: 'hidden' });
      // restore default look for later screenshots
      await page.click('#btn-settings');
      await hc.check(); // no-op guard if locator rebuilt
      const hc2 = page.locator('#settings-body label', { hasText: 'High contrast' }).locator('input');
      if (await hc2.isChecked()) await hc2.uncheck();
      await page.click('#btn-settings-close');
    });

    await step(`${vpName}: help overlay open/close`, async () => {
      await page.click('#btn-help');
      await page.waitForSelector('#help-overlay:not([hidden])');
      const rules = await page.textContent('#help-body');
      if (!rules.includes('three pieces')) throw new Error('help body missing rules text');
      await page.click('#btn-help-close');
      await page.waitForSelector('#help-overlay', { state: 'hidden' });
    });

    await step(`${vpName}: journey setup shows 40 stages`, async () => {
      await page.click('#btn-journey');
      await page.waitForSelector('#setup-screen:not([hidden])');
      const stages = await page.locator('.stage-grid button').count();
      if (stages !== 40) throw new Error(`expected 40 stages, got ${stages}`);
      const unlocked = await page.locator('.stage-grid button:not([disabled])').count();
      if (unlocked !== 1) throw new Error(`expected 1 unlocked stage, got ${unlocked}`);
      await page.screenshot({ path: shot('journey', vpName) });
    });

    await step(`${vpName}: start stage 1 → game screen`, async () => {
      await page.locator('.stage-grid button:not([disabled])').first().click();
      await page.click('#setup-start');
      await page.waitForSelector('#game-screen:not([hidden])');
      await page.waitForSelector('#offer-tray .offer:not(.used)');
      const offers = await page.locator('#offer-tray .offer:not(.used)').count();
      if (offers !== 3) throw new Error(`expected 3 offered pieces, got ${offers}`);
      await page.screenshot({ path: shot('play', vpName) });
    });

    await step(`${vpName}: play stage 1 via hint + Enter until results`, async () => {
      const moves = await playUntilResults(page);
      console.log(`  placed ${moves} pieces`);
      const heading = await page.textContent('#results-heading');
      const sub = await page.textContent('#results-sub');
      console.log(`  outcome: ${heading} — ${sub}`);
      const rows = await page.locator('#results-breakdown dt').count();
      if (rows < 8) throw new Error(`expected results breakdown rows, got ${rows}`);
      await page.screenshot({ path: shot('results', vpName) });
    });

    await step(`${vpName}: progress persisted to localStorage`, async () => {
      const prog = await page.evaluate(() => JSON.parse(localStorage.getItem('prism-parcel:progress:v1')));
      if (!prog || typeof prog !== 'object') throw new Error('no progress saved');
      if (!(prog.totalPlaced > 0)) throw new Error('totalPlaced not recorded');
      console.log(`  stage=${prog.stage} stars=${JSON.stringify(prog.stars)}`);
    });

    await step(`${vpName}: practice round → pause → resume → undo`, async () => {
      await page.click('#btn-results-home');
      await page.waitForSelector('#title-screen:not([hidden])');
      await page.click('#btn-practice');
      await page.waitForSelector('#setup-screen:not([hidden])');
      await page.click('#setup-start');
      await page.waitForSelector('#game-screen:not([hidden])');
      await placeViaHint(page);
      await page.waitForTimeout(120);
      const score = await page.textContent('#hud-score');
      if (!/^[1-9]\d*$/.test(score)) throw new Error(`expected positive score, got "${score}"`);
      await page.click('#btn-pause');
      await page.waitForSelector('#pause-overlay:not([hidden])');
      await page.screenshot({ path: shot('pause', vpName) });
      await page.click('#btn-resume');
      await page.waitForSelector('#pause-overlay', { state: 'hidden' });
      if (await page.locator('#btn-undo').isEnabled()) {
        await page.click('#btn-undo');
        await page.waitForTimeout(80);
        const after = await page.textContent('#hud-score');
        console.log(`  score ${score} → undo → ${after}`);
      }
    });

    await step(`${vpName}: pause → leave round → title`, async () => {
      await page.keyboard.press('Escape');
      await page.waitForSelector('#pause-overlay:not([hidden])');
      await page.click('#btn-quit');
      await page.waitForSelector('#title-screen:not([hidden])');
      await page.screenshot({ path: shot('home', vpName) });
    });

    await context.close();
  } finally {
    await browser.close();
  }
}

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseURL = `http://127.0.0.1:${server.address().port}`;
console.log(`serving ${ROOT} at ${baseURL}`);

try {
  await runPass('desktop', { width: 1280, height: 800 }, false, baseURL);
  if (errors.length) throw new Error('page errors after desktop pass:\n' + errors.join('\n'));
  await runPass('mobile', { width: 390, height: 844 }, true, baseURL);
  if (errors.length) throw new Error('page errors:\n' + errors.join('\n'));
  console.log('\nE2E PASS — full playthrough clean on desktop + mobile, no page errors');
} finally {
  server.close();
}
