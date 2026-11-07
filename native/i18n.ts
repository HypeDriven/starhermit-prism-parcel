// Localization: the nine StarHermit locales in assets/strings.json (en-US text
// or a symbolic key as the key) through the engine's `strings`, which follows
// the player's language (Options › Language, else the account's or the device's)
// and owns the account lines (`starhermit.*`). Every string is drawn through T()
// each frame, so a change shows on the next frame and never restarts a round.
import { strings } from "starhermit:engine";
import * as ui from "starhermit:ui";

strings.load("assets/strings.json");
strings.defaultLocale = "en-US";
ui.setLanguage(strings.locale);
strings.onChange((locale) => ui.setLanguage(locale));

export type Vars = Record<string, string | number>;
/** An en-US source string (or symbolic key) in the player's language; `{name}` placeholders from vars. Text outside the tables passes through. */
export function T(key: string, vars?: Vars | null): string {
  if (typeof key === "string" && strings.has(key)) return strings.t(key, vars ?? undefined);
  if (typeof key !== "string" || !vars) return key;
  return key.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}
/** Marks an en-US key that is translated with T() where it is shown. */
export const N = (s: string): string => s;
/** A help text with the old markup's <b> tags dropped (the runtime's paragraphs draw plain text). */
export function plain(key: string, vars?: Vars): string { return T(key, vars).replace(/<\/?b>/g, ""); }
