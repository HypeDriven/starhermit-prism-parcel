// StarHermit adapter (src/platform.js) over the shared SDK with a stubbed fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The SDK is a classic browser script: evaluate it the way a <script> would.
const holder = {};
new Function('self', 'module', readFileSync(new URL('../starhermit-sdk.js', import.meta.url), 'utf8'))(holder, undefined);
const SDK = holder.StarHermit;

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const TOKEN = `h.${b64u({ sub: 'user-9988ffee', game_scope: 'pp-slug', exp: Math.floor(Date.now() / 1000) + 3600 })}.s`;

function install(href) {
  const calls = [];
  const saves = {};
  const kv = { theme: 'ember' };
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', init });
    const r = (status, body) => new Response(body, { status });
    const j = (o) => r(200, JSON.stringify(o));
    if (url.endsWith('/profile')) return j({ username: 'hidden', nickname: url.includes('user-9988ffee') ? 'Prismatic' : '' });
    if (url.includes('/cloud-saves/')) {
      const key = decodeURIComponent(url.split('/cloud-saves/')[1]);
      if (init.method === 'PUT') { saves[key] = Buffer.from(JSON.parse(init.body).dataBase64, 'base64'); return j({}); }
      return saves[key] ? r(200, saves[key]) : r(404, '');
    }
    if (url.endsWith('/settings') && init.method === 'PATCH') { Object.assign(kv, JSON.parse(init.body).settings); return j({}); }
    if (url.endsWith('/settings')) return j({ settings: kv });
    if (url.endsWith('/controls')) return j({ actions: [{ action: 'hint', codes: ['KeyI'] }] });
    if (url.endsWith('/leaderboards')) return j([{ id: 'lb', key: 'high-score' }]);
    if (url.startsWith('/api/v1/leaderboards/lb/entries')) return j({ items: [{ userId: 'user-other77', score: 321 }] });
    return r(404, '');
  };
  const u = new URL(href);
  const loc = { hash: u.hash, search: u.search, pathname: u.pathname, origin: u.origin, hostname: u.hostname, href };
  globalThis.fetch = fetch;
  globalThis.StarHermit = SDK.create({ window: { location: loc, history: { replaceState() {} } }, fetch, setTimeout: () => 0, clearTimeout: () => {} });
  return { calls, saves, kv };
}

test('hosted: token, nickname, cloud save game:<slug>, settings, bindings, board', async () => {
  const h = install(`https://pp-slug.starhermit.com/#game_token=${TOKEN}`);
  const { platform } = await import('../src/platform.js?hosted');
  platform.init();
  assert.equal(platform.hosted, true);
  assert.equal(platform.userId, 'user-9988ffee');
  assert.equal(platform.gameSlug, 'pp-slug');
  assert.equal(await platform.loadProfile(), 'Prismatic');
  assert.equal(platform.displayName(), 'Prismatic');

  const doc = { v: 1, settings: { theme: 'aurora' }, progress: { stage: 4 } };
  platform.docProvider = () => doc;
  assert.equal(await platform.saveCloud(false), true);
  assert.deepEqual(Object.keys(h.saves), ['game:pp-slug']);
  assert.deepEqual(await platform.loadCloud(), doc);
  assert.equal(platform.syncState, 'synced');

  assert.equal(await platform.syncSettings({ theme: 'x' }), null, 'no PATCH before the KV was read');
  assert.deepEqual(await platform.loadRemoteSettings(), { theme: 'ember' });
  await platform.syncSettings({ theme: 'ember', muted: true });
  const patches = h.calls.filter((c) => c.method === 'PATCH').map((c) => JSON.parse(c.init.body));
  assert.deepEqual(patches, [{ settings: { muted: true } }]);

  assert.deepEqual(await platform.loadBindings({ hint: ['KeyH'], undo: ['KeyU'] }), { hint: ['KeyI'], undo: ['KeyU'] });
  assert.deepEqual(await platform.dailyBoard('2026-10-03'), { ok: true, entries: [{ name: 'Player user-o', score: 321 }] });
  assert.match(platform.inviteLink(), /\/game-invite\/user-9988ffee\/pp-slug$/);
  assert.ok(h.calls.every((c) => c.init.headers.Authorization === `Bearer ${TOKEN}`));
});

test('standalone: no StarHermit request', async () => {
  const h = install('https://example.org/index.html');
  const { platform } = await import('../src/platform.js?standalone');
  platform.init();
  platform.docProvider = () => ({ v: 1 });
  assert.equal(platform.hosted, false);
  assert.equal(platform.canSignIn(), false);
  assert.equal(platform.inviteLink(), null);
  assert.equal(await platform.loadProfile(), null);
  assert.equal(await platform.loadCloud(), null);
  platform.scheduleCloudSave();
  assert.equal(await platform.saveCloud(true), false);
  assert.deepEqual(await platform.loadRemoteSettings(), {});
  assert.deepEqual(await platform.loadBindings({ hint: ['KeyH'] }), { hint: ['KeyH'] });
  assert.deepEqual(await platform.dailyBoard('2026-10-03'), { ok: true, entries: [], localOnly: true });
  assert.deepEqual(await platform.submitScore(321), { posted: false, rank: null });
  assert.ok(Math.abs(platform.now() - Date.now()) < 50, 'local clock');
  assert.equal(h.calls.length, 0);
});
