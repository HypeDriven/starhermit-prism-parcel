'use strict';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { server } from '../server.js';
import { initialState, applyCommand, legalPlacements, pieceById, makeReplay, createRng } from '../src/rules.js';
import { dailySeed, utcDateStr } from '../src/content.js';

let port, base;

before(async () => {
  await new Promise(resolve => server.listen(0, resolve));
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
});

after(() => server.close());

async function api(path, opts) {
  const res = await fetch(base + path, opts && {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts)
  });
  return { status: res.status, body: await res.json() };
}

test('GET /api/v1/time returns platform time', async () => {
  const { status, body } = await api('/api/v1/time');
  assert.equal(status, 200);
  assert.ok(Math.abs(body.now - Date.now()) < 5000);
});

test('GET / serves index.html', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /Prism Parcel/);
});

test('static server refuses dotfiles and data dir', async () => {
  const res = await fetch(base + '/data/daily-boards.json');
  assert.equal(res.status, 403);
});

test('daily ruleset endpoint matches immutable seed', async () => {
  const date = utcDateStr(Date.now());
  const { status, body } = await api('/api/v1/daily?date=' + date);
  assert.equal(status, 200);
  assert.equal(body.seed, dailySeed(date));
});

function finishDailyGame(seed) {
  const rng = createRng(seed ^ 0xabcd);
  let s = initialState({ seed, maxTier: 1 });
  const commands = [];
  while (!s.over && commands.length < 2000) {
    // Only consider slots that actually fit; game ends when none do.
    const fittable = s.offer
      .map((o, i) => o ? i : -1)
      .filter(x => x >= 0 && legalPlacements(s.board, pieceById(s.offer[x].piece)).length > 0);
    if (!fittable.length) break;
    const slot = fittable[rng.int(fittable.length)];
    const spots = legalPlacements(s.board, pieceById(s.offer[slot].piece));
    const [row, col] = spots[rng.int(spots.length)];
    commands.push({ slot, row, col });
    s = applyCommand(s, { type: 'place', slot, row, col });
  }
  return { state: s, commands };
}

test('daily score submission requires valid replay and correct seed', async () => {
  const date = utcDateStr(Date.now());
  const seed = dailySeed(date);
  const { state, commands } = finishDailyGame(seed);
  assert.ok(state.over, 'test game reaches terminal state');

  const replay = makeReplay({ seed, maxTier: 1 }, commands, state);

  // Wrong seed rejected.
  const bad = await api('/api/v1/daily/score', { date, seed: seed + 1, contentVersion: 1, replay, elapsedMs: 1000 });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error, 'seed-mismatch');

  // Valid submission accepted with rank.
  const good = await api('/api/v1/daily/score', {
    id: 'test-' + seed, date, seed, contentVersion: 1, replay, elapsedMs: 60000, name: 'Tester'
  });
  assert.equal(good.status, 200);
  assert.equal(good.body.ok, true);
  assert.equal(good.body.score, state.score.total);
  assert.ok(good.body.rank >= 1);

  // Duplicate id is idempotent.
  const dup = await api('/api/v1/daily/score', {
    id: 'test-' + seed, date, seed, contentVersion: 1, replay, elapsedMs: 60000, name: 'Tester'
  });
  assert.equal(dup.status, 200);

  // Leaderboard includes the entry.
  const board = await api('/api/v1/daily/leaderboard?date=' + date);
  assert.equal(board.status, 200);
  assert.ok(board.body.entries.some(e => e.name === 'Tester'));

  // Tampered replay rejected.
  const tampered = { ...replay, finalHash: replay.finalHash ^ 0xffff };
  const bad2 = await api('/api/v1/daily/score', { date, seed, contentVersion: 1, replay: tampered, elapsedMs: 1000 });
  assert.equal(bad2.status, 422);

  // Malformed commands rejected.
  const bad3 = await api('/api/v1/daily/score', {
    date, seed, contentVersion: 1, elapsedMs: 1000,
    replay: { ...replay, commands: [{ slot: 99, row: -1, col: 0 }] }
  });
  assert.equal(bad3.status, 400);
});

test('achievement unlock is idempotent', async () => {
  const a = await api('/api/v1/achievements', { key: 'first_completion', player: 'p1' });
  assert.equal(a.status, 200);
  const b = await api('/api/v1/achievements', { key: 'first_completion', player: 'p1' });
  assert.equal(b.body.unlockedAt, a.body.unlockedAt);
  const bad = await api('/api/v1/achievements', { key: 'BAD KEY!', player: 'p1' });
  assert.equal(bad.status, 400);
});
