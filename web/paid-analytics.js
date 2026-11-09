// Aggregate paid-feature interest on the production Pages site. No game or chat data is sent.
const ANALYTICS_ORIGIN = 'https://explainmyblunder.pages.dev';
export const paidAnalyticsEnabled = () => location.origin === ANALYTICS_ORIGIN;

export function trackPaidInteraction(event) {
  if (!paidAnalyticsEnabled()) return;
  // Analytics must never delay a coach question or a navigation.
  try {
    void fetch('/paid-interaction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event }),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      keepalive: true,
    }).catch(() => {});
  } catch { /* offline, unsupported keepalive, or blocked analytics */ }
}
