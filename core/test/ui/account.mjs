// The paid plan in the app, against a fake service and a fake sign-in (no AWS): sign in with an
// emailed code, the subscribe pointer, the coach's tool loop running the engine on the device,
// "Explain this with AI" on a card (a coach question), deleting the account. And with
// `backend: null` (the free app) none of it shows.
// Run: npm run test:account (builds web/ first).
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { headersFor } from './support.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WEB = join(HERE, '..', '..', '..', 'web');
const REVIEWS = JSON.parse(readFileSync(join(HERE, 'reviews-public.json'), 'utf8'));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm',
                '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

let config = { backend: null, upgrade_url: null, github_url: null }; // the free app first, whatever web/config.json says
const svc = { active: false, coachCalls: [], checkouts: [], deleted: false, signups: 0, refreshes: 0, expired: false, authorizationHeaders: [] };
const AUTH = { AuthenticationResult: { AccessToken: 'access-1', RefreshToken: 'refresh-1', ExpiresIn: 3600 } };

function cognito(target, body) {
  switch (target) {
    case 'SignUp':
      svc.signups++;
      return body.Username === 'new@example.com' ? [200, { UserConfirmed: false, Session: 'signup' }]
        : [400, { __type: 'UsernameExistsException', message: 'exists' }];
    case 'ConfirmSignUp': return body.ConfirmationCode === '123456' ? [200, { Session: 'confirmed' }] : [400, { __type: 'CodeMismatchException', message: 'Wrong code.' }];
    case 'InitiateAuth':
      if (body.AuthFlow === 'REFRESH_TOKEN_AUTH' || body.Session === 'confirmed') return [200, AUTH];
      return [200, { ChallengeName: 'EMAIL_OTP', Session: 'otp' }];
    case 'RespondToAuthChallenge':
      return body.ChallengeResponses.EMAIL_OTP_CODE === '123456' ? [200, AUTH] : [400, { __type: 'CodeMismatchException', message: 'Wrong code.' }];
    case 'RevokeToken': return [200, {}];
  }
  return [400, { __type: 'Unknown' }];
}

function v1(method, path, body) {
  if (method === 'GET' && path === '/v1/me') {
    return [200, { email: 'player@example.com', owner: false, active: svc.active, plan: svc.active ? 'monthly' : null,
                   usage: { coach: svc.coachCalls.length ? 1 : 0 }, quota: { coach: 30 } }];
  }
  if (!svc.active && !(method === 'POST' && path === '/v1/pay/checkout') && !(method === 'DELETE' && path === '/v1/me')) {
    return [402, { error: 'The coach is part of the paid plan.', code: 'no_subscription' }];
  }
  if (method === 'POST' && path === '/v1/coach') {
    svc.coachCalls.push(body);
    const fen = body.context.board_now.fen;
    if (!body.steps.length) {
      return [200, { status: 'tools', assistant: [{ type: 'text', text: 'checking' }],
                     tool_uses: [{ id: 't1', name: 'threats', input: { fen } }, { id: 't2', name: 'engine_analyse', input: { fen, lines: 1 } }] }];
    }
    return [200, { status: 'done', reply: 'Coach says: the engine agrees.', unchecked: [], rounds: 2 }];
  }
  if (method === 'POST' && path === '/v1/pay/checkout') { svc.checkouts.push(body.plan); return [200, { url: `${base}/pay?_ptxn=txn_test` }]; }
  if (method === 'DELETE' && path === '/v1/me') { svc.deleted = true; return [200, { deleted: true }]; }
  return [404, { error: 'no route', code: 'not_found' }];
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (status, body) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  if (url.pathname === '/cognito' || url.pathname.startsWith('/v1/')) {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      if (url.pathname === '/cognito') return send(...cognito(String(req.headers['x-amz-target']).split('.').pop(), body));
      svc.authorizationHeaders.push(req.headers.authorization || null);
      const signed = (req.headers.cookie || '').includes('test-session=opaque');
      if (url.pathname === '/v1/auth/session') {
        if (body.access !== 'access-1' || body.refresh !== 'refresh-1') return send(401, { code: 'sign_in' });
        res.setHeader('Set-Cookie', 'test-session=opaque; Path=/; HttpOnly; SameSite=Strict');
        svc.expired = false;
        return send(200, { signedIn: true });
      }
      if (url.pathname === '/v1/auth/refresh') {
        if (!signed) return send(401, { code: 'sign_in' });
        svc.refreshes++; svc.expired = false;
        return send(200, { signedIn: true });
      }
      if (url.pathname === '/v1/auth/logout') {
        res.setHeader('Set-Cookie', 'test-session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict');
        return send(200, { signedIn: false });
      }
      if (!signed || svc.expired) return send(401, { error: 'Sign in again.', code: 'sign_in' });
      if (req.method === 'DELETE' && url.pathname === '/v1/me') res.setHeader('Set-Cookie', 'test-session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict');
      if (req.headers['x-api-level'] !== '1') return send(426, { error: 'update', code: 'update' });
      return send(...v1(req.method, url.pathname + url.search, body));
    });
    return;
  }
  if (req.method !== 'GET') { res.writeHead(405).end(); return; }
  const path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  let file = join(WEB, path || 'index.html');
  if (!extname(file) && existsSync(`${file}.html`)) file = `${file}.html`; // /pay -> pay.html, as Cloudflare serves it
  if (!file.startsWith(WEB) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
  const body = path === 'config.json' && config ? JSON.stringify(config) : readFileSync(file);
  res.writeHead(200, { ...headersFor(url.pathname), 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }).end(body);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const chrome = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => p && existsSync(p));
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: process.env.CI ? ['--no-sandbox'] : [] });

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}

const hidden = (page, id) => page.evaluate((id) => document.getElementById(id).hidden, id);
const text = (page, id) => page.evaluate((id) => document.getElementById(id).innerText, id);
const fill = (page, id, v) => page.$eval(`#${id}`, (e, v) => { e.value = v; }, v);
const click = (page, id) => page.evaluate((id) => document.getElementById(id).click(), id);

async function ask(page, question) {
  await page.evaluate((q) => {
    const sec = document.getElementById('chat');
    if (sec.classList.contains('collapsed')) document.getElementById('chat-toggle').click();
    document.getElementById('chat-input').value = q;
    document.getElementById('chat-send').click();
  }, question);
  await page.waitForFunction(() => {
    const m = [...document.querySelectorAll('#chat-log .msg.assistant')];
    return m.length && !document.getElementById('chat-status').innerText;
  }, { timeout: 60000 });
  return page.evaluate(() => [...document.querySelectorAll('#chat-log .msg.assistant')].at(-1).innerText);
}

const errors = [];
try {
  // the free app: no account UI at all
  const free = await browser.newPage();
  free.on('pageerror', (e) => errors.push(e.message));
  await free.evaluateOnNewDocument(() => localStorage.setItem('blunderAccount', JSON.stringify({ access: 'old-access', refresh: 'old-refresh' })));
  await free.goto(`${base}/?local=1`);
  await free.waitForFunction(() => document.body.classList.contains('local'));
  check(await hidden(free, 'plan-wrap'), 'backend null: no account button');
  check(await free.evaluate(() => localStorage.getItem('blunderAccount') === null), 'backend null: legacy credentials are removed too');
  await free.close();

  config = { backend: { api: '', region: 'us-east-1', client_id: 'testclient', cognito_url: `${base}/cognito` }, upgrade_url: null };
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(`${base}/?local=1`);
  await page.waitForFunction(() => document.body.classList.contains('local'));
  await page.evaluate(async (reviews) => { const m = await import('/core.js'); await m.localApi('/api/import', { reviews }); }, REVIEWS);
  await page.reload();
  await page.waitForFunction(() => document.body.classList.contains('local') && !document.getElementById('plan-wrap').hidden);
  check(svc.authorizationHeaders.length === 0, 'a signed-out visitor makes no account API calls');
  check(!(await hidden(page, 'chat-plus')) && !(await hidden(page, 'chat-plus-signin')), 'signed out: the coach card offers Sign in');
  check((await ask(page, 'Why?')).includes('Sign in'), 'signed out: a question gets the sign-in pointer');

  // sign in with an emailed code (an existing account: sign-up says it exists, so a sign-in code is sent)
  await page.evaluate(() => { if (document.getElementById('settings').hidden) document.getElementById('settings-btn').click(); });
  await fill(page, 'plan-email', 'player@example.com');
  await click(page, 'plan-send');
  await page.waitForFunction(() => !document.getElementById('plan-code-row').hidden);
  await fill(page, 'plan-code', '000000');
  await click(page, 'plan-enter');
  await page.waitForFunction(() => document.getElementById('plan-status').innerText.includes('Wrong code'));
  check(true, 'a wrong code is refused with a message');
  await fill(page, 'plan-code', '123456');
  await click(page, 'plan-enter');
  await page.waitForFunction(() => document.getElementById('plan-who').innerText === 'player@example.com');
  check(!(await hidden(page, 'plan-buy')) && (await text(page, 'plan-usage')).includes('No plan yet'), 'signed in, no plan: Subscribe is offered');
  check((await ask(page, 'Why?')).includes('Subscribe'), 'no plan: a question gets the subscribe pointer');

  // Subscribe: the checkout opens in this tab at /pay (no Paddle token in this config: it says so),
  // and coming back as /?paid=1 waits until the webhook has switched the plan on
  check((await text(page, 'plan-annual')).startsWith('Subscribe yearly'), 'both plans are offered');
  await Promise.all([page.waitForNavigation(), click(page, 'plan-annual')]);
  check(new URL(page.url()).pathname === '/pay' && svc.checkouts.at(-1) === 'annual', `Subscribe yearly opens the checkout page (${page.url()})`);
  await page.waitForFunction(() => document.getElementById('pay-status').innerText.includes('not set up'));
  check(true, 'the checkout page says payments are not set up yet');
  svc.active = true; // what Paddle's webhook does
  await page.goto(`${base}/?paid=1`);
  await page.waitForFunction(() => document.getElementById('plan-status').innerText.includes('active'), { timeout: 15000 });
  check(new URL(page.url()).search === '', 'back from the checkout: the plan shows active, and ?paid=1 is gone');

  // subscribed: still signed in after a reload; the coach's tools run on this device
  await page.reload();
  await page.waitForFunction(() => document.getElementById('plan-who').innerText === 'player@example.com');
  check(await hidden(page, 'chat-plus'), 'subscribed: the coach card is gone');
  check(await page.evaluate(() => !localStorage.getItem('blunderAccount') && !sessionStorage.getItem('blunderAccount') && !document.cookie.includes('test-session')), 'credentials are absent from browser storage and document.cookie');
  svc.expired = true;
  await page.evaluate(async () => (await import('/account.js')).refreshMe());
  check(svc.refreshes === 1 && await text(page, 'plan-who') === 'player@example.com', 'an expired access session refreshes once using its HttpOnly cookie');
  check(svc.authorizationHeaders.every((h) => h === null), 'the browser sends no bearer credentials on account API calls');
  await page.evaluate((id) => document.querySelector(`.mg-row[data-id="${id}"]`).click(), REVIEWS[0].id);
  await page.waitForFunction(() => document.querySelector('#explain .moment'));
  await page.evaluate(() => document.querySelector('#explain .moment').click());
  const reply = await ask(page, 'What is best here?');
  check(reply.includes('Coach says'), `the coach answers (${reply.slice(0, 40)})`);
  const second = svc.coachCalls[1];
  const results = second?.steps?.[0]?.tool_results || [];
  const analysis = results[1] && JSON.parse(results[1].content);
  check(svc.coachCalls.length === 2 && second.question_id === svc.coachCalls[0].question_id, 'one question, two rounds, same question id');
  check(results.length === 2 && !results[0].is_error && JSON.parse(results[0].content).threatening_side, 'the threats tool ran on the device');
  check(analysis?.candidates?.length === 1 && /^[+-]\d|mate/.test(analysis.candidates[0].eval_for_player), `the engine ran on the device (${JSON.stringify(analysis?.candidates?.[0])})`);

  // "Explain this with AI" on a card: one coach question about that move
  const before = svc.coachCalls.length;
  const answers = await page.evaluate(() => document.querySelectorAll('#chat-log .msg.assistant').length);
  const chip = await page.waitForSelector('#explain .ai-btn', { timeout: 5000 });
  await chip.click();
  await page.waitForFunction((n) => document.querySelectorAll('#chat-log .msg.assistant').length > n && !document.getElementById('chat-status').innerText,
    { timeout: 60000 }, answers);
  const asked = svc.coachCalls[before];
  const question = asked?.history?.at(-1)?.text || '';
  check(/^Explain \S+ simply: /.test(question), `the chip asks the coach about the move (${question})`);
  check(svc.coachCalls.length === before + 2 && svc.coachCalls[before + 1].question_id === asked.question_id, 'the chip is one coach question');
  check(!(await page.$('#explain .word-btn')) && !(await page.$('#plan-backup')), 'no wording button and no backup toggle any more');

  // delete the account
  await click(page, 'plan-delete');
  await page.waitForFunction(() => !document.getElementById('plan-out').hidden);
  check(svc.deleted && (await page.evaluate(() => localStorage.getItem('blunderAccount'))) === null, 'delete: the service is told and the app signs out');
  // a new account: sign-up sends the code, confirming it signs you in
  await page.evaluate(() => { if (document.getElementById('settings').hidden) document.getElementById('settings-btn').click(); });
  await fill(page, 'plan-email', 'new@example.com');
  await click(page, 'plan-send');
  await page.waitForFunction(() => !document.getElementById('plan-code-row').hidden);
  await fill(page, 'plan-code', '123456');
  await click(page, 'plan-enter');
  await page.waitForFunction(() => document.getElementById('plan-out').hidden, { timeout: 10000 });
  check(svc.signups >= 2, 'a new email signs up, and the code signs it in');
  // A stored session from an older app version is removed and upgraded once.
  await page.evaluate(async () => (await import('/account.js')).signOut());
  await page.evaluate(() => localStorage.setItem('blunderAccount', JSON.stringify({ access: 'access-1', refresh: 'refresh-1', expires: Date.now() + 3600000 })));
  await page.reload();
  await page.waitForFunction(() => document.getElementById('plan-who').textContent === 'player@example.com');
  check(await page.evaluate(() => localStorage.getItem('blunderAccount') === null), 'legacy credentials are migrated and removed from localStorage');
  await page.evaluate(async () => (await import('/account.js')).signOut());
  await page.reload();
  await page.waitForFunction(() => document.body.classList.contains('local'));
  check(!(await page.evaluate(() => document.cookie.includes('test-session'))) && await page.evaluate(async () => !(await import('/account.js')).signedIn()), 'sign-out clears the server session and stays signed out after reload');
  await page.close();
  check(!errors.length, `no page errors ${errors.join('; ')}`);
} catch (e) {
  check(false, `error: ${e.message}`);
  for (const pg of await browser.pages()) {
    console.log(await pg.evaluate(() => ({ who: document.getElementById('plan-who')?.innerText, status: document.getElementById('plan-status')?.innerText, err: document.getElementById('error')?.innerText })).catch(() => null));
  }
  console.log(errors);
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
