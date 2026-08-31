'use strict';

/**
 * Prism Parcel — versioned content: stages, tutorials, dailies, themes,
 * achievements. Pure data + deterministic generators; shared with server.js.
 */

import { createRng } from './rules.js';

export const CONTENT_VERSION = 1;

/* ------------------------------------------------------------------ */
/* Themes — five visual themes, cosmetic only                          */
/* ------------------------------------------------------------------ */

export const THEMES = Object.freeze(['aurora', 'ember', 'frost', 'meadow', 'dusk']);

export const THEME_INFO = Object.freeze({
  aurora: { name: 'Aurora',  bg: 0x101528, key: 0xbfd8ff, fill: 0x4a5f8f, accent: 0x7fe7c4, table: 0x1b2240 },
  ember:  { name: 'Ember',   bg: 0x1d1210, key: 0xffc9a3, fill: 0x8f5a4a, accent: 0xffb054, table: 0x2b1a16 },
  frost:  { name: 'Frost',   bg: 0x0e1a1d, key: 0xd6f4ff, fill: 0x4a7a8f, accent: 0x9fefff, table: 0x16262b },
  meadow: { name: 'Meadow',  bg: 0x121a10, key: 0xe0ffc4, fill: 0x5f8f4a, accent: 0xc4f07f, table: 0x1c2917 },
  dusk:   { name: 'Dusk',    bg: 0x181226, key: 0xe3c9ff, fill: 0x6a4a8f, accent: 0xc99fff, table: 0x241b38 }
});

export function themeInfo(theme) {
  return THEME_INFO[theme] || THEME_INFO.aurora;
}

/* ------------------------------------------------------------------ */
/* Difficulty                                                          */
/* ------------------------------------------------------------------ */

export const DIFFICULTIES = Object.freeze(['easy', 'medium', 'hard']);

export const DIFFICULTY_INFO = Object.freeze({
  easy:   { name: 'Easy',   maxTier: 0, desc: 'Small pieces, generous fits.' },
  medium: { name: 'Medium', maxTier: 1, desc: 'Adds hooks and long bars.' },
  hard:   { name: 'Hard',   maxTier: 2, desc: 'Full piece set, tight boards.' }
});

/* ------------------------------------------------------------------ */
/* Journey stages — 40 authored stages                                 */
/*                                                                      */
/* Schema: id, seed, difficulty, goal, moveLimit, par, theme,          */
/* tutorial flag. Goals ramp: score targets, line targets, move limits. */
/* ------------------------------------------------------------------ */

const STAGE_PLAN = [
  // [difficulty, goalType, base target, moveLimit (0 = none)]
  ['easy',   'score', 150, 0],  ['easy',   'score', 200, 0],  ['easy',   'score', 260, 0],
  ['easy',   'lines', 3, 0],    ['easy',   'score', 320, 0],  ['easy',   'lines', 4, 0],
  ['easy',   'score', 400, 0],  ['easy',   'score', 350, 30], // mastery gate 1
  ['easy',   'score', 480, 0],  ['medium', 'score', 300, 0],  ['medium', 'lines', 4, 0],
  ['medium', 'score', 420, 0],  ['medium', 'lines', 5, 0],    ['medium', 'score', 520, 0],
  ['medium', 'score', 460, 30], ['medium', 'score', 600, 35], // mastery gate 2
  ['medium', 'lines', 6, 0],    ['medium', 'score', 700, 0],  ['medium', 'score', 650, 32],
  ['medium', 'lines', 7, 0],    ['medium', 'score', 800, 0],  ['medium', 'score', 750, 30],
  ['medium', 'score', 850, 34], ['hard',   'score', 500, 0],  // mastery gate 3
  ['hard',   'score', 600, 0],  ['hard',   'lines', 5, 0],    ['hard',   'score', 700, 0],
  ['hard',   'lines', 6, 0],    ['hard',   'score', 800, 0],  ['hard',   'score', 750, 34],
  ['hard',   'lines', 7, 0],    ['hard',   'score', 900, 38], // mastery gate 4
  ['hard',   'score', 1000, 0], ['hard',   'lines', 8, 0],    ['hard',   'score', 1100, 40],
  ['hard',   'score', 950, 34], ['hard',   'lines', 9, 0],    ['hard',   'score', 1200, 0],
  ['hard',   'score', 1100, 38],['hard',   'score', 1400, 45] // final mastery
];

export const STAGES = Object.freeze(STAGE_PLAN.map((p, i) => {
  const [difficulty, goalType, target, moveLimit] = p;
  const seed = 0xC0FFEE + i * 7919;
  return Object.freeze({
    id: i + 1,
    version: CONTENT_VERSION,
    seed,
    difficulty,
    maxTier: DIFFICULTY_INFO[difficulty].maxTier,
    goal: Object.freeze({ type: goalType, target }),
    moveLimit: moveLimit || null,
    par: Math.ceil(target / (goalType === 'lines' ? 1 : 25)),
    theme: THEMES[i % THEMES.length],
    mastery: (i + 1) % 8 === 0,
    tutorial: i === 0
  });
}));

export function stageInfo(id) { return STAGES[id - 1] || null; }
export function stageCount() { return STAGES.length; }

/* ------------------------------------------------------------------ */
/* Daily challenge — one immutable seed per UTC day                     */
/* ------------------------------------------------------------------ */

/** Deterministic daily seed from a UTC date string (YYYY-MM-DD). */
export function dailySeed(dateStr) {
  let h = 2166136261 >>> 0;
  const s = 'prism-parcel-daily:' + dateStr;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function utcDateStr(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Daily ruleset for a UTC day: medium tier, score race against par. */
export function dailyRuleset(dateStr) {
  const seed = dailySeed(dateStr);
  const rng = createRng(seed);
  const target = 500 + rng.int(400);
  return Object.freeze({
    id: 'daily-' + dateStr,
    version: CONTENT_VERSION,
    date: dateStr,
    seed,
    maxTier: 1,
    goal: null, // score chase: play until no fit
    moveLimit: null,
    par: target,
    theme: THEMES[rng.int(THEMES.length)]
  });
}

/* ------------------------------------------------------------------ */
/* Practice setup                                                      */
/* ------------------------------------------------------------------ */

export function practiceOptions(difficulty, seed) {
  const info = DIFFICULTY_INFO[difficulty] || DIFFICULTY_INFO.medium;
  return {
    seed: (seed >>> 0) || ((Math.floor(Math.random() * 0xffffffff)) >>> 0),
    maxTier: info.maxTier,
    goal: null,
    moveLimit: null
  };
}

/* ------------------------------------------------------------------ */
/* Tutorial — interactive lessons, one rule at a time                  */
/* ------------------------------------------------------------------ */

export const TUTORIAL_STEPS = Object.freeze([
  {
    id: 'place',
    title: 'Place a parcel',
    text: 'Select one of the three offered pieces, then place it on an empty space of the board.',
    require: 'place'
  },
  {
    id: 'fill',
    title: 'Fill lines',
    text: 'Complete a full row or column to clear it. Cleared cells are worth 10 points each.',
    require: 'clear'
  },
  {
    id: 'multi',
    title: 'Clear together',
    text: 'Rows and columns clear together. Clearing 2 or more lines at once earns a simultaneous bonus.',
    require: 'place'
  },
  {
    id: 'combo',
    title: 'Chain combos',
    text: 'Clear lines on consecutive placements to build a combo streak for bonus points.',
    require: 'place'
  },
  {
    id: 'end',
    title: 'Watch the board',
    text: 'The round ends when none of the offered pieces fits. Keep space open for large shapes!',
    require: 'place'
  }
]);

export function tutorialSteps() { return TUTORIAL_STEPS; }

/* ------------------------------------------------------------------ */
/* Achievements — stable lowercase keys, idempotent unlocks            */
/* ------------------------------------------------------------------ */

export const ACHIEVEMENTS = Object.freeze([
  Object.freeze({ key: 'first_completion',   name: 'First Light',       desc: 'Finish your first round.' }),
  Object.freeze({ key: 'mechanic_mastery',   name: 'Line Weaver',       desc: 'Clear 3 or more lines in a single placement.' }),
  Object.freeze({ key: 'sustained_streak',   name: 'Streak of Prisms',  desc: 'Reach a combo streak of 4.' }),
  Object.freeze({ key: 'difficult_milestone',name: 'Summit Courier',    desc: 'Complete a hard Journey stage.' }),
  Object.freeze({ key: 'long_term_goal',     name: 'Keeper of Parcels', desc: 'Place 500 pieces across all rounds.' })
]);

export function achievements() { return ACHIEVEMENTS; }

/* ------------------------------------------------------------------ */
/* Mastery track                                                       */
/* ------------------------------------------------------------------ */

export const MASTERY_TIERS = Object.freeze([
  Object.freeze({ name: 'Novice Wrapper',  stars: 0 }),
  Object.freeze({ name: 'Parcel Sorter',   stars: 10 }),
  Object.freeze({ name: 'Prism Handler',   stars: 25 }),
  Object.freeze({ name: 'Route Planner',   stars: 45 }),
  Object.freeze({ name: 'Master Courier',  stars: 70 }),
  Object.freeze({ name: 'Star Hermit',     stars: 100 })
]);

/* ------------------------------------------------------------------ */
/* Content validation (offline validators)                             */
/* ------------------------------------------------------------------ */

/**
 * Validate a stage for basic legality and bounded expectations.
 * Returns { ok, errors[] }.
 */
export function validateStage(stage) {
  const errors = [];
  if (!stage || typeof stage !== 'object') errors.push('missing stage');
  else {
    if (!Number.isSafeInteger(stage.seed)) errors.push('bad seed');
    if (!DIFFICULTY_INFO[stage.difficulty]) errors.push('bad difficulty');
    if (!stage.goal || !['score', 'lines', 'moves'].includes(stage.goal.type)) errors.push('bad goal type');
    if (stage.goal && !(stage.goal.target > 0)) errors.push('bad goal target');
    if (stage.moveLimit != null && !(stage.moveLimit > 0)) errors.push('bad move limit');
    if (!THEMES.includes(stage.theme)) errors.push('bad theme');
    // Bounded duration: score targets must be reachable in sane move counts.
    if (stage.goal && stage.goal.type === 'score' && stage.goal.target > 3000) errors.push('score target too high');
    if (stage.goal && stage.goal.type === 'lines' && stage.goal.target > 20) errors.push('line target too high');
    if (stage.moveLimit != null && stage.moveLimit > 200) errors.push('move limit too high');
  }
  return { ok: errors.length === 0, errors };
}

export function validateAllStages() {
  const bad = [];
  for (const s of STAGES) {
    const r = validateStage(s);
    if (!r.ok) bad.push({ id: s.id, errors: r.errors });
  }
  return { ok: bad.length === 0, bad };
}
