// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in Settings → Graphics,
// starts a Practice round and keeps placing pieces through the real controls (Hint, then Enter places
// the hinted piece), so blocks drop, lines clear with flashes and particle bursts and the prism motes
// drift. A finished round goes Home and starts a new Practice round.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

export async function setPreset(page, preset) {
  await page.waitForSelector('#title-screen:not([hidden])', { timeout: 30000 });
  await page.click('#btn-settings');
  await page.click('#settings-tab-graphics');
  await page.waitForSelector('#settings-graphics:not([hidden])');
  await page.selectOption('#gfx-preset', preset);
  await page.waitForFunction((p) => document.getElementById('gl').dataset.gfxPreset === p, preset);
  await page.locator('#btn-settings-close').scrollIntoViewIfNeeded();
  await page.click('#btn-settings-close');
  await page.waitForSelector('#settings-overlay', { state: 'hidden' });
}

async function newRound(page) {
  await page.click('#btn-practice');
  await page.waitForSelector('#setup-screen:not([hidden])');
  await page.click('#setup-start');
  await page.waitForSelector('#game-screen:not([hidden])');
}

async function step(page) {
  if (await page.locator('#results-screen:not([hidden])').count()) {
    await page.click('#btn-results-home', { timeout: 2000 });
    await page.waitForSelector('#title-screen:not([hidden])');
    return newRound(page);
  }
  if (await page.locator('#btn-hint').isDisabled()) return;
  await page.click('#btn-hint', { timeout: 2000 });
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('Enter');
}

export async function start(page) {
  await newRound(page);
  let open = true;
  page.once('close', () => { open = false; });
  (async () => {
    while (open) {
      try { await step(page); } catch (e) { if (!open) return; if (process.env.BENCH_DEBUG) console.error(e.message); }
      await page.waitForTimeout(450).catch(() => {});
    }
  })();
  await page.waitForTimeout(1500);
}
