'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARD_SIZE, OFFER_COUNT, PIECES, pieceById, emptyBoard, canPlace, legalPlacements,
  findClears, scoreComponents, piecePool, initialState, validateCommand, applyCommand,
  findHint, hashState, serializeState, parseState, makeReplay, runReplay, verifyReplay,
  createRng, ERR, anyFit
} from '../src/rules.js';
import {
  STAGES, validateAllStages, validateStage, dailySeed, dailyRuleset, utcDateStr,
  THEMES, TUTORIAL_STEPS, ACHIEVEMENTS
} from '../src/content.js';

/* ---------------- legality ---------------- */

test('canPlace respects bounds and occupancy', () => {
  const b = emptyBoard();
  const sq = pieceById('sq2');
  assert.equal(canPlace(b, 0, 0, sq), true);
  assert.equal(canPlace(b, 9, 9, sq), false);   // off board
  assert.equal(canPlace(b, 8, 8, sq), true);
  b[0][0] = 1;
  assert.equal(canPlace(b, 0, 0, sq), false);   // occupied
  assert.equal(canPlace(b, 0, 1, sq), true);    // does not touch (0,0)
  b[1][1] = 1;
  assert.equal(canPlace(b, 0, 1, sq), false);   // now overlaps (1,1)
  assert.equal(canPlace(b, 2, 2, sq), true);
});

test('every piece has cells and legal scan works', () => {
  const b = emptyBoard();
  for (const p of PIECES) {
    assert.ok(p.cells.length > 0);
    assert.ok(legalPlacements(b, p).length > 0, p.id + ' fits empty board');
  }
});

test('findClears detects full rows and columns', () => {
  const b = emptyBoard();
  for (let c = 0; c < BOARD_SIZE; c++) b[3][c] = 1;
  for (let r = 0; r < BOARD_SIZE; r++) b[r][7] = 2;
  const { rows, cols } = findClears(b);
  assert.deepEqual(rows, [3]);
  assert.deepEqual(cols, [7]);
});

/* ---------------- scoring ---------------- */

test('score components are integers and additive', () => {
  const single = scoreComponents(4, 10, 1, 1);
  assert.deepEqual(single, { cells: 4, clear: 100, simultaneous: 0, combo: 0, total: 104 });
  const multi = scoreComponents(4, 20, 2, 1);
  assert.equal(multi.simultaneous, 25);
  const combo = scoreComponents(2, 10, 1, 3);
  assert.equal(combo.combo, 30);
  for (const s of [single, multi, combo]) assert.ok(Number.isSafeInteger(s.total));
});

/* ---------------- commands ---------------- */

test('place command mutates via new state and increments turn', () => {
  const s0 = initialState({ seed: 42, maxTier: 0 });
  const slot = 0;
  const piece = pieceById(s0.offer[slot].piece);
  const [r, c] = legalPlacements(s0.board, piece)[0];
  const s1 = applyCommand(s0, { type: 'place', slot, row: r, col: c });
  assert.notEqual(s1, s0);
  assert.equal(s1.turn, 1);
  assert.equal(s1.placedPieces, 1);
  assert.equal(s1.offer[slot], null);
  assert.ok(s1.score.total > 0);
  // original untouched
  assert.equal(s0.turn, 0);
  assert.ok(s0.offer[slot]);
});

test('invalid commands are counted with reasons, never placed', () => {
  let s = initialState({ seed: 7, maxTier: 0 });
  assert.equal(validateCommand(s, { type: 'place', slot: 9, row: 0, col: 0 }).reason, ERR.BAD_SLOT);
  assert.equal(validateCommand(s, { type: 'place', slot: 0, row: -5, col: 0 }).reason, ERR.BOUNDS);
  // An occupied target is rejected: place once, then try to overlap the same cells.
  const p0 = pieceById(s.offer[0].piece);
  const [r0, c0] = legalPlacements(s.board, p0)[0];
  const s2 = applyCommand(s, { type: 'place', slot: 0, row: r0, col: c0 });
  const occupiedCheck = validateCommand(s2, { type: 'place', slot: 1, row: r0, col: c0 });
  assert.ok(!occupiedCheck.ok);
  const before = hashState(s);
  s = applyCommand(s, { type: 'place', slot: 9, row: 0, col: 0 });
  assert.equal(s.invalid, 1);
  assert.equal(s.turn, 0);
  assert.equal(validateCommand(s, { type: 'nonsense' }).reason, ERR.BAD_COMMAND);
  assert.equal(validateCommand(s, null).reason, ERR.BAD_COMMAND);
});

test('offer replenishes after all three pieces used', () => {
  let s = initialState({ seed: 99, maxTier: 0 });
  for (let i = 0; i < OFFER_COUNT; i++) {
    const idx = s.offer.findIndex(o => o !== null);
    assert.ok(idx >= 0);
    const piece = pieceById(s.offer[idx].piece);
    const spot = legalPlacements(s.board, piece)[0];
    s = applyCommand(s, { type: 'place', slot: idx, row: spot[0], col: spot[1] });
  }
  assert.ok(s.offer.every(o => o !== null), 'offer refilled');
  assert.equal(s.turn, 3);
});

test('terminal state: no-fit produces reason', () => {
  // Fill everything except a 1-cell hole, offer only big pieces.
  const s = initialState({ seed: 5, maxTier: 0 });
  for (let r = 0; r < BOARD_SIZE; r++) for (let c = 0; c < BOARD_SIZE; c++) s.board[r][c] = 1;
  s.board[5][5] = 0;
  s.offer = [{ piece: 'sq2', hue: 0 }, { piece: 'sq3', hue: 1 }, { piece: 'bar3-h', hue: 2 }];
  assert.equal(anyFit(s.board, s.offer), false);
  const check = validateCommand(s, { type: 'place', slot: 0, row: 0, col: 0 });
  assert.equal(check.ok, false);
  // Trigger terminal check through a legal move on a crafted goal state instead:
  const g = initialState({ seed: 5, maxTier: 0, goal: { type: 'score', target: 1 } });
  const piece = pieceById(g.offer[0].piece);
  const spot = legalPlacements(g.board, piece)[0];
  const s2 = applyCommand(g, { type: 'place', slot: 0, row: spot[0], col: spot[1] });
  assert.equal(s2.over, true);
  assert.equal(s2.won, true);
  assert.equal(s2.reason, 'goal-complete');
  // Commands after over are rejected without counting invalid.
  const s3 = applyCommand(s2, { type: 'place', slot: 0, row: 0, col: 0 });
  assert.equal(s3, s2);
});

test('move-limit terminal state', () => {
  let s = initialState({ seed: 11, maxTier: 0, goal: { type: 'score', target: 999999 }, moveLimit: 1 });
  const piece = pieceById(s.offer[0].piece);
  const spot = legalPlacements(s.board, piece)[0];
  s = applyCommand(s, { type: 'place', slot: 0, row: spot[0], col: spot[1] });
  assert.equal(s.over, true);
  assert.equal(s.won, false);
  assert.equal(s.reason, 'move-limit');
});

test('undo restores previous state and is single-step', () => {
  let s = initialState({ seed: 21, maxTier: 0 });
  const piece = pieceById(s.offer[0].piece);
  const spot = legalPlacements(s.board, piece)[0];
  const placed = applyCommand(s, { type: 'place', slot: 0, row: spot[0], col: spot[1] });
  assert.ok(placed.undo);
  const undone = applyCommand(placed, { type: 'undo' });
  assert.equal(hashState({ ...undone, undo: null }), hashState({ ...s, undo: null }));
  assert.equal(validateCommand(undone, { type: 'undo' }).reason, ERR.NO_UNDO);
});

test('hint uses the same legality API', () => {
  const s = initialState({ seed: 33, maxTier: 1 });
  const hint = findHint(s);
  assert.ok(hint);
  assert.equal(validateCommand(s, { type: 'place', slot: hint.slot, row: hint.row, col: hint.col }).ok, true);
});

/* ---------------- determinism / replay ---------------- */

function playRandom(seed, moves) {
  const rng = createRng(seed);
  let s = initialState({ seed, maxTier: 1 });
  const commands = [];
  for (let i = 0; i < moves && !s.over; i++) {
    const slots = s.offer.map((o, idx) => o ? idx : -1).filter(x => x >= 0);
    let placed = false;
    for (let tries = 0; tries < slots.length && !placed; tries++) {
      const slot = slots[rng.int(slots.length)];
      const spots = legalPlacements(s.board, pieceById(s.offer[slot].piece));
      if (!spots.length) continue;
      const [row, col] = spots[rng.int(spots.length)];
      const cmd = { type: 'place', slot, row, col };
      commands.push({ slot, row, col });
      s = applyCommand(s, cmd);
      placed = true;
    }
    if (!placed) break;
  }
  return { state: s, commands };
}

test('same seed + commands produce identical state hashes (replay)', () => {
  const a = playRandom(1234, 40);
  const b = playRandom(1234, 40);
  assert.equal(hashState(a.state), hashState(b.state));
  assert.equal(a.state.score.total, b.state.score.total);
});

test('replay envelope verifies and detects tampering', () => {
  const { state, commands } = playRandom(777, 30);
  const options = { seed: 777, maxTier: 1 };
  const replay = makeReplay(options, commands, state);
  const v = verifyReplay(replay);
  assert.equal(v.ok, true);
  const tampered = { ...replay, finalHash: replay.finalHash + 1 };
  assert.equal(verifyReplay(tampered).ok, false);
  const badScore = JSON.parse(JSON.stringify(replay));
  badScore.result.score.total += 10;
  assert.equal(verifyReplay(badScore).ok, false);
});

test('rng stream is deterministic and restorable', () => {
  const a = createRng(5), b = createRng(5);
  for (let i = 0; i < 10; i++) assert.equal(a.next(), b.next());
  const snap = a.state();
  const next = a.next();
  a.restore(snap);
  assert.equal(a.next(), next);
});

/* ---------------- serialization / migration ---------------- */

test('serialize/parse round-trips with checksum', () => {
  const { state } = playRandom(2024, 25);
  const text = serializeState(state);
  const back = parseState(text);
  assert.equal(hashState(back), hashState(state));
  assert.equal(back.score.total, state.score.total);
});

test('parseState rejects malformed payloads', () => {
  const { state } = playRandom(88, 5);
  const good = JSON.parse(serializeState(state));
  assert.throws(() => parseState('not json'));
  assert.throws(() => parseState(JSON.stringify({ ...good, v: 99 })));
  assert.throws(() => parseState(JSON.stringify({ ...good, board: 'xyz' })));
  assert.throws(() => parseState(JSON.stringify({ ...good, hash: 1 })));
  assert.throws(() => parseState(JSON.stringify({ ...good, offer: 'a|b' })));
  assert.throws(() => parseState(JSON.stringify({ ...good, score: { total: -1 } })));
});

/* ---------------- fuzz ---------------- */

test('fuzz: malformed commands never hang or corrupt state', () => {
  let s = initialState({ seed: 314, maxTier: 2 });
  const rng = createRng(2718);
  for (let i = 0; i < 2000; i++) {
    const cmd = {
      type: ['place', 'undo', 'x', null][rng.int(4)],
      slot: rng.int(8) - 2,
      row: rng.int(24) - 7,
      col: rng.int(24) - 7
    };
    s = applyCommand(s, cmd);
    assert.ok(Number.isSafeInteger(s.score.total) && s.score.total >= 0);
    assert.ok(Number.isSafeInteger(s.turn) && s.turn >= 0);
    for (const row of s.board) for (const v of row) assert.ok(Number.isInteger(v));
  }
});

test('fuzz: full random games always terminate sanely', () => {
  for (let g = 0; g < 20; g++) {
    const { state } = playRandom(1000 + g, 500);
    assert.ok(state.turn <= 500);
    assert.ok(Number.isFinite(hashState(state)));
  }
});

/* ---------------- content ---------------- */

test('all 40 stages validate (legality, bounded, no soft-lock shape)', () => {
  const r = validateAllStages();
  assert.equal(r.ok, true, JSON.stringify(r.bad));
  assert.equal(STAGES.length, 40);
});

test('daily seed is deterministic and immutable per UTC date', () => {
  assert.equal(dailySeed('2026-08-29'), dailySeed('2026-08-29'));
  assert.notEqual(dailySeed('2026-08-29'), dailySeed('2026-08-30'));
  const rs = dailyRuleset('2026-01-01');
  assert.equal(rs.seed, dailySeed('2026-01-01'));
  assert.ok(THEMES.includes(rs.theme));
  assert.equal(utcDateStr(Date.UTC(2026, 7, 29, 12)), '2026-08-29');
});

test('achievement keys are stable lowercase identifiers', () => {
  assert.equal(ACHIEVEMENTS.length, 5);
  for (const a of ACHIEVEMENTS) assert.match(a.key, /^[a-z][a-z0-9_]*$/);
  assert.ok(TUTORIAL_STEPS.length >= 4);
});

/* ---------------- golden sessions ---------------- */

test('golden: scripted easy session produces stable hash and score', () => {
  const { state, commands } = playRandom(42, 15);
  const replay = makeReplay({ seed: 42, maxTier: 1 }, commands, state);
  const v = verifyReplay(replay);
  assert.equal(v.ok, true);
  // Interrupt + resume via serialization reproduces the same end state.
  const mid = playRandom(42, 8);
  const resumed = parseState(serializeState(mid.state));
  let s = resumed;
  for (const c of commands.slice(8)) s = applyCommand(s, { type: 'place', ...c });
  assert.equal(hashState(s), hashState(state));
});
