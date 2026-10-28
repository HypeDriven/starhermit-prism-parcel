// Every player-facing key the engine client draws (T('…') / key('…') in
// native/*.ts, the results and settings rows, sound captions) and content
// (themes, difficulties, lessons, achievements, mastery ranks, piece names)
// exists in all nine locales with the same {placeholders}. DUMP=1 lists the keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { STRINGS, EN } from '../src/strings.js';
import { THEMES, themeInfo, DIFFICULTIES, DIFFICULTY_INFO, TUTORIAL_STEPS, ACHIEVEMENTS, MASTERY_TIERS } from '../src/content.js';
import { PIECES } from '../src/rules.js';

const LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
const dir = new URL('../native/', import.meta.url);
const lit = /"((?:[^"\\]|\\.)*)"/.source;

export function usedKeys() {
  const keys = new Set();
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    for (const re of [new RegExp(`(?<![\\w.])(?:T|key|plain|N)\\(${lit}`, 'g'), new RegExp(`\\[${lit}, (?:s\\.|r\\.|Math)`, 'g'),
      new RegExp(`(?<![\\w.])T\\([^()]*?\\?\\s*${lit}\\s*:\\s*${lit}`, 'g'), new RegExp(`case "\\w+": return ${lit};`, 'g')]) {
      for (const m of src.matchAll(re)) for (const g of [1, 2]) if (m[g] != null) keys.add(m[g].replace(/\\"/g, '"'));
    }
  }
  for (const th of THEMES) keys.add(themeInfo(th).name);
  for (const d of DIFFICULTIES) { keys.add(DIFFICULTY_INFO[d].name); keys.add(DIFFICULTY_INFO[d].desc); }
  for (const s of TUTORIAL_STEPS) { keys.add(s.title); keys.add(s.text); }
  for (const a of ACHIEVEMENTS) keys.add(a.name);
  for (const m of MASTERY_TIERS) keys.add(m.name);
  for (const p of PIECES) keys.add(p.name);
  keys.delete('');
  return keys;
}

const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('every used key exists in every translated locale with matching placeholders', () => {
  const keys = usedKeys();
  if (process.env.DUMP) console.log([...keys].sort().map((k) => JSON.stringify(k)).join('\n'));
  assert.ok(keys.size > 150, 'key scan found ' + keys.size);
  const missing = [];
  for (const loc of LOCALES) {
    if (loc.startsWith('en-')) continue;
    for (const k of keys) {
      const v = STRINGS[loc][k];
      if (typeof v !== 'string' || !v) missing.push(loc + ': ' + k);
      else if (ph(v) !== ph(EN[k] ?? k)) missing.push(loc + ' placeholders: ' + k);
    }
  }
  assert.deepEqual(missing, []);
});

test('nine locales; en-GB overrides only real keys; symbolic keys have en-US text', () => {
  assert.deepEqual(Object.keys(STRINGS).sort(), [...LOCALES].sort());
  const keys = usedKeys();
  for (const k of Object.keys(STRINGS['en-GB'])) assert.ok(keys.has(k), 'unknown en-GB key ' + k);
  for (const k of ['help.offer', 'help.clear', 'help.score', 'help.end', 'help.pointer', 'help.keyboard', 'help.gamepad']) assert.ok(EN[k], 'EN text for ' + k);
});
