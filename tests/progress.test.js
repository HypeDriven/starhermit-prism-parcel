// The save model (src/progress.js): the browser build's progress merge, the
// old cloud slot's migration (foreign save), the end-of-round bookkeeping and
// the resumable round snapshot — the signed-in paths the engine client runs
// that cannot be played live here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeProgress, mergeSave, normalize, sameSave, readForeign, pickOptions, recordRound, starsFor, mastery, makeSnapshot, readSnapshot,
  BROWSER_KEYS, OPTION_KEYS,
} from '../src/progress.js';
import { initialState, applyCommand, findHint } from '../src/rules.js';
import { stageInfo } from '../src/content.js';

test('merge keeps both devices: max unlock/counters, best stars/scores/dailies, earliest achievements, union friends', () => {
  const r = { stage: 5, stars: { 1: 3, 2: 1 }, bestScores: { stage1: 400 }, achievements: { first_completion: 200 }, tutorialDone: false, totalPlaced: 90, dailyBest: { '2026-10-01': 300 }, friends: ['a'] };
  const l = { stage: 3, stars: { 2: 2, 3: 1 }, bestScores: { stage1: 350, stage2: 10 }, achievements: { first_completion: 100, sustained_streak: 300 }, tutorialDone: true, totalPlaced: 120, dailyBest: { '2026-10-01': 500 }, friends: ['b'] };
  assert.deepEqual(mergeProgress(r, l), {
    stage: 5, stars: { 1: 3, 2: 2, 3: 1 }, bestScores: { stage1: 400, stage2: 10 }, achievements: { first_completion: 100, sustained_streak: 300 },
    tutorialDone: true, totalPlaced: 120, dailyBest: { '2026-10-01': 500 }, friends: ['a', 'b'],
  });
  const m = mergeSave({ progress: r }, { progress: l });
  assert.equal(m.v, 1);
  assert.ok(sameSave(m, mergeSave(m, m)));
  assert.equal(normalize(null).progress.stage, 1);
});

test('the browser build cloud slot ({ v, savedAt, settings, progress }) migrates progress and the game options', () => {
  const text = JSON.stringify({
    v: 1, savedAt: 1, settings: { music: 0.2, theme: 'ember', cvdPalette: true, haptics: false, graphics: { preset: 'high' }, captions: 'x' },
    progress: { stage: 7, stars: { 6: 2 }, achievements: { first_completion: 5 }, totalPlaced: 40 },
  });
  const f = readForeign(text);
  assert.equal(f.save.progress.stage, 7);
  assert.equal(f.save.progress.stars[6], 2);
  assert.deepEqual(f.options, { theme: 'ember', cvdPalette: true, haptics: false });
  assert.equal(readForeign('not json'), null);
  assert.equal(readForeign(JSON.stringify({ unrelated: 1 })), null);
  assert.deepEqual(pickOptions({ theme: 'nope', leftHanded: true }), { leftHanded: true });
  for (const k of OPTION_KEYS) assert.ok(BROWSER_KEYS.includes(k), k);
});

/** Play a round with the hint until it ends (or `max` placements). */
function playOut(opts, max = 400) {
  let s = initialState(opts);
  for (let i = 0; i < max && !s.over; i++) {
    const h = findHint(s);
    s = applyCommand(s, { type: 'place', slot: h.slot, row: h.row, col: h.col });
  }
  return s;
}

test('a won Journey stage records stars, best score, the next unlock; achievements unlock once', () => {
  const st = stageInfo(1);
  const s = playOut({ seed: st.seed, maxTier: st.maxTier, goal: { ...st.goal }, moveLimit: st.moveLimit });
  assert.ok(s.won, 'the hint player clears stage 1');
  const p = normalize(null).progress;
  const r = recordRound(p, { mode: 'journey', stageId: 1, dailyDate: null, state: s, maxLines: 3, maxCombo: 1, tutorialStep: 0, now: 42 });
  assert.deepEqual(r.newly, ['first_completion', 'mechanic_mastery']);
  assert.equal(r.stars, starsFor(st, s));
  assert.equal(p.stars[1], r.stars);
  assert.equal(p.stage, 2);
  assert.equal(p.bestScores.stage1, s.score.total);
  assert.equal(p.totalPlaced, s.placedPieces);
  const again = recordRound(p, { mode: 'journey', stageId: 1, dailyDate: null, state: s, maxLines: 3, maxCombo: 1, tutorialStep: 0, now: 43 });
  assert.deepEqual(again.newly, []);
  assert.equal(p.stage, 2, 'replaying an earlier stage unlocks nothing more');
  assert.equal(p.achievements.first_completion, 42);
});

test('stars compare the goal metric: lines against lines, score against score', () => {
  const base = { lines: 6, placedPieces: 10, score: { total: 10 } };
  assert.equal(starsFor({ goal: { type: 'lines', target: 4 } }, base), 3);
  assert.equal(starsFor({ goal: { type: 'score', target: 9 } }, base), 1);
  assert.equal(starsFor({ goal: { type: 'score', target: 8 } }, base), 2);
});

test('daily best, tutorial flag, mastery rank and the 500-piece achievement', () => {
  const p = normalize({ progress: { totalPlaced: 495, stars: { 1: 3, 2: 3, 3: 3, 4: 1 } } }).progress;
  const s = { over: true, won: false, placedPieces: 6, score: { total: 300 }, lines: 0 };
  const r = recordRound(p, { mode: 'daily', stageId: null, dailyDate: '2026-10-28', state: s, maxLines: 0, maxCombo: 4, tutorialStep: 0, now: 1 });
  assert.deepEqual(r.newly, ['first_completion', 'sustained_streak', 'long_term_goal']);
  assert.equal(p.dailyBest['2026-10-28'], 300);
  recordRound(p, { mode: 'learn', stageId: null, dailyDate: null, state: s, maxLines: 0, maxCombo: 0, tutorialStep: 5, now: 2 });
  assert.equal(p.tutorialDone, true);
  assert.deepEqual(mastery(p), { stars: 10, rank: 'Parcel Sorter' });
});

test('the round snapshot round-trips and refuses finished or tampered rounds', () => {
  let s = initialState({ seed: 99, maxTier: 1, goal: null, moveLimit: null });
  const h = findHint(s);
  s = applyCommand(s, { type: 'place', slot: h.slot, row: h.row, col: h.col });
  const snap = makeSnapshot({ mode: 'learn', options: { seed: 99, maxTier: 1, goal: null, moveLimit: null }, stageId: null, tutorialStep: 2, dailyDate: null,
    elapsedMs: 5000, maxCombo: 0, maxLines: 0, commands: [{ slot: h.slot, row: h.row, col: h.col }], state: s });
  const back = readSnapshot(JSON.parse(JSON.stringify(snap)));
  assert.equal(back.state.score.total, s.score.total);
  assert.equal(back.tutorial, true);
  assert.equal(back.elapsedMs, 5000);
  const bad = JSON.parse(JSON.stringify(snap));
  bad.state.score.cells += 1;
  assert.equal(readSnapshot(bad), null);
  assert.equal(readSnapshot(null), null);
});
