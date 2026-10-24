// The phone's "server": every /api route of blunder/server.py, answered inside the page
// with the TypeScript core, Stockfish compiled to WebAssembly (in Workers) and IndexedDB.
// Nothing leaves the device except the Lichess game download.
import { InputError, load, play } from './records';
import { explainTry } from './whatif';
import { EngineEvaluator, UciEngine, analyse } from './uci';
import type { EvalStore } from './uci';
import type { Line } from './engine';
import { explainPending, gameId, markInaccuracies, pendingCards, playedAt, reviewGame, splitPgns } from './review';
import type { Review } from './review';

const ENGINE_JS = '/vendor/stockfish/stockfish-19-lite-single.js';
// Several threads need a cross-origin isolated page (COOP/COEP headers, see web/_headers).
const ENGINE_THREADED_JS = '/vendor/stockfish/stockfish-19-lite.js';
const threaded = () => typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated && (navigator.hardwareConcurrency || 1) > 2;
// Lighter than the PC's 1M nodes: a review takes minutes on a phone, not hours.
export const REVIEW_NODES = 250_000;
const WHATIF_NODES = 300_000; // blunder/whatif.py
const REVIEW_ID = /^[A-Za-z0-9_-]{1,60}$/;
const LICHESS_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{1,29}$/;
const CHESSCOM_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{2,24}$/;
// Sync: your latest game on each site you have a name for
const DEFAULTS = { lichess_user: null as string | null, chesscom_user: null as string | null, auto_sync: false, sync_max: 1,
                   explain_inaccuracies: false };

// ---------- IndexedDB ----------

let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  return (dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('blunder-explainer', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('reviews', { keyPath: 'id' });
      d.createObjectStore('evals');
      d.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = fn(d.transaction(store, mode).objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const evalStore: EvalStore = {
  get: (key) => tx<Line[] | undefined>('evals', 'readonly', (s) => s.get(key)),
  put: async (key, lines) => { await tx('evals', 'readwrite', (s) => s.put(lines, key)); },
};

// Ask the browser not to clear our storage under pressure (home-screen apps usually get this).
navigator.storage?.persist?.().catch(() => {});

// ---------- engines: one for the live eval bar, one for reviews and What if ----------

function workerPort(script = ENGINE_JS): { send: (c: string) => void; onLine: (cb: (l: string) => void) => void } {
  const w = new Worker(script);
  const cbs: Array<(l: string) => void> = [];
  w.onmessage = (e) => { const l = String(e.data); cbs.forEach((f) => f(l)); };
  w.onerror = (e) => console.error('engine worker', e.message);
  return { send: (c) => w.postMessage(c), onLine: (cb) => cbs.push(cb) };
}

let live: UciEngine | null = null, work: UciEngine | null = null;
const liveEngine = () => (live ??= new UciEngine(workerPort(), { Hash: 16 }));
// Reviews get every core but one (kept for the eval bar's single-thread engine), up to 4.
export const workThreads = () => (threaded() ? Math.min(4, (navigator.hardwareConcurrency || 2) - 1) : 1);
const workEngine = () => (work ??= threaded()
  ? new UciEngine(workerPort(ENGINE_THREADED_JS), { Hash: 64, Threads: workThreads() })
  : new UciEngine(workerPort(), { Hash: 32 }));
let reviewEval: EngineEvaluator | null = null, whatifEval: EngineEvaluator | null = null;
const reviewEvaluator = () => (reviewEval ??= new EngineEvaluator(workEngine(), REVIEW_NODES, evalStore));
// What if jumps the review queue, so a dragged move is explained even mid-review.
const whatifEvaluator = () => (whatifEval ??= new EngineEvaluator(workEngine(), WHATIF_NODES, evalStore, true));
// The coach's engine tools (coach-tools.ts) jump the review queue too, at the review's node count.
let coachEval: EngineEvaluator | null = null;
export const coachEvaluator = () => (coachEval ??= new EngineEvaluator(workEngine(), REVIEW_NODES, evalStore, true));

// ---------- settings ----------

type Settings = typeof DEFAULTS;

async function settings(): Promise<Settings> {
  const saved = (await tx<Partial<Settings> | undefined>('meta', 'readonly', (s) => s.get('settings'))) || {};
  // sync_max is not a setting you can change: the first phone version (default 5) saved it with
  // the rest, and a saved 5 would keep reviewing 5 games a sync forever.
  const { sync_max: _old, ...kept } = saved;
  return { ...DEFAULTS, ...kept };
}

async function saveSettings(changes: Record<string, unknown>): Promise<Settings> {
  const cfg = await settings();
  if ('lichess_user' in changes) {
    const user = String(changes.lichess_user ?? '').trim() || null;
    if (user !== null && !LICHESS_NAME.test(user)) throw new InputError('That is not a valid Lichess username.');
    cfg.lichess_user = user;
  }
  if ('chesscom_user' in changes) {
    const user = String(changes.chesscom_user ?? '').trim() || null;
    if (user !== null && !CHESSCOM_NAME.test(user)) throw new InputError('That is not a valid chess.com username.');
    cfg.chesscom_user = user;
  }
  if ('auto_sync' in changes) cfg.auto_sync = !!changes.auto_sync;
  if ('explain_inaccuracies' in changes) cfg.explain_inaccuracies = !!changes.explain_inaccuracies;
  if ('sync_max' in changes) cfg.sync_max = Math.max(1, Math.min(Number(changes.sync_max) || DEFAULTS.sync_max, 50));
  await tx('meta', 'readwrite', (s) => s.put(cfg, 'settings'));
  return cfg;
}

// ---------- reviews ----------

async function saveReview(r: Review) {
  await tx('reviews', 'readwrite', (s) => s.put(r));
}

async function allReviews(): Promise<Review[]> {
  return tx<Review[]>('reviews', 'readonly', (s) => s.getAll());
}

/** review.site_of: "Lichess", "chess.com", or "pasted". */
function siteOf(id: string, h: Record<string, string>): string {
  if (id.startsWith('chesscom-') || (h.Site || '').toLowerCase().includes('chess.com')) return 'chess.com';
  if ((h.Site || '').includes('lichess.org')) return 'Lichess';
  return 'pasted';
}

async function listReviews() {
  const out = (await allReviews()).map((r) => {
    const h = r.headers || {};
    const mine = (r.moments || []).filter((m: any) => r.you == null || m.color === r.you);
    return {
      id: r.id, site: siteOf(r.id, h), white: h.White, black: h.Black, result: h.Result, date: h.Date, you: r.you,
      played: r.played || (h.Date || '').replace(/\?+/g, ''),
      blunders: mine.filter((m: any) => m.judgement === 'blunder').length,
      mistakes: mine.filter((m: any) => m.judgement === 'mistake').length,
    };
  });
  return out.sort((a, b) => (a.played < b.played ? 1 : a.played > b.played ? -1 : 0));
}

async function loadReview(id: string): Promise<Review> {
  if (!REVIEW_ID.test(id)) throw new InputError('bad review id');
  const r = await tx<Review | undefined>('reviews', 'readonly', (s) => s.get(id));
  if (!r) throw new InputError('no such review');
  return r;
}

/** Reviews made on the PC (the "Export for the phone" file, or single data/reviews/*.json). */
export async function importReviews(items: unknown[]): Promise<{ imported: number; skipped: number }> {
  let imported = 0, skipped = 0;
  for (const r of items as Review[]) {
    const ok = r && typeof r === 'object' && typeof r.id === 'string' && REVIEW_ID.test(r.id) &&
      Array.isArray(r.records) && r.records.length > 0 && Array.isArray(r.moments) && r.headers && typeof r.headers === 'object';
    if (!ok) { skipped++; continue; }
    await saveReview(r);
    imported++;
  }
  return { imported, skipped };
}

// ---------- jobs: one at a time, in the order asked (like server.ReviewWorker) ----------

type Job = Record<string, any>;
const jobs = new Map<string, Job>();
let chain: Promise<unknown> = Promise.resolve();
let autoSynced = false;

function enqueue(kind: string, run: (job: Job) => Promise<void>): string {
  const id = Math.random().toString(36).slice(2, 14);
  const job: Job = { kind, state: 'queued', done: 0, total: 0 };
  jobs.set(id, job);
  chain = chain.then(async () => {
    job.state = 'running';
    try { await run(job); job.state = 'done'; } catch (e) { job.state = 'error'; job.error = (e as Error).message; }
  });
  return id;
}

async function fetchLichess(user: string, max: number): Promise<string[]> {
  const params = new URLSearchParams({ max: String(max), evals: 'true', literate: 'true', clocks: 'false', opening: 'true' });
  const res = await fetch(`https://lichess.org/api/games/user/${encodeURIComponent(user)}?${params}`,
    { headers: { Accept: 'application/x-chess-pgn' } });
  if (res.status === 404) throw new Error(`No Lichess user called ${user}.`);
  if (!res.ok) throw new Error(`Lichess answered ${res.status}. Are you online?`);
  return splitPgns(await res.text());
}

/** chess.com's monthly archives, newest month first, until `max` standard-chess games (fetch.fetch_chesscom). */
async function fetchChesscom(user: string, max: number): Promise<string[]> {
  const base = `https://api.chess.com/pub/player/${encodeURIComponent(user.toLowerCase())}/games`;
  const get = async (url: string) => {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (res.status === 404) throw new Error(`No chess.com user called ${user}.`);
    if (!res.ok) throw new Error(`chess.com answered ${res.status}. Are you online?`);
    return res.json();
  };
  const { archives = [] } = await get(`${base}/archives`);
  const pgns: string[] = [];
  for (const month of [...archives].reverse()) {
    const { games = [] } = await get(month);
    for (const g of [...games].reverse()) {
      if ((g.rules ?? 'chess') === 'chess' && g.pgn) pgns.push(g.pgn);
      if (pgns.length >= max) return pgns;
    }
  }
  return pgns;
}

/** Your newest games from every site you have a name for, newest first; a site that fails is reported, not fatal. */
async function fetchYourGames(cfg: Settings, max: number): Promise<{ pgns: string[]; errors: string[] }> {
  const sites: Array<Promise<string[]>> = [];
  if (cfg.lichess_user) sites.push(fetchLichess(cfg.lichess_user, max));
  if (cfg.chesscom_user) sites.push(fetchChesscom(cfg.chesscom_user, max));
  const results = await Promise.allSettled(sites);
  const pgns = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const errors = results.flatMap((r) => (r.status === 'rejected' ? [(r.reason as Error).message] : []));
  if (!pgns.length && errors.length) throw new Error(errors.join(' '));
  pgns.sort((a, b) => (playedAt(a) < playedAt(b) ? 1 : -1));
  return { pgns, errors };
}

/** Which of your names played this game (so "you" is the right side), if any. */
function yourName(pgn: string, cfg: Settings): string | null {
  const players = [/\[White "([^"]*)"\]/.exec(pgn)?.[1], /\[Black "([^"]*)"\]/.exec(pgn)?.[1]].map((x) => (x || '').toLowerCase());
  return [cfg.lichess_user, cfg.chesscom_user].find((n) => n && players.includes(n.toLowerCase())) || cfg.lichess_user || cfg.chesscom_user;
}

const hasName = (cfg: Settings) => !!(cfg.lichess_user || cfg.chesscom_user);

// ---------- explanations, built after the moves are judged ----------
// Yours first, then theirs; the one you open jumps the queue. Reviews are saved after each card,
// so the page can pick them up as they arrive, and an interrupted queue resumes on the next start.

const cardQueue: Array<{ id: string; index: number }> = [];
const cardVersion = new Map<string, number>();
let cardsRunning = false;

function queueCards(r: Review) {
  for (const index of pendingCards(r)) if (!cardQueue.some((c) => c.id === r.id && c.index === index)) cardQueue.push({ id: r.id, index });
  runCards();
}

async function runCards() {
  if (cardsRunning) return;
  cardsRunning = true;
  try {
    while (cardQueue.length) {
      const { id, index } = cardQueue.shift()!;
      const r = await tx<Review | undefined>('reviews', 'readonly', (s) => s.get(id));
      if (!r) continue;
      try {
        await explainPending(r, index, reviewEvaluator());
      } catch (e) {
        console.error('card', id, index, e);
        const m = r.moments.find((x: any) => x.index === index);
        if (m) delete m.pending; // shown as "best was …" rather than retried forever
      }
      await saveReview(r);
      cardVersion.set(id, (cardVersion.get(id) || 0) + 1);
    }
  } finally {
    cardsRunning = false;
  }
}

let resumed = false;
async function resumeCards() {
  if (resumed) return;
  resumed = true;
  for (const r of await allReviews()) if (r.moments?.some((m: any) => m.pending)) queueCards(r);
}

/** Judge a game now (seconds with Lichess's analysis), save it, and queue its explanations. */
async function judgeAndQueue(pgn: string, user: string | null, progress?: (done: number, total: number) => void): Promise<Review> {
  const r = await reviewGame(pgn, reviewEvaluator(), user, progress, false, true, (await settings()).explain_inaccuracies);
  r.played ||= playedAt(pgn);
  await saveReview(r);
  queueCards(r);
  return r;
}

// ---------- your recent games (Lichess and chess.com), reviewed or not ----------

const recentPgns = new Map<string, string>();

/** Lichess's speed classes from a PGN TimeControl ("180+2": 180 s + 2 s a move; estimated over 40 moves). */
export function speedOf(tc: string): string | null {
  const m = /^(\d+)(?:\+(\d+))?$/.exec(tc || '');
  if (!m) return tc.includes('/') ? 'daily' : null;
  const t = Number(m[1]) + 40 * Number(m[2] || 0);
  return t < 30 ? 'ultrabullet' : t < 180 ? 'bullet' : t < 480 ? 'blitz' : t < 1500 ? 'rapid' : 'classical';
}

async function recentGames(cfg: Settings, max = 20) {
  const { pgns, errors } = await fetchYourGames(cfg, max);
  const have = new Set((await allReviews()).map((r) => r.id));
  const games = pgns.slice(0, max).map((pgn) => {
    const id = gameId(pgn);
    recentPgns.set(id, pgn);
    const h = (k: string) => pgn.match(new RegExp(String.raw`\[${k} "([^"]*)"\]`))?.[1] || '';
    const me = (yourName(pgn, cfg) || '').toLowerCase();
    const side = h('White').toLowerCase() === me ? 'white' : h('Black').toLowerCase() === me ? 'black' : null;
    const result = h('Result');
    const outcome = !side || !['1-0', '0-1', '1/2-1/2'].includes(result) ? null
      : result === '1/2-1/2' ? 'drew' : (result === '1-0') === (side === 'white') ? 'won' : 'lost';
    return { id, white: h('White'), black: h('Black'), result, played: playedAt(pgn), reviewed: have.has(id),
             analysed: pgn.includes('[%eval'), site: id.startsWith('chesscom-') ? 'chess.com' : 'Lichess',
             opponent: side === 'white' ? h('Black') : side === 'black' ? h('White') : null, outcome, speed: speedOf(h('TimeControl')) };
  });
  return { games, errors };
}

function startSync(cfg: Settings): string {
  for (const [id, j] of jobs) if (j.kind === 'sync' && (j.state === 'queued' || j.state === 'running')) return id;
  return enqueue('sync', async (job) => {
    job.stage = 'fetch';
    // the newest sync_max games of each site
    const { pgns } = await fetchYourGames(cfg, cfg.sync_max);
    const have = new Set((await allReviews()).map((r) => r.id));
    const todo = pgns.filter((p) => !have.has(gameId(p)));
    const fresh: string[] = [];
    Object.assign(job, { stage: 'review', done: 0, total: todo.length });
    for (const pgn of todo) {
      const r = await judgeAndQueue(pgn, yourName(pgn, cfg), (done, total) => { job.positions = { done, total }; });
      delete job.positions;
      fresh.push(r.id);
      job.done = fresh.length;
    }
    Object.assign(job, { fetched: pgns.length, new: fresh, skipped: pgns.length - todo.length });
  });
}

// ---------- the routes ----------

const str = (x: unknown) => String(x ?? '');

async function route(path: string, body: Record<string, any>, signal?: AbortSignal): Promise<unknown> {
  switch (path) {
    case '/api/load': return load(str(body.text));
    case '/api/move': return play(str(body.fen), str(body.uci));
    case '/api/analyse': return analyse(liveEngine(), str(body.fen), Number(body.movetime_ms) || 700, signal);
    case '/api/whatif': return explainTry(str(body.fen), str(body.uci), whatifEvaluator());
    case '/api/chat':
      throw new InputError('The coach is part of the paid plan. Everything else works offline on this device.');
    case '/api/reviews': return { reviews: await listReviews() };
    case '/api/review': return loadReview(str(body.id));
    case '/api/import': return importReviews(Array.isArray(body.reviews) ? body.reviews : []);
    case '/api/settings': {
      const cfg = await settings();
      let syncJob: string | null = null;
      for (const [id, j] of jobs) if (j.kind === 'sync' && (j.state === 'queued' || j.state === 'running')) syncJob = id;
      // Like the PC server at launch: with Auto-load on, sync once when the app opens.
      if (!syncJob && !autoSynced && cfg.auto_sync && hasName(cfg) && navigator.onLine) syncJob = startSync(cfg);
      autoSynced = true;
      resumeCards();
      return { ...cfg, syncJob, local: true, nodes: REVIEW_NODES, threads: workThreads() };
    }
    case '/api/settings/save': return saveSettings(body);
    case '/api/sync/start': {
      const cfg = await settings();
      if (!hasName(cfg)) throw new InputError('Set your Lichess or chess.com username first.');
      return { job: startSync(cfg) };
    }
    case '/api/review/start': {
      const text = str(body.text);
      load(text); // reject bad input now, not in the background
      const user = str(body.user).trim() || null;
      return {
        job: enqueue('review', async (job) => {
          const r = await judgeAndQueue(text, user, (done, total) => { job.done = done; job.total = total; });
          job.id = r.id;
        }),
      };
    }
    case '/api/recent/games': {
      const cfg = await settings();
      if (!hasName(cfg)) throw new InputError('Set your Lichess or chess.com username first.');
      return recentGames(cfg, Math.max(1, Math.min(Number(body.max) || 20, 50)));
    }
    case '/api/recent/review': {
      const pgn = recentPgns.get(str(body.id));
      if (!pgn) throw new InputError('That game is not in the list any more; refresh it.');
      const cfg = await settings();
      return {
        job: enqueue('review', async (job) => {
          const r = await judgeAndQueue(pgn, yourName(pgn, cfg), (done, total) => { job.done = done; job.total = total; });
          job.id = r.id;
        }),
      };
    }
    case '/api/cards/status': {
      // Which judged moves still wait for their card; `version` changes whenever one arrives.
      const id = str(body.id);
      const r = await tx<Review | undefined>('reviews', 'readonly', (s) => s.get(id));
      return { version: cardVersion.get(id) || 0, pending: r ? pendingCards(r) : [] };
    }
    case '/api/cards/inaccuracies': {
      // "Also explain inaccuracies" turned on: queue them for a game reviewed before.
      const r = await tx<Review | undefined>('reviews', 'readonly', (s) => s.get(str(body.id)));
      if (!r) throw new InputError('no such review');
      const added = markInaccuracies(r);
      if (added) { await saveReview(r); queueCards(r); }
      return { added };
    }
    case '/api/cards/first': {
      // You opened a judged move whose card is not ready: build that one next.
      const id = str(body.id), index = Number(body.index);
      const i = cardQueue.findIndex((c) => c.id === id && c.index === index);
      if (i > 0) cardQueue.unshift(...cardQueue.splice(i, 1));
      return { queued: i >= 0 };
    }
    case '/api/review/status': {
      const job = jobs.get(str(body.job));
      if (!job) throw new InputError('no such job');
      return { ...job };
    }
  }
  throw new InputError('not found');
}

/** Same contract as a POST to the PC server: resolves to the JSON, or throws with its error. */
export async function localApi(path: string, body: Record<string, any> = {}, signal?: AbortSignal): Promise<unknown> {
  return route(path, body, signal);
}
