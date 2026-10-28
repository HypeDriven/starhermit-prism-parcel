// The browser build's DOM (index.html + the screens src/main.js built) as
// starhermit:ui, built every frame over the board: the title (the gradient
// wordmark over its soft prism glows, the menu, the progress, profile and
// UTC-day lines), the Journey / Daily / Practice setup panel, the game screen
// (the objective and progress rail, the status, daily-board and controls
// rail, the score HUD, Hint / Undo / Pause, the offer tray with its shape
// thumbnails, the lesson card, a named target over every board cell — the old
// screen-reader board mirror, which play scripts click), the results panel,
// and the pause, settings and help panels. The old media queries are layouts
// picked by the window's logical size: ≥ 1024 px the rails sit either side of
// the playfield, narrower they open as a drawer (☰); ≤ 640 px the HUD
// shrinks to the score; short landscape parks the lesson card in the corner.
// The playfield's rectangle and the bands the HUD and tray cover go to
// render.ts, which frames the board in what they leave.
import { frame, openMenu } from "starhermit:engine";
import { bindings, requestRebind } from "starhermit:input";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { Content, Progress, Rules } from "./game.ts";
import { N as key, S, T, plain } from "./i18n.ts";
import * as platform from "./platform.ts";
import * as render from "./render.ts";
import {
  app, canUndo, closeOverlay, copyInvite, doHint, doUndo, fresh, goTitle, goalText, hudRects, inTutorial, later,
  leaderboardLine, leaveRound, nextStage, objectiveText, openHelp, openSettings, openSetup, pauseGame, play, replayTutorial,
  results, resumeGame, retry, round, selectSlot, signIn, startDaily, startJourney, startLearn, startPractice, today, view,
} from "./main.ts";
import { token } from "./style.ts";

// ------------------------------------------------------------------ layout
interface Layout { lw: number; lh: number; sc: number; wide: boolean; small: boolean; shortLand: boolean }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  return { lw, lh, sc, wide: lw >= 1024, small: lw <= 640, shortLand: lw > lh && lh <= 520 };
}
const lastSize = new Map<string, ui.Rect>();
function textWidth(text: string, style: string, kind?: "button" | "heading"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: [style] }).width / ui.preferences().scale;
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls = "text", id?: string): void {
  if (!text) return;
  let u = ui.style(cls);
  if (id) u = u.id(id);
  if (textWidth(text, cls) <= width) u.label(text);
  else u.paragraph(text, Math.max(20, width));
}
interface Btn {
  id: string; text: string; style?: string; act: () => void; disabled?: boolean; name?: string; selected?: boolean;
  content?: () => void; width?: number; height?: number; tooltip?: string;
}
const buttonWidth = (text: string, style: string): number => textWidth(text, style, "button") + 2;
function button(b: Btn): void {
  const style = b.style ?? "btn";
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  if (b.selected !== undefined) opts.selected = b.selected;
  if (b.tooltip) opts.tooltip = b.tooltip;
  if (b.content) opts.content = b.content;
  else if (b.width != null && buttonWidth(b.text, style) > b.width) {
    const inner = b.width - 34;
    opts.content = () => { ui.style("wrap").paragraph(b.text, Math.max(20, inner)); };
  } else if (b.name && b.name !== b.text) opts.content = () => { ui.label(b.text); };
  const s: ui.Style = {};
  if (b.width != null) s.width = b.width;
  if (b.height != null) s.height = b.height;
  if (ui.style(style, s).id(b.id).button(b.name ?? b.text, opts) && fresh()) later(b.act);
}
/** Buttons at their own widths (or `stretch`ed) in rows that wrap at `width` (flex-wrap), centred or from the start. */
function flow(label: string, list: Btn[], width: number, gap = 9.6, stretch = false, justify: "start" | "center" = "center"): void {
  const rows: Btn[][] = [[]];
  let used = 0;
  const bw = (b: Btn): number => Math.min(width, b.width ?? buttonWidth(b.text, b.style ?? "btn"));
  for (const b of list) {
    const w = bw(b);
    if (rows[rows.length - 1]!.length && used + gap + w > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + w;
    rows[rows.length - 1]!.push(b);
  }
  ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => {
      if (stretch) {
        const total = row.reduce((n, b) => n + bw(b), 0);
        const extra = (width - total - gap * (row.length - 1)) / row.length;
        for (const b of row) button({ ...b, width: bw(b) + extra });
      } else for (const b of row) button(b);
    }, { spacing: gap, width, justify, align: "center" }));
  }, { spacing: gap, width });
}
function rect(r: ui.Rect): void { hudRects.push({ x: r.x, y: r.y, width: r.width, height: r.height }); }
/** A box over a window rectangle (window px) drawn by a placed role-none widget. */
function paint(id: string, x: number, y: number, w: number, h: number, drawFn: (r: ui.Rect) => void): void {
  if (w <= 0 || h <= 0) return;
  const sc = ui.preferences().scale, sa = frame().safeArea;
  ui.place(id, { anchor: "top-start", x: (x - sa.left) / sc, y: (y - sa.top) / sc }, () => {
    ui.widget("", { role: "none", size: { width: w / sc, height: h / sc }, draw: drawFn });
  });
}
function toWindow(x: number, y: number, w: number, h: number): ui.Rect {
  const sc = ui.preferences().scale, sa = frame().safeArea;
  return { x: sa.left + x * sc, y: sa.top + y * sc, width: w * sc, height: h * sc };
}
/** A label left, a value right (.stat / .kv rows). */
function stat(id: string, k: string, v: string, w: number, kc = "stat-k", vc = "stat-v"): void {
  const vw = Math.min(w * 0.6, textWidth(v, vc) + 4);
  ui.row(id, () => {
    ui.column(`${id}-k`, () => para(k, w - vw - 8, kc), { width: w - vw - 8 });
    ui.column(`${id}-v`, () => ui.style(vc).id(`${id}-n`).label(v), { width: vw, align: "end" });
  }, { width: w, spacing: 8, align: "start" });
}
/** A .card with its heading. */
function card(id: string, title: string, w: number, body: (inner: number) => void, style = "card"): void {
  const inner = w - 30;
  ui.column(id, () => {
    if (title) para(title, inner, "card-h", `${id}-h`);
    body(inner);
  }, { style, width: w, spacing: 6 });
}

// ------------------------------------------------------------------ the frame
export function drawScreens(): void {
  const L = layoutNow();
  const f = frame();
  if (app.screen) fullScreen(L);
  else gameScreen(L);
  if (app.overlay === "pause") pausePanel(L);
  else if (app.overlay === "settings") settingsPanel(L);
  else if (app.overlay === "help") helpPanel(L);
  if (app.focusNext) {
    const age = f.frame - app.openedFrame;
    if (age >= 1) ui.setFocus(app.focusNext);
    if (age >= 3) app.focusNext = null;
  }
}

// ------------------------------------------------------------------ the game screen
const RAIL = 230;
function gameScreen(L: Layout): void {
  const s = round.state;
  if (!s) return;
  const left = platform.options.leftHanded;
  let px = 0, pw = L.lw;
  if (L.wide) {
    // #game-screen: the rails, then the screen's 1rem gap, then the playfield
    px = RAIL + 16; pw = L.lw - 2 * px;
    railPanel("rail-left", 0, px, L.lh, "rail", (w) => leftRail(w), 0, 16);
    railPanel("rail-right", L.lw - px, px, L.lh, "rail", (w) => rightRail(w), 0, -16);
  }
  Object.assign(view, toWindow(px, 0, pw, L.lh));
  // the HUD over the playfield
  const pad = L.shortLand ? 3.2 : 8;
  const hudTop = ui.place("hud-top", L.small ? { anchor: "top-start", x: px + (left ? pw - 6.4 - (lastSize.get("hud-top")?.width ?? 0) / L.sc : 6.4), y: pad } : { anchor: "top", x: 0, y: pad }, () => {
    ui.row("hud-top-row", () => {
      ui.style(L.small ? "score-small" : "score").id("hud-score").label(String(s.score.total));
      if (!L.small) ui.style("hud-text").id("hud-objective").label(objectiveText());
      if (s.comboStreak >= 2) ui.style(L.small ? "hud-text-small" : "hud-text").id("hud-combo").label(T("Combo x{n}", { n: s.comboStreak }));
    }, { style: "hud-top", spacing: L.small ? 9.6 : 16, align: "center" });
  });
  lastSize.set("hud-top", hudTop);
  const acts: Btn[] = [];
  if (!L.wide) acts.push({ id: "btn-drawer", text: "☰", name: T("Open info panel"), style: "btn-hud", selected: app.drawer, act: () => { app.drawer = !app.drawer; } });
  acts.push(
    { id: "btn-hint", text: T("Hint"), style: "btn-hud", disabled: s.over, act: doHint, tooltip: T("Hint (H)") },
    { id: "btn-undo", text: T("Undo"), style: "btn-hud", disabled: !canUndo(), act: doUndo, tooltip: T("Undo (U)") },
    { id: "btn-pause", text: T("Pause"), style: "btn-hud", act: pauseGame, tooltip: T("Pause (Esc)") },
  );
  const actX = left ? px + 8 : L.lw - (px + pw) + 8;
  const hudActs = ui.place("hud-actions", { anchor: left ? "top-start" : "top-end", x: actX, y: pad }, () => {
    // focus leaves a HUD button once it acted, so Enter and the arrows go back to the board (the old page's keydown
    // handler took them before any focused button)
    ui.row("hud-actions-row", () => { for (const b of acts) button({ ...b, act: () => { b.act(); ui.setFocus(null); } }); }, { spacing: 6.4, align: "center" });
  });
  rect(hudActs);
  // the offer tray
  const tray = ui.place("offer-tray", { anchor: "bottom", x: L.wide ? 0 : 0, y: L.shortLand ? 3.2 : 9.6 }, () => {
    ui.row("offer-tray-row", () => { for (let i = 0; i < Rules.OFFER_COUNT; i++) offerButton(i); }, { spacing: L.small ? 6.4 : 12.8, align: "end" });
  });
  rect(tray);
  // the lesson card
  let cardRect: ui.Rect | null = null;
  if (inTutorial() || (round.paused && round.mode === "learn" && round.tutorialStep < Content.TUTORIAL_STEPS.length)) {
    const step = Content.TUTORIAL_STEPS[round.tutorialStep]!;
    const corner = L.shortLand;
    const w = corner ? Math.min(208, 0.26 * L.lw) : Math.min(420, 0.9 * pw);
    const at = corner ? { anchor: "top-start" as const, x: px + 6.4, y: 6.4 } : { anchor: "top" as const, x: 0, y: Math.max(56, (Math.max(hudTop.y + hudTop.height, hudActs.y + hudActs.height) - frame().safeArea.top) / L.sc + 6) };
    cardRect = ui.place("tutorial-card", at, () => {
      card("lesson-card", `${round.tutorialStep + 1}/${Content.TUTORIAL_STEPS.length} — ${T(step.title)}`, w, (iw) => para(T(step.text), iw, corner ? "hud-text-small" : "card-text", "lesson-text"), "lesson");
    });
    rect(cardRect);
  }
  // the drawer (both rails as side panels below 1024 px)
  if (!L.wide && app.drawer) {
    // #rail-left.open / #rail-right.open: side panels under the HUD bar (which stays usable to close them)
    const dw = Math.min(RAIL, (L.lw - 8) / 2);
    const dy = (hudActs.y + hudActs.height - frame().safeArea.top) / L.sc + 6;
    railPanel("drawer-left", 0, dw, L.lh - dy, "drawer", (w) => leftRail(w), 0, 0, dy);
    railPanel("drawer-right", L.lw - dw, dw, L.lh - dy, "drawer", (w) => rightRail(w), 0, 0, dy);
  }
  // the camera's band: below the HUD (and a centred lesson card), above the tray
  const v = view;
  let top = 0;
  for (const r of [hudTop, hudActs, cardRect]) {
    if (!r || r.height <= 0) continue;
    const b = r.y + r.height - v.y;
    const centred = r !== cardRect || (r.x - v.x < v.width * 0.42 && r.x + r.width - v.x > v.width * 0.58);
    if (b < v.height * 0.5 && centred) top = Math.max(top, b + 6 * L.sc);
  }
  const bottom = Math.min(v.height * 0.35, v.y + v.height - tray.y + 6 * L.sc);
  const f = frame();
  render.fit(f.width, f.height, v, top, bottom, pw, L.lh);
  cellTargets();
}
/** A rail at x, w wide; `gap` (> 0 after it, < 0 before it) is the screen's gap painted in the page colour. */
function railPanel(id: string, x: number, w: number, h: number, style: string, build: (inner: number) => void, padTop = 0, gap = 0, y = 0): void {
  const r = ui.place(id, { anchor: "top-start", x, y }, () => {
    ui.column(id, () => {
      const prev = lastSize.get(`${id}-in`);
      const inner = h - 26 - padTop;
      const scroll = !!prev && prev.height / ui.preferences().scale > inner + 1;
      const iw = w - Math.abs(gap) - 26 - (scroll ? 14 : 0);
      const body = (): void => { lastSize.set(`${id}-in`, ui.column(`${id}-in`, () => build(iw), { spacing: 12.8, width: iw })); };
      if (scroll) ui.scrollArea(`${id}-scroll`, { width: w - 20, height: inner }, body);
      else body();
    }, { style, width: w, height: h, spacing: 0, padding: { top: 13 + padTop, bottom: 13, start: 13 + Math.max(0, -gap), end: 13 + Math.max(0, gap) } });
  });
  rect(r);
}
/** #rail-left: the objective and the progress. */
function leftRail(w: number): void {
  const s = round.state!;
  card("card-objective", T("Objective"), w, (iw) => para(objectiveText(), iw, "card-text", "rail-objective"));
  card("card-progress", T("Progress"), w, (iw) => {
    if (s.goal) {
      const cur = s.goal.type === "score" ? s.score.total : s.goal.type === "lines" ? s.lines : s.placedPieces;
      stat("stat-goal", T("Goal"), `${cur} / ${s.goal.target}`, iw);
    }
    stat("stat-moves", T("Moves"), s.moveLimit ? `${s.placedPieces} / ${s.moveLimit}` : String(s.placedPieces), iw);
    stat("stat-lines", T("Lines"), String(s.lines), iw);
  });
}
/** #rail-right: the mode, turn and seed, the Daily board, the controls. */
function rightRail(w: number): void {
  const s = round.state!;
  const modeName = round.mode === "learn" ? T("Learn") : round.mode === "journey" ? T("Journey {n}", { n: round.stageId ?? "" }).trim()
    : round.mode === "daily" ? T("Daily Challenge") : round.mode === "practice" ? T("Practice") : T("Round");
  card("card-status", modeName, w, (iw) => {
    stat("stat-turn", T("Turn"), String(s.turn), iw);
    stat("stat-seed", T("Seed"), round.options!.seed.toString(16), iw);
  });
  if (round.mode === "daily") {
    card("card-daily", T("Daily Board"), w, (iw) => {
      const rows = round.boardRows;
      const best = platform.save().progress.dailyBest[round.dailyDate ?? ""] || "—";
      if (rows === undefined) para(T("Loading…"), iw, "card-text", "daily-board");
      else if (rows === null) para(platform.signedIn() ? T("Platform board unavailable — your best today: {best}.", { best }) : T("Your best today: {best} (local).", { best }), iw, "card-text", "daily-board");
      else if (!rows.length) para(T("No scores yet today — be the first!"), iw, "card-text", "daily-board");
      else rows.forEach((e, i) => stat(`daily-row-${i}`, `#${i + 1} ${e.name || T("Player")}`, String(e.score), iw));
    });
  }
  card("card-controls", T("Controls"), w, (iw) => para(T("Tap a piece, tap a cell — or drag. Keys: 1–3 select, arrows move, Enter place, H hint, U undo, Esc pause."), iw, "small", "controls-text"));
}
/** #offer-tray .offer: the piece's shape (a grid of its bounding box) over its name. */
function offerButton(i: number): void {
  const s = round.state!;
  const slot = s.offer[i];
  const sel = round.selected === i;
  if (!slot) {
    button({ id: `offer-${i}`, text: T("Placed"), name: T("Slot {n} empty", { n: i + 1 }), style: "offer", disabled: true, act: () => undefined, height: 76 });
    return;
  }
  const piece = Rules.pieceById(slot.piece);
  const rows = Math.max(...piece.cells.map((c) => c[0])) + 1, cols = Math.max(...piece.cells.map((c) => c[1])) + 1;
  const filled = new Set(piece.cells.map((c) => c[0] * cols + c[1]));
  const name = T(piece.name);
  button({
    id: `offer-${i}`, text: name, name: T("Select {piece}, slot {n}", { piece: name, n: i + 1 }), style: "offer", selected: sel, act: () => { selectSlot(i); ui.setFocus(null); },
    content: () => ui.column(`offer-${i}-face`, () => {
      ui.widget("", {
        role: "none", size: { width: 41.6, height: 41.6 },
        draw: (r, st) => {
          const g = 2 * st.scale;
          const cw = Math.max(6 * st.scale, (r.width - g * (cols - 1)) / cols), ch = Math.max(6 * st.scale, (r.height - g * (rows - 1)) / rows);
          const ox = r.x + (r.width - (cw * cols + g * (cols - 1))) / 2, oy = r.y + (r.height - (ch * rows + g * (rows - 1))) / 2;
          for (let k = 0; k < rows * cols; k++) {
            if (!filled.has(k)) continue;
            draw.roundRect(ox + (k % cols) * (cw + g), oy + Math.floor(k / cols) * (ch + g), cw, ch, 2, token("accent"));
          }
        },
      });
      ui.style(sel ? "offer-name-sel" : "offer-name").label(name);
    }, { spacing: 4, align: "center" }),
  });
}
/** The old screen-reader board mirror: every cell a named target (play scripts and the a11y mirror click them). */
function cellTargets(): void {
  const s = round.state;
  if (!s || app.overlay || round.resultsAt !== null || s.over) return;
  for (let r = 0; r < Rules.BOARD_SIZE; r++) for (let c = 0; c < Rules.BOARD_SIZE; c++) {
    const cr = render.cellRect(r, c);
    if (cr.x + cr.width < view.x || cr.y + cr.height < view.y || cr.x > view.x + view.width || cr.y > view.y + view.height) continue;
    ui.id(`cell-${r}-${c}`).target(T(s.board[r]![c] ? "Row {r} column {c}, occupied" : "Row {r} column {c}, empty", { r: r + 1, c: c + 1 }), cr, { role: "button" });
  }
}

// ------------------------------------------------------------------ full-page screens
function fullScreen(L: Layout): void {
  const f = frame();
  paint("page", 0, 0, f.width, f.height, (r) => {
    draw.rect(r.x, r.y, r.width, r.height, token("bg"));
    if (app.screen === "title") {
      // #title-screen::before: three soft prism glows
      draw.box(r.x, r.y, r.width, r.height, { background: [
        { type: "radial", center: { x: 0.5, y: 0.38 }, radius: { x: 0.6, y: 0.45 }, stops: [{ color: "#6fd3ff1f", at: 0 }, { color: "#6fd3ff00", at: 0.7 }] },
        { type: "radial", center: { x: 0.3, y: 0.7 }, radius: { x: 0.4, y: 0.35 }, stops: [{ color: "#c99fff1a", at: 0 }, { color: "#c99fff00", at: 0.7 }] },
        { type: "radial", center: { x: 0.72, y: 0.64 }, radius: { x: 0.4, y: 0.35 }, stops: [{ color: "#7fe7c417", at: 0 }, { color: "#7fe7c400", at: 0.7 }] },
      ], radius: 0 });
    }
  });
  const key2 = `screen-${app.screen}`;
  const prev = lastSize.get(key2);
  const h = L.lh;
  const scroll = !!prev && prev.height / L.sc > h;
  const opening = f.frame - app.screenFrame <= 6;
  const pad = 16;
  ui.place("screen", { anchor: "top-start", x: 0, y: 0 }, () => {
    const body = (): void => {
      const contentH = prev ? prev.height / L.sc : h;
      const topPad = scroll ? pad : Math.max(pad, (h - contentH) / 2 + pad);
      ui.column(`${key2}-outer`, () => {
        const r = ui.column(`${key2}-body`, () => buildScreen(L), { align: "center", spacing: 16, width: L.lw - (scroll ? 14 : 0) - 2 * pad });
        lastSize.set(key2, { ...r, height: r.height + 2 * pad * L.sc });
      }, { width: L.lw - (scroll ? 14 : 0), align: "center", padding: { top: topPad, bottom: pad } });
    };
    if (scroll) ui.scrollArea(`${key2}-scroll`, { width: L.lw, height: h }, body, opening ? { scrollTo: { top: 0 } } : undefined);
    else body();
  });
}
function buildScreen(L: Layout): void {
  if (app.screen === "title") titleScreen(L);
  else if (app.screen === "setup") setupScreen(L);
  else if (app.screen === "results") resultsScreen(L);
}

// ------------------------------------------------------------------ title
const BRAND = ["#7fe7c4", "#6fd3ff", "#c99fff"];
function mix(a: string, b: string, t: number): string {
  const p = (s: string, i: number): number => parseInt(s.slice(1 + 2 * i, 3 + 2 * i), 16);
  const c = [0, 1, 2].map((i) => Math.round(p(a, i) + (p(b, i) - p(a, i)) * t).toString(16).padStart(2, "0"));
  return `#${c.join("")}`;
}
/** .brand: "Prism Parcel" with the 90° accent → sky → violet text gradient (each letter its colour) and a soft glow. */
function brand(L: Layout): void {
  const size = Math.max(32, Math.min(51.2, 0.06 * L.lw));
  const text = "Prism Parcel";
  const spacing = 0.06 * size;
  // each letter's start: the prefix's advance (spaces included) plus the letter spacing
  const starts = [...text].map((_, i) => (i ? draw.measureText(text.slice(0, i) + "|", { size, weight: "bold" }).width - draw.measureText("|", { size, weight: "bold" }).width : 0) + i * spacing);
  const total = starts[text.length - 1]! + draw.measureText(text[text.length - 1]!, { size, weight: "bold" }).width;
  ui.widget(text, {
    role: "image", size: { width: total + 8, height: size * 1.3 },
    draw: (r, st) => {
      const k = st.scale;
      [...text].forEach((ch, i) => {
        if (ch === " ") return;
        const x = r.x + (4 + starts[i]!) * k;
        const t = (starts[i]! + size * 0.3) / total;
        const col = t < 0.5 ? mix(BRAND[0]!, BRAND[1]!, t * 2) : mix(BRAND[1]!, BRAND[2]!, Math.min(1, (t - 0.5) * 2));
        // drop-shadow(0 0 18px rgba(111,211,255,.28)): two soft outlines under the letter
        draw.text(ch, x, r.y + 0.1 * size * k, { size: size * k, weight: "bold", color: "#6fd3ff00", stroke: { color: "#6fd3ff12", width: Math.min(32, 14 * k) } });
        draw.text(ch, x, r.y + 0.1 * size * k, { size: size * k, weight: "bold", color: col, stroke: { color: "#6fd3ff1c", width: Math.min(32, 6 * k) } });
      });
    },
  });
}
function titleScreen(L: Layout): void {
  const p = platform.save().progress;
  const w = L.lw - 32;
  brand(L);
  para(T("A luminous tabletop of frosted blocks. Fill rows and columns to clear them together."), Math.min(w, 760), "tagline", "tagline");
  const mw = Math.min(320, 0.86 * L.lw);
  ui.column("menu", () => {
    const items: Btn[] = [
      { id: "btn-play", text: T("Play"), style: "btn-primary", act: play },
      { id: "btn-daily", text: T("Daily Challenge"), act: () => openSetup("daily") },
      { id: "btn-journey", text: T("Journey"), act: () => openSetup("journey") },
      { id: "btn-practice", text: T("Practice"), act: () => openSetup("practice") },
      { id: "btn-learn", text: T("Learn to Play"), act: startLearn },
      { id: "btn-help", text: T("Help & Rules"), act: openHelp },
      { id: "btn-settings", text: T("Settings"), act: openSettings },
    ];
    if (platform.inviteLink()) items.push({ id: "btn-invite", text: S("invite"), act: copyInvite });
    if (!platform.signedIn()) items.push({ id: "btn-signin", text: S("signIn"), act: signIn });
    for (const b of items) button({ ...b, width: mw });
  }, { spacing: 9.6, width: mw, padding: { top: 16 } });
  const m = Progress.mastery(p);
  para(T("Journey stage {n}/{total} · {stars} ★ · Rank: {rank}", { n: p.stage, total: Content.stageCount(), stars: m.stars, rank: T(m.rank) }), w, "small", "title-progress");
  para(profileLine(), w, "small", "title-profile");
  if (app.note) para(app.note(), w, "small", "title-note");
  para(T("UTC day {date}", { date: today() }), w, "small", "title-clock");
}
function profileLine(): string {
  if (!platform.signedIn()) return T("Local progress (offline cache)");
  const st = platform.syncState();
  const sync = st === "saving" ? T("Saving…") : st === "synced" ? T("Cloud save synced") : st === "error" ? T("Sync failed") : T("Offline — local cache");
  return T("Playing as {name} · {sync}", { name: platform.displayName() || T("Player"), sync });
}

// ------------------------------------------------------------------ setup (Journey / Daily / Practice)
function setupScreen(L: Layout): void {
  const w = Math.min(620, 0.94 * L.lw), inner = w - 46;
  const kind = app.setup.kind;
  ui.column("setup-panel", () => {
    para(T(kind === "journey" ? "Journey" : kind === "daily" ? "Daily Challenge" : "Practice"), inner, "h2", "setup-heading");
    if (kind === "journey") journeySetup(inner);
    else if (kind === "daily") dailySetup(inner);
    else practiceSetup(inner);
    flow("setup-actions", [
      { id: "setup-start", text: T("Start"), style: "btn-primary", act: startSetup },
      { id: "setup-back", text: T("Back"), style: "btn-ghost", act: goTitle },
    ], inner, 9.6, false, "center");
  }, { style: "panel", width: w, spacing: 12 });
}
function startSetup(): void {
  const k = app.setup.kind;
  if (k === "journey") startJourney(app.setup.stage);
  else if (k === "daily") startDaily();
  else startPractice(app.setup.difficulty);
}
function journeySetup(w: number): void {
  const p = platform.save().progress;
  para(T("40 authored stages. One new idea at a time, then mastery gates. Ranked: no — progress only."), w, "small", "journey-info");
  const gw = Math.min(560, w), gap = 8;
  const cols = Math.max(1, Math.floor((gw + gap) / (64 + gap)));
  const cw = (gw - gap * (cols - 1)) / cols;
  ui.column("stage-grid", () => {
    for (let r = 0; r * cols < Content.STAGES.length; r++) {
      ui.row(`stage-row-${r}`, () => {
        for (const st of Content.STAGES.slice(r * cols, (r + 1) * cols)) {
          const locked = st.id > p.stage;
          const stars = p.stars[st.id] || 0;
          const chosen = app.setup.stage === st.id;
          const diff = T(Content.DIFFICULTY_INFO[st.difficulty]!.name);
          button({
            id: `stage-${st.id}`, text: String(st.id), style: "stage", width: cw, disabled: locked, selected: chosen,
            name: T(locked ? "Stage {n}, {difficulty}, locked" : "Stage {n}, {difficulty}", { n: st.id, difficulty: diff }),
            tooltip: `${diff} — ${goalText(st.goal, st.moveLimit)}${st.mastery ? " " + T("(mastery)") : ""}`,
            act: () => { app.setup.stage = st.id; },
            content: () => ui.column(`stage-${st.id}-face`, () => {
              ui.style(chosen ? "stage-n-dark" : "stage-n").label(String(st.id));
              ui.style("stars").label("★".repeat(stars) + "☆".repeat(3 - stars));
            }, { spacing: 1, align: "center" }),
          });
        }
      }, { spacing: gap });
    }
  }, { spacing: gap, width: gw });
  const st = Content.stageInfo(app.setup.stage);
  if (st) para(`${T("Journey stage {n}.", { n: st.id })} ${T(Content.DIFFICULTY_INFO[st.difficulty]!.name)} — ${goalText(st.goal, st.moveLimit)}${st.mastery ? " " + T("(mastery)") : ""}`, w, "small", "stage-info");
}
function dailySetup(w: number): void {
  const date = today();
  const rs = Content.dailyRuleset(date);
  para(T("One shared seed and ruleset per UTC day. Score chase — play until no piece fits."), w, "text", "daily-info");
  const rows: [string, string][] = [
    [T("Date (UTC)"), date], [T("Seed"), rs.seed.toString(16)], [T("Ruleset"), T("v{n}, medium pieces", { n: rs.version })], [T("Par"), String(rs.par)],
    [T("Ranked"), T("Yes — server-validated replay")], [T("Your best today"), String(platform.save().progress.dailyBest[date] || "—")],
    [T("Expected duration"), T("3–6 minutes")],
  ];
  ui.column("daily-kv", () => rows.forEach(([k, v], i) => stat(`daily-kv-${i}`, k, v, w, "dt", "dd")), { spacing: 4, width: w });
  const nowMs = platform.nowMs();
  const next = new Date(date + "T00:00:00Z").getTime() + 86400000;
  const s = Math.max(0, Math.floor((next - nowMs) / 1000));
  para(T("Next daily in {h}h {m}m {s}s", { h: Math.floor(s / 3600), m: Math.floor(s / 60) % 60, s: s % 60 }), w, "small", "daily-countdown");
}
function practiceSetup(w: number): void {
  para(T("Free play with undo. Restart any time. Ranked: no — never affects rating."), w, "text", "practice-info");
  flow("practice-difficulty", Content.DIFFICULTIES.map((d) => ({
    id: `diff-${d}`, text: T(Content.DIFFICULTY_INFO[d]!.name), style: app.setup.difficulty === d ? "btn-primary" : "btn", selected: app.setup.difficulty === d,
    tooltip: T(Content.DIFFICULTY_INFO[d]!.desc), act: () => { app.setup.difficulty = d; },
  })), w, 9.6, false, "center");
  para(T(Content.DIFFICULTY_INFO[app.setup.difficulty]!.desc), w, "small", "practice-desc");
}

// ------------------------------------------------------------------ results
function resultsScreen(L: Layout): void {
  const s = round.state, r = results;
  if (!s || !r) return;
  const w = Math.min(560, 0.94 * L.lw), inner = w - 46;
  ui.column("results-panel", () => {
    para(s.won ? T("Goal Complete!") : T("Round Over"), inner, "h2", "results-heading");
    const reasons: Record<string, string> = { "goal-complete": T("Objective reached."), "no-fit": T("No offered piece fits on the board."), "move-limit": T("Move limit reached.") };
    para(((s.reason && reasons[s.reason]) || "") + (round.mode === "journey" && round.stageId ? " " + T("Journey stage {n}.", { n: round.stageId }) : ""), inner, "small", "results-sub");
    const rows: [string, number | string][] = [
      ["Piece cells", s.score.cells], ["Cleared cells", s.score.clear], ["Simultaneous bonus", s.score.simultaneous], ["Combo bonus", s.score.combo],
      ["Total score", s.score.total], ["Lines cleared", s.lines], ["Pieces placed", s.placedPieces], ["Invalid actions", s.invalid],
      ["Time", Math.round(r.elapsedMs / 1000) + "s"],
    ];
    ui.column("results-breakdown", () => rows.forEach(([k, v], i) => stat(`results-row-${i}`, T(k), String(v), inner, "dt", "dd")), { spacing: 4, width: inner });
    const unlocked = Progress.unlockedAchievements(platform.save().progress);
    if (unlocked.length) para(T("Achievements: {list}", { list: unlocked.map((a) => T(a.name)).join(", ") }), inner, "small", "results-achievements");
    if (round.mode === "daily" && round.dailyDate) {
      const best = platform.save().progress.dailyBest[round.dailyDate] || "—";
      para(platform.signedIn() ? T("Daily complete — best today: {best} (saved to your account).", { best }) : T("Daily complete — best today: {best} (saved on this device).", { best }), inner, "small", "results-compare");
    }
    const lb = leaderboardLine();
    if (lb) para(lb, inner, "small", "results-lb");
    const btns: Btn[] = [{ id: "btn-retry", text: T("Retry"), style: "btn-primary", act: retry }];
    if (round.mode === "journey" && s.won && (round.stageId ?? 0) < Content.stageCount()) btns.push({ id: "btn-next", text: T("Next"), act: nextStage });
    btns.push({ id: "btn-results-home", text: T("Home"), style: "btn-ghost", act: goTitle });
    flow("results-actions", btns, inner, 9.6, false, "center");
  }, { style: "panel", width: w, spacing: 10 });
}

// ------------------------------------------------------------------ overlays (.overlay .panel)
/** An .overlay .panel dialog: its body scrolls when taller than 88 % of the window; the footer's buttons stay in view. */
function overlayPanel(id: string, label: string, L: Layout, maxW: number, build: (inner: number) => void, onClose: () => void, footer?: (inner: number) => void): void {
  const w = Math.min(maxW, 0.94 * L.lw), inner = w - 46;
  const footH = footer ? (lastSize.get(`${id}-foot`)?.height ?? 54 * L.sc) / L.sc + 10 : 0;
  const maxH = 0.88 * L.lh - footH;
  const prev = lastSize.get(`${id}-in`);
  const scroll = !!prev && prev.height / L.sc > maxH - 40;
  const opening = frame().frame - app.openedFrame <= 6;
  const open = ui.dialog(label, "", true, () => {
    ui.column(`${id}-panel`, () => {
      const body = (): void => {
        lastSize.set(`${id}-in`, ui.column(`${id}-in`, () => build(inner - (scroll ? 14 : 0)), { spacing: 10, width: inner - (scroll ? 14 : 0) }));
      };
      if (scroll) ui.scrollArea(`${id}-scroll`, { width: inner, height: maxH - 40 }, body, opening ? { scrollTo: { top: 0 } } : undefined);
      else body();
      if (footer) lastSize.set(`${id}-foot`, ui.column(`${id}-foot`, () => footer(inner), { width: inner, padding: { top: 10 } }));
    }, { style: "panel", width: w, spacing: 0 });
  });
  if (!open && fresh()) later(onClose);
}
function pausePanel(L: Layout): void {
  overlayPanel("pause", T("Paused"), L, 360, (iw) => {
    para(T("Paused"), iw, "h2", "pause-heading");
    const mw = Math.min(320, iw);
    ui.column("pause-menu", () => {
      button({ id: "btn-resume", text: T("Resume"), style: "btn-primary", width: mw, act: resumeGame });
      button({ id: "btn-pause-settings", text: T("Settings"), width: mw, act: openSettings });
      button({ id: "btn-pause-help", text: T("Help"), width: mw, act: openHelp });
      button({ id: "btn-quit", text: T("Leave Round"), style: "btn-ghost", width: mw, act: leaveRound });
    }, { spacing: 9.6, width: iw, align: "center" });
  }, resumeGame);
}
/** A check box row (a role "checkbox" widget: built-in check box labels don't wrap). */
function toggleRow(id: string, label: string, on: boolean, w: number, set: (v: boolean) => void): void {
  ui.row(`${id}-row`, () => {
    para(T(label), w - 56, "text", `${id}-label`);
    ui.spacer();
    const res = ui.id(id).widget(T(label), {
      role: "checkbox", checked: on, size: { width: 44, height: 44 },
      draw: (r, st) => {
        const s = st.scale, box = 22 * s, bx = r.x + (r.width - box) / 2, by = r.y + (r.height - box) / 2;
        draw.roundRect(bx, by, box, box, 4, on ? token("accent") : token("btn"));
        draw.strokeRoundRect(bx, by, box, box, 4, token("btn-line"), 2);
        if (on) draw.text("✓", bx + box / 2, by + 1 * s, { size: 17 * s, color: "#0a1410", align: "center", weight: "bold" });
      },
    });
    if (res.activated && fresh()) later(() => set(!on));
  }, { width: w, align: "center", spacing: 8 });
}
function settingsPanel(L: Layout): void {
  const o = platform.options;
  overlayPanel("settings", T("Settings"), L, 560, (iw) => {
    para(T("Settings"), iw, "h2", "settings-heading");
    para(T("Sound, graphics, language, larger text, high contrast and reduced motion are in the StarHermit Options."), iw, "small", "options-note");
    flow("settings-runtime", [
      { id: "btn-options", text: T("Open Options"), act: () => openMenu() },
      { id: "btn-rebind", text: T("Key bindings"), act: () => requestRebind() },
    ], iw, 9.6, false, "start");
    ui.row("set-theme-row", () => {
      para(T("Visual theme"), iw * 0.42, "text", "set-theme-label");
      ui.spacer();
      const idx = Math.max(0, Content.THEMES.indexOf(o.theme));
      const pick = ui.id("set-theme").select(T("Visual theme"), idx, Content.THEMES.map((t) => T(Content.themeInfo(t).name)), { width: Math.min(iw * 0.55, 220) } as ui.WidgetOptions);
      if (pick !== idx) later(() => platform.setOption("theme", Content.THEMES[pick]!));
    }, { width: iw, align: "center", height: 48 });
    toggleRow("set-cvd", key("Color-vision-safe palette"), o.cvdPalette, iw, (v) => platform.setOption("cvdPalette", v));
    toggleRow("set-captions", key("Sound captions"), o.captions, iw, (v) => platform.setOption("captions", v));
    toggleRow("set-left", key("Left-handed controls"), o.leftHanded, iw, (v) => platform.setOption("leftHanded", v));
    toggleRow("set-haptics", key("Haptics"), o.haptics, iw, (v) => platform.setOption("haptics", v));
    ui.row("set-tutorial-row", () => {
      para(T("Tutorial"), iw * 0.42, "text", "set-tutorial-label");
      ui.spacer();
      button({ id: "btn-replay-tutorial", text: T("Replay tutorial"), act: replayTutorial });
    }, { width: iw, align: "center" });
  }, closeOverlay, (iw) => flow("settings-done", [{ id: "btn-settings-close", text: T("Done"), style: "btn-primary", act: closeOverlay }], iw, 9.6, false, "center"));
}
const GLYPH: Record<string, string> = { "Arrow Up": "↑", "Arrow Down": "↓", "Arrow Left": "←", "Arrow Right": "→", Escape: "Esc" };
function keys(action: string): string {
  let list: string[] = [];
  try { list = bindings(action).filter((b) => b.device === "keyboard").map((b) => GLYPH[b.label] ?? b.label); } catch { /* not yet */ }
  return [...new Set(list)].join("/");
}
function helpPanel(L: Layout): void {
  overlayPanel("help", T("How to Play"), L, 560, (iw) => {
    para(T("How to Play"), iw, "h2", "help-heading");
    para(T("The rules"), iw, "h3", "help-rules");
    const bullet = (id: string, text: string): void => {
      ui.row(id, () => {
        ui.style("bullet").label("•");
        para(text, iw - 24, "text");
      }, { width: iw, spacing: 8, align: "start" });
    };
    ["help.offer", "help.clear", "help.score", "help.end"].forEach((k, i) => bullet(`help-rule-${i}`, plain(k)));
    para(T("Controls"), iw, "h3", "help-controls");
    bullet("help-pointer", plain("help.pointer"));
    bullet("help-keyboard", plain("help.keyboard", {
      slots: `${keys("slot_1")}–${keys("slot_3")}`, move: `${keys("cursor_up")} ${keys("cursor_left")} ${keys("cursor_down")} ${keys("cursor_right")}`,
      place: keys("place"), hint: keys("hint"), undo: keys("undo"), clear: keys("clear"), pause: keys("pause"),
    }));
    bullet("help-gamepad", plain("help.gamepad"));
    para(T("Pieces"), iw, "h3", "help-pieces");
    const seen = new Set<string>();
    const chips: { text: string; w: number }[] = [];
    for (const p of Rules.PIECES) {
      if (seen.has(p.name)) continue;
      seen.add(p.name);
      const text = `${T(p.name)} (${p.cells.length})`;
      chips.push({ text, w: textWidth(text, "text") + 22 });
    }
    // .row of chips (flex-wrap from the start)
    const rows: { text: string; w: number }[][] = [[]];
    let used = 0;
    for (const c of chips) {
      if (rows[rows.length - 1]!.length && used + 9.6 + c.w > iw) { rows.push([]); used = 0; }
      used += (rows[rows.length - 1]!.length ? 9.6 : 0) + c.w;
      rows[rows.length - 1]!.push(c);
    }
    rows.forEach((row, i) => ui.row(`help-chips-${i}`, () => row.forEach((c, j) => { ui.column(`help-chip-${i}-${j}`, () => { ui.style("text").label(c.text); }, { style: "chip" }); }), { spacing: 9.6 }));
  }, closeOverlay, (iw) => flow("help-done", [{ id: "btn-help-close", text: T("Close"), style: "btn-primary", act: closeOverlay }], iw, 9.6, false, "center"));
}
