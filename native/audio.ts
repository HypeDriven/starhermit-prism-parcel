// Sound, as the browser build's src/audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.json) per game event (three placement
// variants picked by the round's seeded stream, a single- and a multi-line
// clear), the lesson-step chime (synthesised, as before: two triangle notes),
// the quiet ambience pad (sines at 110 / 165 / 220 Hz through a 500 Hz
// lowpass swept ±120 Hz by a 0.07 Hz LFO, gain 0.05) and the music stem (a
// triangle arpeggio every 340 ms with a sine bass note each 8 steps). The
// browser build ran the pad and the arpeggio live (oscillators and a
// setInterval); here they are rendered once at start on OfflineAudioContexts
// and looped on the music bus — the runtime has no ambience bus: the pad's gain
// is the old ambience/music bus ratio (0.4 / 0.5). The oscillator fallbacks it
// played while a sample decoded are not ported: a clip still loading is silent.
// Interface clicks play on the runtime's interface bus. The runtime's Options
// own the volumes, the mute and the voice limit. Every clip loads at start; the
// pad and the music wait for the mixer (in a browser, the first press).
import { context, createClip, loadClip, OfflineAudioContext, play as playClip, type AudioClip, type Bus, type Sound } from "starhermit:audio";
import { Rules } from "./game.ts";

const SFX = ["ui-click", "ui-select", "invalid-thud", "place-frost-1", "place-frost-2", "place-frost-3", "clear-single", "clear-multi",
  "replenish-chime", "win-fanfare", "over-fall", "achievement-ping"] as const;
type Sfx = (typeof SFX)[number];
const clips = new Map<string, AudioClip>();
let suspended = false;
let rng = Rules.createRng(1234);

/** Loads every clip at once (onStart); a cue whose clip is still loading is silent. */
export function loadSfx(): void {
  for (const name of SFX) {
    loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); }, (e: unknown) => console.warn(`sfx ${name}: ${e instanceof Error ? e.message : String(e)}`));
  }
  const failed = (e: unknown): void => console.warn(`audio: ${e instanceof Error ? e.message : String(e)}`);
  void renderCombo().then((c) => { comboClip = c; }).catch(failed);
  void renderPad().then((c) => { padClip = c; }).catch(failed);
  void renderMusic().then((c) => { musicClip = c; }).catch(failed);
}
/** audio.js seedVariants: the placement variant stream follows the round's seed. */
export function seedVariants(seed: number): void { rng = Rules.createRng((seed >>> 0) || 1); }

function sfx(name: Sfx, bus: Bus = "effects"): void {
  if (suspended) return;
  const clip = clips.get(name);
  if (!clip) return;
  try { playClip(clip, { bus }); } catch { /* the mixer is full this frame: skip it */ }
}
export const playClick = (): void => sfx("ui-click", "interface");
export const playSelect = (): void => sfx("ui-select", "interface");
export const playInvalid = (): void => sfx("invalid-thud");
export const playPlace = (): void => sfx((["place-frost-1", "place-frost-2", "place-frost-3"] as const)[Math.floor(rng.next() * 3)]!);
export const playClear = (lines: number): void => sfx(lines >= 2 ? "clear-multi" : "clear-single");
export const playReplenish = (): void => sfx("replenish-chime");
export const playWin = (): void => sfx("win-fanfare");
export const playOver = (): void => sfx("over-fall");
export const playAchievement = (): void => sfx("achievement-ping");
let comboClip: AudioClip | null = null;
/** audio.js playCombo (no sample): 587 Hz then 880 Hz triangle notes; the old ±5 % variation is left out. */
export function playCombo(): void {
  if (suspended || !comboClip) return;
  try { playClip(comboClip, { bus: "effects" }); } catch { /* gone */ }
}

/** audio.js describeEvent: the sound captions. */
export function describeEvent(name: string): string {
  switch (name) {
    case "place": return "Piece placed.";
    case "clear": return "Lines cleared.";
    case "invalid": return "That placement is not legal.";
    case "replenish": return "New pieces offered.";
    case "win": return "Goal complete.";
    case "over": return "Round over.";
    case "achievement": return "Achievement unlocked.";
    default: return "";
  }
}

// -- rendered synthesis (one context a clip) --------------------------------------------------------
const RATE = 22050;
/** One oscillator note with audio.js tone()'s envelope: 0 → gain in 8 ms (linear), → 0.001 at dur (exponential). */
function note(off: OfflineAudioContext, t0: number, f: number, gain: number, dur: number, tri: boolean): void {
  const osc = off.createOscillator();
  osc.type = tri ? "triangle" : "sine";
  osc.frequency.value = f;
  const g = off.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  g.gain.setValueAtTime(0, t0 + dur);
  osc.connect(g).connect(off.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}
async function renderCombo(): Promise<AudioClip> {
  const off = new OfflineAudioContext(1, Math.round(0.24 * RATE), RATE);
  note(off, 0, 587, 0.12, 0.09, true);
  note(off, 0.07, 880, 0.12, 0.14, true);
  return createClip(await off.startRendering());
}
/** The pad: a loop of 786/55 s (whole cycles of 110, 165 and 220 Hz; the LFO's one cycle ≈ 0.07 Hz). */
async function renderPad(): Promise<AudioClip> {
  const seconds = 786 / 55, n = Math.round(seconds * RATE), settle = Math.round(0.5 * RATE);
  const off = new OfflineAudioContext(1, settle + n, RATE);
  const lp = off.createBiquadFilter();
  lp.type = "lowpass";
  lp.Q.value = 1;
  lp.frequency.value = 500;
  const lfo = off.createOscillator();
  lfo.frequency.value = 1 / seconds;
  const depth = off.createGain();
  depth.gain.value = 120;
  lfo.connect(depth).connect(lp.frequency);
  const level = off.createGain();
  level.gain.value = 0.05;
  for (const f of [110, 165, 220]) {
    const osc = off.createOscillator();
    osc.frequency.value = f;
    osc.connect(lp);
    osc.start();
  }
  lp.connect(level).connect(off.destination);
  lfo.start();
  const r = await off.startRendering();
  // Whole cycles settled are periodic, so the slice joins.
  return createClip([r.getChannelData(0).slice(settle)], RATE);
}
/** The music: 24 steps of 340 ms (the arpeggio's pattern repeats each 24); the last notes' tails wrap to the start. */
async function renderMusic(): Promise<AudioClip> {
  const SCALE = [262, 294, 330, 392, 440, 523, 587, 659];
  const STEP = 0.34, STEPS = 24;
  const n = Math.round(STEPS * STEP * RATE), tail = Math.round(0.4 * RATE);
  const off = new OfflineAudioContext(1, n + tail, RATE);
  for (let step = 0; step < STEPS; step++) {
    const idx = [0, 2, 4, 7, 4, 2][step % 6]! + (step % 24 >= 12 ? 1 : 0);
    const f = SCALE[idx % SCALE.length]!;
    note(off, step * STEP, f, 0.05, 0.5, true);
    if (step % 8 === 0) note(off, step * STEP, f / 2, 0.05, 1.2, false);
  }
  const r = await off.startRendering();
  const d = r.getChannelData(0), loop = d.slice(0, n);
  for (let i = 0; i < tail; i++) loop[i] = loop[i]! + d[n + i]!;
  return createClip([loop], RATE);
}

let padClip: AudioClip | null = null, musicClip: AudioClip | null = null;
let padVoice: Sound | null = null, musicVoice: Sound | null = null;
const PAD_GAIN = 0.4 / 0.5;
/** A hidden window silences the loops (audio.js setBackgrounded). */
export function setSuspended(on: boolean): void {
  if (on === suspended) return;
  suspended = on;
  try {
    padVoice?.fade(on ? 0 : PAD_GAIN, 0.1);
    musicVoice?.fade(on ? 0 : 1, 0.1);
  } catch { /* gone */ }
}

/** Each frame: once the mixer runs and they are rendered, the pad and the music. */
export function update(): void {
  if (context.state !== "running") return;
  if (padClip && !padVoice) {
    try { padVoice = playClip(padClip, { bus: "music", gain: suspended ? 0 : PAD_GAIN, loop: true }); } catch { padVoice = null; }
    return;
  }
  if (padVoice && musicClip && !musicVoice) {
    try { musicVoice = playClip(musicClip, { bus: "music", gain: suspended ? 0 : 1, loop: true }); } catch { musicVoice = null; }
  }
}
