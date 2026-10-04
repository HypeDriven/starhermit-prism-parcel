/* Prism Parcel — StarHermit platform adapter over the shared SDK
 * (starhermit-sdk.js, loaded as a classic script before the game modules):
 * launch token + renewal, sign-in, account nickname, cloud save (slot
 * game:<slug>; localStorage stays the offline cache), per-player settings KV,
 * keyboard bindings, invite link and the read-only platform leaderboard.
 * Hosted mode is "the SDK holds a token"; without one the game makes no
 * network request at all (local clock, local daily best and achievements). */

/** The SDK instance (window.StarHermit; tests may inject one on globalThis). */
function sdk() { return globalThis.StarHermit || null; }

export const platform = {
  online: false,
  syncState: 'offline', // offline | syncing | synced | error
  nickname: null,
  onSyncChange: null,  // (state) => void
  onAuthChange: null,  // ({ signedIn }) => void after the platform session ends
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
    if (this.userId) return 'Player ' + this.userId.slice(0, 6);
    return 'Player';
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
    return p ? p.displayName : 'Player ' + String(userId).slice(0, 6);
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
    for (const [k, v] of Object.entries(s)) this._sentSettings[k] = JSON.stringify(v);
    return s;
  },

  /** PATCH changed keys; never before the platform values were read. */
  syncSettings(prefs) {
    if (!this.hosted || !this._settingsLoaded) return Promise.resolve(null);
    const patch = {};
    for (const [k, v] of Object.entries(prefs || {})) {
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

  /* ---- daily board ---- */

  /** Clients never submit to a platform leaderboard; the day's best lives in
   *  the (cloud-saved) progress doc. Standalone there is no board at all. */
  async dailyBoard() {
    if (this.hosted) return this.platformBoard();
    return { ok: true, entries: [], localOnly: true };
  },

  /** Read-only platform leaderboard (first board), nicknames resolved. */
  async platformBoard() {
    if (!this.hosted) return { ok: false, entries: [] };
    const r = await sdk().leaderboard(null, { pageSize: 8 });
    if (!r || !r.board) return { ok: true, entries: [], localOnly: true };
    const entries = [];
    for (const e of (r.items || []).slice(0, 8)) {
      entries.push({ name: await this.nicknameFor(e.userId), score: e.score != null ? e.score : 0 });
    }
    return { ok: true, entries };
  }
};
