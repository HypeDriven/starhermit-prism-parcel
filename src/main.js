'use strict';

/**
 * Prism Parcel — bootstrap + session + UI + platform adapter.
 * Owns the screen state machine and every input path; rules state is only
 * ever changed through validated commands (rules.applyCommand).
 */

import {
  BOARD_SIZE, OFFER_COUNT, pieceById, initialState, applyCommand, validateCommand,
  findHint, serializeState, parseState, makeReplay, PIECES
} from './rules.js';
import {
  STAGES, stageInfo, stageCount, THEMES, themeInfo, DIFFICULTIES, DIFFICULTY_INFO,
  dailyRuleset, utcDateStr, practiceOptions, TUTORIAL_STEPS, ACHIEVEMENTS,
  MASTERY_TIERS, CONTENT_VERSION
} from './content.js';
import { Renderer, QUALITY_TIERS } from './render.js';
import * as audio from './audio.js';

const $ = id => document.getElementById(id);

/* ================================================================== */
/* Persistence (settings, progress, saves)                            */
/* ================================================================== */

const SETTINGS_KEY = 'prism-parcel:settings:v1';
const PROGRESS_KEY = 'prism-parcel:progress:v1';
const SAVE_KEY = 'prism-parcel:save:v1';

const DEFAULT_SETTINGS = {
  music: 0.5, effects: 0.8, ambience: 0.4, voice: 0.6,
  muted: false, quality: 'high', theme: 'aurora',
  reducedMotion: false, highContrast: false, largeText: false,
  cvdPalette: false, captions: true, leftHanded: false, haptics: true
};

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { ...fallback };
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? { ...fallback, ...o } : { ...fallback };
  } catch (e) { return { ...fallback }; }
}

function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage full/blocked */ }
}

const settings = loadJSON(SETTINGS_KEY, DEFAULT_SETTINGS);
const progress = loadJSON(PROGRESS_KEY, {
  stage: 1, stars: {}, bestScores: {}, achievements: {}, tutorialDone: false,
  totalPlaced: 0, dailyBest: {}, friends: []
});

function persistSettings() { saveJSON(SETTINGS_KEY, settings); }
function persistProgress() { saveJSON(PROGRESS_KEY, progress); }

/* ================================================================== */
/* Platform adapter — same-origin /api, offline-tolerant              */
/* ================================================================== */

const platform = {
  serverOffset: 0, // server time minus client time (ms)
  online: false,

  async api(path, opts = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
      const res = await fetch(path, {
        ...opts,
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 429) throw Object.assign(new Error('rate-limited'), { code: 'rate-limited' });
      if (!res.ok) throw Object.assign(new Error(body.error || ('http-' + res.status)), { code: body.error || res.status });
      return body;
    } finally { clearTimeout(timer); }
  },

  /** Synchronize with GET /api/v1/time using round-trip adjustment. */
  async syncTime() {
    try {
      const t0 = Date.now();
      const r = await this.api('/api/v1/time');
      const t1 = Date.now();
      if (typeof r.now === 'number') {
        this.serverOffset = r.now - (t0 + (t1 - t0) / 2);
        this.online = true;
      }
    } catch (e) { this.online = false; }
  },

  now() { return Date.now() + this.serverOffset; },

  async submitDaily(entry) {
    try { return await this.api('/api/v1/daily/score', { method: 'POST', body: JSON.stringify(entry) }); }
    catch (e) { return { ok: false, error: e.message }; }
  },

  async dailyBoard(date) {
    try { return await this.api('/api/v1/daily/leaderboard?date=' + encodeURIComponent(date)); }
    catch (e) { return { ok: false, entries: [] }; }
  },

  async unlockAchievement(key) {
    try { await this.api('/api/v1/achievements', { method: 'POST', body: JSON.stringify({ key }) }); }
    catch (e) { /* offline: kept locally */ }
  }
};

/* ================================================================== */
/* Session — one active round                                         */
/* ================================================================== */

const session = {
  mode: null,          // 'learn' | 'journey' | 'daily' | 'practice' | 'challenge'
  state: null,
  commands: [],        // ordered input log for replay
  cmdSeq: 0,
  options: null,
  stageId: null,
  dailyDate: null,
  startTime: 0,
  pausedAt: 0,
  pausedTotal: 0,
  selectedSlot: null,
  cursor: { row: 0, col: 0 },
  tutorialStep: 0,
  over: false
};

let renderer = null;
let rafId = 0;
let lastFrame = 0;
let appState = 'boot'; // boot → title → mode-select → preparing → tutorial/countdown → active ↔ paused → resolving → results → progression
let currentScreen = 'title';

/* ================================================================== */
/* Announcements + captions                                           */
/* ================================================================== */

let liveTimer = 0;
function announce(msg, assertive = false) {
  const el = $(assertive ? 'live-assertive' : 'live');
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => { el.textContent = msg; }, 30);
}

function caption(soundEvent) {
  if (!settings.captions) return;
  const text = audio.describeEvent(soundEvent);
  if (text) announce(text);
}

/* ================================================================== */
/* Screen management                                                  */
/* ================================================================== */

const SCREENS = ['title-screen', 'setup-screen', 'game-screen', 'results-screen'];

function showScreen(name) {
  currentScreen = name;
  for (const s of SCREENS) $(s).hidden = (s !== name);
  if (name === 'game-screen') {
    $('game-screen').focus({ preventScroll: true });
    renderer && renderer.resize();
  }
}

function openOverlay(id) {
  const el = $(id);
  el.hidden = false;
  el.dataset.returnFocus = document.activeElement && document.activeElement.id || '';
  const first = el.querySelector('button');
  first && first.focus();
}

function closeOverlay(id) {
  const el = $(id);
  el.hidden = true;
  const back = el.dataset.returnFocus && $(el.dataset.returnFocus);
  back ? back.focus() : ($('game-screen').hidden || $('game-screen').focus({ preventScroll: true }));
}

/* ================================================================== */
/* Settings UI                                                        */
/* ================================================================== */

function buildSettings() {
  const body = $('settings-body');
  body.innerHTML = '';
  const row = (label, control) => {
    const l = document.createElement('label');
    const span = document.createElement('span');
    span.textContent = label;
    l.append(span, control);
    body.append(l);
    return control;
  };
  const slider = (key, min = 0, max = 1, step = 0.05) => {
    const i = document.createElement('input');
    i.type = 'range'; i.min = min; i.max = max; i.step = step; i.value = settings[key];
    i.addEventListener('input', () => { settings[key] = Number(i.value); applySettings(); persistSettings(); });
    return i;
  };
  const toggle = (key) => {
    const i = document.createElement('input');
    i.type = 'checkbox'; i.checked = !!settings[key];
    i.addEventListener('change', () => { settings[key] = i.checked; applySettings(); persistSettings(); });
    return i;
  };
  const select = (key, options, labels) => {
    const s = document.createElement('select');
    for (const v of options) {
      const o = document.createElement('option');
      o.value = v; o.textContent = labels ? labels[v] : v;
      s.append(o);
    }
    s.value = settings[key];
    s.addEventListener('change', () => { settings[key] = s.value; applySettings(); persistSettings(); });
    return s;
  };

  row('Music volume', slider('music'));
  row('Effects volume', slider('effects'));
  row('Ambience volume', slider('ambience'));
  row('Voice/cue volume', slider('voice'));
  row('Mute all', toggle('muted'));
  row('Graphics quality', select('quality', Object.keys(QUALITY_TIERS)));
  row('Visual theme', select('theme', THEMES, Object.fromEntries(THEMES.map(t => [t, themeInfo(t).name]))));
  row('Reduced motion', toggle('reducedMotion'));
  row('High contrast', toggle('highContrast'));
  row('Larger text', toggle('largeText'));
  row('Color-vision-safe palette', toggle('cvdPalette'));
  row('Sound captions', toggle('captions'));
  row('Left-handed controls', toggle('leftHanded'));
  row('Haptics', toggle('haptics'));

  const replayTut = document.createElement('button');
  replayTut.textContent = 'Replay tutorial';
  replayTut.addEventListener('click', () => { closeOverlay('settings-overlay'); startLearn(); });
  row('Tutorial', replayTut);
}

function applySettings() {
  audio.setBusVolume('music', settings.music);
  audio.setBusVolume('effects', settings.effects);
  audio.setBusVolume('ambience', settings.ambience);
  audio.setBusVolume('voice', settings.voice);
  audio.setMuted(settings.muted);
  document.body.classList.toggle('high-contrast', settings.highContrast);
  document.body.classList.toggle('large-text', settings.largeText);
  if (renderer) {
    renderer.reducedMotion = settings.reducedMotion;
    renderer.cvdPalette = settings.cvdPalette;
    if (renderer.tierName !== settings.quality || renderer.theme !== settings.theme) rebuildRenderer();
    else if (session.state) {
      renderer.applyBoard(session.state.board);
      renderer.applyOffer(session.state.offer, session.selectedSlot);
    }
  }
}

function rebuildRenderer() {
  const old = renderer;
  if (old) old.dispose();
  renderer = new Renderer($('gl'), {
    theme: settings.theme,
    quality: settings.quality,
    reducedMotion: settings.reducedMotion,
    cvdPalette: settings.cvdPalette
  });
  if (session.state) {
    renderer.applyBoard(session.state.board);
    renderer.applyOffer(session.state.offer, session.selectedSlot);
  }
}

/* ================================================================== */
/* Round lifecycle                                                    */
/* ================================================================== */

function startRound(mode, options, meta = {}) {
  session.mode = mode;
  session.options = options;
  session.state = initialState(options);
  session.commands = [];
  session.cmdSeq = 0;
  session.stageId = meta.stageId || null;
  session.dailyDate = meta.dailyDate || null;
  session.tutorialStep = 0;
  session.selectedSlot = null;
  session.cursor = { row: 4, col: 4 };
  session.over = false;
  session.startTime = Date.now();
  session.pausedTotal = 0;
  appState = 'active';

  audio.seedVariants(options.seed);
  if (!renderer) rebuildRenderer();
  renderer.applyBoard(session.state.board);
  renderer.applyOffer(session.state.offer, null);
  renderer.hideGhost();
  buildRails();
  buildOfferTray();
  buildBoardMirror();
  updateHUD();
  showScreen('game-screen');
  announce(objectiveText() + ' Round started.');

  if (mode === 'learn') {
    appState = 'tutorial';
    showTutorialStep(0);
  }
}

function objectiveText() {
  const g = session.state && session.state.goal;
  if (session.mode === 'daily') return 'Daily: highest score';
  if (session.mode === 'practice') return 'Practice: play freely';
  if (session.mode === 'learn') return 'Learn: follow the lessons';
  if (!g) return 'Score as high as you can';
  const what = g.type === 'score' ? `${g.target} points` : g.type === 'lines' ? `${g.target} lines` : `${g.target} placements`;
  const limit = session.state.moveLimit ? ` in ${session.state.moveLimit} moves` : '';
  return `Goal: ${what}${limit}`;
}

function endRound() {
  session.over = true;
  appState = 'results';
  const s = session.state;
  progress.totalPlaced += s.placedPieces;
  checkAchievements(s);

  // Persist best scores / stars.
  if (session.mode === 'journey' && session.stageId) {
    const best = progress.bestScores['stage' + session.stageId] || 0;
    if (s.score.total > best) progress.bestScores['stage' + session.stageId] = s.score.total;
    if (s.won) {
      const stage = stageInfo(session.stageId);
      const stars = s.score.total >= stage.goal.target * 1.5 ? 3 : s.score.total >= stage.goal.target * 1.2 ? 2 : 1;
      progress.stars[session.stageId] = Math.max(progress.stars[session.stageId] || 0, stars);
      if (session.stageId === progress.stage && progress.stage < stageCount()) progress.stage++;
    }
  }
  if (session.mode === 'daily' && session.dailyDate) {
    const best = progress.dailyBest[session.dailyDate] || 0;
    if (s.score.total > best) progress.dailyBest[session.dailyDate] = s.score.total;
    submitDailyScore();
  }
  if (session.mode === 'learn') progress.tutorialDone = true;
  persistProgress();
  try { localStorage.removeItem(SAVE_KEY); } catch (e) {}

  if (s.won) { audio.playWin(); caption('win'); } else { audio.playOver(); caption('over'); }
  showResults();
}

function checkAchievements(s) {
  const unlock = (key) => {
    if (progress.achievements[key]) return;
    progress.achievements[key] = Date.now();
    audio.playAchievement();
    caption('achievement');
    announce(`Achievement unlocked: ${ACHIEVEMENTS.find(a => a.key === key).name}`, true);
    platform.unlockAchievement(key);
  };
  if (s.over) unlock('first_completion');
  if (s.lastGain && s.lastGain.lines >= 3) unlock('mechanic_mastery');
  if (s.comboStreak >= 4 || (s.lastGain && s.lastGain.comboStreak >= 4)) unlock('sustained_streak');
  if (session.mode === 'journey' && s.won) {
    const stage = stageInfo(session.stageId);
    if (stage && stage.difficulty === 'hard') unlock('difficult_milestone');
  }
  if (progress.totalPlaced >= 500) unlock('long_term_goal');
}

async function submitDailyScore() {
  const replay = makeReplay(session.options, session.commands, session.state);
  const entry = {
    date: session.dailyDate,
    contentVersion: CONTENT_VERSION,
    seed: session.options.seed,
    settings: { maxTier: session.options.maxTier },
    replay,
    elapsedMs: elapsedTime()
  };
  const res = await platform.submitDaily(entry);
  const el = $('results-compare');
  if (res && res.ok) {
    el.textContent = `Daily rank: #${res.rank} of ${res.count} (validated ✓)`;
  } else {
    el.textContent = 'Daily score saved locally — server validation unavailable (casual board).';
  }
}

function elapsedTime() {
  return Date.now() - session.startTime - session.pausedTotal;
}

/* ================================================================== */
/* Commands                                                           */
/* ================================================================== */

let lastCmdId = 0;
function issueCommand(cmd) {
  if (!session.state || session.state.over) return false;
  cmd.id = 'c' + (++lastCmdId);
  const check = validateCommand(session.state, cmd);
  if (!check.ok) {
    session.state = applyCommand(session.state, cmd); // counts the invalid attempt
    audio.playInvalid(); caption('invalid');
    announce('Invalid action: ' + invalidReasonText(check.reason), true);
    updateHUD();
    return false;
  }
  const before = session.state;
  const pieceHue = before.offer[cmd.slot] ? before.offer[cmd.slot].hue : 0;
  const prevOfferEmpty = before.offer.every(o => o === null);
  session.state = applyCommand(session.state, cmd);
  if (cmd.type === 'place') {
    session.commands.push({ slot: cmd.slot, row: cmd.row, col: cmd.col });
    const gain = session.state.lastGain;
    audio.playPlace(); caption('place');
    haptic(15);
    if (gain && gain.lines > 0) {
      const rowsCols = findClearedLines(before, session.state);
      renderer.animateClears(rowsCols.rows, rowsCols.cols,
        (r, c) => (before.board[r][c] || 1) - 1);
      audio.playClear(gain.lines, gain.comboStreak); caption('clear');
      renderer.shake(Math.min(0.05 + gain.lines * 0.04, 0.25));
      haptic([20, 40, 20]);
      announce(`Cleared ${gain.lines} line${gain.lines > 1 ? 's' : ''} for ${gain.total} points.` +
        (gain.comboStreak >= 2 ? ` Combo x${gain.comboStreak}.` : ''));
    }
    if (!prevOfferEmpty && before.offer.filter(o => o === null).length === OFFER_COUNT - 1 &&
        session.state.offer.every(o => o !== null)) {
      audio.playReplenish(); caption('replenish');
    }
    renderer.applyBoard(session.state.board);
    renderer.applyOffer(session.state.offer, session.selectedSlot);
    buildOfferTray();
    buildBoardMirror();
    saveSnapshot();
    if (session.selectedSlot != null && !session.state.offer[session.selectedSlot]) {
      session.selectedSlot = null;
      renderer.hideGhost();
      renderer.setSelectedSlot(null);
    }
    if (session.mode === 'learn') advanceTutorial(cmd, gain);
    if (session.state.over) {
      setTimeout(() => endRound(), settings.reducedMotion ? 60 : 450);
    }
  }
  updateHUD();
  return true;
}

function findClearedLines(before, after) {
  // A line cleared if it was full before the clear resolution and is empty now.
  const rows = [], cols = [];
  for (let i = 0; i < BOARD_SIZE; i++) {
    let wasRowFull = true, wasColFull = true, nowRowEmpty = true, nowColEmpty = true;
    for (let j = 0; j < BOARD_SIZE; j++) {
      if (before.board[i][j] === 0) wasRowFull = false;
      if (before.board[j][i] === 0) wasColFull = false;
      if (after.board[i][j] !== 0) nowRowEmpty = false;
      if (after.board[j][i] !== 0) nowColEmpty = false;
    }
    if (wasRowFull && nowRowEmpty) rows.push(i);
    if (wasColFull && nowColEmpty) cols.push(i);
  }
  return { rows, cols };
}

function invalidReasonText(reason) {
  switch (reason) {
    case 'round-over': return 'the round is over';
    case 'bad-offer-slot': return 'no such offer slot';
    case 'offer-slot-empty': return 'that piece was already placed';
    case 'out-of-bounds': return 'the piece would leave the board';
    case 'cell-occupied': return 'those cells are occupied';
    case 'piece-does-not-fit': return 'the piece does not fit there';
    default: return reason;
  }
}

function haptic(pattern) {
  if (settings.haptics && navigator.vibrate) { try { navigator.vibrate(pattern); } catch (e) {} }
}

function saveSnapshot() {
  if (session.mode === 'daily') return; // daily reconnects via server snapshot
  try {
    saveJSON(SAVE_KEY, {
      mode: session.mode, options: session.options, stageId: session.stageId,
      commands: session.commands, state: JSON.parse(serializeState(session.state))
    });
  } catch (e) {}
}

function tryResumeSnapshot() {
  const raw = loadJSON(SAVE_KEY, null);
  if (!raw || !raw.state || !raw.options) return false;
  try {
    const state = parseState(JSON.stringify(raw.state));
    if (state.over) return false;
    session.mode = raw.mode || 'practice';
    session.options = raw.options;
    session.commands = raw.commands || [];
    session.state = state;
    session.stageId = raw.stageId || null;
    session.selectedSlot = null;
    session.cursor = { row: 4, col: 4 };
    session.over = false;
    session.startTime = Date.now();
    appState = session.mode === 'learn' ? 'tutorial' : 'active';
    if (!renderer) rebuildRenderer();
    renderer.applyBoard(state.board);
    renderer.applyOffer(state.offer, null);
    buildRails(); buildOfferTray(); buildBoardMirror(); updateHUD();
    showScreen('game-screen');
    announce('Round restored from your last safe snapshot.');
    return true;
  } catch (e) { return false; }
}

/* ================================================================== */
/* HUD, rails, offer tray, board mirror                               */
/* ================================================================== */

function updateHUD() {
  const s = session.state;
  if (!s) return;
  $('hud-score').textContent = String(s.score.total);
  $('hud-objective').textContent = objectiveText();
  $('hud-combo').textContent = s.comboStreak >= 2 ? `Combo x${s.comboStreak}` : '';
  $('btn-undo').disabled = !(s.undo && (session.mode === 'practice' || session.mode === 'learn'));
  $('btn-hint').disabled = s.over;
  const goalStat = $('stat-goal');
  if (goalStat && s.goal) {
    const cur = s.goal.type === 'score' ? s.score.total : s.goal.type === 'lines' ? s.lines : s.placedPieces;
    goalStat.textContent = `${cur} / ${s.goal.target}`;
  }
  const movesStat = $('stat-moves');
  if (movesStat) movesStat.textContent = s.moveLimit ? `${s.placedPieces} / ${s.moveLimit}` : String(s.placedPieces);
}

function buildRails() {
  const s = session.state;
  const left = $('rail-left');
  left.innerHTML = '';
  const obj = document.createElement('div');
  obj.className = 'card';
  obj.innerHTML = `<h3>Objective</h3><p id="rail-objective">${objectiveText()}</p>`;
  left.append(obj);

  const prog = document.createElement('div');
  prog.className = 'card';
  prog.innerHTML = '<h3>Progress</h3>';
  const addStat = (label, id, val) => {
    const d = document.createElement('div');
    d.className = 'stat';
    d.innerHTML = `<span>${label}</span><b id="${id}">${val}</b>`;
    prog.append(d);
  };
  if (s.goal) addStat('Goal', 'stat-goal', `0 / ${s.goal.target}`);
  addStat('Moves', 'stat-moves', '0');
  addStat('Lines', 'stat-lines', '0');
  left.append(prog);

  const right = $('rail-right');
  right.innerHTML = '';
  const status = document.createElement('div');
  status.className = 'card';
  const modeNames = { learn: 'Learn', journey: `Journey ${session.stageId || ''}`, daily: 'Daily Challenge', practice: 'Practice', challenge: 'Challenge' };
  status.innerHTML = `<h3>${modeNames[session.mode] || 'Round'}</h3>
    <div class="stat"><span>Turn</span><b id="stat-turn">0</b></div>
    <div class="stat"><span>Seed</span><b>${session.options.seed.toString(16)}</b></div>`;
  right.append(status);

  if (session.mode === 'daily') {
    const board = document.createElement('div');
    board.className = 'card';
    board.innerHTML = '<h3>Daily Board</h3><div class="friends-list" id="daily-board">Loading…</div>';
    right.append(board);
    refreshDailyBoard();
  }

  const acts = document.createElement('div');
  acts.className = 'card';
  acts.innerHTML = `<h3>Controls</h3>
    <p class="small">Tap a piece, tap a cell — or drag. Keys: 1–3 select, arrows move, Enter place,
    H hint, U undo, Esc pause.</p>`;
  right.append(acts);
}

async function refreshDailyBoard() {
  const el = $('daily-board');
  if (!el || !session.dailyDate) return;
  const res = await platform.dailyBoard(session.dailyDate);
  if (!el.isConnected) return;
  if (!res.ok || !res.entries.length) {
    el.textContent = res.ok ? 'No scores yet today — be the first!' : 'Board unavailable offline.';
    return;
  }
  el.innerHTML = '';
  res.entries.slice(0, 8).forEach((e, i) => {
    const d = document.createElement('div');
    d.className = 'stat';
    d.innerHTML = `<span>#${i + 1} ${e.name || 'Player'}</span><b>${e.score}</b>`;
    el.append(d);
  });
}

function buildOfferTray() {
  const tray = $('offer-tray');
  tray.innerHTML = '';
  for (let i = 0; i < OFFER_COUNT; i++) {
    const slot = session.state.offer[i];
    const b = document.createElement('button');
    b.className = 'offer' + (session.selectedSlot === i ? ' selected' : '') + (slot ? '' : ' used');
    b.id = 'offer-' + i;
    b.textContent = slot ? pieceById(slot.piece).name : 'Placed';
    b.setAttribute('aria-label', slot ? `Select ${pieceById(slot.piece).name}, slot ${i + 1}` : `Slot ${i + 1} empty`);
    b.disabled = !slot;
    b.addEventListener('click', () => selectSlot(i));
    tray.append(b);
  }
}

function buildBoardMirror() {
  // Screen-reader board model: concise, navigable grid of cell states.
  const mirror = $('board-mirror');
  mirror.innerHTML = '';
  const s = session.state;
  for (let r = 0; r < BOARD_SIZE; r++) {
    const row = document.createElement('div');
    row.setAttribute('role', 'row');
    for (let c = 0; c < BOARD_SIZE; c++) {
      const cell = document.createElement('button');
      cell.setAttribute('role', 'gridcell');
      cell.tabIndex = -1;
      cell.className = 'visually-hidden';
      cell.textContent = s.board[r][c] ? `Row ${r + 1} column ${c + 1}, occupied` : `Row ${r + 1} column ${c + 1}, empty`;
      cell.addEventListener('click', () => { session.cursor = { row: r, col: c }; commitAt(r, c); });
      row.append(cell);
    }
    mirror.append(row);
  }
}

function selectSlot(i) {
  if (!session.state.offer[i]) return;
  session.selectedSlot = session.selectedSlot === i ? null : i;
  renderer.setSelectedSlot(session.selectedSlot);
  audio.playSelect();
  buildOfferTray();
  if (session.selectedSlot != null) {
    announce(`${pieceById(session.state.offer[i].piece).name} selected. Choose a cell.`);
    previewAt(session.cursor.row, session.cursor.col);
  } else {
    renderer.hideGhost();
  }
}

function previewAt(row, col) {
  if (session.selectedSlot == null) return;
  const slot = session.state.offer[session.selectedSlot];
  if (!slot) return;
  const legal = renderer.showGhost(session.state.board, slot.piece, row, col, slot.hue);
  return legal;
}

function commitAt(row, col) {
  if (appState !== 'active' && appState !== 'tutorial') return;
  if (session.selectedSlot == null) {
    // Auto-select first available piece for one-tap play.
    for (let i = 0; i < OFFER_COUNT; i++) if (session.state.offer[i]) { selectSlot(i); break; }
    if (session.selectedSlot == null) return;
  }
  issueCommand({ type: 'place', slot: session.selectedSlot, row, col });
}

/* ================================================================== */
/* Tutorial                                                           */
/* ================================================================== */

function showTutorialStep(i) {
  session.tutorialStep = i;
  const step = TUTORIAL_STEPS[i];
  if (!step) { appState = 'active'; return; }
  announce(`Lesson ${i + 1} of ${TUTORIAL_STEPS.length}: ${step.title}. ${step.text}`, true);
  let card = $('tutorial-card');
  if (!card) {
    card = document.createElement('div');
    card.id = 'tutorial-card';
    card.className = 'card';
    card.style.cssText = 'position:absolute;left:50%;transform:translateX(-50%);top:calc(3.5rem + var(--sat));z-index:10;max-width:min(420px,90vw);background:rgba(20,26,51,.92)';
    $('playfield').append(card);
  }
  card.innerHTML = `<h3>${i + 1}/${TUTORIAL_STEPS.length} — ${step.title}</h3><p>${step.text}</p>`;
}

function advanceTutorial(cmd, gain) {
  const step = TUTORIAL_STEPS[session.tutorialStep];
  if (!step) return;
  const ok = step.require === 'place' || (step.require === 'clear' && gain && gain.lines > 0);
  if (!ok) {
    announce('Almost — this lesson needs you to clear a line. Try filling a full row or column.', true);
    return;
  }
  audio.playCombo();
  const next = session.tutorialStep + 1;
  if (next >= TUTORIAL_STEPS.length) {
    const card = $('tutorial-card');
    card && card.remove();
    appState = 'active';
    progress.tutorialDone = true;
    persistProgress();
    announce('Tutorial complete! Keep playing — the round ends when no piece fits.', true);
  } else {
    showTutorialStep(next);
  }
}

/* ================================================================== */
/* Setup screens                                                      */
/* ================================================================== */

function showSetup(kind) {
  appState = 'mode-select';
  const body = $('setup-body');
  const start = $('setup-start');
  body.innerHTML = '';
  $('setup-heading').textContent = { journey: 'Journey', daily: 'Daily Challenge', practice: 'Practice' }[kind] || 'Setup';

  if (kind === 'journey') {
    const info = document.createElement('p');
    info.className = 'small';
    info.textContent = '40 authored stages. One new idea at a time, then mastery gates. Ranked: no — progress only.';
    body.append(info);
    const grid = document.createElement('div');
    grid.className = 'stage-grid';
    let chosen = progress.stage;
    for (const st of STAGES) {
      const b = document.createElement('button');
      const locked = st.id > progress.stage;
      b.className = locked ? 'locked' : '';
      b.disabled = locked;
      const stars = progress.stars[st.id] || 0;
      b.innerHTML = `<span>${st.id}</span><span class="stars">${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}</span>`;
      b.title = `${st.difficulty} — ${st.goal.type} ${st.goal.target}${st.moveLimit ? ` in ${st.moveLimit} moves` : ''}${st.mastery ? ' (mastery)' : ''}`;
      b.setAttribute('aria-label', `Stage ${st.id}, ${st.difficulty}${locked ? ', locked' : ''}`);
      b.addEventListener('click', () => { chosen = st.id; grid.querySelectorAll('button').forEach(x => x.classList.remove('primary')); b.classList.add('primary'); });
      grid.append(b);
    }
    body.append(grid);
    start.onclick = () => {
      const st = stageInfo(chosen);
      audio.playClick();
      startRound('journey', {
        seed: st.seed, maxTier: st.maxTier, goal: { ...st.goal }, moveLimit: st.moveLimit
      }, { stageId: st.id });
    };
  }

  if (kind === 'daily') {
    const date = utcDateStr(platform.now());
    const rs = dailyRuleset(date);
    const p = document.createElement('div');
    p.innerHTML = `
      <p>One shared seed and ruleset per UTC day. Score chase — play until no piece fits.</p>
      <dl class="kv">
        <dt>Date (UTC)</dt><dd>${date}</dd>
        <dt>Seed</dt><dd>${rs.seed.toString(16)}</dd>
        <dt>Ruleset</dt><dd>v${rs.version}, medium pieces</dd>
        <dt>Par</dt><dd>${rs.par}</dd>
        <dt>Ranked</dt><dd>Yes — server-validated replay</dd>
        <dt>Your best today</dt><dd>${progress.dailyBest[date] || '—'}</dd>
        <dt>Expected duration</dt><dd>3–6 minutes</dd>
      </dl>
      <p class="small" id="daily-countdown"></p>`;
    body.append(p);
    const cd = () => {
      const el = $('daily-countdown');
      if (!el || !el.isConnected) return;
      const now = platform.now();
      const next = new Date(date + 'T00:00:00Z').getTime() + 86400000;
      const s = Math.max(0, Math.floor((next - now) / 1000));
      el.textContent = `Next daily in ${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m ${s % 60}s`;
      setTimeout(cd, 1000);
    };
    cd();
    start.onclick = () => {
      audio.playClick();
      startRound('daily', { seed: rs.seed, maxTier: rs.maxTier, goal: null, moveLimit: null }, { dailyDate: date });
    };
  }

  if (kind === 'practice') {
    const p = document.createElement('div');
    p.innerHTML = '<p>Free play with undo. Restart any time. Ranked: no — never affects rating.</p>';
    body.append(p);
    let chosen = 'medium';
    const rowEl = document.createElement('div');
    rowEl.className = 'row';
    for (const d of DIFFICULTIES) {
      const b = document.createElement('button');
      b.textContent = DIFFICULTY_INFO[d].name;
      b.title = DIFFICULTY_INFO[d].desc;
      if (d === chosen) b.classList.add('primary');
      b.addEventListener('click', () => { chosen = d; rowEl.querySelectorAll('button').forEach(x => x.classList.remove('primary')); b.classList.add('primary'); });
      rowEl.append(b);
    }
    body.append(rowEl);
    start.onclick = () => {
      audio.playClick();
      startRound('practice', practiceOptions(chosen, (Math.random() * 0xffffffff) >>> 0));
    };
  }

  showScreen('setup-screen');
  start.focus();
}

function startLearn() {
  audio.playClick();
  startRound('learn', { seed: 0x1EAA42, maxTier: 0, goal: null, moveLimit: null });
}

/* ================================================================== */
/* Results                                                            */
/* ================================================================== */

function showResults() {
  const s = session.state;
  $('results-heading').textContent = s.won ? 'Goal Complete!' : 'Round Over';
  const reasons = {
    'goal-complete': 'Objective reached.',
    'no-fit': 'No offered piece fits on the board.',
    'move-limit': 'Move limit reached.'
  };
  $('results-sub').textContent = (reasons[s.reason] || '') +
    (session.mode === 'journey' && session.stageId ? ` Journey stage ${session.stageId}.` : '');

  const dl = $('results-breakdown');
  dl.innerHTML = '';
  const add = (k, v) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = String(v);
    dl.append(dt, dd);
  };
  add('Piece cells', s.score.cells);
  add('Cleared cells', s.score.clear);
  add('Simultaneous bonus', s.score.simultaneous);
  add('Combo bonus', s.score.combo);
  add('Total score', s.score.total);
  add('Lines cleared', s.lines);
  add('Pieces placed', s.placedPieces);
  add('Invalid actions', s.invalid);
  add('Time', Math.round(elapsedTime() / 1000) + 's');

  const ach = $('results-achievements');
  const unlocked = ACHIEVEMENTS.filter(a => progress.achievements[a.key]);
  ach.innerHTML = unlocked.length
    ? `<p class="small">Achievements: ${unlocked.map(a => a.name).join(', ')}</p>` : '';

  if (session.mode !== 'daily') $('results-compare').textContent = '';

  $('btn-next').hidden = !(session.mode === 'journey' && s.won && session.stageId < stageCount());
  showScreen('results-screen');
  announce(`${$('results-heading').textContent} Total score ${s.score.total}.`, true);
  $('btn-retry').focus();
  updateTitleProgress();
}

/* ================================================================== */
/* Help                                                               */
/* ================================================================== */

function buildHelp() {
  const body = $('help-body');
  body.innerHTML = `
    <h3>The rules</h3>
    <ul>
      <li>You receive <b>three pieces</b> at a time. Place all three to receive a new offer.</li>
      <li>Complete a full <b>row or column</b> of 10 cells to clear it. Rows and columns clear together.</li>
      <li>Score: placed cells + 10 per cleared cell + simultaneous bonus (2+ lines) + combo streak bonus.</li>
      <li>The round ends when <b>no offered piece fits</b>.</li>
    </ul>
    <h3>Controls</h3>
    <ul>
      <li><b>Pointer/touch:</b> tap a piece in the tray, then tap a board cell — or drag from the tray onto the board.</li>
      <li><b>Keyboard:</b> 1–3 select a piece · arrow keys move the cursor · Enter/Space place · H hint · U undo (practice) · Esc pause.</li>
      <li><b>Gamepad:</b> D-pad/stick moves the cursor, A places, B cancels, Start pauses.</li>
    </ul>
    <h3>Pieces</h3>
    <div id="help-pieces" class="row" style="justify-content:flex-start"></div>`;
  const wrap = body.querySelector('#help-pieces');
  const seen = new Set();
  for (const p of PIECES) {
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    const chip = document.createElement('span');
    chip.className = 'card';
    chip.style.padding = '.3rem .6rem';
    chip.textContent = `${p.name} (${p.cells.length})`;
    wrap.append(chip);
  }
}

/* ================================================================== */
/* Title                                                              */
/* ================================================================== */

function updateTitleProgress() {
  const stars = Object.values(progress.stars).reduce((a, b) => a + b, 0);
  const tier = [...MASTERY_TIERS].reverse().find(t => stars >= t.stars) || MASTERY_TIERS[0];
  $('title-progress').textContent =
    `Journey stage ${progress.stage}/${stageCount()} · ${stars} ★ · Rank: ${tier.name}`;
}

function updateTitleClock() {
  const date = utcDateStr(platform.now());
  $('title-clock').textContent = `UTC day ${date}${platform.online ? ' · server time synced' : ' · offline mode'}`;
}

/* ================================================================== */
/* Pause                                                              */
/* ================================================================== */

function pauseGame() {
  if (currentScreen !== 'game-screen' || session.over) return;
  if (appState === 'paused') return;
  appState = 'paused';
  session.pausedAt = Date.now();
  openOverlay('pause-overlay');
  announce('Paused.');
}

function resumeGame() {
  if (appState !== 'paused') return;
  session.pausedTotal += Date.now() - session.pausedAt;
  appState = session.mode === 'learn' && session.tutorialStep < TUTORIAL_STEPS.length ? 'tutorial' : 'active';
  closeOverlay('pause-overlay');
  announce('Resumed.');
}

/* ================================================================== */
/* Input — pointer                                                    */
/* ================================================================== */

let drag = null; // {slot, pointerId, started, x0, y0}

function canvasNDC(e) {
  const rect = $('gl').getBoundingClientRect();
  return [((e.clientX - rect.left) / rect.width) * 2 - 1, -(((e.clientY - rect.top) / rect.height) * 2 - 1)];
}

function setupPointer() {
  const canvas = $('gl');
  canvas.style.pointerEvents = 'auto';

  canvas.addEventListener('pointerdown', (e) => {
    audio.unlockAudio();
    if (currentScreen !== 'game-screen') return;
    canvas.setPointerCapture(e.pointerId);
    const [nx, ny] = canvasNDC(e);
    const slot = renderer.pickOffer(nx, ny);
    if (slot != null && session.state.offer[slot]) {
      selectSlot(slot);
      drag = { slot, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false };
    } else {
      const cell = renderer.pickCell(nx, ny);
      if (cell) {
        session.cursor = cell;
        renderer.setCursor(cell.row, cell.col, true);
        if (session.selectedSlot != null) {
          previewAt(cell.row, cell.col);
          drag = { slot: session.selectedSlot, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false, commitOnUp: true };
        } else {
          drag = { slot: null, pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false, commitOnUp: true };
        }
      }
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (currentScreen !== 'game-screen') return;
    const [nx, ny] = canvasNDC(e);
    if (drag && e.pointerId === drag.pointerId) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 8) drag.moved = true;
      const cell = renderer.pickCell(nx, ny);
      if (cell) {
        session.cursor = cell;
        renderer.setCursor(cell.row, cell.col, true);
        previewAt(cell.row, cell.col);
      }
    } else {
      // Hover preview (never required).
      const cell = renderer.pickCell(nx, ny);
      if (cell && session.selectedSlot != null) previewAt(cell.row, cell.col);
    }
  });

  const finish = (e, cancelled) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const d = drag;
    drag = null;
    try { canvas.releasePointerCapture(e.pointerId); } catch (err) {}
    if (cancelled) { renderer.hideGhost(); return; }
    const [nx, ny] = canvasNDC(e);
    const cell = renderer.pickCell(nx, ny);
    if (d.slot != null && cell) {
      session.selectedSlot = d.slot;
      commitAt(cell.row, cell.col);
    } else if (d.commitOnUp && cell && !d.moved) {
      commitAt(cell.row, cell.col);
    }
  };

  canvas.addEventListener('pointerup', (e) => finish(e, false));
  canvas.addEventListener('pointercancel', (e) => finish(e, true));
  canvas.addEventListener('lostpointercapture', (e) => { if (drag && drag.pointerId === e.pointerId) drag = null; });
}

/* ================================================================== */
/* Input — keyboard + gamepad                                         */
/* ================================================================== */

function setupKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('settings-overlay').hidden) { closeOverlay('settings-overlay'); return; }
      if (!$('help-overlay').hidden) { closeOverlay('help-overlay'); return; }
      if (!$('pause-overlay').hidden) { resumeGame(); return; }
      if (currentScreen === 'game-screen') { pauseGame(); return; }
      return;
    }
    if (currentScreen !== 'game-screen' || (appState !== 'active' && appState !== 'tutorial')) return;
    if (document.activeElement && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) return;

    const cur = session.cursor;
    let handled = true;
    switch (e.key) {
      case 'ArrowUp': cur.row = Math.max(0, cur.row - 1); break;
      case 'ArrowDown': cur.row = Math.min(BOARD_SIZE - 1, cur.row + 1); break;
      case 'ArrowLeft': cur.col = Math.max(0, cur.col - 1); break;
      case 'ArrowRight': cur.col = Math.min(BOARD_SIZE - 1, cur.col + 1); break;
      case '1': case '2': case '3': selectSlot(Number(e.key) - 1); break;
      case 'Enter': case ' ': commitAt(cur.row, cur.col); break;
      case 'h': case 'H': doHint(); break;
      case 'u': case 'U': doUndo(); break;
      case 'c': case 'C': renderer.hideGhost(); session.selectedSlot = null; renderer.setSelectedSlot(null); buildOfferTray(); break;
      default: handled = false;
    }
    if (handled) {
      e.preventDefault();
      audio.unlockAudio();
      renderer.setCursor(cur.row, cur.col, true);
      if (session.selectedSlot != null) previewAt(cur.row, cur.col);
    }
  });
}

let gamepadIndex = null;
function setupGamepad() {
  window.addEventListener('gamepadconnected', (e) => { gamepadIndex = e.gamepad.index; });
  window.addEventListener('gamepaddisconnected', () => { gamepadIndex = null; });
}

let padPrev = {};
function pollGamepad() {
  if (gamepadIndex == null || currentScreen !== 'game-screen') return;
  const gp = navigator.getGamepads && navigator.getGamepads()[gamepadIndex];
  if (!gp) return;
  const press = (name, val) => {
    const was = padPrev[name];
    padPrev[name] = val;
    return val && !was;
  };
  const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
  const cur = session.cursor;
  if (press('left', ax < -0.5 || (gp.buttons[14] && gp.buttons[14].pressed))) cur.col = Math.max(0, cur.col - 1);
  if (press('right', ax > 0.5 || (gp.buttons[15] && gp.buttons[15].pressed))) cur.col = Math.min(BOARD_SIZE - 1, cur.col + 1);
  if (press('up', ay < -0.5 || (gp.buttons[12] && gp.buttons[12].pressed))) cur.row = Math.max(0, cur.row - 1);
  if (press('down', ay > 0.5 || (gp.buttons[13] && gp.buttons[13].pressed))) cur.row = Math.min(BOARD_SIZE - 1, cur.row + 1);
  if (press('a', gp.buttons[0] && gp.buttons[0].pressed)) commitAt(cur.row, cur.col);
  if (press('b', gp.buttons[1] && gp.buttons[1].pressed)) { session.selectedSlot = null; renderer.hideGhost(); buildOfferTray(); }
  if (press('x', gp.buttons[2] && gp.buttons[2].pressed)) {
    const next = session.selectedSlot == null ? 0 : (session.selectedSlot + 1) % OFFER_COUNT;
    selectSlot(next);
  }
  if (press('start', gp.buttons[9] && gp.buttons[9].pressed)) pauseGame();
  renderer.setCursor(cur.row, cur.col, session.selectedSlot != null);
  if (session.selectedSlot != null) previewAt(cur.row, cur.col);
}

function doHint() {
  const hint = findHint(session.state);
  if (!hint) { announce('No legal placement exists.', true); return; }
  session.selectedSlot = hint.slot;
  session.cursor = { row: hint.row, col: hint.col };
  renderer.setSelectedSlot(hint.slot);
  renderer.setCursor(hint.row, hint.col, true);
  previewAt(hint.row, hint.col);
  buildOfferTray();
  audio.playSelect();
  announce(`Hint: place slot ${hint.slot + 1} at row ${hint.row + 1}, column ${hint.col + 1}.`);
}

function doUndo() {
  if (session.mode !== 'practice' && session.mode !== 'learn') {
    announce('Undo is only available in practice and learn modes.', true);
    return;
  }
  const s = applyCommand(session.state, { type: 'undo' });
  if (s === session.state || !session.state.undo) {
    announce('Nothing to undo.', true);
    return;
  }
  session.state = s;
  session.commands.pop();
  session.selectedSlot = null;
  renderer.applyBoard(s.board);
  renderer.applyOffer(s.offer, null);
  renderer.hideGhost();
  buildOfferTray(); buildBoardMirror(); updateHUD();
  audio.playClick();
  announce('Undone.');
}

/* ================================================================== */
/* Frame loop + lifecycle                                             */
/* ================================================================== */

function frame(t) {
  rafId = requestAnimationFrame(frame);
  const dt = Math.min(0.05, (t - lastFrame) / 1000 || 0.016);
  lastFrame = t;
  if (document.hidden) return; // background tabs: zero rendering
  pollGamepad();
  if (renderer && currentScreen === 'game-screen') renderer.render(dt);
}

function setupLifecycle() {
  document.addEventListener('visibilitychange', () => {
    audio.setBackgrounded(document.hidden);
    if (document.hidden && currentScreen === 'game-screen' && !session.over) pauseGame();
  });
  window.addEventListener('resize', () => renderer && renderer.resize());
  window.addEventListener('orientationchange', () => setTimeout(() => renderer && renderer.resize(), 60));
  window.addEventListener('beforeunload', () => session.state && !session.state.over && saveSnapshot());
  $('gl').addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    announce('Graphics context lost — rebuilding…', true);
  });
  $('gl').addEventListener('webglcontextrestored', () => {
    rebuildRenderer();
    announce('Graphics restored.');
  });
}

/* ================================================================== */
/* Wiring                                                             */
/* ================================================================== */

function wire() {
  const click = (id, fn) => $(id).addEventListener('click', () => { audio.unlockAudio(); audio.playClick(); fn(); });

  click('btn-play', () => {
    if (tryResumeSnapshot()) return;
    showSetup('journey');
  });
  click('btn-daily', () => showSetup('daily'));
  click('btn-journey', () => showSetup('journey'));
  click('btn-practice', () => showSetup('practice'));
  click('btn-learn', startLearn);
  click('btn-help', () => { buildHelp(); openOverlay('help-overlay'); });
  click('btn-settings', () => { buildSettings(); openOverlay('settings-overlay'); });

  $('setup-back').addEventListener('click', () => { audio.playClick(); showScreen('title-screen'); });

  click('btn-pause', pauseGame);
  click('btn-resume', resumeGame);
  click('btn-pause-settings', () => { buildSettings(); openOverlay('settings-overlay'); });
  click('btn-pause-help', () => { buildHelp(); openOverlay('help-overlay'); });
  click('btn-quit', () => {
    closeOverlay('pause-overlay');
    appState = 'title';
    showScreen('title-screen');
    updateTitleProgress();
  });
  click('btn-settings-close', () => closeOverlay('settings-overlay'));
  click('btn-help-close', () => closeOverlay('help-overlay'));
  click('btn-hint', doHint);
  click('btn-undo', doUndo);
  click('btn-drawer', () => {
    const open = $('rail-left').classList.toggle('open');
    $('rail-right').classList.toggle('open', open);
  });

  click('btn-retry', () => {
    const { mode, options, stageId, dailyDate } = session;
    if (mode === 'practice') {
      startRound('practice', practiceOptions(DIFFICULTIES[options.maxTier] || 'medium', (Math.random() * 0xffffffff) >>> 0));
    } else {
      startRound(mode, { ...options }, { stageId, dailyDate });
    }
  });
  click('btn-next', () => {
    const st = stageInfo(session.stageId + 1);
    if (st) startRound('journey', { seed: st.seed, maxTier: st.maxTier, goal: { ...st.goal }, moveLimit: st.moveLimit }, { stageId: st.id });
  });
  click('btn-results-home', () => { appState = 'title'; showScreen('title-screen'); });
}

/* ================================================================== */
/* Boot                                                               */
/* ================================================================== */

async function boot() {
  appState = 'boot';
  applySettings();
  wire();
  setupPointer();
  setupKeyboard();
  setupGamepad();
  setupLifecycle();
  updateTitleProgress();

  // WebGL capability check with clear compatibility message.
  try {
    renderer = new Renderer($('gl'), {
      theme: settings.theme, quality: settings.quality,
      reducedMotion: settings.reducedMotion, cvdPalette: settings.cvdPalette
    });
  } catch (e) {
    const p = document.createElement('p');
    p.style.color = 'var(--danger)';
    p.textContent = 'This device or browser does not support WebGL. ' +
      'Your settings and progress are preserved; the game needs 3D support to render the board.';
    $('title-screen').append(p);
  }

  appState = 'title';
  showScreen('title-screen');

  // Direct-launch hook (?mode=practice|daily|learn|journey) for deep links and testing.
  const launchMode = new URLSearchParams(location.search).get('mode');
  if (launchMode === 'practice') startRound('practice', practiceOptions('medium', (Math.random() * 0xffffffff) >>> 0));
  else if (launchMode === 'daily') {
    const date = utcDateStr(platform.now());
    const rs = dailyRuleset(date);
    startRound('daily', { seed: rs.seed, maxTier: rs.maxTier, goal: null, moveLimit: null }, { dailyDate: date });
  } else if (launchMode === 'learn') startLearn();
  else if (launchMode === 'journey') {
    const st = stageInfo(progress.stage);
    startRound('journey', { seed: st.seed, maxTier: st.maxTier, goal: { ...st.goal }, moveLimit: st.moveLimit }, { stageId: st.id });
  }

  platform.syncTime().then(updateTitleClock);
  setInterval(() => platform.syncTime().then(updateTitleClock), 5 * 60 * 1000);
  lastFrame = performance.now();
  rafId = requestAnimationFrame(frame);
}

boot();
