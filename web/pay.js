// The checkout page (/pay?_ptxn=<transaction>): loads Paddle.js with the client-side token from
// config.json, which opens Paddle's checkout for that transaction by itself. Paying only creates the
// subscription at Paddle; the service unlocks the coach when Paddle's signed webhook arrives, never
// because of anything this page says.

const PADDLE_JS = 'https://cdn.paddle.com/paddle/v2/paddle.js';
const status = (t) => { document.getElementById('pay-status').textContent = t; };

function load(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('The payment page could not be loaded. Are you online?'));
    document.head.appendChild(s);
  });
}

async function start() {
  const txn = new URLSearchParams(location.search).get('_ptxn');
  if (!txn) { status('Nothing to pay here: start from Subscribe in the app.'); return; }
  let cfg = {};
  try { cfg = await (await fetch('/config.json')).json(); } catch (e) { /* defaults */ }
  const paddle = cfg.paddle || {};
  if (!paddle.client_token) { status('Payments are not set up yet.'); return; }
  await load(PADDLE_JS);
  if (paddle.environment === 'sandbox') window.Paddle.Environment.set('sandbox');
  window.Paddle.Initialize({
    token: paddle.client_token,
    eventCallback: (e) => {
      if (e.name === 'checkout.completed') location.replace('/?paid=1');
      if (e.name === 'checkout.closed') status('The checkout is closed. Nothing was charged unless you finished paying.');
    },
  });
  status('The checkout is open.');
}

start().catch((e) => status(e.message));
