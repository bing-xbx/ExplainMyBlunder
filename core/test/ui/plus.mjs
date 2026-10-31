// The free app's chat points to the paid coach: the "Ask the coach" card, and a short answer
// instead of an error when a question is sent. Checked with and without `upgrade_url` in config.json.
// Run: npm run test:plus (builds web/ first).
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const WEB = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', 'web');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm',
                '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
// The free app's config, whatever web/config.json says (this repo's own sets the paid backend).
let config = { backend: null, upgrade_url: null, github_url: null };

const server = createServer((req, res) => {
  if (req.method !== 'GET') { res.writeHead(405).end(); return; }
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
  const file = join(WEB, path || 'index.html');
  if (!file.startsWith(WEB) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
  const body = path === 'config.json' && config ? JSON.stringify(config) : readFileSync(file);
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }).end(body);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const chrome = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => p && existsSync(p));
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: process.env.CI ? ['--no-sandbox'] : [] }); // CI runners block Chrome's sandbox

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}

async function open() {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base);
  await page.waitForFunction(() => document.body.classList.contains('local'));
  await page.waitForFunction(() => !document.getElementById('chat-plus').hidden, { timeout: 5000 });
  await page.waitForFunction(() => document.getElementById('about-version').textContent.startsWith('version ') && document.querySelector('#board piece') && document.getElementById('context').textContent.trim());
  await page.evaluate(() => document.querySelector('#chat-suggest .chip').click());
  const state = await page.evaluate(() => {
    const msgs = [...document.querySelectorAll('#chat-log .msg')];
    const link = document.getElementById('chat-plus-link');
    return { msgs: msgs.map((m) => m.className + ': ' + m.innerText), link: link.hidden ? null : link.href,
             soon: !document.getElementById('chat-plus-soon').hidden, replyLink: msgs.at(-1)?.querySelector('a')?.href || null,
             support: document.getElementById('support').hidden ? null : [...document.querySelectorAll('#support a')].filter((x) => !x.hidden).map((x) => x.href),
             versionText: document.getElementById('about-version').textContent, source: !document.getElementById('about-source').hasAttribute('href') ? null : document.getElementById('about-source').href };
  });
  await page.close();
  return { ...state, errors };
}

try {
  const a = await open();
  check(a.msgs.length === 2 && a.msgs[0].startsWith('msg user') && a.msgs[1].includes('part of the paid plan'),
        `no upgrade_url: the question gets a pointer, not an error (${a.msgs.at(-1)})`);
  check(a.soon && !a.link && !a.replyLink, 'no upgrade_url: "Coming soon", no link');
  check(!a.errors.length, `no page errors ${a.errors.join('; ')}`);

  check(a.support === null, 'no github_url: no star link');
  check(a.source === null && a.versionText.startsWith('version '), 'no github_url: version remains readable without a source link');

  config = { backend: null, upgrade_url: 'https://example.com/plus', github_url: 'https://github.com/example/repo' };
  const b = await open();
  check(!b.soon && b.link === 'https://example.com/plus', 'upgrade_url: the card links to the plan');
  check(b.replyLink === 'https://example.com/plus', 'upgrade_url: the answer links to the plan too');
  check(JSON.stringify(b.support) === JSON.stringify(['https://github.com/example/repo']), `the star link shows (${b.support})`);
  check(/^https:\/\/github\.com\/example\/repo\/tree\/site-[0-9a-f]{12}$/.test(b.source || ''), `the version text links to this version's source tag (${b.source})`);
  check(!b.errors.length, `no page errors ${b.errors.join('; ')}`);
} catch (e) {
  check(false, `error: ${e.message}`);
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
