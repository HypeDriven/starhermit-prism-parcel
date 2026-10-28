// Prism Parcel on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules (src/rules.js), content (src/content.js)
// and save model (src/progress.js) are the browser build's, unchanged; this
// module is what src/main.js did around them — the screen flow (title →
// Journey / Daily / Practice setup → round ⇄ pause / settings / help →
// results), starting every mode (Learn, Journey, Daily, Practice, the resumed
// round), validated commands with the replay log, the round's events
// (sounds, sparks, shake, haptics, captions and announcements, lesson
// steps, achievements), the cursor, slot selection, hint and undo by keys,
// pads, pointer and touch (tap a piece then a cell, or drag a 3D offer piece
// onto the board), the results with the high-score post, and the lifecycle
// (a hidden window pauses a round and keeps its snapshot, as
// visibilitychange did). Screens are drawn by screens.ts (starhermit:ui),
// the board by render.ts (starhermit:scene).
//
// Time is the runtime's fixed steps (60 a second): the round clock, the
// short pause before the results and the Daily countdown run on it, so play
// scripts replay exactly.
import { clipboard, frame, onFixedUpdate, onPreferencesChange, onRender, onResume, onStart, onSuspend, onUpdate, preferences, setFixedRate } from "starhermit:engine";
import { onAction, onPointerButton, onPointerMove, onTouch, vibrate } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onSessionEnded, requestSignIn } from "starhermit:platform";
import { Content, Progress, Rules, type LoggedCommand, type RoundOptions, type State } from "./game.ts";
import * as audio from "./audio.ts";
import { S, T } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens } from "./screens.ts";
import { applyTokens, initStyles } from "./style.ts";

const N = Rules.BOARD_SIZE, OFFERS = Rules.OFFER_COUNT;
export type ScreenName = "title" | "setup" | "results";
export type Mode = "learn" | "journey" | "daily" | "practice";
export type Overlay = "pause" | "settings" | "help";

export const app = {
  /** The full-page screen, or null on the game screen. */
  screen: "title" as ScreenName | null,
  /** The pause, settings or help panel (settings and help also open over the title). */
  overlay: null as Overlay | null,
  /** Settings or help opened from the pause panel return to it. */
  overlayBack: null as Overlay | null,
  openedFrame: 0,
  screenFrame: 0,
  focusNext: null as string | null,
  setup: { kind: "journey" as "journey" | "daily" | "practice", stage: 1, difficulty: "medium" },
  /** The info drawer (both rails) on layouts narrower than 1024 px. */
  drawer: false,
  note: null as (() => string) | null,
};

/** The round (main.js session). */
export const round = {
  mode: null as Mode | null,
  state: null as State | null,
  options: null as RoundOptions | null,
  commands: [] as LoggedCommand[],
  stageId: null as number | null,
  dailyDate: null as string | null,
  selected: null as number | null,
  cursor: { row: 4, col: 4 },
  cursorShown: false,
  tutorialStep: 0,
  maxCombo: 0,
  maxLines: 0,
  /** Milliseconds played (the fixed-step clock, stopped while paused or hidden). */
  playedMs: 0,
  paused: false,
  over: false,
  /** Clock time the results show (the old 450 ms setTimeout), or null. */
  resultsAt: null as number | null,
  boardRows: null as { name: string; score: number }[] | null | undefined,
};
export interface Results {
  stars: number; prevBest: number; newly: string[]; lb: platform.Posted | "posting" | null; elapsedMs: number;
}
export let results: Results | null = null;

let clockMs = 0;
export const now = (): number => clockMs;
export const fresh = (): boolean => frame().frame !== app.openedFrame;

// ------------------------------------------------------------------ helpers
export function announce(text: string, assertive = false): void {
  if (text) ui.announce(text.slice(0, 500), { politeness: assertive ? "assertive" : "polite" });
}
function caption(event: string): void {
  if (!platform.options.captions) return;
  const text = audio.describeEvent(event);
  if (text) announce(T(text));
}
function haptic(ms: number): void { if (platform.options.haptics) { try { vibrate(ms); } catch { /* no motor */ } } }
const pending: (() => void)[] = [];
/** A widget's press, run once the frame's UI is built (state changes mid-build would break later widgets). */
export function later(fn: () => void): void { pending.push(fn); }

export function openScreen(name: ScreenName | null): void {
  app.screen = name;
  app.openedFrame = app.screenFrame = frame().frame;
  app.drawer = false;
  ui.setFocus(null);
  render.setActive(name === null);
}
export function openOverlay(o: Overlay | null, back: Overlay | null = null): void {
  app.overlay = o;
  app.overlayBack = back;
  app.openedFrame = frame().frame;
}
export function goTitle(): void { openOverlay(null); openScreen("title"); app.focusNext = "btn-play"; }

// ------------------------------------------------------------------ objective texts
export function goalText(g: { type: string; target: number }, moveLimit: number | null): string {
  const what = g.type === "score" ? T("{n} points", { n: g.target }) : g.type === "lines" ? T("{n} lines", { n: g.target }) : T("{n} placements", { n: g.target });
  return moveLimit ? T("Goal: {what} in {n} moves", { what, n: moveLimit }) : T("Goal: {what}", { what });
}
export function objectiveText(): string {
  const g = round.state?.goal;
  if (round.mode === "daily") return T("Daily: highest score");
  if (round.mode === "practice") return T("Practice: play freely");
  if (round.mode === "learn") return T("Learn: follow the lessons");
  if (!g) return T("Score as high as you can");
  return goalText(g, round.state!.moveLimit);
}
export function today(): string { return Content.utcDateStr(platform.nowMs()); }

// ------------------------------------------------------------------ starting rounds
const randomSeed = (): number => (Math.random() * 0xffffffff) >>> 0;
export function startRound(mode: Mode, options: RoundOptions, meta: { stageId?: number; dailyDate?: string } = {}): void {
  round.mode = mode;
  round.options = options;
  round.state = Rules.initialState(options);
  round.commands = [];
  round.stageId = meta.stageId ?? null;
  round.dailyDate = meta.dailyDate ?? null;
  round.tutorialStep = 0;
  round.selected = null;
  round.cursor = { row: 4, col: 4 };
  round.cursorShown = false;
  round.over = false;
  round.maxCombo = 0;
  round.maxLines = 0;
  round.playedMs = 0;
  round.paused = false;
  round.resultsAt = null;
  round.boardRows = undefined;
  results = null;
  audio.seedVariants(options.seed);
  showRound();
  announce(objectiveText() + " " + T("Round started."));
  if (mode === "learn") showLesson(0);
  if (mode === "daily") refreshDailyBoard();
}
function showRound(): void {
  const s = round.state!;
  render.resetEffects();
  render.applyBoard(s.board);
  render.applyOffer(s.offer, null);
  render.hideGhost();
  render.setCursor(round.cursor.row, round.cursor.col, false);
  openOverlay(null);
  openScreen(null);
}
export function startJourney(id: number): void {
  const st = Content.stageInfo(id);
  if (!st) return;
  startRound("journey", { seed: st.seed, maxTier: st.maxTier, goal: { ...st.goal }, moveLimit: st.moveLimit }, { stageId: st.id });
}
export function startDaily(): void {
  const date = today();
  const rs = Content.dailyRuleset(date);
  startRound("daily", { seed: rs.seed, maxTier: rs.maxTier, goal: null, moveLimit: null }, { dailyDate: date });
}
export function startPractice(difficulty: string): void { startRound("practice", Content.practiceOptions(difficulty, randomSeed())); }
export function startLearn(): void { startRound("learn", { seed: 0x1eaa42, maxTier: 0, goal: null, moveLimit: null }); }
export function openSetup(kind: "journey" | "daily" | "practice"): void {
  app.setup.kind = kind;
  app.setup.stage = platform.save().progress.stage;
  openScreen("setup");
  app.focusNext = "setup-start";
}
/** Play: the round left unfinished on this device, else the Journey setup. */
export function play(): void {
  const snap = Progress.readSnapshot(platform.loadRound());
  if (!snap) { openSetup("journey"); return; }
  round.mode = snap.mode as Mode;
  round.options = snap.options;
  round.commands = snap.commands;
  round.state = snap.state;
  round.stageId = snap.stageId;
  round.dailyDate = snap.dailyDate;
  round.selected = null;
  round.cursor = { row: 4, col: 4 };
  round.cursorShown = false;
  round.over = false;
  round.maxCombo = snap.maxCombo;
  round.maxLines = snap.maxLines;
  round.playedMs = snap.elapsedMs;
  round.tutorialStep = snap.tutorialStep;
  round.paused = false;
  round.resultsAt = null;
  round.boardRows = undefined;
  results = null;
  audio.seedVariants(snap.options.seed);
  showRound();
  if (snap.tutorial) showLesson(round.tutorialStep);
  announce(T("Round restored from your last safe snapshot."));
}
export function retry(): void {
  const { mode, options, stageId, dailyDate } = round;
  if (!mode || !options) { goTitle(); return; }
  if (mode === "practice") startPractice(Content.DIFFICULTIES[options.maxTier] ?? "medium");
  else if (mode === "learn") startLearn();
  else startRound(mode, { ...options }, { ...(stageId ? { stageId } : {}), ...(dailyDate ? { dailyDate } : {}) });
}
export function nextStage(): void { if (round.stageId) startJourney(round.stageId + 1); }
export const inTutorial = (): boolean => round.mode === "learn" && round.tutorialStep < Content.TUTORIAL_STEPS.length;
/** The board takes input: a round on screen, no panel over it, not finished. */
export const playing = (): boolean => !!round.state && app.screen === null && app.overlay === null && !round.paused && !round.state.over;

function saveSnapshot(): void {
  if (!round.state || round.mode === "daily" || round.state.over) return;
  platform.saveRound(Progress.makeSnapshot({
    mode: round.mode!, options: round.options!, stageId: round.stageId, tutorialStep: round.tutorialStep, dailyDate: round.dailyDate,
    elapsedMs: round.playedMs, maxCombo: round.maxCombo, maxLines: round.maxLines, commands: round.commands, state: round.state,
  }));
}

// ------------------------------------------------------------------ lessons
export function showLesson(i: number): void {
  round.tutorialStep = i;
  const step = Content.TUTORIAL_STEPS[i];
  if (!step) return;
  announce(T("Lesson {n} of {total}: {title}.", { n: i + 1, total: Content.TUTORIAL_STEPS.length, title: T(step.title) }) + " " + T(step.text), true);
}
function advanceLesson(gain: State["lastGain"]): void {
  const step = Content.TUTORIAL_STEPS[round.tutorialStep];
  if (!step) return;
  const ok = step.require === "place" || (step.require === "clear" && !!gain && gain.lines > 0);
  if (!ok) { announce(T("Almost — this lesson needs you to clear a line. Try filling a full row or column."), true); return; }
  audio.playCombo();
  const next = round.tutorialStep + 1;
  if (next >= Content.TUTORIAL_STEPS.length) {
    round.tutorialStep = Content.TUTORIAL_STEPS.length;
    platform.save().progress.tutorialDone = true;
    platform.persist();
    announce(T("Tutorial complete! Keep playing — the round ends when no piece fits."), true);
  } else showLesson(next);
}

// ------------------------------------------------------------------ commands (main.js issueCommand)
function invalidReasonText(reason: string): string {
  switch (reason) {
    case "round-over": return T("the round is over");
    case "bad-offer-slot": return T("no such offer slot");
    case "offer-slot-empty": return T("that piece was already placed");
    case "out-of-bounds": return T("the piece would leave the board");
    case "cell-occupied": return T("those cells are occupied");
    case "piece-does-not-fit": return T("the piece does not fit there");
    default: return reason;
  }
}
function findClearedLines(before: State, after: State): { rows: number[]; cols: number[] } {
  const rows: number[] = [], cols: number[] = [];
  for (let i = 0; i < N; i++) {
    let wasRow = true, wasCol = true, nowRow = true, nowCol = true;
    for (let j = 0; j < N; j++) {
      if (before.board[i]![j] === 0) wasRow = false;
      if (before.board[j]![i] === 0) wasCol = false;
      if (after.board[i]![j] !== 0) nowRow = false;
      if (after.board[j]![i] !== 0) nowCol = false;
    }
    if (wasRow && nowRow) rows.push(i);
    if (wasCol && nowCol) cols.push(i);
  }
  return { rows, cols };
}
let cmdSeq = 0;
function place(slot: number, row: number, col: number): boolean {
  const s0 = round.state;
  if (!s0 || s0.over) return false;
  const cmd = { type: "place" as const, slot, row, col, id: "c" + ++cmdSeq };
  const check = Rules.validateCommand(s0, cmd);
  if (!check.ok) {
    round.state = Rules.applyCommand(s0, cmd); // counts the invalid attempt
    if (check.reason !== "round-over" && check.reason !== "malformed-command" && slot >= 0 && slot < OFFERS && row >= 0 && row < N && col >= 0 && col < N) {
      round.commands.push({ slot, row, col, inv: 1 });
    }
    audio.playInvalid(); caption("invalid");
    announce(T("Invalid action: {reason}", { reason: invalidReasonText(check.reason ?? "") }), true);
    return false;
  }
  const before = s0;
  const prevOfferEmpty = before.offer.every((o) => o === null);
  round.state = Rules.applyCommand(before, cmd);
  const s = round.state;
  round.commands.push({ slot, row, col });
  const gain = s.lastGain;
  if (gain) { round.maxCombo = Math.max(round.maxCombo, gain.comboStreak); round.maxLines = Math.max(round.maxLines, gain.lines); }
  audio.playPlace(); caption("place");
  haptic(15);
  if (gain && gain.lines > 0) {
    const rc = findClearedLines(before, s);
    render.animateClears(rc.rows, rc.cols, (r, c) => (before.board[r]![c] || 1) - 1);
    audio.playClear(gain.lines); caption("clear");
    render.shake(Math.min(0.05 + gain.lines * 0.04, 0.25));
    haptic(60);
    announce(T(gain.lines > 1 ? "Cleared {n} lines for {points} points." : "Cleared {n} line for {points} points.", { n: gain.lines, points: gain.total })
      + (gain.comboStreak >= 2 ? " " + T("Combo x{n}.", { n: gain.comboStreak }) : ""));
  }
  if (!prevOfferEmpty && before.offer.filter((o) => o === null).length === OFFERS - 1 && s.offer.every((o) => o !== null)) {
    audio.playReplenish(); caption("replenish");
  }
  if (round.selected != null && !s.offer[round.selected]) { round.selected = null; render.hideGhost(); }
  render.applyBoard(s.board);
  render.applyOffer(s.offer, round.selected);
  saveSnapshot();
  if (round.mode === "learn") advanceLesson(gain);
  if (s.over) round.resultsAt = clockMs + (preferences().reducedMotion ? 60 : 450);
  return true;
}
export function selectSlot(i: number): void {
  const s = round.state;
  if (!s || !s.offer[i]) return;
  round.selected = round.selected === i ? null : i;
  render.setSelectedSlot(round.selected);
  audio.playSelect();
  if (round.selected != null) {
    announce(T("{piece} selected. Choose a cell.", { piece: T(Rules.pieceById(s.offer[i]!.piece).name) }));
    preview();
  } else render.hideGhost();
}
export function clearSelection(): void { round.selected = null; render.hideGhost(); render.setSelectedSlot(null); }
function preview(): void {
  const s = round.state;
  if (!s || round.selected == null) return;
  const slot = s.offer[round.selected];
  if (slot) render.showGhost(s.board, slot.piece, round.cursor.row, round.cursor.col, slot.hue);
}
/** Place at a cell (one-tap play: the first offered piece when none is selected). */
export function commitAt(row: number, col: number): void {
  if (!playing() || round.resultsAt !== null) return;
  if (round.selected == null) {
    for (let i = 0; i < OFFERS; i++) if (round.state!.offer[i]) { selectSlot(i); break; }
    if (round.selected == null) return;
  }
  place(round.selected, row, col);
}
export function doHint(): void {
  const s = round.state;
  if (!s) return;
  const hint = Rules.findHint(s);
  if (!hint) { announce(T("No legal placement exists."), true); return; }
  round.selected = hint.slot;
  round.cursor = { row: hint.row, col: hint.col };
  round.cursorShown = true;
  render.setSelectedSlot(hint.slot);
  preview();
  audio.playSelect();
  announce(T("Hint: place slot {slot} at row {row}, column {col}.", { slot: hint.slot + 1, row: hint.row + 1, col: hint.col + 1 }));
}
export const canUndo = (): boolean => !!round.state?.undo && (round.mode === "practice" || round.mode === "learn");
export function doUndo(): void {
  if (round.mode !== "practice" && round.mode !== "learn") { announce(T("Undo is only available in practice and learn modes."), true); return; }
  const cur = round.state!;
  const s = Rules.applyCommand(cur, { type: "undo" });
  if (s === cur || !cur.undo) { announce(T("Nothing to undo."), true); return; }
  round.state = s;
  // Drop the undone placement plus any logged invalid attempts after it.
  while (round.commands.length) { const c = round.commands.pop()!; if (!c.inv) break; }
  round.selected = null;
  render.applyBoard(s.board);
  render.applyOffer(s.offer, null);
  render.hideGhost();
  saveSnapshot();
  audio.playClick();
  announce(T("Undone."));
}
function moveCursor(dr: number, dc: number): void {
  round.cursor.row = Math.max(0, Math.min(N - 1, round.cursor.row + dr));
  round.cursor.col = Math.max(0, Math.min(N - 1, round.cursor.col + dc));
  round.cursorShown = true;
}

// ------------------------------------------------------------------ the end of a round (main.js endRound)
function endRound(): void {
  const s = round.state!;
  round.over = true;
  const p = platform.save().progress;
  const r = Progress.recordRound(p, {
    mode: round.mode!, stageId: round.stageId, dailyDate: round.dailyDate, state: s, maxLines: round.maxLines, maxCombo: round.maxCombo,
    tutorialStep: round.tutorialStep, now: platform.nowMs(),
  });
  for (const key of r.newly) {
    audio.playAchievement(); caption("achievement");
    const a = Content.ACHIEVEMENTS.find((x) => x.key === key);
    announce(T("Achievement unlocked: {name}", { name: a ? T(a.name) : key }), true);
  }
  platform.persist();
  platform.clearRound();
  if (s.won) { audio.playWin(); caption("win"); } else { audio.playOver(); caption("over"); }
  results = { stars: r.stars, prevBest: r.prevBest, newly: r.newly, lb: null, elapsedMs: round.playedMs };
  // Signed in, Journey and Daily rounds: post the total to the high-score board and show the rank.
  if (platform.signedIn() && (round.mode === "journey" || round.mode === "daily")) {
    results.lb = "posting";
    const res = results;
    void platform.postScore(s.score.total).then((x) => { res.lb = x; if (round.mode === "daily") refreshDailyBoard(); });
  }
  openScreen("results");
  app.focusNext = "btn-retry";
  announce(T("{heading} Total score {n}.", { heading: s.won ? T("Goal Complete!") : T("Round Over"), n: s.score.total }), true);
}
export function refreshDailyBoard(): void {
  round.boardRows = undefined;
  if (!platform.signedIn()) { round.boardRows = null; return; }
  void platform.topEntries().then((rows) => { round.boardRows = rows; });
}
export function leaderboardLine(): string | null {
  const r = results?.lb;
  if (!r) return null;
  if (r === "posting") return S("lbPosting");
  return !r.posted ? S("lbNotPosted") : r.rank ? S("lbRank", { rank: r.rank }) : S("lbPosted");
}

// ------------------------------------------------------------------ pause, settings, help
export function pauseGame(): void {
  if (app.screen !== null || !round.state || round.over || round.paused) return;
  round.paused = true;
  openOverlay("pause");
  app.focusNext = "btn-resume";
  announce(T("Paused."));
}
export function resumeGame(): void {
  if (!round.paused) return;
  round.paused = false;
  openOverlay(null);
  ui.setFocus(null);
  announce(T("Resumed."));
}
export function leaveRound(): void {
  // A logically finished round still gets its results (and progress) recorded.
  if (round.state && round.state.over && !round.over) { openOverlay(null); round.paused = false; endRound(); return; }
  round.paused = false;
  saveSnapshot();
  goTitle();
}
export function openSettings(): void { openOverlay("settings", app.overlay === "pause" ? "pause" : null); }
export function openHelp(): void { openOverlay("help", app.overlay === "pause" ? "pause" : null); app.focusNext = "btn-help-close"; }
/** Done / Close / Escape on settings or help: back to the pause panel when it opened them. */
export function closeOverlay(): void {
  const back = app.overlayBack;
  openOverlay(back);
  if (back === "pause") app.focusNext = "btn-resume";
}
export function replayTutorial(): void { openOverlay(null); round.paused = false; startLearn(); }

// ------------------------------------------------------------------ the account
export function signIn(): void { void requestSignIn().catch(() => undefined); }
export function copyInvite(): void {
  const link = platform.inviteLink();
  if (!link) return;
  try { clipboard.writeText(link); app.note = () => S("inviteCopied"); } catch { app.note = () => S("inviteFailed", { link }); }
}

// ------------------------------------------------------------------ keys and pads (main.js keydown + pollGamepad)
onAction((e) => {
  if (!e.pressed) return;
  const a = e.action;
  if (ui.capturingKeys()) return;
  if (a === "pause") {
    if (!fresh()) return;
    if (app.overlay === "settings" || app.overlay === "help") { later(closeOverlay); return; }
    if (app.overlay === "pause") { later(resumeGame); return; }
    if (app.screen === null) { later(pauseGame); return; }
    if (app.screen === "setup") { later(goTitle); return; }
    return;
  }
  if (!playing() || round.resultsAt !== null) return;
  let handled = true;
  switch (a) {
    case "cursor_up": moveCursor(-1, 0); break;
    case "cursor_down": moveCursor(1, 0); break;
    case "cursor_left": moveCursor(0, -1); break;
    case "cursor_right": moveCursor(0, 1); break;
    case "slot_1": case "slot_2": case "slot_3": selectSlot(Number(a.slice(-1)) - 1); break;
    case "next_slot": selectSlot(round.selected == null ? 0 : (round.selected + 1) % OFFERS); break;
    case "place":
      if (ui.focused() !== null && e.source !== "gamepad") return; // Enter / Space on a focused button is the button's
      round.cursorShown = true;
      later(() => commitAt(round.cursor.row, round.cursor.col));
      break;
    case "hint": later(doHint); break;
    case "undo": later(doUndo); break;
    case "clear": clearSelection(); break;
    default: handled = false;
  }
  if (handled) {
    if (a.startsWith("cursor_")) ui.setFocus(null);
    preview();
  }
});

// ------------------------------------------------------------------ pointer and touch on the board (main.js setupPointer)
/** Rectangles (window px) where a press belongs to the UI, set by screens.ts each frame. */
export const hudRects: render.Rect[] = [];
/** The playfield (the old canvas) in window px, set by screens.ts. */
export const view: render.Rect = { x: 0, y: 0, width: 0, height: 0 };
const inView = (x: number, y: number): boolean => x >= view.x && y >= view.y && x <= view.x + view.width && y <= view.y + view.height;
const onHud = (x: number, y: number): boolean => hudRects.some((r) => x >= r.x && y >= r.y && x <= r.x + r.width && y <= r.y + r.height);
type PEvent = { kind: "down" | "move" | "up" | "cancel"; x: number; y: number; id: number };
const events: PEvent[] = [];
let lastTouch = -1e9;
onTouch((e) => {
  lastTouch = clockMs;
  if (e.phase === "start") { if (!e.control) events.push({ kind: "down", x: e.x, y: e.y, id: e.id }); }
  else if (e.phase === "move") events.push({ kind: "move", x: e.x, y: e.y, id: e.id });
  else if (e.phase === "end") events.push({ kind: "up", x: e.x, y: e.y, id: e.id });
  else events.push({ kind: "cancel", x: e.x, y: e.y, id: e.id });
});
onPointerButton((e) => {
  if (e.button !== 0 || clockMs - lastTouch < 600) return;
  events.push({ kind: e.pressed ? "down" : "up", x: e.x, y: e.y, id: -1 });
});
onPointerMove((x, y) => { if (clockMs - lastTouch >= 600) events.push({ kind: "move", x, y, id: -1 }); });
let drag: { slot: number | null; id: number; x0: number; y0: number; moved: boolean; commitOnUp: boolean } | null = null;
function pointerInput(wasPlaying: boolean): void {
  const list = events.splice(0);
  // a press that closed a panel or left a screen this frame belongs to that widget, not the board
  if (!wasPlaying || !playing() || round.resultsAt !== null) { if (!playing()) drag = null; return; }
  const s = round.state!;
  for (const ev of list) {
    if (ev.kind === "down") {
      if (!inView(ev.x, ev.y) || onHud(ev.x, ev.y)) continue;
      ui.setFocus(null);
      const slot = render.pickOffer(ev.x, ev.y);
      if (slot != null && s.offer[slot]) {
        selectSlot(slot);
        drag = { slot, id: ev.id, x0: ev.x, y0: ev.y, moved: false, commitOnUp: false };
        continue;
      }
      const cell = render.pickCell(ev.x, ev.y);
      if (!cell) continue;
      round.cursor = cell;
      round.cursorShown = true;
      preview();
      drag = { slot: round.selected, id: ev.id, x0: ev.x, y0: ev.y, moved: false, commitOnUp: true };
    } else if (ev.kind === "move") {
      if (drag && ev.id === drag.id) {
        const k = ui.preferences().scale;
        if (Math.hypot(ev.x - drag.x0, ev.y - drag.y0) > 8 * k) drag.moved = true;
        const cell = render.pickCell(ev.x, ev.y);
        if (cell) { round.cursor = cell; round.cursorShown = true; preview(); }
      } else if (!drag && round.selected != null && inView(ev.x, ev.y) && !onHud(ev.x, ev.y)) {
        // hover preview (never required)
        const cell = render.pickCell(ev.x, ev.y);
        if (cell) { round.cursor = cell; preview(); }
      }
    } else if (drag && ev.id === drag.id) {
      const d = drag;
      drag = null;
      if (ev.kind === "cancel") { render.hideGhost(); continue; }
      const cell = render.pickCell(ev.x, ev.y);
      if (d.slot != null && cell && (d.moved || d.commitOnUp)) {
        round.selected = d.slot;
        commitAt(cell.row, cell.col);
      } else if (d.commitOnUp && cell && !d.moved) commitAt(cell.row, cell.col);
    }
  }
}

// ------------------------------------------------------------------ the clock
let hidden = false;
onFixedUpdate(() => {
  if (hidden) return;
  clockMs += 1000 / 60;
  if (round.state && app.screen === null && !round.paused && !round.over) round.playedMs += 1000 / 60;
  if (round.resultsAt !== null && clockMs >= round.resultsAt) {
    round.resultsAt = null;
    if (round.state && round.state.over && !round.over && app.screen === null) {
      if (round.paused) { round.paused = false; openOverlay(null); }
      endRound();
    }
  }
});

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const k = `${f.quality}:${f.levelIndex}`;
  if (k === lookKey) return;
  lookKey = k;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}
function applyOptions(): void { render.setTheme(platform.options.theme, platform.options.cvdPalette); }
onStart(() => {
  setFixedRate(60);
  initStyles();
  platform.initPlatform();
  audio.loadSfx();
  render.setReducedMotion(preferences().reducedMotion);
  applyOptions();
  applyLook();
  openScreen("title");
  app.focusNext = "btn-play";
});
onPreferencesChange((p) => render.setReducedMotion(p.reducedMotion));
platform.onOptionsChange(() => applyOptions());
platform.onProgressMerged(() => { if (app.screen === "title") announce(T("Progress restored from your StarHermit cloud save.")); });
onSessionEnded(() => { app.note = () => S("signedOut"); });
onSuspend(() => {
  hidden = true;
  // Backgrounding pauses a round in progress and keeps its snapshot.
  if (round.state && !round.over && app.screen === null) { pauseGame(); saveSnapshot(); }
  audio.setSuspended(true);
  platform.flush();
});
onResume(() => { hidden = false; audio.setSuspended(false); });

let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  applyTokens(ui.preferences().highContrast);
  audio.update();
});
onRender(() => {
  hudRects.length = 0;
  const wasPlaying = playing();
  drawScreens();
  for (const fn of pending.splice(0)) fn();
  pointerInput(wasPlaying);
  if (round.state && app.screen === null) {
    const showCursor = round.cursorShown && !round.state.over;
    render.setCursor(round.cursor.row, round.cursor.col, showCursor);
  }
  render.update(frameDt);
});
