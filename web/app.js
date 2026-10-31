// Board UI, modelled on the Lichess analysis board. Renders records from the backend;
// computes no chess facts itself. The backend is the Python server on the PC, or, with no
// server (the phone, or ?local=1), the same routes answered inside the page by /core.js:
// the TypeScript core with Stockfish in WebAssembly, storing reviews in IndexedDB.
//
// Moves form a tree, like Lichess: the game is the main line; explanations hang off a
// judged move as a comment plus two variations ("after your move, best play" and
// "better was"); moves you drag become your own variations.
import { Chessground } from '/vendor/chessground/chessground.min.js';
import * as account from '/account.js';


const GLYPH = { blunder: '??', mistake: '?', inaccuracy: '?!' };
const JUDGE = { blunder: 'Blunder', mistake: 'Mistake', inaccuracy: 'Inaccuracy' };
const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
// The two kinds of wrong (the Python/TS core decides which): your move gives them
// a chance, or a better move was there and you missed it.
const KIND = {
  mine: { allowed: 'Gives them a chance', missed: 'Missed chance', best: 'Top engine move' },
  theirs: { allowed: 'Gives you a chance', missed: 'They missed a chance', best: 'Top engine move' },
};
const kindOf = (card) => card?.kind || 'missed';
// A card is "mine" unless the core marked it as the opponent's move.
const mineOf = (card) => card?.mine !== false;
// What the gap is made of: pieces (material), only the engine's score (positional), or mate.
// Positional is exactly when the card's text says material ends the same (card.evalGap).
const natureOf = (card) => (!card ? null : card.lineA?.mate || card.lineB?.mate ? 'mate' : card.evalGap ? 'positional' : 'material');
// The chip for a judged move: its kind, or "explaining…" while the phone still builds the card.
const chipFor = (m, card) => (card ? `<span class="kind kind-${kindOf(card)}${mineOf(card) ? '' : ' theirs'}">${kindLabel(card)}</span>`
  : m.pending ? '<span class="kind pending">explaining…</span>' : '');
const kindLabel = (card, kind) => {
  const k = kind || kindOf(card);
  const nature = k !== 'best' && natureOf(card);
  return KIND[mineOf(card) ? 'mine' : 'theirs'][k] + (nature ? ` · ${nature}` : '');
};

const BRUSHES = {
  played: { key: 'pl', color: '#d64545', opacity: 0.85, lineWidth: 10 },
  best: { key: 'bs', color: '#3aa655', opacity: 0.85, lineWidth: 10 },
  next: { key: 'nx', color: '#7c7c7c', opacity: 0.45, lineWidth: 9 },
  hanging: { key: 'hg', color: '#e03131', opacity: 0.9, lineWidth: 6 },
  forked: { key: 'fk', color: '#f08c00', opacity: 0.9, lineWidth: 6 },
  pinned: { key: 'pn', color: '#9c36b5', opacity: 0.85, lineWidth: 8 },
  threat: { key: 'th', color: '#e03131', opacity: 0.7, lineWidth: 8 },
  defender: { key: 'df', color: '#868e96', opacity: 0.75, lineWidth: 7 },
  trapped: { key: 'tp', color: '#e8590c', opacity: 0.9, lineWidth: 6 },
  idea: { key: 'id', color: '#2f9e44', opacity: 0.5, lineWidth: 9 },
  gain: { key: 'gn', color: '#2f9e44', opacity: 0.9, lineWidth: 6 },
};
const TAG_COLORS = {
  hanging: '#e03131', forked: '#f08c00', pinned: '#9c36b5', trapped: '#e8590c', threat: '#e03131',
  defender: '#495057', gain: '#2f9e44', idea: '#2f9e44', lost: '#495057', escape: '#e8590c', feature: '#1864ab',
};
const DEFAULT_BRUSHES = {
  green: { key: 'g', color: '#15781B', opacity: 1, lineWidth: 10 },
  red: { key: 'r', color: '#882020', opacity: 1, lineWidth: 10 },
  blue: { key: 'b', color: '#003088', opacity: 1, lineWidth: 10 },
  yellow: { key: 'y', color: '#e68f00', opacity: 1, lineWidth: 10 },
  paleBlue: { key: 'pb', color: '#003088', opacity: 0.4, lineWidth: 15 },
  paleGreen: { key: 'pg', color: '#15781B', opacity: 0.4, lineWidth: 15 },
  paleRed: { key: 'pr', color: '#882020', opacity: 0.4, lineWidth: 15 },
  paleGrey: { key: 'pgr', color: '#4a4a4a', opacity: 0.35, lineWidth: 15 },
};

const $ = (id) => document.getElementById(id);
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Card text, escaped, with the core's **feature terms** in bold.
const rich = (s) => escapeHtml(s).replace(/\*\*(.+?)\*\*/g, '<b class="feat">$1</b>');
const other = (c) => (c === 'white' ? 'black' : 'white');

const state = {
  root: null, node: null, headers: {}, review: null, reviews: [],
  inaccuracies: false, // Settings: also explain inaccuracies (off: they are not shown at all)
  you: null,        // 'white' | 'black' | null: your side, shown at the bottom
  flipped: false,   // the Flip button; kept across every view until a new game is loaded
  compare: null,    // node whose two line endpoints are shown side by side
  analysis: null, seq: 0, abort: null, cache: new Map(),
};

const orientation = () => (state.flipped ? other(state.you || 'white') : state.you || 'white');

const cgConfig = (extra = {}) => ({ drawable: { enabled: true, brushes: { ...DEFAULT_BRUSHES, ...BRUSHES } }, ...extra });
const cg = Chessground($('board'), cgConfig({
  movable: { free: false, showDests: true, events: { after: onUserMove } },
  draggable: { showGhost: true },
  highlight: { lastMove: true, check: true },
  animation: { enabled: true, duration: 200 },
}));
const miniA = Chessground($('cmpA'), cgConfig({ viewOnly: true, coordinates: false }));
const miniB = Chessground($('cmpB'), cgConfig({ viewOnly: true, coordinates: false }));

const backend = { local: null }; // the in-page backend module, when there is no PC server
// web/config.json: `backend` is the paid service's address (null: none), `upgrade_url` the page
// that sells the paid plan (null: the coach shows "Coming soon").
// `github_url`: the "star us on GitHub" link at the bottom and in About (hidden while null).
// `plans`: the prices shown on the Subscribe buttons (text, e.g. "$5 a month"); `paddle`: for the /pay page.
const appConfig = { backend: null, upgrade_url: null, github_url: null, plans: null, paddle: null };
// The free app on a phone has no LLM: the chat panel points to the paid coach instead.
const freePlan = () => !!backend.local && !account.enabled();
// With a backend in config.json, a signed-in subscriber's questions go to the paid coach.
const coachMode = () => !!backend.local && account.enabled();

async function chooseBackend() {
  const params = new URLSearchParams(location.search);
  const onPc = ['127.0.0.1', 'localhost'].includes(location.hostname);
  if (onPc && params.get('local') !== '1') {
    try {
      const res = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (res.ok && (res.headers.get('Content-Type') || '').startsWith('application/json')) return;
    } catch (e) { /* no server: run on this device */ }
  }
  backend.local = await import('/core.js');
  try { Object.assign(appConfig, await (await fetch('/config.json')).json()); } catch (e) { /* defaults */ }
  showSupport();
  await account.init(appConfig.backend, renderPlan).catch(() => {});
  afterCheckout();
  $('plan-wrap').hidden = !account.enabled();
  showPlusCard();
  document.body.classList.add('local');
  // Offline support for the installed app; not on the PC, where it would cache the dev files.
  if ('serviceWorker' in navigator && (!onPc || params.get('sw') === '1')) watchForUpdates();
}

// A new version is downloaded whole by the service worker (sw.js), then waits. Ready at launch:
// switch at once, before you start anything. Ready later: a "New version" button switches when you tap it.
async function watchForUpdates() {
  const sw = navigator.serviceWorker;
  let reg;
  try { reg = await sw.register('/sw.js'); } catch (e) { return; }
  const hadController = !!sw.controller;
  let reloading = false;
  sw.addEventListener('controllerchange', () => {
    if (hadController && !reloading) { reloading = true; location.reload(); }
  });
  const offer = (worker) => {
    const btn = $('update');
    btn.hidden = false;
    btn.onclick = () => { btn.disabled = true; worker.postMessage('activate'); };
  };
  const waitInstalled = (worker) => worker.addEventListener('statechange', () => {
    if (worker.state === 'installed' && sw.controller) offer(worker);
  });
  if (reg.waiting && sw.controller) reg.waiting.postMessage('activate'); // downloaded last time: switch now
  else if (reg.installing) waitInstalled(reg.installing);
  reg.addEventListener('updatefound', () => waitInstalled(reg.installing));
  // An installed app on a phone can stay suspended for days; look for a new version when it comes back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reg.update().catch(() => {});
  });
}

async function api(path, body = {}, signal) {
  if (backend.local) return backend.local.localApi(path, body, signal);
  const res = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
// An error stays until your next tap or key press, so it never sticks to an unrelated view.
let errorShown = false;
function showError(msg) {
  $('error').textContent = msg || '';
  errorShown = !!msg;
}
for (const ev of ['pointerdown', 'keydown']) {
  document.addEventListener(ev, () => { if (errorShown) showError(''); }, true); // fires before the action's own error
}

// ---------- the move tree ----------

function makeNode(rec, parent, kind, extra = {}) {
  const n = { rec, parent, children: [], kind, ...extra };
  if (parent) parent.children.push(n);
  return n;
}

const gameChild = (n) => n.children.find((c) => c.kind === 'game');
const isVariation = (n) => n.kind !== 'game';

function mainline() {
  const out = [];
  for (let n = state.root; n; n = gameChild(n)) out.push(n);
  return out;
}

function nearestGameNode(n) {
  while (n && isVariation(n)) n = n.parent;
  return n || state.root;
}

function addLine(parent, plies, kind, line, firstK) {
  let p = parent, first = null;
  plies.forEach((rec, j) => {
    p = makeNode(rec, p, kind, { line, k: firstK + j }); // k: 1-based ply number within the line
    first = first || p;
  });
  return first;
}

// A judged move gets its explanation: Line A minus its first move (which IS this move)
// continues from it; Line B is an alternative to it, from the same position.
function attachCard(node, moment) {
  const card = moment.card;
  node.moment = moment;
  node.card = card;
  const a = [...card.lineA.plies, ...card.lineA.extra];
  const b = [...card.lineB.plies, ...card.lineB.extra];
  node.annot = a[0];                 // what this move does, drawn on the position after it
  node.parent.preAnnot = card.start; // e.g. the threat you ignored, drawn before it
  node.afterLine = addLine(node, a.slice(1), 'after', card.lineA, 2);
  node.bestLine = addLine(node.parent, b, 'best', card.lineB, 1);
  const passLine = { end: 2, cashed: null };
  // "Imagine they skip a move": the best move's threat, from the position after the best move.
  if (card.passes?.idea && node.bestLine) node.ideaPass = addLine(node.bestLine, card.passes.idea, 'pass', passLine, 1);
  // "Imagine you skip a move": what they already threatened before your move. Left out when
  // their reply in the line after your move is that very threat: the line already shows it.
  const threat = card.passes?.threat;
  const repeats = threat && a[1] && a[1].uci === threat[threat.length - 1].uci;
  if (threat && !repeats) node.threatPass = addLine(node.parent, card.passes.threat, 'pass', passLine, 1);
  for (const n of [node.afterLine, node.bestLine, node.ideaPass, node.threatPass]) if (n) n.cardOwner = node;
}

function buildTree(records, review) {
  const root = makeNode(records[0], null, 'game');
  const nodes = [root];
  for (let i = 1; i < records.length; i++) nodes.push(makeNode(records[i], nodes[i - 1], 'game'));
  for (const m of review?.moments || []) {
    const n = nodes[m.index];
    if (!n) continue;
    if (m.judgement === 'inaccuracy' && !state.inaccuracies) continue;
    if (m.card) attachCard(n, m);
    else n.moment = m;
  }
  return root;
}

function cardOwnerOf(node) {
  for (let n = node; n; n = n.parent) if (n.cardOwner) return n.cardOwner;
  return null;
}

// ---------- loading ----------

// Your side in a game: either of your names (Lichess, chess.com) as White or Black.
function sideOf(headers, user) {
  for (const name of [user, $('user-cc').value.trim()]) {
    if (!name) continue;
    const u = name.toLowerCase();
    if ((headers.White || '').toLowerCase() === u) return 'white';
    if ((headers.Black || '').toLowerCase() === u) return 'black';
  }
  return null;
}

function setGame(records, headers, review = null) {
  state.headers = headers || {};
  state.review = review;
  $('review-guide').hidden = !review;
  state.you = review?.you || sideOf(state.headers, $('user').value.trim());
  state.flipped = false; // a new game starts with your side at the bottom
  state.compare = null;
  state.root = buildTree(records, review);
  resetChat();
  renderMoments();
  show(state.root); // always start from the first move, like Lichess
}

// A pasted Lichess or chess.com link becomes the game's PGN; anything else is used as pasted.
async function pastedGame(text) {
  const core = backend.local || await import('/core.js');
  const link = core.parseGameLink(text);
  if (!link) {
    if (core.looksLikeUrl(text)) throw new Error('That link is not a Lichess or chess.com game.');
    return text;
  }
  setProgress(`Fetching the game from ${link.site === 'lichess' ? 'Lichess' : 'chess.com'}…`);
  try {
    return await core.pgnFromLink(link, [$('user-cc').value.trim()]);
  } finally {
    setProgress('');
  }
}

// Which of your usernames plays in this game (so "you" is the right side), else the first one.
function yourNameIn(pgn) {
  const names = [$('user').value.trim(), $('user-cc').value.trim()].filter(Boolean);
  const players = [/\[White "([^"]*)"\]/.exec(pgn)?.[1], /\[Black "([^"]*)"\]/.exec(pgn)?.[1]].map((x) => (x || '').toLowerCase());
  return names.find((n) => players.includes(n.toLowerCase())) || names[0] || '';
}

async function load(text) {
  showError('');
  try {
    text = await pastedGame(text.trim());
    const data = await api('/api/load', { text });
    setGame(data.records, data.headers);
  } catch (e) { showError(e.message); }
}

// ---------- explanations arriving (phone: built after the moves are judged) ----------

const cards = { id: null, version: -1, timer: null };

function watchCards(review) {
  clearTimeout(cards.timer);
  cards.id = review?.id ?? null;
  cards.version = -1;
  if (!backend.local || !review?.moments?.some((m) => m.pending)) return;
  const tick = async () => {
    if (cards.id !== review.id || state.review?.id !== review.id) return;
    let st;
    try { st = await api('/api/cards/status', { id: review.id }); } catch (e) { return; }
    if (cards.version !== -1 && st.version !== cards.version) await mergeCards(review.id);
    cards.version = st.version;
    if (st.pending.length) cards.timer = setTimeout(tick, 1500);
    else if (state.review?.moments?.some((m) => m.pending)) await mergeCards(review.id);
  };
  tick();
}

// Attach the cards that arrived to the moves already on screen, without moving the board.
async function mergeCards(id) {
  let r;
  try { r = await api('/api/review', { id }); } catch (e) { return; }
  if (state.review?.id !== id) return;
  const main = mainline();
  for (const m of r.moments) {
    const n = main[m.index];
    if (!n) continue;
    if (m.card && !n.card) attachCard(n, m);
    else n.moment = m;
  }
  state.review = r;
  renderMoments();
  renderMoves();
  renderExplain();
  renderCaption();
  if (!state.compare) cg.setAutoShapes(shapesFor(state.node));
}

// You are looking at a judged move whose explanation is not ready: build that one next.
function askForCard(node) {
  const m = node?.moment;
  if (backend.local && m?.pending && state.review) api('/api/cards/first', { id: state.review.id, index: m.index }).catch(() => {});
}

async function openReview(id) {
  // No showError(''): this also runs when a background review finishes, and must not hide
  // an unrelated error you just got. Errors clear on your next tap instead.
  try {
    // a game reviewed before "Also explain inaccuracies" was on gets them queued now
    if (state.inaccuracies && backend.local) await api('/api/cards/inaccuracies', { id }).catch(() => {});
    const r = await api('/api/review', { id });
    setGame(r.records, r.headers, r);
    renderGameList();
    watchCards(r);
  } catch (e) { showError(e.message); }
}

async function refreshReviews(selectId) {
  try {
    const { reviews } = await api('/api/reviews');
    state.reviews = reviews;
    renderMyGames();
    return reviews;
  } catch (e) { return []; /* the list is a convenience */ }
}

// ---------- settings and auto-sync (saved in local/config.json on this computer) ----------

let autoOpened = null; // the review opened automatically at start, if the user is still on it

async function saveSettings(changes) {
  try {
    const cfg = await api('/api/settings/save', changes);
    showError('');
    return cfg;
  } catch (e) { showError(e.message); return null; }
}

// The bar under the buttons: a fraction 0..1 (null hides the bar) and what is being waited for.
function setProgress(text, fraction = null) {
  $('progress').textContent = text || '';
  const bar = $('progress-bar');
  bar.hidden = fraction === null || !text;
  bar.firstElementChild.style.width = `${Math.round(Math.max(0, Math.min(1, fraction ?? 0)) * 100)}%`;
}

function watchSync(job) {
  const status = $('progress');
  const tick = async () => {
    let s;
    try { s = await api('/api/review/status', { job }); } catch (e) { setProgress(''); return; }
    if (s.state === 'queued' || s.state === 'running') {
      if (s.stage === 'review' && s.total) {
        const game = Math.min(s.done + 1, s.total);
        const within = s.positions ? s.positions.done / s.positions.total : 0;
        setProgress(`Judging your new game${s.total > 1 ? `s: ${game} of ${s.total}` : ''}` +
          (s.positions ? `, move ${s.positions.done} of ${s.positions.total}` : '') + '…', (s.done + within) / s.total);
      } else {
        setProgress('Looking for your new games…', 0);
      }
      setTimeout(tick, 1000);
      return;
    }
    setProgress('');
    if (s.state === 'error') { showError('Sync failed: ' + s.error); return; }
    const reviews = await refreshReviews();
    refreshLichessGames(false);
    if (!s.new?.length) {
      status.textContent = 'Up to date: no new games.';
      setTimeout(() => { if (status.textContent.startsWith('Up to date')) status.textContent = ''; }, 6000);
      return;
    }
    status.textContent = `${s.new.length} new game${s.new.length > 1 ? 's' : ''} reviewed.`;
    // Open the newest one, unless you have moved on to something else meanwhile.
    const stillOnAuto = autoOpened === null ? state.review === null : state.review?.id === autoOpened;
    if (stillOnAuto && reviews.length) openReview(reviews[0].id);
  };
  tick();
}

async function startSync() {
  try {
    const { job } = await api('/api/sync/start');
    watchSync(job);
  } catch (e) { showError(e.message); }
}

// Which site a game is from: the core gives it; older lists fall back to the id.
const siteOf = (r) => r.site || (String(r.id).startsWith('chesscom-') ? 'chess.com' : 'Lichess');
const siteClass = (site) => (site === 'chess.com' ? 'chesscom' : site === 'Lichess' ? 'lichess' : 'pasted');

// Settings: one panel (a popup on the PC, the Settings tab on a phone).
let namesWhenOpened = '';
function toggleSettings(open = $('settings').hidden) {
  if (phone.matches) {
    if (open) setSheet('settings');
    return;
  }
  const names = `${$('user').value.trim()}|${$('user-cc').value.trim()}`;
  if (open) namesWhenOpened = names;
  $('settings').hidden = !open;
  $('settings-btn').setAttribute('aria-expanded', String(open));
  if (open && !$('user').value && !$('user-cc').value) $('user').focus();
  // a username was just added or changed: show the games to pick from
  if (!open && names !== namesWhenOpened && ($('user').value.trim() || $('user-cc').value.trim())) toggleMyGames(true);
}

// The one games list (My games; on a phone the Games tab).
function renderGameList() {
  renderMyGames();
}

async function init() {
  setSheet('explain');
  placeLoader();
  await chooseBackend();
  let cfg = { lichess_user: null, auto_sync: false };
  try { cfg = await api('/api/settings'); } catch (e) { /* older server: no settings */ }
  $('user').value = cfg.lichess_user || localStorage.getItem('user') || '';
  $('user-cc').value = cfg.chesscom_user || localStorage.getItem('userCc') || '';
  const hasAccounts = !!($('user').value.trim() || $('user-cc').value.trim());
  $('account-setup').open = !hasAccounts;
  $('accounts-title').textContent = hasAccounts ? 'Your game accounts' : 'Review your games';
  $('auto-review-option').hidden = !hasAccounts;
  $('find-games').disabled = false;
  $('autosync').checked = !!cfg.auto_sync;
  state.inaccuracies = !!cfg.explain_inaccuracies;
  $('inaccuracies').checked = state.inaccuracies;
  $('inaccuracies-label').hidden = !backend.local; // the PC server explains blunders and mistakes only
  showVersion();
  const reviews = await refreshReviews();
  // On a machine set up for one player, open their latest reviewed game straight away.
  const names = [cfg.lichess_user, cfg.chesscom_user].filter(Boolean).map((n) => n.toLowerCase());
  const mine = names.length && reviews.filter((r) => [r.white, r.black].some((n) => names.includes((n || '').toLowerCase())));
  if (mine && mine.length) {
    autoOpened = mine[0].id;
    await openReview(mine[0].id);
  } else {
    load('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  }
  if (cfg.syncJob) watchSync(cfg.syncJob); // started by the server at launch
  refreshLichessGames();
}

// One button for what you pasted: a game is reviewed; a position (no moves) is shown to explore,
// since there is nothing to review. "or just show it" puts a game on the board without reviewing.
async function startReview() {
  showError('');
  let text = $('input').value.trim();
  if (!text) { showError('Paste a game link or a PGN to review, or a position (FEN) to explore.'); return; }
  try {
    text = await pastedGame(text);
    const user = yourNameIn(text);
    const data = await api('/api/load', { text });
    if (data.records.length <= 1) { setGame(data.records, data.headers); return; }
    const { job } = await api('/api/review/start', { text, user });
    watchReview(job);
  } catch (e) { showError(e.message); }
}

// One review job: progress while the moves are judged, then open the game (explanations follow).
function watchReview(job) {
  setProgress('Reviewing…', 0);
  const poll = async () => {
    let s;
    try { s = await api('/api/review/status', { job }); } catch (e) { setProgress(''); showError(e.message); return; }
    if (s.state === 'done') {
      setProgress('');
      await refreshReviews(s.id);
      refreshLichessGames(false);
      openReview(s.id);
    } else if (s.state === 'error') {
      setProgress('');
      showError('Review failed: ' + s.error);
    } else {
      setProgress(s.total ? `Judging the moves: ${s.done} of ${s.total}…` : 'Reviewing…', s.total ? s.done / s.total : 0);
      setTimeout(poll, 800);
    }
  };
  poll();
}

// ---------- one games list: your recent online games, then your other reviews ----------

// Your recent Lichess and chess.com games (phone), fetched when you have a username.
const recent = { games: [], errors: [], loaded: false, offline: false };

async function refreshLichessGames(force = true) {
  if (!backend.local || !($('user').value.trim() || $('user-cc').value.trim())) {
    Object.assign(recent, { games: [], errors: [], loaded: false });
    renderGamesSelect();
    return;
  }
  if (!force && !recent.loaded) return;
  try {
    const { games, errors } = await api('/api/recent/games', { max: 20 });
    Object.assign(recent, { games, errors, loaded: true, offline: false });
  } catch (e) { recent.offline = true; }
  renderGamesSelect();
}

function renderGamesSelect() {
  renderMyGames();
}

// ---------- showing a position ----------

function moveNumber(plyAfter) {
  const p = plyAfter - 1;
  return { n: Math.floor(p / 2) + 1, white: p % 2 === 0 };
}
const moveLabel = (rec, force) => {
  const { n, white } = moveNumber(rec.ply);
  return white ? `${n}. ` : force ? `${n}… ` : '';
};

function show(node) {
  state.node = node;
  askForCard(node.moment ? node : cardOwnerOf(node));
  state.compare = null;
  const rec = node.rec;
  $('compare').hidden = true;
  if ($('board').hidden) {
    $('board').hidden = false;
    cg.redrawAll(); // it measured 0 wide while Compare hid it; arrows need the real size
  }
  cg.set({
    fen: rec.fen, orientation: orientation(), turnColor: rec.turn,
    lastMove: rec.lastMove || undefined, check: rec.check,
    movable: { color: rec.outcome ? undefined : rec.turn, dests: new Map(Object.entries(rec.dests || {})) },
  });
  cg.setAutoShapes(shapesFor(node));
  renderPlayers();
  renderContext();
  renderCaption();
  renderMoves();
  renderStrip();
  renderExplain();
  $('to-game').hidden = !isVariation(node);
  requestAnalysis(rec.fen);
}

function annotationsOf(node) {
  if (node.kind === 'game' || node.kind === 'user') {
    const items = [];
    if (node.annot) items.push(node.annot);
    if (node.preAnnot && node.children.some((c) => c.card)) items.push(node.preAnnot);
    return items;
  }
  return [node.rec];
}

function shapesFor(node) {
  const shapes = [];
  const tagsOn = {};
  // A judged move: the best move instead, as a green arrow (the highlighted squares already show the move played).
  const m = node.moment;
  if (m && (node.kind === 'game' || node.kind === 'user') && m.best && !m.isBest) {
    shapes.push({ orig: m.best.slice(0, 2), dest: m.best.slice(2, 4), brush: 'best' });
  }
  const untagged = [];
  for (const src of annotationsOf(node)) {
    for (const ar of src.arrows || []) {
      shapes.push({ orig: ar.from, dest: ar.to, brush: BRUSHES[ar.kind] ? ar.kind : 'threat' });
      if (ar.kind === 'threat') untagged.push(ar.to);
    }
    for (const an of src.annotations || []) {
      if (BRUSHES[an.kind]) shapes.push({ orig: an.square, brush: an.kind });
      if (an.label) {
        const i = (tagsOn[an.square] = (tagsOn[an.square] ?? -1) + 1);
        shapes.push({ orig: an.square, customSvg: { html: tagSvg(an.label, TAG_COLORS[an.kind] || '#495057', i) } });
      }
    }
  }
  // "This piece now attacks that one": say so on the target, unless it already has a tag.
  for (const sq of new Set(untagged)) {
    if (tagsOn[sq] === undefined) shapes.push({ orig: sq, customSvg: { html: tagSvg('attacks', TAG_COLORS.threat, (tagsOn[sq] = 0)) } });
  }
  if (node.kind === 'after' || node.kind === 'best' || node.kind === 'pass') {
    const next = node.children[0];
    if (next?.rec.lastMove) shapes.push({ orig: next.rec.lastMove[0], dest: next.rec.lastMove[1], brush: 'next' });
  }
  return shapes;
}

function tagSvg(text, color, row = 0) {
  // Drawn in the square's 100x100 box: a small badge along the top edge (row 0), then below.
  const t = escapeHtml(text).slice(0, 14);
  const w = Math.min(98, 12 + t.length * 9.5);
  const y = 1 + row * 27;
  return `<g><rect x="1" y="${y}" rx="7" width="${w}" height="24" fill="${color}" opacity="0.95"/>` +
    `<text x="7" y="${y + 18}" font-size="17" font-family="Segoe UI, sans-serif" font-weight="700" fill="#fff">${t}</text></g>`;
}

function materialOf(rec) {
  if (rec.material) return rec.material;
  const out = { white: 0, black: 0 };
  for (const ch of rec.fen.split(' ')[0]) {
    const v = VALUES[ch.toLowerCase()];
    if (v) out[ch === ch.toUpperCase() ? 'white' : 'black'] += v;
  }
  return out;
}

function renderPlayers() {
  const rec = state.node.rec;
  const mat = materialOf(rec);
  const h = state.headers;
  const bar = (color, isBottom) => {
    const name = h[color === 'white' ? 'White' : 'Black'];
    const elo = h[color === 'white' ? 'WhiteElo' : 'BlackElo'];
    const lead = mat[color] - mat[other(color)];
    return `<span class="dot ${color}" title="${color}"></span>` +
      `<b>${escapeHtml(name && name !== '?' ? name : color === 'white' ? 'White' : 'Black')}</b>` +
      (elo && elo !== '?' ? ` <span class="muted">${escapeHtml(elo)}</span>` : '') +
      (state.you === color ? ' <span class="you">you</span>' : '') +
      (rec.turn === color && !rec.outcome ? ' <span class="to-move">to move</span>' : '') +
      (lead > 0 ? ` <span class="lead" title="material lead">+${lead}</span>` : '') +
      (isBottom ? '<button id="flip" class="secondary flip" title="Flip the board">⇅ Flip board</button>' : '');
  };
  const bottom = orientation();
  $('player-bottom').innerHTML = bar(bottom, true);
  $('player-top').innerHTML = bar(other(bottom), false);
  $('flip').onclick = flip;
}

function lineTitle(node) {
  const owner = cardOwnerOf(node);
  if (node.kind === 'after' && owner) return `Variation · best play after ${mineOf(owner.card) ? 'your' : 'their'} move ${moveLabel(owner.rec, true)}${owner.rec.san}`;
  if (node.kind === 'best' && owner?.bestLine) return `Variation · better was ${moveLabel(owner.bestLine.rec, true)}${owner.bestLine.rec.san}`;
  if (node.kind === 'pass') {
    const first = firstOfLine(node);
    const who = first.rec.turn === (state.you || 'white') ? 'they skip their move' : 'you skip your move';
    return `Imagine ${who}: what the threat is`;
  }
  return 'Your own move';
}

function renderContext() {
  const node = state.node;
  const el = $('context');
  $('board-wrap').className = isVariation(node) ? `var-${node.kind}` : '';
  if (!isVariation(node)) {
    const m = node.moment;
    const where = node === state.root ? 'start position' : `after ${moveLabel(node.rec, true)}${node.rec.san}`;
    el.className = 'ctx-game';
    el.innerHTML = `<b>Game</b> · ${escapeHtml(where)}` +
      (m ? ` <span class="j-${m.judgement}">${GLYPH[m.judgement]} ${JUDGE[m.judgement]}</span>` : '');
    return;
  }
  const delta = node.rec.delta;
  el.className = `ctx-var ctx-${node.kind}`;
  el.innerHTML = `<b>${escapeHtml(lineTitle(node))}</b>` +
    (delta !== undefined && !(node.kind === 'pass' && delta === 0)
      ? ` · material for ${mineOf(cardOwnerOf(node)?.card) ? 'you' : 'them'} <span class="${delta < 0 ? 'neg' : delta > 0 ? 'pos' : ''}">${delta > 0 ? '+' : ''}${delta}</span> ${node.kind === 'pass' ? 'if the threat lands' : 'since before the move'}`
      : '');
}

function renderCaption() {
  const node = state.node;
  const cap = $('caption');
  let html = '';
  if (node.kind === 'pass') {
    html = escapeHtml(node.rec.caption || '');
  } else if (node.kind === 'after' || node.kind === 'best') {
    const L = node.line;
    html = (node.k === L.cashed ? (node.kind === 'best' ? '★ ' : '⚠ ') : '') + escapeHtml(node.rec.caption || '') +
      (node.k === L.end ? ' <b>The line has settled here.</b>' : node.k > L.end ? ' <span class="muted">(after the line settled)</span>' : '');
  } else if (node.moment) {
    const m = node.moment;
    const kind = m.isBest ? 'best' : node.card ? kindOf(node.card) : null;
    const mine = mineOf(node.card);
    html = (mine ? '' : '<span class="whose">Their move</span> ') +
      (m.judgement ? `<b class="j-${m.judgement}">${JUDGE[m.judgement]}.</b> ` : '') +
      (kind ? `<span class="kind kind-${kind}${mine ? '' : ' theirs'}">${kindLabel(node.card, kind)}</span> ` : '') +
      (m.isBest ? 'This is the engine’s top move.' : !node.card ? `Best was ${escapeHtml(m.bestSan)}.`
        : rich(kind === 'allowed' ? node.card.reasons?.lost || node.card.summary : node.card.summary));
  }
  cap.hidden = !html;
  cap.innerHTML = html;
}

// ---------- the move list (Lichess style) ----------

function moveSpan(node, opts = {}) {
  const el = document.createElement('span');
  const m = node.moment;
  const L = node.line;
  el.className = ['mv', node === state.node ? 'current' : '', m ? `j-${m.judgement}` : '',
    L && node.k > L.end ? 'extra' : '', L && node.k === L.cashed ? (node.kind === 'best' ? 'gain' : 'loss') : '',
    node.kind === 'user' ? 'user' : ''].filter(Boolean).join(' ');
  const isPass = node.rec.san === '(pass)';
  el.textContent = (opts.number && !isPass ? moveLabel(node.rec, opts.forceNumber) : '') + node.rec.san + (m ? GLYPH[m.judgement] || '' : '');
  if (isPass) el.classList.add('pass');
  if (node.rec.caption) el.title = node.rec.caption;
  el.onclick = () => show(node);
  return el;
}

// One variation, inline: "4… Qg5 5. Bxf7+ Kd8 6. O-O Qxe5 | 7. c3"
function renderInline(start) {
  const line = document.createElement('span');
  line.className = 'inline';
  let first = true;
  for (let n = start; n; n = n.children[0]) {
    line.appendChild(moveSpan(n, { number: true, forceNumber: first }));
    if (n.line && n.k === n.line.end && n.children.length) {
      line.insertAdjacentHTML('beforeend', '<span class="settle" title="material stops changing here">|</span>');
    }
    first = false;
    for (const alt of n.children.slice(1)) { // your own tries inside a variation
      if (alt.kind !== 'user') continue;
      const sub = document.createElement('div');
      sub.className = 'subvar';
      sub.appendChild(renderInline(alt));
      line.appendChild(sub);
    }
    if (n.card && n.kind === 'user') { // a try you asked to explain: its lines live in its comment
      line.appendChild(commentFor(n));
      break;
    }
  }
  return line;
}

function commentFor(node) {
  const m = node.moment;
  const c = document.createElement('div');
  c.className = `comment jb-${m.judgement || 'none'}`;
  if (!node.card) {
    c.innerHTML = `<b class="j-${m.judgement}">${JUDGE[m.judgement]}.</b> ${escapeHtml(m.bestSan)} was best.` +
      (m.pending ? ' <span class="muted">The explanation is being worked out; it appears here in a moment.</span>' : '');
    return c;
  }
  const r = node.card.reasons || {};
  const para = (label, text) => (text ? `<p><span class="rlabel">${label}</span> ${rich(text)}</p>` : '');
  const kind = m.isBest ? 'best' : kindOf(node.card);
  const mine = mineOf(node.card);
  const whose = mine ? '' : '<span class="whose">Their move</span> ';
  const head = m.isBest ? `<b>${escapeHtml(m.san)}</b> is the engine’s top move.`
    : `${whose}<b class="j-${m.judgement}">${JUDGE[m.judgement]}.</b> <span class="kind kind-${kind}${mine ? '' : ' theirs'}">${kindLabel(node.card, kind)}</span>`;
  c.innerHTML = `<div class="c-head">${node.kind === 'user' ? '<span class="muted">What if</span> ' : ''}${head}</div>` +
    `<p>${rich(node.card.summary)}</p>`; // card.llm (who worded it, fact-check counts) stays in the JSON, not on screen
  const lineRow = (label, start, cls) => {
    const row = document.createElement('div');
    row.className = `vline v-${cls}`;
    row.innerHTML = `<span class="vlabel">${label}</span>`;
    row.appendChild(renderInline(start));
    return row;
  };
  const section = (title, text, subs) => {
    const sec = document.createElement('div');
    sec.className = 'csec';
    sec.innerHTML = `<p><span class="rlabel">${title}</span> ${rich(text || '')}</p>`;
    const ul = document.createElement('div');
    ul.className = 'subs';
    for (const s of subs) if (s) ul.appendChild(s);
    sec.appendChild(ul);
    return sec;
  };
  // The other side of the story, after the lesson; open, and it can still be folded.
  const folded = (title, parts) => {
    const d = document.createElement('details');
    d.className = 'fold';
    d.open = true;
    d.innerHTML = `<summary>${title}</summary>`;
    for (const p of parts) if (p) d.appendChild(p);
    return d;
  };
  const textP = (text) => {
    if (!text) return null;
    const p = document.createElement('p');
    p.innerHTML = rich(text);
    return p;
  };
  const punishTitle = mine ? 'How they take advantage:' : 'How you can take advantage:';
  const missedTitle = mine ? 'What you missed:' : 'What they missed:';
  const howTheyPunish = () => section(punishTitle, r.lost || 'With the best replies the mover ends up worse off.', [
    node.afterLine && lineRow(`After ${mine ? 'your' : 'their'} move, best play:`, node.afterLine, 'after'),
    node.threatPass && lineRow(mine ? 'Their threat, if you had skipped a move:' : 'Your threat, if they had skipped a move:', node.threatPass, 'pass'),
  ]);
  const whatYouMissed = () => section(missedTitle, r.gaveUp, [
    node.bestLine && lineRow('Better was:', node.bestLine, 'best'),
    node.ideaPass && lineRow(`Its threat, if ${mine ? 'they' : 'you'} skipped a move:`, node.ideaPass, 'pass'),
  ]);
  // Material ends level: the clearest positional differences, feature terms in bold.
  const inThePosition = () => {
    if (!r.position) return null;
    const d = document.createElement('div');
    d.className = 'csec position';
    d.innerHTML = `<p><span class="rlabel">In the position:</span> ${rich(r.position)}</p>`;
    return d;
  };
  const addPosition = () => { const p = inThePosition(); if (p) c.appendChild(p); };
  if (kind === 'allowed') {
    c.appendChild(howTheyPunish());
    addPosition();
    c.appendChild(folded(`Instead: ${escapeHtml(m.bestSan)}`, [node.bestLine && lineRow('Better was:', node.bestLine, 'best'), textP(r.gaveUp)]));
  } else if (kind === 'missed') {
    c.appendChild(whatYouMissed());
    addPosition();
    c.appendChild(folded(`${mine ? 'Your' : 'Their'} move ${escapeHtml(m.san)}: what happens after it`, [textP(r.lost),
      node.afterLine && lineRow(`After ${mine ? 'your' : 'their'} move, best play:`, node.afterLine, 'after')]));
  } else {
    c.appendChild(section('After your move:', '', [node.afterLine && lineRow('Best play:', node.afterLine, 'after')]));
    c.appendChild(folded(`Next best: ${escapeHtml(m.bestSan)}`, [node.bestLine && lineRow('Line:', node.bestLine, 'best')]));
  }
  const actions = document.createElement('div');
  actions.className = 'card-actions';
  const btn = document.createElement('button');
  btn.className = 'secondary small';
  btn.textContent = 'Compare where both lines end';
  btn.onclick = () => openCompare(node);
  actions.appendChild(btn);
  if (node.kind !== 'user' && !m.isBest) {
    const ai = document.createElement('button');
    ai.className = 'small ai-btn';
    ai.textContent = '✦ Explain this with AI';
    ai.title = 'Ask the coach about this move (one coach question)';
    ai.onclick = (e) => { e.stopPropagation(); explainWithAi(node); };
    actions.appendChild(ai);
  }
  c.appendChild(actions);
  return c;
}

function renderMoves() {
  const box = $('moves');
  box.innerHTML = '';
  let row = null;
  const main = mainline();
  for (const node of main.slice(1)) {
    const { n, white } = moveNumber(node.rec.ply);
    if (white || !row) {
      row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<span class="num">${n}.</span>`;
      if (!white) row.insertAdjacentHTML('beforeend', '<span class="mv placeholder">…</span>');
      box.appendChild(row);
    }
    row.appendChild(moveSpan(node));
    const block = [];
    const m = node.moment;
    if (m && (node.card || !state.you || m.color === state.you)) block.push(commentFor(node)); // both sides now carry cards
    for (const alt of node.parent.children) {
      if (alt.kind !== 'user') continue;
      const d = document.createElement('div');
      d.className = 'vline v-user';
      d.appendChild(renderInline(alt));
      block.push(d);
    }
    if (block.length) {
      const wrap = document.createElement('div');
      wrap.className = 'block';
      block.forEach((b) => wrap.appendChild(b));
      box.appendChild(wrap);
      row = null; // the next move starts a fresh row, with "…" if it is Black's
    }
  }
  const last = main[main.length - 1];
  const tail = last.children.filter((c) => c.kind === 'user'); // your moves after the game's last move
  if (tail.length) {
    const d = document.createElement('div');
    d.className = 'block';
    for (const alt of tail) {
      const v = document.createElement('div');
      v.className = 'vline v-user';
      v.appendChild(renderInline(alt));
      d.appendChild(v);
    }
    box.appendChild(d);
  }
  if (last.rec.outcome) box.insertAdjacentHTML('beforeend', `<div class="result">${last.rec.outcome}</div>`);
  const current = box.querySelector('.mv.current');
  current?.scrollIntoView({ block: 'nearest' });
  // On a judged move, also bring its comment into view, up to the first line under it.
  const block = state.node.moment && current?.closest('.row')?.nextElementSibling;
  if (block?.classList.contains('block')) revealBelow(current, block.querySelector('.vline') || block);
}

// Scroll the move list so everything from `top` down to `bottom` shows, `top` winning if it can't all fit.
function revealBelow(top, bottom) {
  // The move list scrolls on its own on wide screens, together with the blunder list otherwise.
  const list = [$('moves'), $('study')].find((e) => getComputedStyle(e).overflowY === 'auto' && e.scrollHeight > e.clientHeight);
  if (!list) return;
  const box = list.getBoundingClientRect();
  const t = top.getBoundingClientRect().top, b = bottom.getBoundingClientRect().bottom;
  if (b > box.bottom) list.scrollTop += Math.min(b - box.bottom + 8, t - box.top - 4);
}

function renderMoments() {
  const sec = $('moments');
  const box = $('moments-body');
  const r = state.review;
  if (!r) { sec.hidden = true; return; }
  const all = r.moments.filter((m) => (m.card || m.pending) && (state.inaccuracies || m.judgement !== 'inaccuracy'));
  const mine = all.filter((m) => m.mine !== false);
  sec.hidden = false;
  const waiting = all.filter((m) => m.pending).length;
  if (waiting) {
    // Shown whole once every explanation (yours and theirs) is ready, so the list never shifts.
    const done = all.length - waiting;
    $('moments-title').textContent = `Explaining the mistakes in this game: ${done} of ${all.length}`;
    box.innerHTML = `<div class="moments-wait"><span class="pbar"><span class="pbar-fill" style="width:${Math.round(done / all.length * 100)}%"></span></span>` +
      `<span class="muted">The list appears when all ${all.length} are explained. You can step through the game meanwhile.</span></div>`;
    return;
  }
  $('moments-title').textContent = r.you
    ? `${state.inaccuracies ? 'Blunders, mistakes and inaccuracies' : 'Blunders and mistakes'}: yours (${mine.length}), theirs (${all.length - mine.length}) · click to jump`
    : `${state.inaccuracies ? 'Blunders, mistakes and inaccuracies' : 'Blunders and mistakes'} (${all.length}) · click to jump`;
  box.innerHTML = '';
  if (!all.length) box.insertAdjacentHTML('beforeend', '<div class="muted">None found. Clean game.</div>');
  for (const m of all) {
    const isMine = m.mine !== false;
    const { n, white } = moveNumber(m.index);
    const el = document.createElement('div');
    el.className = `moment j-${m.judgement}${isMine ? '' : ' theirs'}`;
    el.innerHTML = `<span class="mnum">${n}${white ? '.' : '…'}</span> <b>${escapeHtml(m.san)}${GLYPH[m.judgement]}</b> ` +
      `${chipFor(m, m.card)} ` +
      `<span class="muted">best ${escapeHtml(m.bestSan)}</span>`;
    el.onclick = () => show(mainline()[m.index]);
    box.appendChild(el);
  }
}

// ---------- phone layout: move strip, explanation panel, tabs ----------

const phone = window.matchMedia('(max-width: 820px)');

// The line you are on, start to end: the path to here plus what follows.
function renderStrip() {
  const box = $('strip');
  box.innerHTML = '';
  const line = pathTo(state.node);
  for (let n = state.node.children[0]; n; n = n.children[0]) line.push(n);
  let prevKind = 'game';
  line.forEach((n, i) => {
    const el = moveSpan(n, { number: true, forceNumber: i === 0 || n.kind !== prevKind });
    if (isVariation(n)) el.classList.add(`in-${n.kind}`);
    box.appendChild(el);
    prevKind = n.kind;
  });
  box.querySelector('.mv.current')?.scrollIntoView({ inline: 'center', block: 'nearest' });
}

// The explanation for where you are: this move, the move a variation belongs to,
// or the move about to be played from here.
function renderExplain() {
  const box = $('explain');
  box.innerHTML = '';
  const node = state.node;
  const owner = node.moment ? node : cardOwnerOf(node) || node.children.find((c) => c.card);
  if (owner?.moment) {
    box.appendChild(commentFor(owner));
    return;
  }
  const judged = mainline().filter((n) => n.card || n.moment?.pending);
  const waiting = judged.filter((n) => n.moment?.pending).length;
  if (waiting) {
    box.innerHTML = `<p class="muted">No mistake at this move. The list of mistakes appears when all ${judged.length} are explained ` +
      `(${judged.length - waiting} so far).</p>`;
    return;
  }
  box.innerHTML = judged.length
    ? '<p class="muted">No mistake at this move. Jump to one:</p>'
    : `<p class="muted">${state.review ? 'No blunders or mistakes in this game.' : 'Open a reviewed game in the Games tab.'}</p>`;
  for (const n of judged) {
    const m = n.moment;
    const el = document.createElement('div');
    el.className = `moment j-${m.judgement}`;
    el.innerHTML = `<b>${escapeHtml(moveLabel(n.rec, true) + m.san)}${GLYPH[m.judgement]}</b> ` +
      `${chipFor(m, n.card)} ` +
      `<span class="muted">best ${escapeHtml(m.bestSan)}</span>`;
    el.onclick = () => show(n);
    box.appendChild(el);
  }
}

function setSheet(name) {
  document.body.dataset.sheet = name;
  document.querySelectorAll('#sheet-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.sheet === name));
}

// Keep the account-first introduction above the board at every screen size.
// Only the saved-games list and settings move into tabs on narrow screens.
function placeLoader() {
  $('paste-game').appendChild($('loader'));
  if (phone.matches) $('games').prepend($('mygames-wrap'));
  else $('header-actions').prepend($('mygames-wrap'));
  $('mygames').hidden = !phone.matches;
  if (phone.matches) { $('settings-sheet').appendChild($('settings')); $('settings').hidden = false; }
  else { $('settings-wrap').appendChild($('settings')); $('settings').hidden = true; }
  // the chat sits under the board on wide screens, and in its own tab on a phone
  if (phone.matches) document.querySelector('aside').appendChild($('chat'));
  else $('board-col').appendChild($('chat'));
  document.body.classList.toggle('phone', phone.matches);
}

document.querySelectorAll('#sheet-tabs button').forEach((b) => (b.onclick = () => setSheet(b.dataset.sheet)));
phone.addEventListener('change', placeLoader);

// ---------- compare ----------

function openCompare(node) {
  const c = node.card;
  if (!c) return;
  if (state.node !== node && !isVariation(state.node)) show(node);
  state.compare = node;
  const endOf = (line) => line.plies[line.end - 1] || c.start;
  cg.setAutoShapes([]); // arrows are drawn on the next frame, when the hidden board measures 0 wide
  $('board').hidden = true;
  $('compare').hidden = false;
  for (const [mini, rec] of [[miniA, endOf(c.lineA)], [miniB, endOf(c.lineB)]]) {
    mini.set({ fen: rec.fen, orientation: orientation(), lastMove: rec.lastMove || undefined, check: rec.check });
    mini.redrawAll();
  }
  const sign = (x) => (x > 0 ? '+' : '') + x;
  const cls = (x) => (x < 0 ? 'neg' : x > 0 ? 'pos' : '');
  $('cmpAcap').innerHTML = `<b>After your move</b> ${escapeHtml(node.moment.san)} · material <span class="${cls(c.lineA.delta)}">${sign(c.lineA.delta)}</span>`;
  $('cmpBcap').innerHTML = `<b>After the best move</b> ${escapeHtml(node.moment.bestSan)} · material <span class="${cls(c.lineB.delta)}">${sign(c.lineB.delta)}</span>`;
  $('context').className = 'ctx-var';
  $('context').innerHTML = `<b>Compare</b> · where both lines settle · difference ${sign(c.lineB.delta - c.lineA.delta)} for the best move · <button id="close-compare" class="secondary small">Close</button>`;
  $('close-compare').onclick = () => show(state.node);
  $('caption').hidden = false;
  $('caption').innerHTML = rich(c.summary);
}

// ---------- moving pieces ----------

const sameMove = (rec, uci) => rec?.uci && rec.uci.slice(0, 4) === uci.slice(0, 4);

async function playUci(uci) {
  const from = state.node;
  const existing = from.children.find((c) => sameMove(c.rec, uci));
  if (existing) { show(existing); return existing; }
  const rec = await api('/api/move', { fen: from.rec.fen, uci });
  const node = makeNode(rec, from, 'user');
  show(node);
  return node;
}

async function onUserMove(orig, dest) {
  const from = state.node;
  try {
    const node = await playUci(orig + dest);
    if ($('whatif').checked && node.kind === 'user' && !node.card) await explainTry(node, from);
  } catch (e) { showError(e.message); show(state.node); }
}

async function explainTry(node, from) {
  showError('');
  $('progress').textContent = 'Explaining your move…';
  try {
    const m = await api('/api/whatif', { fen: from.rec.fen, uci: node.rec.uci });
    attachCard(node, m);
    if (state.node === node) show(node);
    else renderMoves();
  } catch (e) {
    showError(e.message);
  } finally {
    $('progress').textContent = '';
  }
}

async function playPvUpTo(k) {
  const pv = state.analysis?.pvUci || [];
  try { for (let i = 0; i <= k && i < pv.length; i++) await playUci(pv[i]); } catch (e) { showError(e.message); }
}

// ---------- engine ----------

let debounce = null;
function requestAnalysis(fen) {
  clearTimeout(debounce);
  state.abort?.abort();
  state.analysis = null;
  const cached = state.cache.get(fen);
  if (cached) { renderAnalysis(cached); return; }
  $('score').textContent = '…';
  $('depth').textContent = '';
  $('pv').innerHTML = ''; // never show the previous position's line under this one
  debounce = setTimeout(async () => {
    const seq = ++state.seq;
    state.abort = new AbortController();
    try {
      const res = await api('/api/analyse', { fen, movetime_ms: 700 }, state.abort.signal);
      state.cache.set(fen, res);
      if (seq === state.seq && state.node.rec.fen === fen) renderAnalysis(res);
    } catch (e) {
      if (e.name !== 'AbortError') showError('Engine: ' + e.message);
    }
  }, 120);
}

function formatScore(res) {
  if (res.gameOver) return res.gameOver;
  if (res.mate !== null && res.mate !== undefined) return (res.mate > 0 ? '#' : '#-') + Math.abs(res.mate);
  const v = res.cp / 100;
  return (v > 0 ? '+' : '') + v.toFixed(2);
}

function renderAnalysis(res) {
  state.analysis = res;
  const score = formatScore(res);
  $('score').textContent = score;
  $('depth').textContent = res.depth ? `depth ${res.depth}` : '';
  if (res.engine) $('engine-name').textContent = res.engine;

  const wc = res.gameOver ? (res.gameOver === '1-0' ? 1 : res.gameOver === '0-1' ? -1 : 0) : res.wc;
  const bar = $('evalbar');
  bar.classList.toggle('flipped', orientation() === 'black');
  bar.classList.toggle('black-better', wc < 0);
  $('evalbar').style.setProperty('--wcp', `${((wc + 1) / 2) * 100}%`);
  $('evaltext').textContent = res.gameOver ? '' : res.mate != null ? 'M' + Math.abs(res.mate) : Math.abs(res.cp / 100).toFixed(1);

  const pv = $('pv');
  pv.innerHTML = '';
  (res.pv || []).forEach((san, i) => {
    const ply = res.startPly + i;
    const white = ply % 2 === 0;
    const n = Math.floor(ply / 2) + 1;
    if (white) pv.insertAdjacentText('beforeend', `${n}. `);
    else if (i === 0) pv.insertAdjacentText('beforeend', `${n}… `);
    const m = document.createElement('span');
    m.className = 'm';
    m.textContent = san;
    m.onclick = () => playPvUpTo(i);
    pv.appendChild(m);
    pv.insertAdjacentText('beforeend', ' ');
  });
  // The engine's arrow only where the board has no explanation of its own.
  if (!state.compare && !shapesFor(state.node).length && res.best) {
    cg.setAutoShapes([{ orig: res.best.slice(0, 2), dest: res.best.slice(2, 4), brush: 'paleBlue' }]);
  }
}

// ---------- chat ----------

const chat = { history: [], busy: false };

function numbered(nodes) {
  return nodes.map((n, i) => moveLabel(n.rec, i === 0) + n.rec.san + (n.moment ? GLYPH[n.moment.judgement] || '' : '')).join(' ');
}

function pathTo(node) {
  const out = [];
  for (let n = node; n && n.parent; n = n.parent) out.unshift(n);
  return out;
}

function lineForChat(start) {
  const out = [];
  for (let n = start; n; n = n.children[0]) {
    out.push({ move: moveLabel(n.rec, out.length === 0) + n.rec.san, what_happens: n.rec.caption || '',
               material_change_for_you: n.rec.delta, settled_here: !!(n.line && n.k === n.line.end) });
    if (n.line && n.k >= n.line.end) break;
  }
  return out;
}

function explanationFor(node) {
  const owner = node.card ? node : cardOwnerOf(node) || node.children.find((c) => c.card);
  if (!owner?.card) return null;
  const m = owner.moment, c = owner.card;
  return {
    move: moveLabel(owner.rec, true) + m.san, judgement: m.judgement || null, best_move: m.bestSan, is_engine_top_move: !!m.isBest,
    kind_of_wrong: m.isBest ? 'none' : kindOf(c) === 'allowed' ? 'your move gives them a chance (explain how they take advantage)'
      : 'missed chance (explain why the best move is better)',
    summary: c.summary, what_your_move_allowed: c.reasons?.lost, what_the_best_move_gives: c.reasons?.gaveUp,
    why_that_idea_disappeared: c.reasons?.gone,
    nature_of_the_gap: natureOf(c), positional_differences_where_the_lines_end: c.reasons?.position || null,
    line_after_your_move: [{ move: moveLabel(owner.rec, true) + owner.rec.san, what_happens: owner.annot?.caption || '' },
      ...(owner.afterLine ? lineForChat(owner.afterLine) : [])],
    line_with_best_move: owner.bestLine ? lineForChat(owner.bestLine) : [],
    best_moves_threat_if_they_skip_a_move: owner.ideaPass ? lineForChat(owner.ideaPass) : null,
    their_threat_before_your_move_if_you_skip_a_move: owner.threatPass ? lineForChat(owner.threatPass) : null,
  };
}

function chatContext() {
  const node = state.node;
  const h = state.headers;
  const you = state.you || 'white';
  const shown = [];
  for (const src of annotationsOf(node)) {
    for (const an of src.annotations || []) if (an.label) shown.push(`${an.label} on ${an.square}`);
    for (const ar of src.arrows || []) shown.push(`${ar.kind} arrow ${ar.from}->${ar.to}`);
  }
  const a = state.analysis && state.analysis.fen === node.rec.fen ? state.analysis : null;
  const pov = (x) => (you === 'white' ? x : -x);
  return {
    you,
    players: { white: `${h.White || 'White'}${h.WhiteElo ? ' (' + h.WhiteElo + ')' : ''}`, black: `${h.Black || 'Black'}${h.BlackElo ? ' (' + h.BlackElo + ')' : ''}` },
    result: h.Result || null,
    game_moves: numbered(mainline().slice(1)),
    judged_moves: mainline().filter((n) => n.moment).map((n) =>
      `${moveLabel(n.rec, true)}${n.rec.san}${GLYPH[n.moment.judgement] || ''} (${n.moment.color}, ${n.moment.judgement}; best ${n.moment.bestSan})`),
    board_now: {
      fen: node.rec.fen,
      where: $('context').innerText,
      is_the_real_game: !isVariation(node),
      moves_from_start: numbered(pathTo(node)),
      side_to_move: node.rec.turn,
      caption_under_board: $('caption').hidden ? null : $('caption').innerText,
      marks_on_board: shown,
    },
    explanation: explanationFor(node),
    engine_now: a && !a.gameOver ? {
      eval_for_you: a.mate != null ? `mate in ${pov(a.mate)}` : (pov(a.cp) / 100).toFixed(2),
      best_line: (a.pv || []).join(' '),
    } : null,
  };
}

function renderChatText(t) {
  return escapeHtml(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
}

function addMsg(role, text, extra = {}) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.innerHTML = (extra.where ? `<div class="where">${escapeHtml(extra.where)}</div>` : '') + renderChatText(text) +
    (extra.tools?.length ? `<div class="meta">checked with: ${extra.tools.map((t) => t.tool.replace('_', ' ')).join(', ')}</div>` : '') +
    (extra.unchecked?.length ? `<div class="warn">⚠ not checked against the engine: ${escapeHtml(extra.unchecked.join(', '))}</div>` : '');
  $('chat-log').appendChild(el);
  $('chat-log').scrollTop = $('chat-log').scrollHeight;
}

// "Like it?": a star on GitHub, from config.json; hidden while github_url is not set.
function showSupport() {
  const links = [['support-star', appConfig.github_url]];
  for (const [id, url] of links) {
    const ok = typeof url === 'string' && /^https:\/\//.test(url);
    $(id).hidden = !ok;
    if (ok) $(id).href = url;
  }
  $('support').hidden = links.every(([id]) => $(id).hidden);
  for (const [id, from] of [['about-star', 'support-star']]) {
    $(id).hidden = $(from).hidden;
    $(id).href = $(from).href;
  }
}

// The version of the app files (what the service worker installed), for "About", and the GPL source
// link: the open repo's tag site-<version> holds exactly this version (scripts/release_site.py).
async function showVersion() {
  try {
    const text = await (await fetch('/sw.js')).text();
    const v = /VERSION = "([^"]+)"/.exec(text)?.[1];
    const b = /const BUILT = (\{[^;\n]*\});/.exec(text);
    const stamp = b ? JSON.parse(b[1]) : null;
    // the commit time in your own time zone, to the minute, and its id, so you can find the diff
    const when = stamp && new Date(stamp.time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    if (v) $('about-version').textContent = stamp ? `version ${when} · commit ${stamp.commit}${stamp.local ? ' + local changes' : ''} (${v})` : `version ${v}`;
    const repo = typeof appConfig.github_url === 'string' && /^https:\/\//.test(appConfig.github_url) ? appConfig.github_url.replace(/\/+$/, '') : null;
    if (repo && v) {
      $('about-source').href = `${repo}/tree/site-${v}`;
      $('about-source').title = 'View source for this version on GitHub (GPL-3.0)';
    } else {
      $('about-source').removeAttribute('href');
      $('about-source').removeAttribute('title');
    }
  } catch (e) { /* offline before the first install */ }
}

function showPlusCard() {
  $('coach-plus-badge').hidden = !backend.local;
  if (coachMode()) {
    $('chat-plus').hidden = account.paid();
    $('chat-plus-signin').hidden = account.signedIn();
    $('chat-plus-soon').hidden = true;
    $('chat-plus-link').hidden = true;
    return;
  }
  if (!freePlan()) return;
  $('chat-plus').hidden = false;
  if (appConfig.upgrade_url) {
    $('chat-plus-link').href = appConfig.upgrade_url;
    $('chat-plus-link').hidden = false;
    $('chat-plus-soon').hidden = true;
  }
}

// In the free app a question gets a short pointer to the coach, not an error.
function answerFreePlan(text) {
  addMsg('user', text, { where: $('context').innerText });
  $('chat-input').value = '';
  const msg = 'That is a question for the coach, which is part of the paid plan. ' +
    (coachMode() ? (account.signedIn() ? 'Subscribe from the account button at the top to ask it.' : 'Sign in from the button at the top to ask it.')
      : appConfig.upgrade_url ? 'It answers in plain words and checks every move with the engine.' : 'It is coming soon.');
  addMsg('assistant', msg);
  if (appConfig.upgrade_url) {
    const a = $('chat-plus-link').cloneNode(true);
    a.removeAttribute('id');
    $('chat-log').lastElementChild.appendChild(document.createElement('br'));
    $('chat-log').lastElementChild.appendChild(a);
  }
}

const TOOL_LABEL = { engine_analyse: 'the engine', play_moves: 'the line', move_facts: 'what the move does', threats: 'the threats' };

// The paid coach: one call per round; the server asks for engine tools, this device runs them.
async function askCoach(history, context) {
  const question_id = crypto.randomUUID().replace(/-/g, '');
  const steps = [], tools = [];
  for (;;) {
    const r = await account.api('POST', '/v1/coach', { question_id, history, context, steps });
    if (r.status === 'done') return { reply: r.reply, unchecked: r.unchecked, tools };
    const results = [];
    for (const u of r.tool_uses) {
      $('chat-status').textContent = `Checking ${TOOL_LABEL[u.name] || 'with the engine'}…`;
      try {
        const out = await backend.local.runCoachTool(u.name, u.input, context.you, backend.local.coachEvaluator());
        results.push({ tool_use_id: u.id, content: JSON.stringify(out), is_error: false });
        tools.push({ tool: u.name, input: u.input, error: false });
      } catch (e) {
        results.push({ tool_use_id: u.id, content: `Error: ${e.message}`, is_error: true });
        tools.push({ tool: u.name, input: u.input, error: true });
      }
    }
    steps.push({ assistant: r.assistant, tool_results: results });
  }
}

async function sendChat(text) {
  text = (text || '').trim();
  if (!text || chat.busy) return;
  if (freePlan() || (coachMode() && !account.paid())) { answerFreePlan(text); return; }
  chat.busy = true;
  addMsg('user', text, { where: $('context').innerText });
  chat.history.push({ role: 'user', text });
  $('chat-input').value = '';
  $('chat-status').textContent = 'Thinking, and checking with the engine…';
  try {
    const r = coachMode() ? await askCoach(chat.history, chatContext())
      : await api('/api/chat', { history: chat.history, context: chatContext() });
    if (coachMode()) account.refreshMe();
    chat.history.push({ role: 'assistant', text: r.reply });
    addMsg('assistant', r.reply, r);
    $('chat-count').textContent = `(${chat.history.length / 2} question${chat.history.length > 2 ? 's' : ''})`;
  } catch (e) {
    chat.history.pop();
    addMsg('assistant', e.message);
  } finally {
    chat.busy = false;
    $('chat-status').textContent = '';
  }
}

// "Explain this with AI": the coach, asked about this card's move; one coach question. It replaced
// the LLM rewording of the cards (2026-10-23): one paid feature, one quota.
function explainWithAi(node) {
  if (state.node !== node) show(node);
  if (phone.matches) setSheet('chat');
  const m = node.moment;
  const what = JUDGE[m.judgement];
  sendChat(what ? `Explain ${m.san} simply: why is it a ${what.toLowerCase()}, and what was better?`
    : `Explain ${m.san} simply: what does it do, and was there something better?`);
}

// ---------- the account (only with a backend in config.json) ----------

function renderPlan() {
  const me = account.info();
  const signed = account.signedIn();
  $('plan-out').hidden = signed;
  $('plan-in').hidden = !signed;
  if (signed && me) {
    $('plan-who').textContent = me.email || '';
    $('plan-usage').textContent = me.owner ? 'Owner account: no limits.'
      : `${me.active ? `Coach plan (${me.plan || 'monthly'})` : 'No plan yet'}. This month: ${me.usage.coach} of ${me.quota.coach} coach questions.`;
    $('plan-buy').hidden = me.active;
    const price = (plan, fallback) => appConfig.plans?.[plan] ? `${fallback} · ${appConfig.plans[plan]}` : fallback;
    $('plan-monthly').textContent = price('monthly', 'Subscribe monthly');
    $('plan-annual').textContent = price('annual', 'Subscribe yearly');
    $('plan-manage-row').hidden = !me.active || me.owner;
  }
  showPlusCard();
  if (state.node) renderExplain();
}

function togglePlan() {
  toggleSettings(true);
}

const planStatus = (t) => { $('plan-status').textContent = t || ''; };

async function planStep(fn, busyText, doneText = '') {
  planStatus(busyText);
  try {
    const out = await fn();
    planStatus(typeof doneText === 'function' ? doneText(out) : doneText);
  } catch (e) {
    planStatus(e.message);
  }
}

$('chat-plus-signin').onclick = () => { togglePlan(); $('plan-email').focus(); };
$('plan-send').onclick = () => planStep(async () => {
  await account.sendCode($('plan-email').value);
  $('plan-code-row').hidden = false;
  $('plan-code-actions').hidden = false;
  $('plan-code').focus();
}, 'Sending…', 'We emailed you a code.');
$('plan-enter').onclick = () => planStep(async () => {
  await account.enterCode($('plan-code').value);
  $('plan-code').value = '';
  $('plan-code-row').hidden = true;
  $('plan-code-actions').hidden = true;
}, 'Signing in…');
$('plan-monthly').onclick = () => planStep(() => account.subscribe('monthly'), 'Opening the checkout…');
$('plan-annual').onclick = () => planStep(() => account.subscribe('annual'), 'Opening the checkout…');

// Back from the checkout (/pay sends you to /?paid=1): the plan switches on when Paddle's webhook
// reaches the service, usually within seconds; until then, "Activating…".
async function afterCheckout() {
  if (new URLSearchParams(location.search).get('paid') !== '1' || !account.signedIn()) return;
  history.replaceState(null, '', location.pathname);
  togglePlan();
  for (let i = 0; i < 20; i++) {
    planStatus('Activating your plan…');
    if ((await account.refreshMe())?.active) { planStatus('Your plan is active. Thank you!'); return; }
    await new Promise((r) => setTimeout(r, 3000));
  }
  planStatus('The payment is still being confirmed. It shows here once it is; reload in a minute.');
}
$('plan-manage').onclick = () => planStep(() => account.manage(), 'Opening…');
$('plan-signout').onclick = () => planStep(() => account.signOut());
$('plan-delete').onclick = () => {
  if (!confirm('Delete your account? This cancels your subscription and deletes everything stored for you on the service. ' +
               'The reviews on this device stay.')) return;
  planStep(() => account.deleteAccount(), 'Deleting…', 'Your account is deleted.');
};

function resetChat() {
  chat.history = [];
  $('chat-log').innerHTML = '';
  $('chat-count').textContent = '';
}

// The moments list folds to its title bar; the choice is remembered.
function setFold(id, open) {
  const sec = $(id);
  sec.classList.toggle('collapsed', !open);
  const btn = $(`${id}-toggle`);
  btn.setAttribute('aria-expanded', String(open));
  btn.querySelector('.chev').textContent = open ? '▾' : '▸';
  localStorage.setItem(`${id}Open`, open ? '1' : '0');
}

function initFold(id, defaultOpen, onOpen) {
  const stored = localStorage.getItem(`${id}Open`);
  $(`${id}-toggle`).onclick = () => {
    const open = $(id).classList.contains('collapsed');
    setFold(id, open);
    if (open) onOpen?.();
  };
  setFold(id, stored === null ? defaultOpen : stored === '1');
}

initFold('moments', true);

$('chat-send').onclick = () => sendChat($('chat-input').value);
$('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat($('chat-input').value); }
});
document.querySelectorAll('#chat-suggest .chip').forEach((b) => (b.onclick = () => sendChat(b.textContent)));

// ---------- controls ----------

function flip() {
  state.flipped = !state.flipped;
  const comparing = state.compare;
  show(state.node);
  if (comparing) openCompare(comparing);
  if (state.analysis) renderAnalysis(state.analysis);
}

function firstOfLine(node) {
  let n = node;
  while (n.parent && n.parent.kind === node.kind) n = n.parent;
  return n;
}

function nav(action) {
  if (state.compare) { show(state.node); return; } // any navigation closes Compare first
  const node = state.node;
  if (action === 'prev' && node.parent) show(node.parent);
  else if (action === 'next' && node.children[0]) show(node.children[0]);
  else if (action === 'start') show(isVariation(node) ? firstOfLine(node) : state.root);
  else if (action === 'end') { let n = node; while (n.children[0]) n = n.children[0]; show(n); }
}

function toGame() {
  if (state.compare) { show(state.node); return; }
  if (isVariation(state.node)) show(nearestGameNode(state.node));
}

document.querySelectorAll('[data-nav]').forEach((b) => (b.onclick = () => nav(b.dataset.nav)));
$('to-game').onclick = toGame;
$('load').onclick = () => load($('input').value);
$('review').onclick = startReview;
$('account-form').onsubmit = async (e) => {
  e.preventDefault();
  const lichess = $('user').value.trim(), chesscom = $('user-cc').value.trim();
  if (!lichess && !chesscom) {
    $('account-status').textContent = 'Enter a Lichess or chess.com username to find your games.';
    $('user').focus();
    return;
  }
  $('find-games').disabled = true;
  $('account-status').textContent = 'Finding your recent games…';
  try {
    const cfg = await saveSettings({ lichess_user: lichess, chesscom_user: chesscom });
    if (!cfg) { $('account-status').textContent = $('error').textContent; return; }
    localStorage.setItem('user', lichess);
    localStorage.setItem('userCc', chesscom);
    $('accounts-title').textContent = 'Your game accounts';
    $('auto-review-option').hidden = false;
    recent.loaded = false;
    await refreshLichessGames(true);
    $('account-status').textContent = recent.offline ? 'Could not fetch games. Check your connection and try again.'
      : recent.errors.length ? recent.errors.join(' ')
      : recent.games.length ? 'Choose a game below, then press Review. Your usernames are saved on this device.'
      : 'No recent games found. Check your usernames or paste a game instead.';
    toggleMyGames(true);
    if (phone.matches) setSheet('games');
  } finally { $('find-games').disabled = false; }
};
$('edit-accounts').onclick = () => {
  if (phone.matches) setSheet('explain');
  else toggleSettings(false);
  $('account-setup').open = true;
  $('account-setup').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('user').focus({ preventScroll: true });
};
$('settings-btn').onclick = () => toggleSettings();
$('settings-done').onclick = () => (phone.matches ? setSheet('explain') : toggleSettings(false));
$('inaccuracies').onchange = async (e) => {
  e.target.blur();
  const cfg = await saveSettings({ explain_inaccuracies: e.target.checked });
  if (!cfg) { e.target.checked = !e.target.checked; return; }
  state.inaccuracies = !!cfg.explain_inaccuracies;
  if (state.review) {
    const at = state.node?.rec?.ply ?? 0;
    await openReview(state.review.id);
    const n = mainline()[at];
    if (n) show(n);
  }
};
document.addEventListener('pointerdown', (e) => {
  if (!phone.matches && !$('settings').hidden && !$('settings-wrap').contains(e.target)) toggleSettings(false);
});
$('autosync').onchange = async (e) => {
  e.target.blur();
  const cfg = await saveSettings({ lichess_user: $('user').value.trim(), chesscom_user: $('user-cc').value.trim(), auto_sync: e.target.checked });
  if (!cfg) { e.target.checked = !e.target.checked; return; }
  if (cfg.auto_sync) startSync(); // turning it on reviews your newest game now
};
// ---------- My games: your recent online games; you pick which to review ----------

const picked = new Set();     // unreviewed games ticked for "Review selected"
const batch = { running: false };

function renderMyGames() {
  const box = $('mygames-list');
  if (!box) return;
  const reviews = state.reviews || [];
  const reviewed = new Map(reviews.map((r) => [r.id, r]));
  const hasName = $('user').value.trim() || $('user-cc').value.trim();
  const section = (text) => box.insertAdjacentHTML('beforeend', `<div class="mg-section">${text}</div>`);
  const note = (text) => box.insertAdjacentHTML('beforeend', `<p class="muted acc-help">${text}</p>`);
  const counts = (r) => `<span class="counts"><span class="j-blunder">${r.blunders}??</span> <span class="j-mistake">${r.mistakes}?</span> ✓</span>`;
  const open = (id) => async () => { toggleMyGames(false); await openReview(id); if (phone.matches) setSheet('explain'); };
  box.innerHTML = '';
  const shown = new Set();

  if (!hasName) note('Enter your Lichess or chess.com username above and press Find my games.');
  else if (!recent.loaded) note(recent.offline ? 'Could not reach Lichess or chess.com. Are you online?' : 'Fetching your recent games…');
  else if (!recent.games.length) note('No games found for that username yet.');
  if (recent.games.length) {
    section('Recent on Lichess / chess.com');
    if (recent.errors.length) note(escapeHtml(recent.errors.join(' ')));
    for (const g of recent.games) {
      shown.add(g.id);
      const r = reviewed.get(g.id);
      const row = document.createElement('div');
      row.className = `mg-row${r ? ' reviewed' : ''}${state.review?.id === g.id ? ' current' : ''}`;
      row.dataset.id = g.id;
      const day = (g.played || '').split(' ')[0];
      const vs = g.opponent ? `vs <b>${escapeHtml(g.opponent)}</b>` : `<b>${escapeHtml(g.white)}</b> vs <b>${escapeHtml(g.black)}</b>`;
      const outcome = g.outcome ? ` · <span class="mg-${g.outcome}">${g.outcome}</span>` : '';
      row.innerHTML = `<span class="mg-check">${r ? '' : `<input type="checkbox" ${picked.has(g.id) ? 'checked' : ''} ${batch.running ? 'disabled' : ''} aria-label="Select this game">`}</span>` +
        `<span class="mg-what"><span class="site-tag ${siteClass(g.site)}">${escapeHtml(g.site)}</span> ${vs}${outcome}` +
        `<span class="mg-when muted">${escapeHtml([g.speed, day].filter(Boolean).join(' · '))}</span></span>` +
        (r ? counts(r) : `<button class="secondary mg-one" ${batch.running ? 'disabled' : ''}>Review</button>`);
      if (r) row.onclick = open(g.id);
      else {
        row.querySelector('input').onchange = (e) => { e.target.checked ? picked.add(g.id) : picked.delete(g.id); renderMyGamesFoot(); };
        row.querySelector('.mg-one').onclick = () => reviewBatch([g.id]);
      }
      box.appendChild(row);
    }
  }

  const others = reviews.filter((r) => !shown.has(r.id));
  if (others.length) {
    section(recent.games.length ? 'Other reviews' : 'Your reviews');
    for (const r of others) {
      const row = document.createElement('div');
      row.className = `mg-row reviewed${state.review?.id === r.id ? ' current' : ''}`;
      row.dataset.id = r.id;
      const day = (r.played || r.date || '').split(' ')[0];
      const when = /\d/.test(day) ? day.replace(/\.\?+/g, '') : '';
      row.innerHTML = `<span class="mg-check"></span><span class="mg-what"><span class="site-tag ${siteClass(siteOf(r))}">${escapeHtml(siteOf(r))}</span> ` +
        `<b>${escapeHtml(r.white)}</b> vs <b>${escapeHtml(r.black)}</b><span class="mg-when muted">${escapeHtml([r.result, when].filter(Boolean).join(' · '))}</span></span>` +
        counts(r);
      row.onclick = open(r.id);
      box.appendChild(row);
    }
  } else if (!recent.games.length && !reviews.length) {
    note('No reviewed games yet. Find your games using a username, or use “Or, you can also paste a game”.');
  }
  renderMyGamesFoot();
}

function renderMyGamesFoot() {
  for (const id of [...picked]) if ((state.reviews || []).some((r) => r.id === id)) picked.delete(id);
  const btn = $('mygames-review');
  btn.disabled = batch.running || !picked.size;
  btn.textContent = batch.running ? 'Reviewing…' : picked.size ? `Review ${picked.size} selected` : 'Review selected';
  const open = recent.games.filter((g) => !(state.reviews || []).some((r) => r.id === g.id));
  $('mygames-newest').hidden = !open.length || batch.running;
}

function toggleMyGames(open = $('mygames').hidden) {
  if (phone.matches) open = true; // on a phone the list is the Games tab itself
  $('mygames').hidden = !open;
  $('sync').setAttribute('aria-expanded', String(open));
  if (open) {
    renderMyGames();
    if (!recent.loaded) refreshLichessGames(true);
  }
}

// The newest 5 games you haven't reviewed, skipping the ones you have.
function pickNewest(n = 5) {
  picked.clear();
  const done = new Set((state.reviews || []).map((r) => r.id));
  for (const g of recent.games) {
    if (picked.size >= n) break;
    if (!done.has(g.id)) picked.add(g.id);
  }
  renderMyGames();
}

// Reviews run one after another; each finished game shows ✓ in the list at once, so you can
// open it while the rest continue. At the end the first one opens, unless you moved on.
async function reviewBatch(ids) {
  if (batch.running || !ids.length) return;
  batch.running = true;
  picked.clear();
  renderMyGames();
  const startedOn = state.review?.id ?? null;
  let first = null;
  try {
    for (let i = 0; i < ids.length; i++) {
      const prefix = ids.length > 1 ? `Game ${i + 1} of ${ids.length}: ` : '';
      let job;
      try { ({ job } = await api('/api/recent/review', { id: ids[i] })); } catch (e) { showError(e.message); continue; }
      for (;;) {
        let s;
        try { s = await api('/api/review/status', { job }); } catch (e) { showError(e.message); break; }
        if (s.state === 'done') { first ??= s.id; break; }
        if (s.state === 'error') { showError('Review failed: ' + s.error); break; }
        setProgress(`${prefix}judging the moves${s.total ? `: ${s.done} of ${s.total}` : ''}…`, (i + (s.total ? s.done / s.total : 0)) / ids.length);
        await new Promise((r) => setTimeout(r, 800));
      }
      await refreshReviews();
    }
  } finally {
    batch.running = false;
    setProgress('');
    renderMyGames();
  }
  if (first && (state.review?.id ?? null) === startedOn) openReview(first);
}

$('sync').onclick = () => toggleMyGames();
$('mygames-refresh').onclick = () => { recent.loaded = false; renderMyGames(); refreshLichessGames(true); };
$('mygames-newest').onclick = () => pickNewest(5);
$('mygames-review').onclick = () => reviewBatch(recent.games.map((g) => g.id).filter((id) => picked.has(id)));
document.addEventListener('pointerdown', (e) => {
  if (!$('mygames').hidden && !$('mygames-wrap').contains(e.target) && !phone.matches) toggleMyGames(false);
});
// What if is on unless you turned it off (it costs only engine time on this device, no LLM).
$('whatif').checked = localStorage.getItem('whatif') !== '0';
$('whatif').onchange = (e) => { localStorage.setItem('whatif', e.target.checked ? '1' : '0'); e.target.blur(); };
document.addEventListener('keydown', (e) => {
  // Text fields keep their keys; checkboxes and buttons do not.
  const t = e.target;
  if (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t.tagName === 'INPUT' && t.type !== 'checkbox')) return;
  const map = { ArrowLeft: 'prev', ArrowRight: 'next', Home: 'start', End: 'end' };
  if (map[e.key]) { e.preventDefault(); nav(map[e.key]); } // the only keyboard shortcuts: navigation
});

init();
