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
  const etags = {};
  let version = 0;
  const kv = { theme: 'ember', 'ui.language': { choice: 'it-IT' } };
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', init });
    const r = (status, body) => new Response(body, { status });
    const j = (o) => r(200, JSON.stringify(o));
    if (url.endsWith('/profile')) return j({ username: 'hidden', nickname: url.includes('user-9988ffee') ? 'Prismatic' : '' });
    if (url.includes('/cloud-saves/')) {
      // Versioned slot like the platform: /info carries the ETag, a PUT must
      // match it (If-Match) or target an empty slot (If-None-Match: *), else 412.
      const rest = decodeURIComponent(url.split('/cloud-saves/')[1]);
      const key = rest.replace(/\/info$/, '');
      if (rest.endsWith('/info')) return j(saves[key] ? { exists: true, etag: etags[key] } : { exists: false });
      if (init.method === 'PUT') {
        const hd = init.headers || {};
        if ((hd['If-Match'] && hd['If-Match'] !== etags[key]) || (hd['If-None-Match'] === '*' && saves[key])) {
          return r(412, JSON.stringify({ error: 'precondition failed', etag: etags[key] }));
        }
        saves[key] = Buffer.from(JSON.parse(init.body).dataBase64, 'base64');
        etags[key] = `"v${++version}"`;
        return j({ etag: etags[key] });
      }
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
  return { calls, saves, kv, fetch, loc };
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
  await platform.syncSettings({ theme: 'ember', muted: true, 'ui.language': { choice: 'de-DE' } }); // ui.* never mirrored
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

test('hosted: a save that lost to another device reloads, merges and saves on top', async () => {
  const h = install(`https://pp-slug.starhermit.com/#game_token=${TOKEN}`);
  const { platform, mergeProgress } = await import('../src/platform.js?conflict');
  platform.init();
  assert.equal(await platform.loadCloud(), null); // empty slot -> next write is If-None-Match: *
  const other = SDK.create({ window: { location: h.loc, history: { replaceState() {} } }, fetch: h.fetch, setTimeout: () => 0, clearTimeout: () => {} });
  other.init();
  const remote = { v: 1, settings: { theme: 'frost' }, progress: { stage: 6, stars: { 1: 3, 2: 1 }, bestScores: { stage1: 900 }, achievements: { first_completion: 50 }, tutorialDone: true, totalPlaced: 120, dailyBest: { '2026-10-01': 400 }, friends: ['a'] } };
  assert.equal(await other.writeSave(JSON.stringify(remote)), true);
  const local = { v: 1, settings: { theme: 'ember' }, progress: { stage: 3, stars: { 2: 3, 3: 2 }, bestScores: { stage1: 500, stage3: 700 }, achievements: { first_completion: 10, line_weaver: 20 }, tutorialDone: false, totalPlaced: 90, dailyBest: { '2026-10-01': 600 }, friends: ['b'] } };
  platform.docProvider = () => local;
  const got = new Promise((resolve) => { platform.onSaveConflict = resolve; });
  platform.scheduleCloudSave();
  assert.equal(await platform.saveCloud(true), false, 'the stale write is refused');
  const doc = await got;
  assert.deepEqual(doc, remote, 'onSaveConflict receives the newer doc from loadJSON');
  const merged = mergeProgress(doc.progress, local.progress);
  assert.deepEqual(merged, {
    stage: 6, stars: { 1: 3, 2: 3, 3: 2 }, bestScores: { stage1: 900, stage3: 700 },
    achievements: { first_completion: 10, line_weaver: 20 }, tutorialDone: true, totalPlaced: 120,
    dailyBest: { '2026-10-01': 600 }, friends: ['a', 'b'],
  });
  platform.docProvider = () => ({ ...local, progress: merged });
  platform.scheduleCloudSave();
  assert.equal(await platform.saveCloud(true), true, 'the merged doc saves on top');
  assert.equal((await other.loadJSON()).progress.stage, 6);
});

test('hosted: the settings KV mirror ignores platform ui.* keys', async () => {
  install(`https://pp-slug.starhermit.com/#game_token=${TOKEN}`);
  const { platform } = await import('../src/platform.js?uikeys');
  platform.init();
  assert.deepEqual(await platform.loadRemoteSettings(), { theme: 'ember' });
});
