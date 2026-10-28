// The look per graphics level: the browser build's four presets and budgets
// (src/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU
// its Auto gave it) keyed by the runtime's quality tier (frame().quality),
// with the spark pool and the ambient motes scaled within the tier by the
// level (frame().levelIndex, at most 2×), as the browser build scaled them by
// its hardware level. The runtime owns the rest of what the old Graphics
// panel did: Auto and the level choice, render scale and the pixel-ratio cap,
// adaptive resolution, the frame-rate limit and readout. The old panel's
// per-effect overrides are not offered (the runtime's Options choose a level).
import type { QualityTier } from "starhermit:engine";
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
  bloomRes: number;
  aoRes: number;
}
export interface Look {
  preset: QualityTier;
  /** Key-light shadow map (0 = off). */
  shadows: 0 | 1024 | 2048 | 4096;
  ao: "off" | "on" | "high";
  bloom: boolean;
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

/** gfx.js TABLE. */
const TABLE: Record<QualityTier, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "off", reflections: false, particles: "low", animated: false, detailed: false },
  balanced: { shadows: 1024, ao: "off", bloom: true, grade: true, antialias: "fxaa", reflections: true, particles: "high", animated: true, detailed: true },
  high: { shadows: 2048, ao: "on", bloom: true, grade: true, antialias: "smaa", reflections: true, particles: "high", animated: true, detailed: true },
  ultra: { shadows: 4096, ao: "high", bloom: true, grade: true, antialias: "msaa", reflections: true, particles: "high", animated: true, detailed: true },
};
/** gfx.js BUDGETS. */
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", bevel: 1, noise: 128, tableSeg: 32, sparks: 180, motes: 50, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: "standard", bevel: 2, noise: 256, tableSeg: 48, sparks: 240, motes: 70, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: "physical", bevel: 3, noise: 256, tableSeg: 64, sparks: 360, motes: 90, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: "physical", bevel: 4, noise: 512, tableSeg: 96, sparks: 540, motes: 160, bloomRes: 1, aoRes: 1 },
};
/** The first level index of each tier. */
const TIER_FLOOR: Record<QualityTier, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };
export const SPARK_MAX = 1080, MOTE_MAX = 320, SPARK_LOW = 60;

/** The look for a quality tier at a level index (0 … 9). */
export function lookFor(preset: QualityTier, levelIndex: number): Look {
  const b = { ...BUDGETS[preset] };
  const k = Math.min(2, Math.pow(1.64, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.sparks = Math.min(SPARK_MAX, Math.round(b.sparks * k));
  b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
  return { preset, ...TABLE[preset], budget: b };
}
/** gfx.js sparkPool: the preset's pool at Particles high, ≤ 60 at low. */
export function sparkPool(l: Look): number { return l.particles === "high" ? l.budget.sparks : Math.min(SPARK_LOW, l.budget.sparks); }
