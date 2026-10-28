'use strict';

/**
 * Prism Parcel — the save document, its merge, the end-of-round bookkeeping
 * (best scores, stars, Journey unlocks, daily bests, achievements, the
 * tutorial flag), the resumable round snapshot and the game's own options.
 * Pure (no storage, no platform): the engine client (native/platform.ts,
 * native/main.ts) and the node tests share it. Moved here from the browser
 * build's src/platform.js (mergeProgress) and src/main.js (endRound,
 * checkAchievements, saveSnapshot / tryResumeSnapshot), unchanged in what
 * they decide.
 *
 * The engine save is { v, progress }: progress is the document the browser
 * build kept in localStorage (prism-parcel:progress:v1) and mirrored, with
 * its settings, to the cloud slot game:<slug> as { v, savedAt, settings,
 * progress }. readForeign() reads that cloud text; its settings carry the
 * game's own options over.
 */

import { serializeState, parseState } from './rules.js';
import { stageInfo, stageCount, ACHIEVEMENTS, MASTERY_TIERS, TUTORIAL_STEPS, THEMES } from './content.js';

export const SAVE_VERSION = 1;
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const clone = (x) => JSON.parse(JSON.stringify(x));

/** main.js's progress defaults. */
export function emptyProgress() {
  return { stage: 1, stars: {}, bestScores: {}, achievements: {}, tutorialDone: false, totalPlaced: 0, dailyBest: {}, friends: [] };
}

/** A progress document from anything (missing fields from the empty one). */
export function normalizeProgress(raw) {
  const p = obj(raw) ? clone(raw) : {};
  const out = { ...emptyProgress(), ...p };
  for (const k of ['stars', 'bestScores', 'achievements', 'dailyBest']) out[k] = obj(out[k]) || {};
  out.stage = Math.min(stageCount(), Math.max(1, Math.floor(num(out.stage)) || 1));
  out.totalPlaced = num(out.totalPlaced);
  out.tutorialDone = !!out.tutorialDone;
  out.friends = Array.isArray(out.friends) ? out.friends : [];
  return out;
}

export function defaultSave() { return { v: SAVE_VERSION, progress: emptyProgress() }; }
/** A save document from anything. */
export function normalize(raw) {
  const d = obj(raw) || {};
  return { v: SAVE_VERSION, progress: normalizeProgress(d.progress) };
}

/**
 * Progress merge (start-up load and `saveconflict`): neither device's progress
 * is dropped. Journey unlock and lifetime counters take the larger value,
 * stars / best scores / daily bests the better one per stage or day,
 * achievements the earliest unlock; tutorial done if either finished it;
 * friends are the union. (platform.js mergeProgress, unchanged.)
 */
export function mergeProgress(remote, local) {
  const r = remote && typeof remote === 'object' ? remote : {};
  const l = local && typeof local === 'object' ? local : {};
  const o = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const maxMap = (a, b) => {
    const out = { ...o(a) };
    for (const [k, v] of Object.entries(o(b))) out[k] = Math.max(num(out[k]), num(v));
    return out;
  };
  const achievements = { ...o(r.achievements) };
  for (const [k, v] of Object.entries(o(l.achievements))) {
    achievements[k] = achievements[k] ? Math.min(num(achievements[k]), num(v)) : v;
  }
  const friends = [...new Set([...(Array.isArray(r.friends) ? r.friends : []), ...(Array.isArray(l.friends) ? l.friends : [])])];
  return {
    stage: Math.max(num(r.stage), num(l.stage), 1),
    stars: maxMap(r.stars, l.stars),
    bestScores: maxMap(r.bestScores, l.bestScores),
    achievements,
    tutorialDone: !!(r.tutorialDone || l.tutorialDone),
    totalPlaced: Math.max(num(r.totalPlaced), num(l.totalPlaced)),
    dailyBest: maxMap(r.dailyBest, l.dailyBest),
    friends,
  };
}

/** Merge two saves (another device saved since, or the old cloud slot). */
export function mergeSave(remote, local) {
  const a = normalize(remote), b = normalize(local);
  return { v: SAVE_VERSION, progress: normalizeProgress(mergeProgress(a.progress, b.progress)) };
}
export function sameSave(a, b) { return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b)); }

/* ---- the game's own options (engine `settings`, kept with the account) ---- */

/** The browser build's game-owned settings (main.js DEFAULT_SETTINGS minus what the runtime's Options own). */
export const DEFAULT_OPTIONS = Object.freeze({ theme: 'aurora', cvdPalette: false, captions: true, leftHanded: false, haptics: true });
export const OPTION_KEYS = Object.keys(DEFAULT_OPTIONS);
/** Every key the browser build patched into the account's settings KV (all removed after migrating). */
export const BROWSER_KEYS = ['music', 'effects', 'ambience', 'voice', 'muted', 'graphics', 'theme', 'reducedMotion', 'highContrast',
  'largeText', 'cvdPalette', 'captions', 'leftHanded', 'haptics', 'quality'];

/** The valid game options among any settings object. */
export function pickOptions(raw) {
  const s = obj(raw) || {};
  const out = {};
  if (typeof s.theme === 'string' && THEMES.includes(s.theme)) out.theme = s.theme;
  for (const k of ['cvdPalette', 'captions', 'leftHanded', 'haptics']) if (typeof s[k] === 'boolean') out[k] = s[k];
  return out;
}

/**
 * The browser build's cloud slot text ({ v, savedAt, settings, progress } through the JS SDK's
 * saveJSON): { save, options }, or null.
 */
export function readForeign(text) {
  if (typeof text !== 'string' || !text) return null;
  try {
    const d = JSON.parse(text);
    if (!obj(d)) return null;
    if (obj(d.progress)) return { save: normalize({ progress: d.progress }), options: pickOptions(d.settings) };
    if ('stars' in d || 'bestScores' in d || 'achievements' in d) return { save: normalize({ progress: d }), options: {} };
    return null;
  } catch (e) { return null; }
}

/* ---- the end of a round (main.js endRound + checkAchievements) ---- */

/** Stars for a won Journey stage: the goal's own metric against its target (×1.5 three, ×1.2 two). */
export function starsFor(stage, state) {
  const metric = stage.goal.type === 'lines' ? state.lines : stage.goal.type === 'moves' ? state.placedPieces : state.score.total;
  return metric >= stage.goal.target * 1.5 ? 3 : metric >= stage.goal.target * 1.2 ? 2 : 1;
}

/**
 * Records a finished round in `p` (mutated). round: { mode, stageId, dailyDate, state, maxLines,
 * maxCombo, tutorialStep, now }. Returns { newly: [achievement keys in unlock order], stars, prevBest }.
 */
export function recordRound(p, round) {
  const s = round.state;
  const newly = [];
  p.totalPlaced += s.placedPieces;
  const unlock = (key) => {
    if (p.achievements[key]) return;
    p.achievements[key] = round.now;
    newly.push(key);
  };
  if (s.over) unlock('first_completion');
  if (round.maxLines >= 3) unlock('mechanic_mastery');
  if (round.maxCombo >= 4) unlock('sustained_streak');
  if (round.mode === 'journey' && s.won) {
    const stage = stageInfo(round.stageId);
    if (stage && stage.difficulty === 'hard') unlock('difficult_milestone');
  }
  if (p.totalPlaced >= 500) unlock('long_term_goal');

  let stars = 0, prevBest = 0;
  if (round.mode === 'journey' && round.stageId) {
    prevBest = p.bestScores['stage' + round.stageId] || 0;
    if (s.score.total > prevBest) p.bestScores['stage' + round.stageId] = s.score.total;
    if (s.won) {
      stars = starsFor(stageInfo(round.stageId), s);
      p.stars[round.stageId] = Math.max(p.stars[round.stageId] || 0, stars);
      if (round.stageId === p.stage && p.stage < stageCount()) p.stage++;
    }
  }
  if (round.mode === 'daily' && round.dailyDate) {
    prevBest = p.dailyBest[round.dailyDate] || 0;
    if (s.score.total > prevBest) p.dailyBest[round.dailyDate] = s.score.total;
  }
  if (round.mode === 'learn' && round.tutorialStep >= TUTORIAL_STEPS.length) p.tutorialDone = true;
  return { newly, stars, prevBest };
}

/** The unlocked achievements in content order. */
export function unlockedAchievements(p) { return ACHIEVEMENTS.filter((a) => p.achievements[a.key]); }

/** Total stars and the mastery rank they earn (main.js updateTitleProgress). */
export function mastery(p) {
  const stars = Object.values(p.stars).reduce((a, b) => a + num(b), 0);
  const tier = [...MASTERY_TIERS].reverse().find((t) => stars >= t.stars) || MASTERY_TIERS[0];
  return { stars, rank: tier.name };
}

/* ---- the resumable round (main.js saveSnapshot / tryResumeSnapshot; kept on the device) ---- */

/** The snapshot of a round in progress (Daily rounds are never kept, as before). */
export function makeSnapshot(r) {
  return {
    mode: r.mode, options: r.options, stageId: r.stageId, tutorialStep: r.tutorialStep, dailyDate: r.dailyDate,
    elapsedMs: r.elapsedMs, maxCombo: r.maxCombo, maxLines: r.maxLines,
    commands: r.commands, state: JSON.parse(serializeState(r.state)),
  };
}

/** A stored snapshot back as a round to continue, or null (missing, finished or tampered). */
export function readSnapshot(raw) {
  if (!obj(raw) || !raw.state || !raw.options) return null;
  try {
    const state = parseState(JSON.stringify(raw.state));
    if (state.over) return null;
    const mode = raw.mode || 'practice';
    const tutorialStep = Number.isInteger(raw.tutorialStep) ? raw.tutorialStep : 0;
    return {
      mode, options: raw.options, state,
      commands: Array.isArray(raw.commands) ? raw.commands : [],
      stageId: raw.stageId || null, dailyDate: raw.dailyDate || null,
      maxCombo: Number.isFinite(raw.maxCombo) ? raw.maxCombo : 0,
      maxLines: Number.isFinite(raw.maxLines) ? raw.maxLines : 0,
      elapsedMs: Number.isFinite(raw.elapsedMs) ? Math.max(0, raw.elapsedMs) : 0,
      tutorialStep,
      tutorial: mode === 'learn' && tutorialStep < TUTORIAL_STEPS.length,
    };
  } catch (e) { return null; }
}
