// Updates of the installed app: a new deploy is downloaded whole, then switched to at once
// (button tap, or the next launch), and a failed download leaves the old version working.
// The server plays successive deploys: deploy N serves sw.js with its own version and a
// style.css ending in "/* deploy N */", without touching the files in web/.
// Run: npm run test:update (builds web/ first).
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const WEB = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', 'web');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm',
                '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

// Deploy -1 is the first service worker (legacy-sw.js, as shipped until 2026-10-22), which refreshed file by file:
// phones that have it must move over.
const LEGACY_SW = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), 'legacy-sw.js'), 'utf-8');
let deploy = -1;
let broken = null; // a path that fails in this deploy

const server = createServer((req, res) => {
  if (req.method !== 'GET') { res.writeHead(405).end(); return; }
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
  const file = join(WEB, path || 'index.html');
  if (!file.startsWith(WEB) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
  if ('/' + path.replaceAll('\\', '/') === broken) { res.writeHead(500).end(); return; }
  let body = readFileSync(file);
  if (path === 'sw.js' && deploy < 0) body = LEGACY_SW;
  else if (path === 'sw.js') body = body.toString().replace(/const VERSION = "([0-9a-f]+)"/, `const VERSION = "$1-${deploy}"`);
  if (path === 'style.css') body = body.toString() + `\n/* deploy ${deploy} */\n`;
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }).end(body);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const chrome = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => p && existsSync(p));
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: process.env.CI ? ['--no-sandbox'] : [] }); // CI runners block Chrome's sandbox
const page = await browser.newPage();

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}
const caches = () => page.evaluate(() => caches.keys());
const served = () => page.evaluate(async () => (await (await fetch('/style.css')).text()).match(/deploy (\d+)/)[1]);
const waitFor = (fn, ...args) => page.waitForFunction(fn, { timeout: 15000 }, ...args);
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const buttonShown = () => page.evaluate(() => !document.getElementById('update').hidden);
// Polls through the page's own reloads (an evaluate that a reload interrupts is just retried).
async function until(fn, what) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    try { if (await fn()) return; } catch (e) { /* the page reloaded under us */ }
    await settle(200);
  }
  throw new Error(`timed out: ${what}`);
}

try {
  // A phone with the first service worker installed.
  await page.goto(`${base}/?sw=1`);
  await waitFor(() => navigator.serviceWorker.controller);
  await waitFor(async () => (await caches.keys()).includes('blunder-app'));

  // Deploy 0, the first with versions: it takes over from the old worker without a tap.
  deploy = 0;
  await page.reload();
  await waitFor(async () => { const k = await caches.keys(); return k.length === 1 && k[0].endsWith('-0'); });
  await page.reload();
  check((await served()) === '0' && !(await buttonShown()), 'from the first service worker: deploy 0 served, old cache removed');

  // Deploy 1 while the app is open: downloaded in the background, offered with a button.
  deploy = 1;
  await page.reload();
  await waitFor(() => !document.getElementById('update').hidden);
  check((await served()) === '0', 'deploy 1 downloaded: deploy 0 still served until the switch');
  await Promise.all([page.waitForNavigation(), page.click('#update')]);
  await waitFor(() => navigator.serviceWorker.controller);
  check((await served()) === '1', 'tap "New version": deploy 1 served');
  const keys1 = await caches();
  check(keys1.length === 1 && keys1[0].endsWith('-1'), `old cache removed (${keys1.join(', ')})`);

  // Deploy 2, downloaded during one session, not tapped: the next launch switches by itself.
  deploy = 2;
  await page.reload();
  await waitFor(() => !document.getElementById('update').hidden);
  await page.reload(); // the next launch: the waiting version takes over and the page reloads once
  await until(async () => (await served()) === '2', 'deploy 2 served');
  await settle(1000);
  check((await served()) === '2' && !(await buttonShown()), 'next launch: deploy 2 served, no button');

  // Deploy 3 with a file that fails to download: nothing switches, deploy 2 keeps working.
  deploy = 3;
  broken = '/vendor/stockfish/stockfish-19-lite.wasm';
  await page.reload();
  await settle(3000);
  const keys3 = await caches();
  check(!(await buttonShown()) && (await served()) === '2' && keys3.length === 1 && keys3[0].endsWith('-2'),
        `failed download: still deploy 2, no button (${keys3.join(', ')})`);

  // The file comes back: deploy 3 installs on the next check.
  broken = null;
  await page.reload();
  await waitFor(() => !document.getElementById('update').hidden);
  check(true, 'after the failure: deploy 3 offered once the file downloads');
} catch (e) {
  check(false, `error: ${e.message}`);
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
