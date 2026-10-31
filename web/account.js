// The account for the paid plan: sign-in with a one-time code sent by email (Cognito, called
// directly; no login page), the plan and this month's usage, subscribe / manage, and deleting the
// account. Active only when web/config.json names a `backend`:
//
//   "backend": { "api": "", "region": "us-east-1", "client_id": "<app client id>" }
//
// `api` is the same-origin /v1 service. Credentials stay in secure HttpOnly cookies. Every paid call is
// checked again by the service; nothing here decides what you may use.

export const API_LEVEL = 1; // sent as X-Api-Level; the service answers 426 below its minimum

const KEY = 'blunderAccount'; // legacy credentials: read once and remove during upgrade
const SESSION_HINT = 'blunderSession'; // a display hint only; the server authorizes every request
let cfg = null;
let session = false;
let me = null;
let onChange = () => {};

const $ = (id) => document.getElementById(id);


export const enabled = () => !!cfg;
export const signedIn = () => session;
export const paid = () => !!me?.active;
export const info = () => me;

// ---------- Cognito (its JSON API, the same one the AWS SDK uses) ----------

async function cognito(action, body) {
  const url = cfg.cognito_url || `https://cognito-idp.${cfg.region}.amazonaws.com/`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': `AWSCognitoIdentityProviderService.${action}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.Message || 'Sign-in failed');
    err.code = String(data.__type || '').split('#').pop();
    throw err;
  }
  return data;
}

function apiUrl(path) {
  const url = new URL(`${cfg.api || ''}${path}`, location.origin);
  if (url.origin !== location.origin) throw new Error('The account service must use this app’s origin.');
  return url;
}

async function sessionRequest(path, body = {}) {
  const res = await fetch(apiUrl(path), { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Api-Level': String(API_LEVEL) }, body: JSON.stringify(body) });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw Object.assign(new Error(data.error || 'Sign in again.'), { code: data.code, status: res.status });
  }
  return res.json();
}

async function establish(result) {
  await sessionRequest('/v1/auth/session', { access: result.AccessToken, refresh: result.RefreshToken });
  session = true;
  try { localStorage.setItem(SESSION_HINT, '1'); } catch {}
}

let pending = null; // the sign-in in progress: { email, session, step: 'signup' | 'otp' }

export async function sendCode(email) {
  email = email.trim().toLowerCase();
  try {
    const r = await cognito('SignUp', { ClientId: cfg.client_id, Username: email, UserAttributes: [{ Name: 'email', Value: email }] });
    pending = { email, session: r.Session, step: 'signup' };
    return;
  } catch (e) {
    // already signed up, or sign-up is closed (test pools): sign in with a code instead
    if (!['UsernameExistsException', 'NotAuthorizedException', 'InvalidParameterException'].includes(e.code)) throw e;
  }
  const r = await cognito('InitiateAuth', { ClientId: cfg.client_id, AuthFlow: 'USER_AUTH',
    AuthParameters: { USERNAME: email, PREFERRED_CHALLENGE: 'EMAIL_OTP' } });
  pending = { email, session: r.Session, step: 'otp' };
}

export async function enterCode(code) {
  if (!pending) throw new Error('Ask for a code first.');
  code = code.trim();
  const { email } = pending;
  let result;
  if (pending.step === 'signup') {
    const c = await cognito('ConfirmSignUp', { ClientId: cfg.client_id, Username: email, ConfirmationCode: code, Session: pending.session });
    const r = await cognito('InitiateAuth', { ClientId: cfg.client_id, AuthFlow: 'USER_AUTH', Session: c.Session,
      AuthParameters: { USERNAME: email } });
    result = r.AuthenticationResult;
  } else {
    const r = await cognito('RespondToAuthChallenge', { ClientId: cfg.client_id, ChallengeName: 'EMAIL_OTP', Session: pending.session,
      ChallengeResponses: { USERNAME: email, EMAIL_OTP_CODE: code } });
    result = r.AuthenticationResult;
  }
  if (!result?.AccessToken) throw new Error('That code did not work; ask for a new one.');
  pending = null;
  await establish(result);
  await refreshMe();
}

function forget() {
  try { localStorage.removeItem(SESSION_HINT); } catch {}
  session = false;
  me = null;
  onChange();
}

export async function signOut() {
  await sessionRequest('/v1/auth/logout');
  forget();
}

let refreshing = null;
function refreshSession() {
  if (!refreshing) refreshing = sessionRequest('/v1/auth/refresh').finally(() => { refreshing = null; });
  return refreshing;
}

// ---------- the service ----------

export async function api(method, path, body) {
  const send = () => fetch(apiUrl(path), { method, credentials: 'same-origin',
    headers: { 'X-Api-Level': String(API_LEVEL), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  let res = await send();
  if (res.status === 401) {
    try { await refreshSession(); res = await send(); }
    catch (e) { if (e.status === 401) forget(); throw e; }
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) forget();
  if (res.status === 426) $('update').hidden = false;
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { code: data.code, status: res.status });
  session = true;
  try { localStorage.setItem(SESSION_HINT, '1'); } catch {}
  return data;
}

export async function refreshMe() {
  try {
    me = await api('GET', '/v1/me');
  } catch (e) {
    if (e.code !== 'sign_in') me = me || null;
  }
  onChange();
  return me;
}

// The checkout opens in this tab: a window opened after the network call is blocked as a pop-up on
// iPhone. /pay comes back to /?paid=1, and the app waits for the webhook there.
export async function subscribe(plan) {
  const { url } = await api('POST', '/v1/pay/checkout', { plan });
  location.assign(url);
}

export async function manage() {
  const { url } = await api('POST', '/v1/pay/portal');
  window.open(url, '_blank', 'noopener');
}

export async function deleteAccount() {
  await api('DELETE', '/v1/me');
  localStorage.removeItem('blunderSyncSince');
  localStorage.removeItem('blunderSyncPushed');
  forget();
}

// ---------- start ----------

export async function init(backendConfig, changed) {
  // Remove legacy credentials even when an installation disables the account service.
  let legacy = null;
  try { legacy = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch {}
  try { localStorage.removeItem(KEY); sessionStorage.removeItem(KEY); } catch {}
  if (!backendConfig || !backendConfig.client_id) return;
  cfg = backendConfig;
  onChange = changed || onChange;
  if (legacy?.access && legacy?.refresh) {
    try {
      let result = { AccessToken: legacy.access, RefreshToken: legacy.refresh };
      if (Date.now() >= legacy.expires) {
        const renewed = await cognito('InitiateAuth', { ClientId: cfg.client_id, AuthFlow: 'REFRESH_TOKEN_AUTH',
          AuthParameters: { REFRESH_TOKEN: legacy.refresh } });
        result.AccessToken = renewed.AuthenticationResult?.AccessToken;
      }
      await establish(result);
    } catch { /* ask for a fresh code if a legacy session has expired or cannot be upgraded */ }
  }
  legacy = null;
  let remembered = session;
  try { remembered ||= localStorage.getItem(SESSION_HINT) === '1'; } catch {}
  // Free visitors do not invoke the account service merely by opening the board.
  if (remembered) await refreshMe();
  else onChange();
  // After a checkout in another tab or browser view, the plan shows up when you come back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && session) refreshMe();
  });
}
