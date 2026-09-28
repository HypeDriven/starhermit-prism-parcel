import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPreset, resolve, presetTier, choosePreset, describe, CATEGORIES, PRESETS } from '../src/gfx.js';
import { gfxStrings, pickGfxLocale, GFX_LOCALES } from '../src/gfx-i18n.js';

test('detectPreset maps GPU strings to presets', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))'), 'low');
  assert.equal(detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)'), 'low');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0)'), 'high');
  assert.equal(detectPreset('Apple M2'), 'high');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)'), 'balanced');
  assert.equal(detectPreset('Adreno (TM) 650'), 'balanced');
  assert.equal(detectPreset(''), 'balanced');
});

test('detectPreset caps touch/mobile devices at balanced', () => {
  assert.equal(detectPreset('Apple M2', true), 'balanced');
  assert.equal(detectPreset('SwiftShader', true), 'low');
});

test('resolve: Auto follows detection, explicit preset wins', () => {
  const auto = resolve({}, 'high');
  assert.equal(auto.preset, 'high');
  assert.equal(auto.auto, true);
  const low = resolve({ preset: 'low' }, 'high');
  assert.equal(low.preset, 'low');
  assert.equal(low.auto, false);
  assert.equal(low.post, false, 'Low renders without the composer');
  assert.equal(low.shadows, 'off');
  assert.equal(resolve({ preset: 'bogus' }, undefined).preset, 'balanced');
});

test('resolve: per-category overrides and invalid values', () => {
  const r = resolve({ preset: 'low', bloom: 'on', shadows: 'nope' }, 'low');
  assert.equal(r.bloom, 'on');
  assert.equal(r.shadows, 'off');
  assert.equal(r.post, true);
  for (const p of PRESETS) {
    for (const cat of Object.keys(CATEGORIES)) assert.ok(CATEGORIES[cat].includes(presetTier(p, cat)), `${p}.${cat}`);
  }
});

test('resolve: render scale is clamped to 50–200%', () => {
  assert.equal(resolve({ preset: 'high', render_scale: 5 }).scale, 2);
  assert.equal(resolve({ preset: 'high', render_scale: 0.1 }).scale, 0.5);
  assert.equal(resolve({ preset: 'low', render_scale: 1 }).scale, 0.85);
  assert.equal(resolve({}).adaptive, true);
  assert.equal(resolve({ adaptive: false, show_fps: true }).showFps, true);
});

test('choosePreset clears overrides but keeps scale and toggles', () => {
  const next = choosePreset({ preset: 'low', bloom: 'on', ao: 'high', render_scale: 1.5, show_fps: true }, 'high');
  assert.deepEqual(next, { preset: 'high', render_scale: 1.5, show_fps: true });
  assert.equal(resolve(next).bloom, presetTier('high', 'bloom'));
  assert.equal(choosePreset({}, 'auto').preset, 'auto');
});

test('describe summarises cost', () => {
  const s = describe(resolve({ preset: 'high' }), [1280, 800]);
  assert.match(s, /2048² shadows/);
  assert.match(s, /SMAA/);
  assert.match(s, /1280×800 px/);
  assert.match(describe(resolve({ preset: 'low' })), /no shadows/);
});

test('graphics strings exist for every required locale', () => {
  for (const l of ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT']) {
    assert.ok(GFX_LOCALES.includes(l), l);
    const s = gfxStrings(l);
    for (const cat of Object.keys(CATEGORIES)) assert.ok(s.cat[cat], `${l} cat.${cat}`);
    for (const t of [...PRESETS, ...Object.values(CATEGORIES).flat()]) assert.ok(s.tier[t], `${l} tier.${t}`);
    for (const k of ['tabGeneral', 'tabGraphics', 'quality', 'auto', 'fromPreset', 'renderScale', 'adaptive', 'showFps', 'postNote']) assert.ok(s[k], `${l} ${k}`);
  }
  assert.equal(pickGfxLocale('es-MX'), 'es-419');
  assert.equal(pickGfxLocale('fr-CA'), 'fr-CA');
  assert.equal(pickGfxLocale('ja-JP'), 'en-US');
});
