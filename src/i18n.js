// Prism Parcel — game language. One source for every string module (this
// file; platform-i18n.js reads getLocale()): the engine client sets the
// locale from the runtime's interface language (native/i18n.ts). Strings are
// keyed by their en-US text; EN holds the symbolic keys.

import { STRINGS, EN } from './strings.js';

export const LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];

let locale = 'en-US';
let table = STRINGS['en-US'];

/** Translate an en-US string (or symbolic key); {name} placeholders filled from vars. */
export function t(key, vars) {
  let s = table[key] ?? STRINGS['en-US'][key] ?? EN[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return s;
}

export function getLocale() { return locale; }

export function setLocale(next) {
  locale = LOCALES.includes(next) ? next : 'en-US';
  table = STRINGS[locale] || STRINGS['en-US'];
}
