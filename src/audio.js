'use strict';

/**
 * Prism Parcel — audio: WebAudio procedural sounds, independent buses
 * (music, effects, ambience, voice), seeded variants, focus behavior.
 * Effects prefer authored one-shot samples (sfx/<name>.opus, see
 * sfx/manifest.json); the procedural synthesis below remains the
 * fallback while a sample is loading or if it fails to load.
 */

import { createRng } from './rules.js';

const BUS_NAMES = ['music', 'effects', 'ambience', 'voice'];

let ctx = null;
let buses = null;
let masterMuted = false;
let rng = createRng(1234);
let ambienceNodes = null;
let musicTimer = null;
let started = false;
const volumes = { music: 0.7, effects: 0.7, ambience: 0.7, voice: 0.7 };

function ensureCtx() {
  if (ctx) return true;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    buses = {};
    for (const name of BUS_NAMES) {
      const g = ctx.createGain();
      g.gain.value = 0.7;
      g.connect(ctx.destination);
      buses[name] = g;
    }
    return true;
  } catch (e) {
    return false;
  }
}

/** Must be called from a user gesture before any sound plays. */
export function unlockAudio() {
  if (!ensureCtx()) return;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  if (!started) {
    started = true;
    startAmbience();
    startMusic();
  }
  warmSamples();
}

export function setBusVolume(name, v) {
  volumes[name] = Math.max(0, Math.min(1, v));
  if (!ensureCtx() || !buses[name]) return;
  buses[name].gain.value = volumes[name];
}

export function getBusVolume(name) {
  return volumes[name] != null ? volumes[name] : 0.7;
}

export function setMuted(m) { masterMuted = !!m; }
export function isMuted() { return masterMuted; }

/** Lower everything when the tab is hidden; restore on return. */
export function setBackgrounded(hidden) {
  if (!ensureCtx()) return;
  for (const name of BUS_NAMES) {
    const g = buses[name];
    g.gain.setTargetAtTime(hidden ? 0 : volumes[name], ctx.currentTime, 0.1);
  }
}

export function seedVariants(seed) { rng = createRng((seed >>> 0) || 1); }

/* ------------------------------------------------------------------ */
/* Authored one-shot samples (lazy, cached, effects bus)               */
/* ------------------------------------------------------------------ */

/** event method name -> sample basenames (sfx/<name>.opus). */
const SFX_MAP = {
  playClick: ['ui-click'],
  playSelect: ['ui-select'],
  playInvalid: ['invalid-thud'],
  playPlace: ['place-frost-1', 'place-frost-2', 'place-frost-3'],
  playClear: ['clear-single', 'clear-multi'],
  playReplenish: ['replenish-chime'],
  playWin: ['win-fanfare'],
  playOver: ['over-fall'],
  playAchievement: ['achievement-ping']
};

/** name -> { state: 'loading'|'ready'|'failed', buffer } */
const sfxCache = new Map();

function loadSample(name) {
  let entry = sfxCache.get(name);
  if (entry) return entry;
  entry = { state: 'loading', buffer: null };
  sfxCache.set(name, entry);
  fetch(`sfx/${name}.opus`)
    .then(res => { if (!res.ok) throw new Error(`http-${res.status}`); return res.arrayBuffer(); })
    .then(bytes => (ctx ? ctx.decodeAudioData(bytes) : Promise.reject(new Error('no-ctx'))))
    .then(buffer => { entry.state = 'ready'; entry.buffer = buffer; })
    .catch(() => { entry.state = 'failed'; });
  return entry;
}

/** Begin fetching all mapped samples; call only after the gesture unlock. */
function warmSamples() {
  if (!ctx) return;
  for (const names of Object.values(SFX_MAP)) names.forEach(loadSample);
}

/**
 * Try to play a mapped sample for an event. Returns true when a ready
 * sample was played; false means the caller should run its synthesis.
 */
function playSample(event, pick = 0) {
  const names = SFX_MAP[event];
  if (!names || !ctx || masterMuted) return !names; // muted: handled, no synth
  const name = names[pick % names.length];
  const entry = loadSample(name);
  if (entry.state !== 'ready') return false;
  const src = ctx.createBufferSource();
  src.buffer = entry.buffer;
  src.connect(buses.effects);
  src.start();
  return true;
}

/* ------------------------------------------------------------------ */
/* Effects — layered material impacts                                  */
/* ------------------------------------------------------------------ */

function tone(bus, { freq = 440, type = 'sine', dur = 0.12, gain = 0.2, slide = 0, delay = 0 }) {
  if (!ensureCtx() || masterMuted) return;
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t0 + dur);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(g).connect(buses[bus]);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function noiseBurst(bus, { dur = 0.08, gain = 0.12, freq = 2000, delay = 0 }) {
  if (!ensureCtx() || masterMuted) return;
  const t0 = ctx.currentTime + delay;
  const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (rng.next() * 2 - 1) * (1 - i / len);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(filter).connect(g).connect(buses[bus]);
  src.start(t0);
}

export function playClick() {
  if (playSample('playClick')) return;
  const v = 0.95 + rng.next() * 0.1;
  tone('effects', { freq: 620 * v, type: 'triangle', dur: 0.05, gain: 0.12 });
}

export function playSelect() {
  if (playSample('playSelect')) return;
  const v = 0.95 + rng.next() * 0.1;
  tone('effects', { freq: 520 * v, type: 'sine', dur: 0.07, gain: 0.14 });
  tone('effects', { freq: 780 * v, type: 'sine', dur: 0.06, gain: 0.08, delay: 0.03 });
}

export function playInvalid() {
  if (playSample('playInvalid')) return;
  tone('effects', { freq: 180, type: 'square', dur: 0.12, gain: 0.08 });
  noiseBurst('effects', { dur: 0.06, gain: 0.05, freq: 400 });
}

export function playPlace() {
  if (playSample('playPlace', Math.floor(rng.next() * 3))) return;
  const v = 0.95 + rng.next() * 0.1;
  tone('effects', { freq: 300 * v, type: 'sine', dur: 0.1, gain: 0.2, slide: -60 });
  noiseBurst('effects', { dur: 0.05, gain: 0.1, freq: 1200 });
}

export function playClear(lines, streak) {
  if (playSample('playClear', lines >= 2 ? 1 : 0)) return;
  const base = 520 + Math.min(lines, 4) * 90 + Math.min(streak, 6) * 30;
  tone('effects', { freq: base, type: 'sine', dur: 0.22, gain: 0.18 });
  tone('effects', { freq: base * 1.5, type: 'sine', dur: 0.25, gain: 0.12, delay: 0.05 });
  noiseBurst('effects', { dur: 0.18, gain: 0.08, freq: 3200, delay: 0.02 });
  if (lines >= 2) tone('effects', { freq: base * 2, type: 'triangle', dur: 0.3, gain: 0.1, delay: 0.1 });
}

export function playReplenish() {
  if (playSample('playReplenish')) return;
  tone('effects', { freq: 440, type: 'triangle', dur: 0.08, gain: 0.1 });
  tone('effects', { freq: 587, type: 'triangle', dur: 0.08, gain: 0.1, delay: 0.06 });
  tone('effects', { freq: 880, type: 'triangle', dur: 0.1, gain: 0.1, delay: 0.12 });
}

export function playWin() {
  if (playSample('playWin')) return;
  const notes = [523, 659, 784, 1047];
  notes.forEach((f, i) => tone('effects', { freq: f, type: 'sine', dur: 0.35, gain: 0.15, delay: i * 0.12 }));
}

export function playOver() {
  if (playSample('playOver')) return;
  const notes = [392, 330, 262];
  notes.forEach((f, i) => tone('effects', { freq: f, type: 'sine', dur: 0.4, gain: 0.14, delay: i * 0.15 }));
}

export function playAchievement() {
  if (playSample('playAchievement')) return;
  tone('effects', { freq: 880, type: 'sine', dur: 0.15, gain: 0.14 });
  tone('effects', { freq: 1175, type: 'sine', dur: 0.3, gain: 0.14, delay: 0.1 });
}

/** Captions/text-cue hook: describe the last meaningful sound for accessibility. */
export function describeEvent(name) {
  switch (name) {
    case 'place': return 'Piece placed.';
    case 'clear': return 'Lines cleared.';
    case 'invalid': return 'That placement is not legal.';
    case 'replenish': return 'New pieces offered.';
    case 'win': return 'Goal complete.';
    case 'over': return 'Round over.';
    case 'achievement': return 'Achievement unlocked.';
    default: return '';
  }
}

/* ------------------------------------------------------------------ */
/* Ambience — quiet evolving pad                                       */
/* ------------------------------------------------------------------ */

function startAmbience() {
  if (!ensureCtx() || ambienceNodes) return;
  const g = ctx.createGain();
  g.gain.value = 0.05;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 500;
  const oscs = [110, 165, 220].map(f => {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = f;
    o.connect(filter);
    o.start();
    return o;
  });
  filter.connect(g).connect(buses.ambience);
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.07;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 120;
  lfo.connect(lfoGain).connect(filter.frequency);
  lfo.start();
  ambienceNodes = { oscs, lfo, g };
}

/* ------------------------------------------------------------------ */
/* Music — quiet adaptive arpeggio stem                                */
/* ------------------------------------------------------------------ */

const MUSIC_SCALE = [262, 294, 330, 392, 440, 523, 587, 659];

function startMusic() {
  if (!ensureCtx() || musicTimer) return;
  let step = 0;
  musicTimer = setInterval(() => {
    if (masterMuted || document.hidden) return;
    if (!ctx || ctx.state !== 'running') return;
    const idx = [0, 2, 4, 7, 4, 2][step % 6] + (step % 24 >= 12 ? 1 : 0);
    const f = MUSIC_SCALE[idx % MUSIC_SCALE.length];
    tone('music', { freq: f, type: 'triangle', dur: 0.5, gain: 0.05 });
    if (step % 8 === 0) tone('music', { freq: f / 2, type: 'sine', dur: 1.2, gain: 0.05 });
    step++;
  }, 340);
}

/** Stop all audio (e.g. page unload). */
export function shutdown() {
  if (musicTimer) { clearInterval(musicTimer); musicTimer = null; }
  if (ctx) { ctx.close().catch(() => {}); ctx = null; buses = null; ambienceNodes = null; started = false; }
}
