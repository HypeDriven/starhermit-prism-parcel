// The browser build's pure game modules (shared with the node tests and
// server.js), typed for this client: the rules (src/rules.js: board, pieces,
// validated commands, scoring, undo, hints, replay), the content
// (src/content.js: themes, difficulties, the 40 Journey stages, the Daily,
// the lessons, achievements, mastery ranks) and the save model
// (src/progress.js).
import * as rules from "../src/rules.js";
import * as content from "../src/content.js";
import * as progress from "../src/progress.js";

export type Cell = [number, number];
export interface Piece { id: string; name: string; tier: number; cells: readonly Cell[] }
export interface Slot { piece: string; hue: number }
export interface Goal { type: "score" | "lines" | "moves"; target: number }
export interface ScoreParts { cells: number; clear: number; simultaneous: number; combo: number; total: number }
export interface Gain extends ScoreParts { lines: number; clearedCells: number; comboStreak: number }
export interface State {
  v: number; seed: number; rngState: number; maxTier: number; board: number[][]; offer: (Slot | null)[];
  turn: number; comboStreak: number; invalid: number; score: ScoreParts; lines: number; placedPieces: number;
  goal: Goal | null; moveLimit: number | null; over: boolean; won: boolean; reason: string | null;
  lastGain?: Gain; undo?: { snapshot: State } | null;
}
export interface RoundOptions { seed: number; maxTier: number; goal: Goal | null; moveLimit: number | null }
export interface Command { type: "place" | "undo"; slot?: number; row?: number; col?: number; id?: string }
export interface Stage {
  id: number; seed: number; difficulty: string; maxTier: number; goal: Goal; moveLimit: number | null; par: number;
  theme: string; mastery: boolean; tutorial: boolean;
}
export interface DailyRules { id: string; version: number; date: string; seed: number; maxTier: number; par: number; theme: string }
export interface ThemeInfo { name: string; bg: number; key: number; fill: number; accent: number; table: number }
export interface Lesson { id: string; title: string; text: string; require: "place" | "clear" }
export interface Achievement { key: string; name: string; desc: string }

export interface Progress {
  stage: number; stars: Record<string, number>; bestScores: Record<string, number>; achievements: Record<string, number>;
  tutorialDone: boolean; totalPlaced: number; dailyBest: Record<string, number>; friends: string[];
}
export interface SaveDoc { v: number; progress: Progress }
export interface Options { theme: string; cvdPalette: boolean; captions: boolean; leftHanded: boolean; haptics: boolean }
export type LoggedCommand = { slot: number; row: number; col: number; inv?: number };
export interface Snapshot {
  mode: string; options: RoundOptions; state: State; commands: LoggedCommand[]; stageId: number | null; dailyDate: string | null;
  maxCombo: number; maxLines: number; elapsedMs: number; tutorialStep: number; tutorial: boolean;
}

interface RulesApi {
  BOARD_SIZE: number; OFFER_COUNT: number; PIECES: readonly Piece[];
  pieceById(id: string): Piece; canPlace(board: number[][], row: number, col: number, piece: Piece): boolean;
  initialState(o: RoundOptions): State; applyCommand(s: State, c: Command): State;
  validateCommand(s: State, c: Command): { ok: boolean; reason?: string };
  findHint(s: State): { slot: number; row: number; col: number } | null;
  createRng(seed: number): { next(): number; int(n: number): number };
}
interface ContentApi {
  STAGES: readonly Stage[]; THEMES: readonly string[]; DIFFICULTIES: readonly string[];
  DIFFICULTY_INFO: Record<string, { name: string; maxTier: number; desc: string }>;
  TUTORIAL_STEPS: readonly Lesson[]; ACHIEVEMENTS: readonly Achievement[];
  stageInfo(id: number): Stage | null; stageCount(): number; themeInfo(theme: string): ThemeInfo;
  dailyRuleset(date: string): DailyRules; utcDateStr(ms: number): string;
  practiceOptions(difficulty: string, seed: number): RoundOptions;
}
interface ProgressApi {
  defaultSave(): SaveDoc; normalize(raw: unknown): SaveDoc; mergeSave(remote: unknown, local: unknown): SaveDoc; sameSave(a: unknown, b: unknown): boolean;
  readForeign(text: string): { save: SaveDoc; options: Partial<Options> } | null;
  DEFAULT_OPTIONS: Options; OPTION_KEYS: (keyof Options)[]; BROWSER_KEYS: string[]; pickOptions(raw: unknown): Partial<Options>;
  recordRound(p: Progress, r: {
    mode: string; stageId: number | null; dailyDate: string | null; state: State; maxLines: number; maxCombo: number; tutorialStep: number; now: number;
  }): { newly: string[]; stars: number; prevBest: number };
  unlockedAchievements(p: Progress): Achievement[];
  mastery(p: Progress): { stars: number; rank: string };
  makeSnapshot(r: {
    mode: string; options: RoundOptions; stageId: number | null; tutorialStep: number; dailyDate: string | null; elapsedMs: number;
    maxCombo: number; maxLines: number; commands: LoggedCommand[]; state: State;
  }): unknown;
  readSnapshot(raw: unknown): Snapshot | null;
}

export const Rules = rules as unknown as RulesApi;
export const Content = content as unknown as ContentApi;
export const Progress = progress as unknown as ProgressApi;
