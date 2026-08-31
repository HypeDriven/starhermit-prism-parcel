'use strict';

/**
 * Prism Parcel — rules engine.
 * Pure, deterministic, seedable. No DOM, no rendering, no globals.
 * Shared by the browser client and the authoritative server (server.js).
 *
 * State is plain JSON-serializable data. All transitions happen through
 * applyCommand(); the state carries a monotonically increasing `turn`
 * counter and, when finished, a terminal `reason`.
 */

export const BOARD_SIZE = 10;
export const OFFER_COUNT = 3;
export const RULES_VERSION = 1;

/* ------------------------------------------------------------------ */
/* Seeded random stream (mulberry32)                                   */
/* ------------------------------------------------------------------ */

export function createRng(seed) {
  let a = (seed >>> 0) || 1;
  return {
    next() {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    int(n) { return Math.floor(this.next() * n); },
    state() { return a >>> 0; },
    restore(s) { a = (s >>> 0) || 1; }
  };
}

/* ------------------------------------------------------------------ */
/* Piece definitions                                                   */
/* ------------------------------------------------------------------ */

/**
 * Every piece is a list of [dr, dc] cells with a stable id, a tier
 * (difficulty weight class) and a display name for help screens.
 * Coordinates are relative to an anchor cell; min dr/dc is 0 so the
 * anchor is the top-left of the piece bounding box.
 */
function def(id, name, tier, cells) {
  return Object.freeze({ id, name, tier, cells: Object.freeze(cells.map(c => Object.freeze(c))) });
}

export const PIECES = Object.freeze([
  def('dot',       'Prism Chip',    0, [[0, 0]]),
  def('domino-h',  'Twin Bar',      0, [[0, 0], [0, 1]]),
  def('domino-v',  'Twin Column',   0, [[0, 0], [1, 0]]),
  def('bar3-h',    'Triple Bar',    0, [[0, 0], [0, 1], [0, 2]]),
  def('bar3-v',    'Triple Column', 0, [[0, 0], [1, 0], [2, 0]]),
  def('sq2',       'Frost Square',  0, [[0, 0], [0, 1], [1, 0], [1, 1]]),
  def('l3-a',      'Corner Chip',   1, [[0, 0], [1, 0], [1, 1]]),
  def('l3-b',      'Corner Chip',   1, [[0, 0], [0, 1], [1, 0]]),
  def('l3-c',      'Corner Chip',   1, [[0, 0], [0, 1], [1, 1]]),
  def('l3-d',      'Corner Chip',   1, [[0, 1], [1, 0], [1, 1]]),
  def('bar4-h',    'Long Bar',      1, [[0, 0], [0, 1], [0, 2], [0, 3]]),
  def('bar4-v',    'Long Column',   1, [[0, 0], [1, 0], [2, 0], [3, 0]]),
  def('bar5-h',    'Grand Bar',     2, [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]]),
  def('bar5-v',    'Grand Column',  2, [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]]),
  def('l4-a',      'Tall Hook',     2, [[0, 0], [1, 0], [2, 0], [2, 1]]),
  def('l4-b',      'Tall Hook',     2, [[0, 0], [0, 1], [1, 0], [2, 0]]),
  def('l4-c',      'Tall Hook',     2, [[0, 0], [0, 1], [1, 1], [2, 1]]),
  def('l4-d',      'Tall Hook',     2, [[0, 1], [1, 1], [2, 0], [2, 1]]),
  def('l4-e',      'Wide Hook',     2, [[0, 0], [1, 0], [1, 1], [1, 2]]),
  def('l4-f',      'Wide Hook',     2, [[0, 0], [0, 1], [0, 2], [1, 0]]),
  def('l4-g',      'Wide Hook',     2, [[0, 0], [0, 1], [0, 2], [1, 2]]),
  def('l4-h',      'Wide Hook',     2, [[0, 2], [1, 0], [1, 1], [1, 2]]),
  def('t4-u',      'Crown',         2, [[0, 0], [0, 1], [0, 2], [1, 1]]),
  def('t4-d',      'Crown',         2, [[0, 1], [1, 0], [1, 1], [1, 2]]),
  def('t4-l',      'Crown',         2, [[0, 0], [1, 0], [2, 0], [1, 1]]),
  def('t4-r',      'Crown',         2, [[0, 1], [1, 0], [1, 1], [2, 1]]),
  def('sq3',       'Grand Square',  2, [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [2, 0], [2, 1], [2, 2]])
]);

const PIECE_BY_ID = new Map(PIECES.map(p => [p.id, p]));

export function pieceById(id) {
  const p = PIECE_BY_ID.get(id);
  if (!p) throw new Error('unknown piece ' + id);
  return p;
}

/* ------------------------------------------------------------------ */
/* Board helpers                                                       */
/* ------------------------------------------------------------------ */

export function emptyBoard() {
  return Array.from({ length: BOARD_SIZE }, () => new Array(BOARD_SIZE).fill(0));
}

/** Can `piece` be placed with its anchor at (row, col)? All cells must be on-board and empty. */
export function canPlace(board, row, col, piece) {
  for (const [dr, dc] of piece.cells) {
    const r = row + dr, c = col + dc;
    if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) return false;
    if (board[r][c] !== 0) return false;
  }
  return true;
}

/** All legal anchor positions for a piece on a board. */
export function legalPlacements(board, piece) {
  const out = [];
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (canPlace(board, r, c, piece)) out.push([r, c]);
    }
  }
  return out;
}

/** Does any piece in the offer fit anywhere? Null offer slots are skipped. */
export function anyFit(board, offer) {
  for (const slot of offer) {
    if (!slot) continue;
    const piece = pieceById(slot.piece);
    if (legalPlacements(board, piece).length > 0) return true;
  }
  return false;
}

/** Find all completed rows and columns (they clear together). */
export function findClears(board) {
  const rows = [], cols = [];
  for (let i = 0; i < BOARD_SIZE; i++) {
    let rowFull = true, colFull = true;
    for (let j = 0; j < BOARD_SIZE; j++) {
      if (board[i][j] === 0) rowFull = false;
      if (board[j][i] === 0) colFull = false;
    }
    if (rowFull) rows.push(i);
    if (colFull) cols.push(i);
  }
  return { rows, cols };
}

/* ------------------------------------------------------------------ */
/* Scoring                                                             */
/* ------------------------------------------------------------------ */

/**
 * Score components for one placement:
 *  - cells:       1 point per cell occupied by the placed piece
 *  - clearCells:  10 points per cell removed by clears
 *  - simultaneous: clearing k>=2 lines at once grants 25*k*(k-1)/2
 *  - combo:       consecutive clearing placements grant 15*(streak-1)
 * All components are integers; formatting happens in presentation only.
 */
export function scoreComponents(placedCells, clearedCells, lineCount, comboStreak) {
  const cells = placedCells;
  const clear = clearedCells * 10;
  const simultaneous = lineCount >= 2 ? 25 * (lineCount * (lineCount - 1)) / 2 : 0;
  const combo = comboStreak >= 2 ? 15 * (comboStreak - 1) : 0;
  return { cells, clear, simultaneous, combo, total: cells + clear + simultaneous + combo };
}

/* ------------------------------------------------------------------ */
/* State construction                                                  */
/* ------------------------------------------------------------------ */

/** Weighted piece pool for a difficulty tier ceiling (0 easy, 1 medium, 2 hard). */
export function piecePool(maxTier) {
  const pool = [];
  for (const p of PIECES) {
    if (p.tier > maxTier) continue;
    const w = p.tier === 0 ? 4 : p.tier === 1 ? 3 : 2;
    for (let i = 0; i < w; i++) pool.push(p.id);
  }
  return pool;
}

function drawOffer(rng, pool) {
  const offer = [];
  for (let i = 0; i < OFFER_COUNT; i++) {
    offer.push({ piece: pool[rng.int(pool.length)], hue: rng.int(6) });
  }
  return offer;
}

/**
 * Create the initial state for a session.
 * options: { seed, maxTier, board (optional prefilled board, array rows of ints),
 *            goal: {type:'score', target} | {type:'lines', target} | {type:'moves', target} | null,
 *            moveLimit (optional) }
 */
export function initialState(options = {}) {
  const seed = (options.seed >>> 0) || 1;
  const rng = createRng(seed);
  const maxTier = options.maxTier == null ? 1 : options.maxTier;
  const pool = piecePool(maxTier);
  const board = options.board ? options.board.map(r => r.slice()) : emptyBoard();
  const offer = drawOffer(rng, pool);
  return {
    v: RULES_VERSION,
    seed,
    rngState: rng.state(),
    maxTier,
    board,
    offer,
    turn: 0,
    comboStreak: 0,
    invalid: 0,
    score: { cells: 0, clear: 0, simultaneous: 0, combo: 0, total: 0 },
    lines: 0,
    placedPieces: 0,
    goal: options.goal || null,
    moveLimit: options.moveLimit || null,
    over: false,
    won: false,
    reason: null
  };
}

/* ------------------------------------------------------------------ */
/* Command validation and resolution                                   */
/* ------------------------------------------------------------------ */

export const ERR = Object.freeze({
  OVER: 'round-over',
  BAD_SLOT: 'bad-offer-slot',
  SLOT_USED: 'offer-slot-empty',
  BOUNDS: 'out-of-bounds',
  OCCUPIED: 'cell-occupied',
  NO_FIT: 'piece-does-not-fit',
  NO_UNDO: 'undo-not-available',
  BAD_COMMAND: 'malformed-command'
});

/**
 * Validate a command without mutating state.
 * Returns { ok: true } or { ok: false, reason }.
 */
export function validateCommand(state, cmd) {
  if (!cmd || typeof cmd !== 'object') return { ok: false, reason: ERR.BAD_COMMAND };
  const type = cmd.type || 'place'; // replay logs may omit the default type
  if (type === 'undo') return state.undo ? { ok: true } : { ok: false, reason: ERR.NO_UNDO };
  if (type !== 'place') return { ok: false, reason: ERR.BAD_COMMAND };
  if (state.over) return { ok: false, reason: ERR.OVER };
  const slot = cmd.slot;
  if (!Number.isInteger(slot) || slot < 0 || slot >= OFFER_COUNT) return { ok: false, reason: ERR.BAD_SLOT };
  if (!state.offer[slot]) return { ok: false, reason: ERR.SLOT_USED };
  const row = cmd.row, col = cmd.col;
  if (!Number.isInteger(row) || !Number.isInteger(col)) return { ok: false, reason: ERR.BOUNDS };
  const piece = pieceById(state.offer[slot].piece);
  for (const [dr, dc] of piece.cells) {
    const r = row + dr, c = col + dc;
    if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) return { ok: false, reason: ERR.BOUNDS };
    if (state.board[r][c] !== 0) return { ok: false, reason: ERR.OCCUPIED };
  }
  if (!canPlace(state.board, row, col, piece)) return { ok: false, reason: ERR.NO_FIT };
  return { ok: true };
}

function cloneState(s) {
  return {
    ...s,
    board: s.board.map(r => r.slice()),
    offer: s.offer.slice(),
    score: { ...s.score },
    goal: s.goal ? { ...s.goal } : null,
    undo: s.undo || null
  };
}

function addScore(acc, part) {
  acc.cells += part.cells;
  acc.clear += part.clear;
  acc.simultaneous += part.simultaneous;
  acc.combo += part.combo;
  acc.total += part.total;
}

function finish(state, won, reason) {
  state.over = true;
  state.won = won;
  state.reason = reason;
}

function checkTerminal(state) {
  if (state.over) return;
  if (state.goal) {
    const g = state.goal;
    const met =
      (g.type === 'score' && state.score.total >= g.target) ||
      (g.type === 'lines' && state.lines >= g.target) ||
      (g.type === 'moves' && state.placedPieces >= g.target);
    if (met) return finish(state, true, 'goal-complete');
    if (state.moveLimit != null && state.placedPieces >= state.moveLimit) {
      return finish(state, false, 'move-limit');
    }
  }
  if (!anyFit(state.board, state.offer)) finish(state, false, 'no-fit');
}

/**
 * Apply a validated command; returns a NEW state (input is not mutated).
 * Invalid commands bump `invalid` (counted for tie-breaking) but otherwise
 * leave the game untouched. Undo restores the snapshot taken before the
 * previous placement; undo is single-step and only offered where enabled.
 */
export function applyCommand(state, cmd) {
  const check = validateCommand(state, cmd);
  if (!check.ok) {
    if (check.reason === ERR.BAD_COMMAND || check.reason === ERR.OVER) return state;
    const s = cloneState(state);
    s.invalid += 1;
    return s;
  }

  if (cmd.type === 'undo') {
    const s = cloneState(state.undo.snapshot);
    s.undo = null; // single-step undo
    return s;
  }

  const s = cloneState(state);
  s.undo = { snapshot: cloneState(state) }; // enable one-step undo after this move

  const slot = s.offer[cmd.slot];
  const piece = pieceById(slot.piece);
  const hue = slot.hue;

  for (const [dr, dc] of piece.cells) s.board[cmd.row + dr][cmd.col + dc] = hue + 1;
  s.offer[cmd.slot] = null;
  s.placedPieces += 1;

  const clears = findClears(s.board);
  const lineCount = clears.rows.length + clears.cols.length;
  let clearedCells = 0;
  if (lineCount > 0) {
    const clearRows = new Set(clears.rows), clearCols = new Set(clears.cols);
    for (let r = 0; r < BOARD_SIZE; r++) {
      for (let c = 0; c < BOARD_SIZE; c++) {
        if (s.board[r][c] !== 0 && (clearRows.has(r) || clearCols.has(c))) {
          s.board[r][c] = 0;
          clearedCells++;
        }
      }
    }
    s.comboStreak += 1;
    s.lines += lineCount;
  } else {
    s.comboStreak = 0;
  }

  const part = scoreComponents(piece.cells.length, clearedCells, lineCount, s.comboStreak);
  addScore(s.score, part);
  s.lastGain = { ...part, lines: lineCount, clearedCells, comboStreak: s.comboStreak };
  s.turn += 1;

  // Replenish when the whole offer has been used.
  if (s.offer.every(o => o === null)) {
    const rng = createRng(s.seed);
    rng.restore(s.rngState);
    s.offer = drawOffer(rng, piecePool(s.maxTier));
    s.rngState = rng.state();
  }

  checkTerminal(s);
  return s;
}

/* ------------------------------------------------------------------ */
/* Hints — use the same legality API as play                           */
/* ------------------------------------------------------------------ */

/** First legal placement for any offered piece (deterministic scan order). */
export function findHint(state) {
  if (state.over) return null;
  for (let i = 0; i < OFFER_COUNT; i++) {
    const slot = state.offer[i];
    if (!slot) continue;
    const piece = pieceById(slot.piece);
    const spots = legalPlacements(state.board, piece);
    if (spots.length) return { slot: i, row: spots[0][0], col: spots[0][1] };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Serialization and hashing                                           */
/* ------------------------------------------------------------------ */

/** Stable FNV-1a hash over the full logical state. */
export function hashState(state) {
  let h = 2166136261 >>> 0;
  const mix = (x) => {
    x = x >>> 0;
    for (let i = 0; i < 4; i++) {
      h ^= (x >>> (i * 8)) & 0xff;
      h = Math.imul(h, 16777619) >>> 0;
    }
  };
  mix(state.v); mix(state.seed); mix(state.rngState); mix(state.maxTier);
  for (let r = 0; r < BOARD_SIZE; r++) for (let c = 0; c < BOARD_SIZE; c++) mix(state.board[r][c]);
  for (let i = 0; i < OFFER_COUNT; i++) {
    const o = state.offer[i];
    if (o) { mix(1); for (const ch of o.piece) mix(ch.charCodeAt(0)); mix(o.hue); }
    else mix(0);
  }
  mix(state.turn); mix(state.comboStreak); mix(state.invalid); mix(state.lines); mix(state.placedPieces);
  mix(state.score.cells); mix(state.score.clear); mix(state.score.simultaneous); mix(state.score.combo);
  mix(state.over ? 1 : 0); mix(state.won ? 1 : 0);
  return h >>> 0;
}

export function serializeState(state) {
  return JSON.stringify({
    v: state.v,
    seed: state.seed,
    rngState: state.rngState,
    maxTier: state.maxTier,
    board: state.board.map(r => r.join('')).join(''),
    offer: state.offer.map(o => (o ? o.piece + ':' + o.hue : '-')).join('|'),
    turn: state.turn,
    comboStreak: state.comboStreak,
    invalid: state.invalid,
    score: state.score,
    lines: state.lines,
    placedPieces: state.placedPieces,
    goal: state.goal,
    moveLimit: state.moveLimit,
    over: state.over,
    won: state.won,
    reason: state.reason,
    hash: hashState(state)
  });
}

export function parseState(text) {
  const o = JSON.parse(String(text));
  if (!o || typeof o !== 'object') throw new Error('bad payload');
  if (o.v !== RULES_VERSION) throw new Error('unsupported version ' + o.v);
  if (!/^[0-9]{100}$/.test(o.board)) throw new Error('bad board');
  const board = [];
  for (let r = 0; r < BOARD_SIZE; r++) {
    const row = [];
    for (let c = 0; c < BOARD_SIZE; c++) row.push(o.board.charCodeAt(r * BOARD_SIZE + c) - 48);
    board.push(row);
  }
  const offerParts = String(o.offer).split('|');
  if (offerParts.length !== OFFER_COUNT) throw new Error('bad offer');
  const offer = offerParts.map(part => {
    if (part === '-') return null;
    const [id, hue] = part.split(':');
    pieceById(id); // throws on unknown piece
    const h = Number(hue);
    if (!Number.isInteger(h) || h < 0 || h > 5) throw new Error('bad hue');
    return { piece: id, hue: h };
  });
  const num = (x, name) => {
    const n = Number(x);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('bad ' + name);
    return n;
  };
  const state = {
    v: o.v,
    seed: num(o.seed, 'seed'),
    rngState: num(o.rngState, 'rngState'),
    maxTier: num(o.maxTier, 'maxTier'),
    board, offer,
    turn: num(o.turn, 'turn'),
    comboStreak: num(o.comboStreak, 'comboStreak'),
    invalid: num(o.invalid, 'invalid'),
    score: {
      cells: num(o.score && o.score.cells, 'score.cells'),
      clear: num(o.score && o.score.clear, 'score.clear'),
      simultaneous: num(o.score && o.score.simultaneous, 'score.simultaneous'),
      combo: num(o.score && o.score.combo, 'score.combo'),
      total: num(o.score && o.score.total, 'score.total')
    },
    lines: num(o.lines, 'lines'),
    placedPieces: num(o.placedPieces, 'placedPieces'),
    goal: o.goal && typeof o.goal === 'object' ? { type: String(o.goal.type), target: num(o.goal.target, 'goal.target') } : null,
    moveLimit: o.moveLimit == null ? null : num(o.moveLimit, 'moveLimit'),
    over: !!o.over,
    won: !!o.won,
    reason: o.reason == null ? null : String(o.reason)
  };
  if (hashState(state) !== num(o.hash, 'hash')) throw new Error('state checksum mismatch');
  return state;
}

/* ------------------------------------------------------------------ */
/* Replay                                                              */
/* ------------------------------------------------------------------ */

/**
 * Replay envelope: schema version, build/content version, seed, options,
 * ordered commands, terminal result. Replaying must reproduce the final
 * state hash exactly — this is the core of server-side score validation.
 */
export function makeReplay(options, commands, finalState) {
  return {
    schema: 1,
    rulesVersion: RULES_VERSION,
    options,
    commands,
    finalHash: hashState(finalState),
    result: {
      over: finalState.over,
      won: finalState.won,
      reason: finalState.reason,
      score: { ...finalState.score },
      turns: finalState.turn,
      invalid: finalState.invalid
    }
  };
}

/** Re-run a replay; returns the final state. Throws if malformed. */
export function runReplay(replay) {
  if (!replay || replay.schema !== 1) throw new Error('bad replay schema');
  let state = initialState(replay.options || {});
  for (const cmd of replay.commands || []) state = applyCommand(state, cmd);
  return state;
}

/** Verify a replay reproduces its claimed final hash and result. */
export function verifyReplay(replay) {
  const state = runReplay(replay);
  if (hashState(state) !== replay.finalHash) return { ok: false, reason: 'hash-mismatch' };
  if (state.score.total !== replay.result.score.total) return { ok: false, reason: 'score-mismatch' };
  return { ok: true, state };
}
