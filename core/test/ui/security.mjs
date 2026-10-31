// Browser security regressions using public chess fixtures and the shipped response headers.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { headersFor } from './support.mjs';

const WEB = fileURLToPath(new URL('../../../web/', import.meta.url));
const reviews = JSON.parse(readFileSync(new URL('./reviews-public.json', import.meta.url), 'utf8'));
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json',
  '.wasm': 'application/wasm', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
let config = { backend: null, paddle: { environment: 'sandbox', client_token: 'test-only-token' } };
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://test').pathname;
  let file = resolve(WEB, '.' + (path === '/' ? '/index.html' : path));
  if (!file.startsWith(WEB)) { res.writeHead(403).end(); return; }
  if (!extname(file) && existsSync(file + '.html')) file += '.html';
  if (path === '/policy-probe.js') {
    res.writeHead(200, { ...headersFor(path), 'Content-Type': 'application/javascript' }).end(`
      (async () => {
        const violations = [];
        document.addEventListener('securitypolicyviolation', (e) => violations.push(e.effectiveDirective));
        const script = document.createElement('script'); script.textContent = 'window.inlineAudit=true'; document.head.appendChild(script);
        let evaluation = false;
        try { new Function('window.evalAudit=true')(); } catch { evaluation = true; }
        try { await fetch('https://blocked.example/security-test'); } catch {}
        await WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0]));
        await new Promise((r) => setTimeout(r, 40));
        window.cspProbe = { inline: !window.inlineAudit, evaluation: evaluation && !window.evalAudit, connection: violations.includes('connect-src') };
      })();
    `);
    return;
  }
  try {
    const body = path === '/config.json' ? JSON.stringify(config) : readFileSync(file);
    res.writeHead(200, { ...headersFor(path), 'Content-Type': types[extname(file)] || 'application/octet-stream' }).end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const chrome = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((p) => p && existsSync(p));
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: process.env.CI ? ['--no-sandbox'] : [] });
let checks = 0;
const check = (ok, message) => { assert.ok(ok, message); checks++; console.log('ok  ' + message); };
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.url() === 'https://cdn.paddle.com/paddle/v2/paddle.js') return req.respond({ status: 200, contentType: 'application/javascript',
      body: "window.Paddle={Environment:{set(){}},Initialize(){window.checkoutLoaded=true;}}" });
    if (req.url().startsWith(base) || req.url().startsWith('blob:') || req.url().startsWith('data:')) return req.continue();
    return req.abort();
  });
  await page.goto(base + '/?local=1&sw=1');
  await page.waitForFunction(() => document.querySelector('#pv').textContent.trim().length > 0, { timeout: 60000 });
  check(true, 'Stockfish WebAssembly and its worker run under the enforced CSP');
  // Run the probe as a normal served script: DevTools evaluation can bypass eval CSP.
  await page.addScriptTag({ url: base + '/policy-probe.js' });
  await page.waitForFunction(() => !!window.cspProbe);
  const blocked = await page.evaluate(() => window.cspProbe);
  check(blocked.inline && blocked.evaluation && blocked.connection, 'CSP blocks inline scripts, string evaluation and unapproved connections');
  for (const [i, field] of ['White', 'Black', 'WhiteElo', 'BlackElo', 'Event', 'Site', 'Date', 'Result'].entries()) {
    const payload = '<img src=x onerror=document.documentElement.dataset.pgnAudit=1>audit-' + i;
    const headers = { White: 'audit-' + i, Black: 'Opponent', [field]: payload };
    const pgn = Object.entries(headers).map(([k, v]) => `[${k} "${v}"]`).join('\n') + '\n\n1. e4 e5 *';
    await page.evaluate((pgn) => { document.querySelector('#input').value = pgn; document.querySelector('#load').click(); }, pgn);
    await page.waitForFunction((s) => document.querySelector('#player-bottom').textContent.includes(s), {}, 'audit-' + i);
    check(await page.evaluate(() => !document.documentElement.dataset.pgnAudit && !document.querySelector('#player-bottom img, #player-top img')), field + ' metadata stays text');
  }
  const bad = structuredClone(reviews[0]); bad.id = 'malformed-review';
  bad.records.at(-1).outcome = '<img src=x onerror=document.documentElement.dataset.importAudit=1>';
  const imported = await page.evaluate(async ({ good, bad }) => (await import('/core.js')).importReviews([good, bad]), { good: reviews[0], bad });
  check(imported.imported === 1 && imported.skipped === 1, 'valid reviews import and malicious review results are rejected');
  await page.reload();
  await page.waitForSelector('.mg-row.reviewed[data-id]');
  await page.evaluate(() => document.querySelector('.mg-row.reviewed[data-id]').click());
  await page.waitForFunction(() => document.querySelectorAll('#moves .mv').length > 5);
  check(await page.evaluate(() => !document.querySelector('#moves .result img') && !document.documentElement.dataset.importAudit), 'opening a valid imported review does not create executable result markup');
  // Old stored data is checked again on read, independently of import validation.
  await page.evaluate(async (review) => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('blunder-explainer', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    await new Promise((resolve, reject) => { const t = db.transaction('reviews', 'readwrite'); t.objectStore('reviews').put(review); t.oncomplete = resolve; t.onerror = () => reject(t.error); });
    db.close();
  }, bad);
  await page.reload();
  await page.waitForSelector('.mg-row.reviewed[data-id="malformed-review"]');
  await page.evaluate(() => document.querySelector('.mg-row.reviewed[data-id="malformed-review"]').click());
  await page.waitForFunction(() => document.body.innerText.includes('This saved review is not valid.'));
  check(await page.evaluate(() => !document.documentElement.dataset.importAudit), 'legacy malformed stored reviews are rejected before rendering');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: 30000 });
  await page.setOfflineMode(true);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#pv').textContent.trim().length > 0, { timeout: 60000 });
  check(true, 'the protected app and engine still work offline');
  await page.setOfflineMode(false);
  config = { backend: null, paddle: { environment: 'sandbox', client_token: 'test-only-token' } };
  await page.goto(base + '/pay?_ptxn=txn_test');
  await page.waitForFunction(() => window.checkoutLoaded === true);
  check(true, 'the checkout page permits the mocked trusted checkout script');
  check(!errors.length, 'no unexpected browser errors: ' + errors.join('; '));
  await page.close();
} finally { await browser.close(); server.close(); }
console.log(`${checks} browser security checks passed`);
