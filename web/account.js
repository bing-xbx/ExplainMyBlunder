// The account for the paid plan: sign-in with a one-time code sent by email (Cognito, called
// directly; no login page), the plan and this month's usage, subscribe / manage, and deleting the
// account. Active only when web/config.json names a `backend`:
//
//   "backend": { "api": "", "region": "us-east-1", "client_id": "<app client id>" }
//
// `api` is where /v1 lives ("" = this site, served by the Worker in edge/). Every paid call is
// checked again by the service; nothing here decides what you may use.

export const API_LEVEL = 1; // sent as X-Api-Level; the service answers 426 below its minimum

const KEY = 'blunderAccount';
let cfg = null;
let tokens = null; // { access, refresh, expires (ms), email }
let me = null;
let onChange = () => {};

const $ = (id) => document.getElementById(id);
const save = () => (tokens ? localStorage.setItem(KEY, JSON.stringify(tokens)) : localStorage.removeItem(KEY));

export const enabled = () => !!cfg;
export const signedIn = () => !!tokens;
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

function keep(result, email) {
  tokens = {
    access: result.AccessToken,
    refresh: result.RefreshToken || tokens?.refresh,
    expires: Date.now() + (result.ExpiresIn || 3600) * 1000,
    email: email || tokens?.email,
  };
  save();
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
  keep(result, email);
  await refreshMe();
}

async function accessToken() {
  if (!tokens) return null;
  if (Date.now() > tokens.expires - 60_000) {
    try {
      const r = await cognito('InitiateAuth', { ClientId: cfg.client_id, AuthFlow: 'REFRESH_TOKEN_AUTH',
        AuthParameters: { REFRESH_TOKEN: tokens.refresh } });
      keep(r.AuthenticationResult);
    } catch (e) {
      forget();
      return null;
    }
  }
  return tokens.access;
}

function forget() {
  tokens = null;
  me = null;
  save();
  onChange();
}

export async function signOut() {
  const t = tokens;
  forget();
  if (t?.refresh) cognito('RevokeToken', { ClientId: cfg.client_id, Token: t.refresh }).catch(() => {});
}

// ---------- the service ----------

export async function api(method, path, body) {
  const token = await accessToken();
  if (!token) throw Object.assign(new Error('Sign in to use the coach.'), { code: 'sign_in' });
  const res = await fetch(`${cfg.api || ''}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'X-Api-Level': String(API_LEVEL), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) forget();
  if (res.status === 426) $('update').hidden = false;
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { code: data.code, status: res.status });
  return data;
}

export async function refreshMe() {
  if (!tokens) { me = null; onChange(); return null; }
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
  if (!backendConfig || !backendConfig.client_id) return;
  cfg = backendConfig;
  onChange = changed || onChange;
  try { tokens = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { tokens = null; }
  await refreshMe();
  // After a checkout in another tab or browser view, the plan shows up when you come back.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && tokens) refreshMe();
  });
}
