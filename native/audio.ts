// Sound, as the browser build's src/audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.json) per game event (three placement
// variants picked by the round's seeded stream, a single- and a multi-line
// clear), the lesson-step chime (synthesised, as before: two triangle notes),
// the quiet ambience pad (sines at 110 / 165 / 220 Hz through a 500 Hz
// lowpass swept ±120 Hz by a 0.07 Hz LFO, gain 0.05) and the music stem (a
// triangle arpeggio every 340 ms with a sine bass note each 8 steps). The
// browser build ran the pad and the arpeggio live (oscillators and a
// setInterval); here they are rendered once into clips (createClip, a slice
// a frame) and looped on the music bus — the runtime has no ambience bus:
// the pad's gain is the old ambience/music bus ratio (0.4 / 0.5). The
// oscillator fallbacks it played while a sample decoded are not ported (a
// live synthesis graph makes clip loads fail on the web runtime): a clip
// still loading is silent. Interface clicks play on the runtime's interface
// bus. The runtime's Options own the volumes, the mute and the voice limit.
// Clips load once the mixer runs (natively at once, in a browser after the
// first press), one at a time.
import { context, createClip, loadClip, play as playClip, type AudioClip, type Bus, type Sound } from "starhermit:audio";
import { Rules } from "./game.ts";

const SFX = ["ui-click", "ui-select", "invalid-thud", "place-frost-1", "place-frost-2", "place-frost-3", "clear-single", "clear-multi",
  "replenish-chime", "win-fanfare", "over-fall", "achievement-ping"] as const;
type Sfx = (typeof SFX)[number];
const clips = new Map<string, AudioClip>();
const queue: string[] = [];
let loading = false;
let wantClips = false;
let suspended = false;
let rng = Rules.createRng(1234);

/** Asks for the clips; they load once the mixer runs (see update). */
export function loadSfx(): void { wantClips = true; }
/** audio.js seedVariants: the placement variant stream follows the round's seed. */
export function seedVariants(seed: number): void { rng = Rules.createRng((seed >>> 0) || 1); }

function sfx(name: Sfx, bus: Bus = "effects"): void {
  if (suspended) return;
  const clip = clips.get(name);
  if (!clip) return;
  try { playClip(clip, { bus }); } catch { clips.delete(name); if (!queue.includes(name)) queue.push(name); }
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

// -- rendered synthesis ---------------------------------------------------------------------------
const RATE = 22050;
/** One oscillator note with audio.js tone()'s envelope: 0 → gain in 8 ms (linear), → 0.001 at dur (exponential). */
function renderTone(buf: Float32Array, t0: number, f: number, gain: number, dur: number, tri: boolean): void {
  const start = Math.round(t0 * RATE), len = Math.round((dur + 0.02) * RATE);
  for (let i = 0; i < len; i++) {
    const t = i / RATE;
    const env = t < 0.008 ? gain * (t / 0.008) : t < dur ? gain * Math.pow(0.001 / gain, (t - 0.008) / (dur - 0.008)) : 0;
    const ph = (f * t) % 1;
    const w = tri ? 1 - 4 * Math.abs(ph - 0.5) : Math.sin(ph * 2 * Math.PI);
    const k = (start + i) % buf.length;
    buf[k] = buf[k]! + w * env;
  }
}
function makeCombo(): AudioClip {
  const buf = new Float32Array(Math.round(0.24 * RATE));
  renderTone(buf, 0, 587, 0.12, 0.09, true);
  renderTone(buf, 0.07, 880, 0.12, 0.14, true);
  return createClip([buf], RATE);
}

// The pad: a loop of 786/55 s (whole cycles of 110, 165 and 220 Hz; the LFO's one cycle ≈ 0.07 Hz).
const PAD_N = Math.round((786 / 55) * RATE);
const pad = new Float32Array(PAD_N);
let padPos = 0, z1 = 0, z2 = 0, y1 = 0, y2 = 0;
let b0 = 0, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
/** WebAudio's lowpass biquad (Q 1 dB) at the LFO's cutoff, run twice round so the loop joins. */
function renderPad(count: number): boolean {
  const end = Math.min(2 * PAD_N, padPos + count);
  const lfo = 1 / (786 / 55);
  for (; padPos < end; padPos++) {
    const i = padPos % PAD_N, t = i / RATE;
    if ((padPos & 63) === 0) {
      const fc = 500 + 120 * Math.sin(2 * Math.PI * lfo * t);
      const w0 = (2 * Math.PI * fc) / RATE, q = Math.pow(10, 1 / 20), alpha = Math.sin(w0) / (2 * q), c = Math.cos(w0);
      const a0 = 1 + alpha;
      b0 = (1 - c) / 2 / a0; b1 = (1 - c) / a0; b2 = b0; a1 = (-2 * c) / a0; a2 = (1 - alpha) / a0;
    }
    const x = Math.sin(2 * Math.PI * 110 * t) + Math.sin(2 * Math.PI * 165 * t) + Math.sin(2 * Math.PI * 220 * t);
    const y = b0 * x + b1 * z1 + b2 * z2 - a1 * y1 - a2 * y2;
    z2 = z1; z1 = x; y2 = y1; y1 = y;
    if (padPos >= PAD_N) pad[i] = y * 0.05;
  }
  return padPos >= 2 * PAD_N;
}

// The music: 24 steps of 340 ms (the arpeggio's pattern repeats each 24).
const SCALE = [262, 294, 330, 392, 440, 523, 587, 659];
const STEP = 0.34, STEPS = 24;
const music = new Float32Array(Math.round(STEPS * STEP * RATE));
let step = 0;
function renderMusic(): boolean {
  if (step >= STEPS) return true;
  const idx = [0, 2, 4, 7, 4, 2][step % 6]! + (step % 24 >= 12 ? 1 : 0);
  const f = SCALE[idx % SCALE.length]!;
  renderTone(music, step * STEP, f, 0.05, 0.5, true);
  if (step % 8 === 0) renderTone(music, step * STEP, f / 2, 0.05, 1.2, false);
  step++;
  return false;
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

/** Each frame: the clips once the mixer runs (one at a time), then the pad and the music. */
export function update(): void {
  if (context.state !== "running") return;
  if (wantClips) {
    wantClips = false;
    for (const n of SFX) if (!queue.includes(n)) queue.push(n);
  }
  if (!loading && queue.length) {
    const name = queue.shift()!;
    if (!clips.has(name)) {
      loading = true;
      loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); loading = false; }, (e: unknown) => {
        console.warn(`sfx ${name}: ${e instanceof Error ? e.message : String(e)}`);
        loading = false;
      });
    }
    return;
  }
  if (loading) return;
  if (!comboClip) {
    try { comboClip = makeCombo(); } catch (e) { console.warn(`audio: ${String(e)}`); }
    return;
  }
  if (!padClip) {
    if (!renderPad(12000)) return;
    try { padClip = createClip([pad], RATE); } catch (e) { console.warn(`audio: ${String(e)}`); padPos = 0; }
    return;
  }
  if (!padVoice) {
    try { padVoice = playClip(padClip, { bus: "music", gain: suspended ? 0 : PAD_GAIN, loop: true }); } catch { padVoice = null; }
    return;
  }
  if (!musicClip) {
    if (!renderMusic()) return;
    try { musicClip = createClip([music], RATE); } catch (e) { console.warn(`audio: ${String(e)}`); }
    return;
  }
  if (!musicVoice) {
    try { musicVoice = playClip(musicClip, { bus: "music", gain: suspended ? 0 : 1, loop: true }); } catch { musicVoice = null; }
  }
}
