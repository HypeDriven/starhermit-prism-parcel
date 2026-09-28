'use strict';

/**
 * Prism Parcel — strings for the Graphics settings panel in every supported
 * locale. The locale comes from navigator.language (exact tag, then language).
 */

const en = {
  tabGeneral: 'General', tabGraphics: 'Graphics',
  quality: 'Quality', auto: 'Auto (detected: {tier})', fromPreset: 'From preset ({tier})',
  renderScale: 'Render scale', adaptive: 'Adaptive resolution', showFps: 'Show frame rate',
  postNote: 'Post-processing is unavailable on this device; the game renders without it.',
  cat: {
    shadows: 'Shadows', ao: 'Ambient occlusion', bloom: 'Bloom', grade: 'Color grade & vignette',
    antialias: 'Anti-aliasing', reflections: 'Reflections', particles: 'Particles',
    background: 'Ambient motion', detail: 'Surface detail'
  },
  tier: {
    low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra', medium: 'Medium',
    off: 'Off', on: 'On', static: 'Static', animated: 'Animated', plain: 'Plain', detailed: 'Detailed',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA'
  },
  words: { noShadows: 'no shadows', shadows: 'shadows', ao: 'AO', fullAo: 'full AO', bloom: 'bloom', reflections: 'reflections', noAa: 'no AA' }
};

const STRINGS = {
  'en-US': en,
  'en-GB': {
    ...en,
    cat: { ...en.cat, grade: 'Colour grade & vignette' }
  },
  'es-419': {
    tabGeneral: 'General', tabGraphics: 'Gráficos',
    quality: 'Calidad', auto: 'Automática (detectada: {tier})', fromPreset: 'Según el ajuste ({tier})',
    renderScale: 'Escala de renderizado', adaptive: 'Resolución adaptativa', showFps: 'Mostrar cuadros por segundo',
    postNote: 'El posprocesamiento no está disponible en este dispositivo; el juego se muestra sin él.',
    cat: {
      shadows: 'Sombras', ao: 'Oclusión ambiental', bloom: 'Resplandor', grade: 'Gradación de color y viñeta',
      antialias: 'Antialiasing', reflections: 'Reflejos', particles: 'Partículas',
      background: 'Movimiento ambiental', detail: 'Detalle de superficies'
    },
    tier: {
      low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra', medium: 'Media',
      off: 'Desactivado', on: 'Activado', static: 'Estático', animated: 'Animado', plain: 'Simple', detailed: 'Detallado',
      fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA'
    },
    words: { noShadows: 'sin sombras', shadows: 'sombras', ao: 'AO', fullAo: 'AO completa', bloom: 'resplandor', reflections: 'reflejos', noAa: 'sin AA' }
  },
  'es-ES': {
    tabGeneral: 'General', tabGraphics: 'Gráficos',
    quality: 'Calidad', auto: 'Automática (detectada: {tier})', fromPreset: 'Según el ajuste ({tier})',
    renderScale: 'Escala de renderizado', adaptive: 'Resolución adaptativa', showFps: 'Mostrar fotogramas por segundo',
    postNote: 'El posprocesado no está disponible en este dispositivo; el juego se muestra sin él.',
    cat: {
      shadows: 'Sombras', ao: 'Oclusión ambiental', bloom: 'Resplandor', grade: 'Etalonaje y viñeta',
      antialias: 'Antialiasing', reflections: 'Reflejos', particles: 'Partículas',
      background: 'Movimiento ambiental', detail: 'Detalle de superficies'
    },
    tier: {
      low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra', medium: 'Media',
      off: 'Desactivado', on: 'Activado', static: 'Estático', animated: 'Animado', plain: 'Sencillo', detailed: 'Detallado',
      fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA'
    },
    words: { noShadows: 'sin sombras', shadows: 'sombras', ao: 'AO', fullAo: 'AO completa', bloom: 'resplandor', reflections: 'reflejos', noAa: 'sin AA' }
  },
  'de-DE': {
    tabGeneral: 'Allgemein', tabGraphics: 'Grafik',
    quality: 'Qualität', auto: 'Automatisch (erkannt: {tier})', fromPreset: 'Laut Voreinstellung ({tier})',
    renderScale: 'Renderskalierung', adaptive: 'Adaptive Auflösung', showFps: 'Bildrate anzeigen',
    postNote: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar; das Spiel wird ohne sie dargestellt.',
    cat: {
      shadows: 'Schatten', ao: 'Umgebungsverdeckung', bloom: 'Leuchteffekt', grade: 'Farbkorrektur & Vignette',
      antialias: 'Kantenglättung', reflections: 'Spiegelungen', particles: 'Partikel',
      background: 'Umgebungsbewegung', detail: 'Oberflächendetails'
    },
    tier: {
      low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra', medium: 'Mittel',
      off: 'Aus', on: 'An', static: 'Statisch', animated: 'Animiert', plain: 'Schlicht', detailed: 'Detailliert',
      fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA'
    },
    words: { noShadows: 'keine Schatten', shadows: 'Schatten', ao: 'AO', fullAo: 'volle AO', bloom: 'Leuchten', reflections: 'Spiegelungen', noAa: 'keine Glättung' }
  },
  'fr-FR': {
    tabGeneral: 'Général', tabGraphics: 'Graphismes',
    quality: 'Qualité', auto: 'Auto (détecté : {tier})', fromPreset: 'Selon le préréglage ({tier})',
    renderScale: 'Échelle de rendu', adaptive: 'Résolution adaptative', showFps: 'Afficher les images par seconde',
    postNote: 'Le post-traitement n’est pas disponible sur cet appareil ; le jeu s’affiche sans.',
    cat: {
      shadows: 'Ombres', ao: 'Occlusion ambiante', bloom: 'Halo lumineux', grade: 'Étalonnage et vignettage',
      antialias: 'Anticrénelage', reflections: 'Reflets', particles: 'Particules',
      background: 'Mouvement d’ambiance', detail: 'Détail des surfaces'
    },
    tier: {
      low: 'Basse', balanced: 'Équilibrée', high: 'Haute', ultra: 'Ultra', medium: 'Moyenne',
      off: 'Désactivé', on: 'Activé', static: 'Statique', animated: 'Animé', plain: 'Simple', detailed: 'Détaillé',
      fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA'
    },
    words: { noShadows: 'sans ombres', shadows: 'ombres', ao: 'AO', fullAo: 'AO complète', bloom: 'halo', reflections: 'reflets', noAa: 'sans anticrénelage' }
  },
  'fr-CA': {
    tabGeneral: 'Général', tabGraphics: 'Graphiques',
    quality: 'Qualité', auto: 'Auto (détectée : {tier})', fromPreset: 'Selon le préréglage ({tier})',
    renderScale: 'Échelle de rendu', adaptive: 'Résolution adaptative', showFps: 'Afficher les images par seconde',
    postNote: 'Le post-traitement n’est pas offert sur cet appareil; le jeu s’affiche sans.',
    cat: {
      shadows: 'Ombres', ao: 'Occlusion ambiante', bloom: 'Halo lumineux', grade: 'Étalonnage et vignettage',
      antialias: 'Anticrénelage', reflections: 'Reflets', particles: 'Particules',
      background: 'Mouvement d’ambiance', detail: 'Détail des surfaces'
    },
    tier: {
      low: 'Basse', balanced: 'Équilibrée', high: 'Haute', ultra: 'Ultra', medium: 'Moyenne',
      off: 'Désactivé', on: 'Activé', static: 'Statique', animated: 'Animé', plain: 'Simple', detailed: 'Détaillé',
      fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA'
    },
    words: { noShadows: 'sans ombres', shadows: 'ombres', ao: 'AO', fullAo: 'AO complète', bloom: 'halo', reflections: 'reflets', noAa: 'sans anticrénelage' }
  },
  'pt-BR': {
    tabGeneral: 'Geral', tabGraphics: 'Gráficos',
    quality: 'Qualidade', auto: 'Automática (detectada: {tier})', fromPreset: 'Conforme a predefinição ({tier})',
    renderScale: 'Escala de renderização', adaptive: 'Resolução adaptativa', showFps: 'Mostrar taxa de quadros',
    postNote: 'O pós-processamento não está disponível neste dispositivo; o jogo é exibido sem ele.',
    cat: {
      shadows: 'Sombras', ao: 'Oclusão de ambiente', bloom: 'Brilho', grade: 'Correção de cor e vinheta',
      antialias: 'Antisserrilhamento', reflections: 'Reflexos', particles: 'Partículas',
      background: 'Movimento ambiente', detail: 'Detalhe das superfícies'
    },
    tier: {
      low: 'Baixa', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra', medium: 'Média',
      off: 'Desligado', on: 'Ligado', static: 'Estático', animated: 'Animado', plain: 'Simples', detailed: 'Detalhado',
      fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA'
    },
    words: { noShadows: 'sem sombras', shadows: 'sombras', ao: 'AO', fullAo: 'AO completa', bloom: 'brilho', reflections: 'reflexos', noAa: 'sem AA' }
  },
  'it-IT': {
    tabGeneral: 'Generale', tabGraphics: 'Grafica',
    quality: 'Qualità', auto: 'Automatica (rilevata: {tier})', fromPreset: 'Da preimpostazione ({tier})',
    renderScale: 'Scala di rendering', adaptive: 'Risoluzione adattiva', showFps: 'Mostra frame al secondo',
    postNote: 'La post-elaborazione non è disponibile su questo dispositivo; il gioco viene mostrato senza.',
    cat: {
      shadows: 'Ombre', ao: 'Occlusione ambientale', bloom: 'Bagliore', grade: 'Correzione colore e vignettatura',
      antialias: 'Antialiasing', reflections: 'Riflessi', particles: 'Particelle',
      background: 'Movimento ambientale', detail: 'Dettaglio superfici'
    },
    tier: {
      low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra', medium: 'Media',
      off: 'Disattivato', on: 'Attivato', static: 'Statico', animated: 'Animato', plain: 'Semplice', detailed: 'Dettagliato',
      fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA'
    },
    words: { noShadows: 'senza ombre', shadows: 'ombre', ao: 'AO', fullAo: 'AO completa', bloom: 'bagliore', reflections: 'riflessi', noAa: 'senza AA' }
  }
};

export const GFX_LOCALES = Object.keys(STRINGS);

const LANG_DEFAULT = { en: 'en-US', es: 'es-419', de: 'de-DE', fr: 'fr-FR', pt: 'pt-BR', it: 'it-IT' };

/** Pick the best supported locale for a BCP-47 tag. */
export function pickGfxLocale(tag) {
  const t = String(tag || 'en-US');
  const exact = GFX_LOCALES.find(l => l.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  const lang = t.split('-')[0].toLowerCase();
  if (lang === 'es' && /-(ES)$/i.test(t)) return 'es-ES';
  if (lang === 'en' && /-(GB|UK|IE|AU|NZ)$/i.test(t)) return 'en-GB';
  if (lang === 'fr' && /-CA$/i.test(t)) return 'fr-CA';
  return LANG_DEFAULT[lang] || 'en-US';
}

export function gfxStrings(tag) {
  return STRINGS[pickGfxLocale(tag)];
}
