/* Prism Parcel — StarHermit platform adapter over the shared SDK
 * (starhermit-sdk.js, loaded as a classic script before the game modules):
 * launch token + renewal, sign-in, account nickname, cloud save (slot
 * game:<slug>; localStorage stays the offline cache), per-player settings KV,
 * keyboard bindings, invite link and the high-score leaderboard.
 * Hosted mode is "the SDK holds a token"; without one the game makes no
 * network request at all (local clock, local daily best and achievements). */

import { t } from './i18n.js';

/**
 * Progress merge (start-up load and `saveconflict`): neither device's progress
 * is dropped. Journey unlock and lifetime counters take the larger value,
 * stars / best scores / daily bests the better one per stage or day,
 * achievements the earliest unlock; tutorial done if either finished it;
 * friends are the union.
 */
export function mergeProgress(remote, local) {
  const r = remote && typeof remote === 'object' ? remote : {};
  const l = local && typeof local === 'object' ? local : {};
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const maxMap = (a, b) => {
    const out = { ...obj(a) };
    for (const [k, v] of Object.entries(obj(b))) out[k] = Math.max(num(out[k]), num(v));
    return out;
  };
  const achievements = { ...obj(r.achievements) };
  for (const [k, v] of Object.entries(obj(l.achievements))) {
    achievements[k] = achievements[k] ? Math.min(num(achievements[k]), num(v)) : v;
  }
  const friends = [...new Set([...(Array.isArray(r.friends) ? r.friends : []), ...(Array.isArray(l.friends) ? l.friends : [])])];
  return {
    stage: Math.max(num(r.stage), num(l.stage), 1),
    stars: maxMap(r.stars, l.stars),
    bestScores: maxMap(r.bestScores, l.bestScores),
    achievements,
    tutorialDone: !!(r.tutorialDone || l.tutorialDone),
    totalPlaced: Math.max(num(r.totalPlaced), num(l.totalPlaced)),
    dailyBest: maxMap(r.dailyBest, l.dailyBest),
    friends,
  };
}

/** The SDK instance (window.StarHermit; tests may inject one on globalThis). */
function sdk() { return globalThis.StarHermit || null; }

export const platform = {
  online: false,
  syncState: 'offline', // offline | syncing | synced | error
  nickname: null,
  onSyncChange: null,  // (state) => void
  onAuthChange: null,  // ({ signedIn }) => void after the platform session ends
  onSaveConflict: null, // (remoteDoc|null) => void after a save lost to another device
  docProvider: null,   // () => save doc mirrored to the cloud slot
  _settingsLoaded: false,
  _sentSettings: {},

  get hosted() { return !!(sdk() && sdk().signedIn); },
  get userId() { return this.hosted ? String(sdk().userId) : null; },
  get gameSlug() { return this.hosted ? sdk().slug : null; },

  /** Read the launch token (no-op when index.html already did) and wire events. */
  init() {
    const sh = sdk();
    if (!sh) return;
    if (!sh.signedIn) sh.init();
    if (sh.signedIn) this.online = true;
    sh.on('saved', (ok) => this.setSync(ok ? 'synced' : 'offline'));
    // A conditional cloud write lost to another device: reload the newer doc
    // (loadJSON lifts the SDK's write block); main.js merges it with this
    // device's progress and saves on top.
    sh.on('saveconflict', async () => {
      let doc = null;
      try { doc = await sh.loadJSON(); } catch (e) { doc = null; }
      if (this.onSaveConflict) this.onSaveConflict(doc && typeof doc === 'object' ? doc : null);
    });
    sh.on('auth', (a) => {
      if (!a.signedIn) { this.nickname = null; this.setSync('offline'); }
      if (this.onAuthChange) this.onAuthChange({ signedIn: !!a.signedIn });
    });
  },

  setSync(state) {
    this.syncState = state;
    if (this.onSyncChange) this.onSyncChange(state);
  },

  canSignIn() { return !!(sdk() && sdk().canSignIn()); },
  signIn() { return !!(sdk() && sdk().signIn()); },
  inviteLink() { return this.hosted ? sdk().inviteLink() : null; },

  /** Display name: profile nickname, else "Player " + id prefix. */
  displayName() {
    if (this.nickname) return this.nickname;
    if (this.userId) return t('Player {id}', { id: this.userId.slice(0, 6) });
    return t('Player');
  },

  now() { return Date.now(); },

  /* ---- identity ---- */

  async loadProfile() {
    if (!this.hosted) return null;
    const p = await sdk().profile();
    this.nickname = p ? p.displayName : null;
    return this.nickname;
  },

  async nicknameFor(userId) {
    const p = this.hosted ? await sdk().profile(String(userId)) : null;
    return p ? p.displayName : t('Player {id}', { id: String(userId).slice(0, 6) });
  },

  /* ---- cloud save ---- */

  /** The remote save doc (null when none / signed out). */
  async loadCloud() {
    if (!this.hosted) return null;
    this.setSync('syncing');
    const doc = await sdk().loadJSON();
    this.setSync('synced');
    return doc && typeof doc === 'object' ? doc : null;
  },

  /** Debounced (~2 s) mirror of docProvider() to the cloud slot. */
  scheduleCloudSave() {
    if (!this.hosted || !this.docProvider) return;
    this.setSync('syncing');
    sdk().saveJSON(this.docProvider(), 2000);
  },

  /** Write the current doc now, or (flush) push out a pending debounced save
   *  with keepalive — used on pagehide / backgrounding. */
  saveCloud(flush) {
    if (!this.hosted || !this.docProvider) return Promise.resolve(false);
    if (!flush) sdk().saveJSON(this.docProvider(), 2000);
    return sdk().flushSave(!!flush);
  },

  /* ---- per-player settings KV ---- */

  async loadRemoteSettings() {
    if (!this.hosted) return {};
    const s = (await sdk().getSettings()) || {};
    this._settingsLoaded = true;
    const out = {};
    for (const [k, v] of Object.entries(s)) {
      if (k.startsWith('ui.')) continue; // platform-owned keys (ui.language) are not game settings
      this._sentSettings[k] = JSON.stringify(v);
      out[k] = v;
    }
    return out;
  },

  /** PATCH changed keys; never before the platform values were read. */
  syncSettings(prefs) {
    if (!this.hosted || !this._settingsLoaded) return Promise.resolve(null);
    const patch = {};
    for (const [k, v] of Object.entries(prefs || {})) {
      if (k.startsWith('ui.')) continue;
      const json = JSON.stringify(v);
      if (this._sentSettings[k] !== json) { patch[k] = v; this._sentSettings[k] = json; }
    }
    return Object.keys(patch).length ? sdk().patchSettings(patch) : Promise.resolve(null);
  },

  /* ---- controls ---- */

  loadBindings(defaults) {
    const copy = () => JSON.parse(JSON.stringify(defaults));
    if (!this.hosted) return Promise.resolve(copy());
    return sdk().loadBindings(defaults).catch(copy);
  },

  /* ---- leaderboard ---- */

  /** Post a finished Journey/Daily round to the high-score board
   *  (score-script.js); resolves { posted, rank } — rank may be null. */
  async submitScore(total) {
    if (!this.hosted) return { posted: false, rank: null };
    const s = sdk();
    try {
      const keys = await s.submitScores({ 'high-score': total });
      if (!keys || keys.indexOf('high-score') < 0) return { posted: false, rank: null };
      try {
        const r = await s.leaderboard('high-score', { pageSize: 100 });
        const me = (r.items || []).find((i) => String(i.userId) === String(s.userId));
        return { posted: true, rank: me ? me.rank : null };
      } catch (e) { return { posted: true, rank: null }; }
    } catch (e) { return { posted: false, rank: null }; }
  },

  /** The day's best lives in the (cloud-saved) progress doc; hosted, the
   *  board panel shows the high-score board. Standalone there is no board. */
  async dailyBoard() {
    if (this.hosted) return this.platformBoard();
    return { ok: true, entries: [], localOnly: true };
  },

  /** The high-score board's top entries, nicknames resolved. */
  async platformBoard() {
    if (!this.hosted) return { ok: false, entries: [] };
    const r = await sdk().leaderboard('high-score', { pageSize: 8 });
    if (!r || !r.board) return { ok: true, entries: [], localOnly: true };
    const entries = [];
    for (const e of (r.items || []).slice(0, 8)) {
      entries.push({ name: await this.nicknameFor(e.userId), score: e.score != null ? e.score : 0 });
    }
    return { ok: true, entries };
  }
};
