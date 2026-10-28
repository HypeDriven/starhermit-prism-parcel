// The look of the screens, rails, HUD, tray and overlays: the browser
// build's index.html <style>, rewritten class-based in tools/ui-style.css and
// converted once with `starhermit css` into assets/ui-style.json (`npm run
// css`), registered at start with the theme the runtime's own widgets
// (scroll bars, focus rings, selects) take. The runtime's high-contrast
// option is the old body.high-contrast token set.
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

type Tokens = Record<string, string>;
const BASE: Tokens = {
  bg: "#101528", panel: "#1a2140", panel2: "#141a33", ink: "#eef1ff", dim: "#9aa4cc", accent: "#7fe7c4", danger: "#ff6f6f",
  focus: "#ffd76f", btn: "#2a3464", "btn-hover": "#35418a", "btn-line": "#3d4a8a", line: "#2c3766",
};
/** body.high-contrast. */
const CONTRAST: Tokens = {
  bg: "#000000", panel: "#0a0a0a", panel2: "#111111", ink: "#ffffff", dim: "#dddddd", accent: "#00ffcc", focus: "#ffff00",
};

let current: Tokens = { ...BASE };
export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  ui.setFont({ family: "sans-serif" });
  ui.setTheme({
    fontSize: 16, smallSize: 13.6, headingSize: 24, padding: 8, spacing: 10, radius: 10,
    text: BASE.ink!, muted: BASE.dim!, panel: BASE.panel!, control: BASE.btn!, hovered: BASE["btn-hover"]!,
    pressed: "#3d4a8a", field: BASE.btn!, accent: BASE.accent!, focus: BASE.focus!, outline: BASE["btn-line"]!,
  });
  ui.setTokens(css.tokens);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$ink" } },
    paragraph: { text: { color: "$ink" } },
    heading: { text: { color: "$ink" } },
    widget: { focusRing: { color: "$focus", width: 3, offset: 2 } },
    scrollArea: { parts: { bar: { background: "$btn-line", radius: 4 } } },
    tooltip: { background: "$panel", text: { color: "$ink" }, radius: 6, padding: 6 },
    // .overlay: rgba(8, 10, 22, .66) behind the pause, settings and help panels.
    dialog: { background: "#00000000", padding: 0, parts: { backdrop: { background: "#080a16a8" } } },
  });
  key = "";
  applyTokens(false);
}

let key = "";
/** The base or high-contrast tokens (cheap when unchanged). */
export function applyTokens(highContrast: boolean): void {
  const k = String(highContrast);
  if (k === key) return;
  key = k;
  current = { ...BASE, ...(highContrast ? CONTRAST : {}) };
  ui.setTokens(current);
  ui.setTheme({
    text: current.ink!, muted: current.dim!, panel: current.panel!, control: current.btn!,
    field: current.btn!, accent: current.accent!, focus: current.focus!, outline: current["btn-line"]!,
  });
}
/** A token's current colour (for draw calls, which take real colours). */
export function token(name: string): string { return current[name] ?? "#000000"; }
