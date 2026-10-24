// Monkey test for the board page: random taps, keys, drags and screen sizes, with the
// page's invariants checked after every action. Runs the page in phone mode (in-page
// backend, Stockfish WebAssembly) from a local static server, with the test reviews imported.
//
//   npm run test:ui                        # 3 seeds x 3 screens x 150 actions
//   node test/ui/monkey.mjs --seed 7 --actions 400 --screens phone
//
// Needs Chrome or Edge (CHROME_PATH to override). A failure prints the seed, the screen
// and the last actions, so `--seed N --screens S` replays it exactly.
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WEB = join(HERE, '..', '..', '..', 'web');
// reviews-public.json: famous games (scripts/export_parity_fixtures.py --public), always there;
// reviews.json: two of your own, only in the closed repo.
const REVIEWS = ['reviews-public.json', 'reviews.json'].filter((f) => existsSync(join(HERE, f)))
  .flatMap((f) => JSON.parse(readFileSync(join(HERE, f), 'utf-8')));
// a short game to paste and review (Légal's mate, a famous public game)
const SAMPLE = readFileSync(join(HERE, '..', 'public-games', 'legal-1750.pgn'), 'utf8');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const SEEDS = arg('seed', '1,2,3').split(',').map(Number);
const ACTIONS = Number(arg('actions', 150));
const SCREENS = {
  desktop: { width: 1400, height: 900, isMobile: false, hasTouch: false },
  wide: { width: 2000, height: 1000, isMobile: false, hasTouch: false },
  ipad: { width: 810, height: 1080, isMobile: true, hasTouch: true },
  'ipad-landscape': { width: 1080, height: 810, isMobile: true, hasTouch: true },
  phone: { width: 390, height: 844, isMobile: true, hasTouch: true },
};
const screens = arg('screens', Object.keys(SCREENS).join(',')).split(',');

function findChrome() {
  const candidates = [process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find((p) => p && existsSync(p));
}

// ---------- a static server for web/, like Cloudflare Pages (no /api: POSTs get 405) ----------

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm',
                '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
function serve() {
  const server = createServer((req, res) => {
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    const file = join(WEB, path || 'index.html');
    if (!file.startsWith(WEB) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
    // the isolation headers of web/_headers, so the multi-threaded engine is the one tested
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
                         'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }).end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ---------- seeded randomness, so every run can be replayed ----------

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

// ---------- what must always hold ----------

async function invariants(page, screen) {
  return page.evaluate((screen) => {
    const bad = [];
    const visible = (el) => el && el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden';
    const text = document.body.innerText;
    for (const word of ['undefined', 'NaN', '[object Object]', 'null.']) if (text.includes(word)) bad.push(`page shows "${word}"`);
    if (!document.querySelector('#board cg-board') && !visible(document.getElementById('compare'))) bad.push('no board');
    if (!document.getElementById('context').innerText.trim()) bad.push('empty banner above the board');
    const pieces = document.querySelectorAll('#board piece:not(.ghost):not(.fading)').length;
    if (!document.getElementById('board').hidden && (pieces < 2 || pieces > 32)) bad.push(`${pieces} pieces on the board`);
    if (document.documentElement.scrollWidth > innerWidth + 1) bad.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${innerWidth})`);
    const current = document.querySelectorAll(screen === 'desktop' ? '#moves .mv.current' : '#strip .mv.current');
    if (current.length > 1) bad.push(`${current.length} moves marked current`);
    for (const b of document.querySelectorAll('button')) {
      if (!visible(b)) continue;
      const r = b.getBoundingClientRect();
      if (r.width && r.right > innerWidth + 1) bad.push(`button "${b.innerText.trim().slice(0, 20)}" sticks out of the screen`);
    }
    // A judged game move shows the best move as a green arrow (unless Compare hides the board).
    const ctx = document.getElementById('context');
    if (ctx.classList.contains('ctx-game') && ctx.querySelector('[class^="j-"]') && !document.getElementById('board').hidden &&
        !document.querySelector('#board svg line[stroke="#3aa655"]')) bad.push('judged move without the green best-move arrow');
    // In every comment the main line comes first and the "skip a move" line below it.
    for (const subs of document.querySelectorAll('.comment .subs')) {
      const rows = [...subs.children].filter((e) => e.classList.contains('vline'));
      const pass = rows.findIndex((e) => e.classList.contains('v-pass'));
      const main = rows.findIndex((e) => e.classList.contains('v-best') || e.classList.contains('v-after'));
      if (pass >= 0 && main >= 0 && pass < main) bad.push('a "skip a move" line above the main line');
    }
    return bad;
  }, screen);
}

// ---------- the monkey ----------

async function visibleHandles(page, selector) {
  const out = [];
  for (const h of await page.$$(selector)) {
    if (await h.evaluate((e) => e.offsetParent !== null && e.getBoundingClientRect().width > 0)) out.push(h);
  }
  return out;
}

async function act(page, rand, screen) {
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const roll = rand();
  if (roll < 0.35) { // tap a move: in the move list, a variation, the strip, the engine line or the blunder list
    const el = pick(await visibleHandles(page, '.mv:not(.placeholder), #pv .m, .moment'));
    if (!el) return 'no moves to tap';
    const label = await el.evaluate((e) => e.innerText.slice(0, 30));
    await el.click();
    return `tap move "${label}"`;
  }
  if (roll < 0.55) { // navigation buttons or keys
    const how = pick(['start', 'prev', 'next', 'end', 'key']);
    if (how === 'key') {
      const key = pick(['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape', 'f', 'c']);
      await page.keyboard.press(key);
      return `key ${key}`;
    }
    await page.click(`[data-nav="${how}"]`);
    return `nav ${how}`;
  }
  if (roll < 0.75) { // any other visible button, tab, fold or checkbox (not the ones that leave the page)
    const skip = ['sync', 'review', 'chat-send', 'mygames-review', 'mygames-newest', 'mygames-refresh', 'inaccuracies', 'autosync'];
    const all = await visibleHandles(page, 'button, summary, input[type=checkbox], .chip');
    const ok = [];
    for (const h of all) if (!skip.includes(await h.evaluate((e) => e.id))) ok.push(h);
    const el = pick(ok);
    if (!el) return 'nothing to press';
    const label = await el.evaluate((e) => (e.innerText || e.id || e.tagName).trim().replace(/\s+/g, ' ').slice(0, 30));
    await el.click();
    return `press "${label}"`;
  }
  if (roll < 0.9) { // drag a piece of the side to move to a random square (legal or not)
    const box = await page.$eval('#board', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, hidden: e.hidden }; });
    if (box.hidden || !box.w) return 'board hidden';
    const sq = () => [box.x + (Math.floor(rand() * 8) + 0.5) * box.w / 8, box.y + (Math.floor(rand() * 8) + 0.5) * box.w / 8];
    const [x1, y1] = sq(), [x2, y2] = sq();
    await page.mouse.click(x1, y1);
    await page.mouse.click(x2, y2);
    return `tap squares (${x1 | 0},${y1 | 0}) -> (${x2 | 0},${y2 | 0})`;
  }
  if (roll < 0.95) { // open another reviewed game, from the list or the games tab
    const id = pick(REVIEWS).id;
    await page.evaluate((id) => {
      document.querySelector(`.mg-row[data-id="${id}"]`)?.click();
    }, id);
    return `open review ${id}`;
  }
  // load a FEN or the sample game, or review the sample (explanations then arrive in the background)
  const what = pick(['sample', 'fen', 'bad', 'review']);
  if (what === 'review') {
    await page.evaluate((pgn) => { document.getElementById('input').value = pgn; }, SAMPLE);
    await page.$eval('#review', (e) => e.click());
    return 'review the sample game';
  }
  await page.evaluate((what, sample) => {
    const input = document.getElementById('input');
    input.value = what === 'sample' ? sample : what === 'fen' ? '8/8/8/4k3/8/8/4P3/4K3 w - - 0 1' : 'not a chess game';
  }, what, SAMPLE);
  await page.$eval('#load', (e) => e.click());
  return `load ${what}`;
}

async function run(browser, base, seed, screen) {
  const page = await browser.newPage();
  const { width, height, ...rest } = SCREENS[screen];
  await page.emulate({ viewport: { width, height, deviceScaleFactor: 1, ...rest },
    userAgent: rest.isMobile ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' : undefined });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  page.on('dialog', (d) => d.dismiss());
  await page.goto(`${base}/?local=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.classList.contains('local'));
  await page.evaluate(async (reviews) => { const m = await import('/core.js'); await m.localApi('/api/import', { reviews }); }, REVIEWS);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction((n) => document.querySelectorAll('.mg-row[data-id]').length >= n, {}, REVIEWS.length);
  if (!(await page.evaluate(() => crossOriginIsolated))) throw new Error('page is not cross-origin isolated: the threaded engine is not tested');

  const rand = rng(seed * 1000 + Object.keys(SCREENS).indexOf(screen)); // same sequence whatever --screens lists
  const trail = [];
  const failures = [];
  let lastError = '';
  for (let i = 0; i < ACTIONS; i++) {
    let did;
    try {
      did = await act(page, rand, screen);
    } catch (e) {
      did = `(action failed: ${e.message.split('\n')[0]})`;
    }
    trail.push(`${i + 1}. ${did}`);
    await new Promise((r) => setTimeout(r, 60 + rand() * 120));
    const bad = await invariants(page, screen);
    // An error may appear after an action, but the next tap or key must clear it.
    const error = await page.$eval('#error', (e) => e.textContent.trim());
    if (error && error === lastError && /^(tap move|key|nav) /.test(did)) bad.push(`error still shown after another action: ${error}`);
    // the error comes back asynchronously, later when the page is busy explaining in the background
    if (did === 'load bad' && !error && !(await page.waitForFunction(() => document.getElementById('error').textContent.trim(), { timeout: 1500 }).catch(() => null))) {
      bad.push('bad input showed no error');
    }
    lastError = error;
    const all = [...errors.splice(0), ...bad];
    if (all.length) {
      failures.push({ seed, screen, step: i + 1, problems: all, trail: trail.slice(-8) });
      if (failures.length >= 3) break;
    }
  }
  await page.close();
  return failures;
}

const chrome = findChrome();
if (!chrome) {
  console.log('monkey test skipped: no Chrome or Edge found (set CHROME_PATH)');
  process.exit(0);
}
const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--js-flags=--max-old-space-size=512', ...(process.env.CI ? ['--no-sandbox'] : [])] }); // CI runners block Chrome's sandbox
let failures = [];
try {
  for (const screen of screens) {
    for (const seed of SEEDS) {
      const f = await run(browser, base, seed, screen);
      console.log(`${screen.padEnd(14)} seed ${seed}: ${f.length ? `${f.length} problem(s)` : `ok, ${ACTIONS} actions`}`);
      failures = failures.concat(f);
    }
  }
} finally {
  await browser.close();
  server.close();
}
for (const f of failures) {
  console.log(`\n✗ ${f.screen}, seed ${f.seed}, step ${f.step}:\n  ${f.problems.join('\n  ')}\n  last actions:\n    ${f.trail.join('\n    ')}`);
}
process.exit(failures.length ? 1 : 0);
