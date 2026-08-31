'use strict';

/**
 * Prism Parcel — authoritative server (StarHermit game script).
 * Zero-dependency Node.js server:
 *  - serves the static distribution (index.html, src/, local three.js)
 *  - GET  /api/v1/time                  platform time sync
 *  - GET  /api/v1/daily                 today's daily ruleset + seed
 *  - POST /api/v1/daily/score           replay-validated daily score submission
 *  - GET  /api/v1/daily/leaderboard     validated daily board
 *  - POST /api/v1/achievements          durable, idempotent achievement delivery
 *  - GET  /api/v1/health
 *
 * All network input is validated for shape, bounds, rate and payload size.
 * Score claims are trusted only after deterministic replay verification
 * against the immutable daily seed.
 */

import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { verifyReplay, runReplay, hashState, initialState, RULES_VERSION } from './src/rules.js';
import { dailySeed, dailyRuleset, utcDateStr, CONTENT_VERSION } from './src/content.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const DATA_DIR = join(ROOT, 'data');
const BOARD_FILE = join(DATA_DIR, 'daily-boards.json');
const ACH_FILE = join(DATA_DIR, 'achievements.json');
const MAX_BODY = 256 * 1024;

/* ------------------------------------------------------------------ */
/* Durable stores                                                     */
/* ------------------------------------------------------------------ */

function loadStore(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

const boards = loadStore(BOARD_FILE, {});        // { date: [entry] }
const achievementLog = loadStore(ACH_FILE, {});  // { playerId: { key: ts } }
let saveTimer = null;

function persistStores() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await mkdir(DATA_DIR, { recursive: true });
      await writeFile(BOARD_FILE, JSON.stringify(boards));
      await writeFile(ACH_FILE, JSON.stringify(achievementLog));
    } catch (e) { /* read-only fs: keep serving from memory */ }
  }, 250);
}

/* ------------------------------------------------------------------ */
/* Rate limiting (per-IP token bucket)                                */
/* ------------------------------------------------------------------ */

const buckets = new Map();
function rateOk(ip, cost = 1) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b) { b = { tokens: 100, ts: now }; buckets.set(ip, b); }
  b.tokens = Math.min(100, b.tokens + (now - b.ts) / 1000 * 2);
  b.ts = now;
  if (b.tokens < cost) return false;
  b.tokens -= cost;
  return true;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.opus': 'audio/ogg; codecs=opus',
  '.wasm': 'application/wasm'
};

function send(res, status, body, headers = {}) {
  const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  const data = isObj ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : (headers['Content-Type'] || 'text/plain; charset=utf-8'),
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(data);
}

const err = (res, status, message) => send(res, status, { error: message });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('payload-too-large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/* API                                                                */
/* ------------------------------------------------------------------ */

async function handleApi(req, res, url, ip) {
  if (!rateOk(ip)) return err(res, 429, 'rate-limited');

  if (req.method === 'GET' && url.pathname === '/api/v1/time') {
    return send(res, 200, { now: Date.now() });
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/health') {
    return send(res, 200, { ok: true, rulesVersion: RULES_VERSION, contentVersion: CONTENT_VERSION });
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/daily') {
    const date = url.searchParams.get('date') || utcDateStr(Date.now());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return err(res, 400, 'bad-date');
    return send(res, 200, dailyRuleset(date));
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/daily/leaderboard') {
    const date = url.searchParams.get('date') || utcDateStr(Date.now());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return err(res, 400, 'bad-date');
    const entries = (boards[date] || [])
      .slice()
      .sort((a, b) => b.score - a.score || a.invalid - b.invalid || a.elapsedMs - b.elapsedMs || String(a.id).localeCompare(String(b.id)))
      .slice(0, 50)
      .map(e => ({ name: e.name, score: e.score, rank: 0 }));
    entries.forEach((e, i) => { e.rank = i + 1; });
    return send(res, 200, { ok: true, date, validated: true, entries });
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/daily/score') {
    if (!rateOk(ip, 3)) return err(res, 429, 'rate-limited');
    let payload;
    try { payload = JSON.parse(await readBody(req)); }
    catch (e) { return err(res, 400, e.message === 'payload-too-large' ? 'payload-too-large' : 'bad-json'); }

    const p = payload;
    if (!p || typeof p !== 'object') return err(res, 400, 'bad-payload');
    const date = String(p.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return err(res, 400, 'bad-date');
    // Daily seeds are immutable: the claimed seed must match the day's seed.
    if ((p.seed >>> 0) !== dailySeed(date)) return err(res, 422, 'seed-mismatch');
    if (p.contentVersion !== CONTENT_VERSION) return err(res, 422, 'stale-content-version');
    if (!p.replay || typeof p.replay !== 'object') return err(res, 400, 'missing-replay');
    if (!Array.isArray(p.replay.commands) || p.replay.commands.length > 5000) return err(res, 400, 'bad-command-log');
    for (const c of p.replay.commands) {
      if (!c || !Number.isInteger(c.slot) || c.slot < 0 || c.slot > 2 ||
          !Number.isInteger(c.row) || c.row < 0 || c.row > 9 ||
          !Number.isInteger(c.col) || c.col < 0 || c.col > 9) {
        return err(res, 400, 'bad-command');
      }
    }
    const elapsedMs = Number(p.elapsedMs);
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs > 6 * 3600 * 1000) return err(res, 400, 'bad-elapsed');

    // Authoritative validation: replay the input log deterministically.
    let verification;
    try { verification = verifyReplay(p.replay); }
    catch (e) { return err(res, 422, 'replay-invalid'); }
    if (!verification.ok) return err(res, 422, verification.reason);

    const state = verification.state;
    if (!state.over) return err(res, 422, 'round-not-finished');

    // Idempotent by submission id; reject duplicates silently as accepted.
    const id = typeof p.id === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(p.id) ? p.id : randomUUID();
    const name = typeof p.name === 'string' ? p.name.slice(0, 24).replace(/[<>&"]/g, '') : 'Player';
    const list = boards[date] || (boards[date] = []);
    let entry = list.find(e => e.id === id);
    if (!entry) {
      entry = {
        id, name,
        score: state.score.total,
        invalid: state.invalid,
        elapsedMs: Math.round(elapsedMs),
        turns: state.turn,
        hash: hashState(state),
        ts: Date.now()
      };
      list.push(entry);
      persistStores();
    }
    const sorted = list.slice().sort((a, b) => b.score - a.score || a.invalid - b.invalid || a.elapsedMs - b.elapsedMs || String(a.id).localeCompare(String(b.id)));
    const rank = sorted.findIndex(e => e.id === entry.id) + 1;
    return send(res, 200, { ok: true, rank, count: list.length, score: entry.score, validated: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/achievements') {
    let payload;
    try { payload = JSON.parse(await readBody(req)); }
    catch (e) { return err(res, 400, 'bad-json'); }
    const key = String((payload && payload.key) || '');
    if (!/^[a-z][a-z0-9_]{2,40}$/.test(key)) return err(res, 400, 'bad-key');
    const player = String((payload && payload.player) || 'guest').slice(0, 64);
    const mine = achievementLog[player] || (achievementLog[player] = {});
    if (!mine[key]) { mine[key] = Date.now(); persistStores(); } // idempotent unlock
    return send(res, 200, { ok: true, key, unlockedAt: mine[key] });
  }

  return err(res, 404, 'not-found');
}

/* ------------------------------------------------------------------ */
/* Static files                                                       */
/* ------------------------------------------------------------------ */

async function serveStatic(req, res, url) {
  let path = decodeURIComponent(url.pathname);
  if (path === '/') path = '/index.html';
  const full = normalize(join(ROOT, path));
  if (!full.startsWith(ROOT)) return err(res, 403, 'forbidden');
  // Never serve secrets, data, or dotfiles.
  if (full.includes('/data/') || /\/\.[^/]*$/.test(full)) return err(res, 403, 'forbidden');
  try {
    const data = await readFile(full);
    send(res, 200, data, {
      'Content-Type': MIME[extname(full)] || 'application/octet-stream',
      'Cache-Control': extname(full) === '.html' ? 'no-store' : 'public, max-age=3600, immutable'
    });
  } catch (e) {
    err(res, 404, 'not-found');
  }
}

/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const ip = req.socket.remoteAddress || 'unknown';
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url, ip);
    if (req.method !== 'GET' && req.method !== 'HEAD') return err(res, 405, 'method-not-allowed');
    return await serveStatic(req, res, url);
  } catch (e) {
    return err(res, 500, 'internal-error');
  }
});

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  server.listen(PORT, () => {
    console.log(`Prism Parcel server listening on http://localhost:${PORT}`);
  });
}

export { server, boards, rateOk };
export default server;
