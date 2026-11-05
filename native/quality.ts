// The look per graphics level. Shadows, AO, bloom, the grade and anti-aliasing
// come from the engine's levelSettings() for the frame's level; the art columns
// here (the browser build's src/gfx.js TABLE / BUDGETS) stay keyed by its
// quality tier, with the spark pool and the ambient motes scaled within the
// tier by the level's particle budget (at most 2×). The runtime owns the rest
// of what the old Graphics panel did: Auto and the level choice, render scale and the pixel-ratio cap,
// adaptive resolution, the frame-rate limit and readout. The old panel's
// per-effect overrides are not offered (the runtime's Options choose a level).
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export interface Budget {
  /** Block, table and board shading: Lambert (Low), Standard (Balanced), clear-coated Physical (High, Ultra). */
  material: "lambert" | "standard" | "physical";
  /** Rounded-block bevel segments (Surface detail). */
  bevel: number;
  /** Frosted table noise texture size (sockets: half). */
  noise: number;
  /** Tabletop / glow disc radial segments. */
  tableSeg: number;
  /** Spark pool at Particles high (low: ≤ 60). */
  sparks: number;
  /** Ambient prism motes (animated background). */
  motes: number;
}
export interface Look {
  preset: QualityTier;
  /** Key-light shadow map: the level's size (0 = off). */
  shadows: number;
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution (null = off). */
  bloom: number | null;
  grade: boolean;
  antialias: AntialiasMode;
  reflections: boolean;
  particles: "low" | "high";
  /** Background animated: motes, the breathing table glow, the bobbing selected piece. */
  animated: boolean;
  /** Surface detail: rounded bevelled blocks, frosted table and sockets. */
  detailed: boolean;
  budget: Budget;
}

/** gfx.js TABLE, without the engine's effects. */
const ART: Record<QualityTier, Pick<Look, "reflections" | "particles" | "animated" | "detailed">> = {
  low: { reflections: false, particles: "low", animated: false, detailed: false },
  balanced: { reflections: true, particles: "high", animated: true, detailed: true },
  high: { reflections: true, particles: "high", animated: true, detailed: true },
  ultra: { reflections: true, particles: "high", animated: true, detailed: true },
};
/** gfx.js BUDGETS. */
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", bevel: 1, noise: 128, tableSeg: 32, sparks: 180, motes: 50 },
  balanced: { material: "standard", bevel: 2, noise: 256, tableSeg: 48, sparks: 240, motes: 70 },
  high: { material: "physical", bevel: 3, noise: 256, tableSeg: 64, sparks: 360, motes: 90 },
  ultra: { material: "physical", bevel: 4, noise: 512, tableSeg: 96, sparks: 540, motes: 160 },
};
/** Each tier's first level: its budgets are authored for this level's particle budget. */
const ANCHOR: Record<QualityTier, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };
export const SPARK_MAX = 1080, MOTE_MAX = 320, SPARK_LOW = 60;

/** The look for a level's settings. */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const b = { ...BUDGETS[preset] };
  const k = Math.min(2, s.particles / levelSettings(ANCHOR[preset]).particles);
  b.sparks = Math.min(SPARK_MAX, Math.round(b.sparks * k));
  b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
  return {
    preset, ...ART[preset],
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
    budget: b,
  };
}
/** gfx.js sparkPool: the preset's pool at Particles high, ≤ 60 at low. */
export function sparkPool(l: Look): number { return l.particles === "high" ? l.budget.sparks : Math.min(SPARK_LOW, l.budget.sparks); }
