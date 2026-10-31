// Apply the shipped static-header rules to a test server, including combined CSP policies.
import { readFileSync } from 'node:fs';
const rules = [];
for (const raw of readFileSync(new URL('../../../web/_headers', import.meta.url), 'utf8').split(/\r?\n/)) {
  if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
  if (!/^\s/.test(raw)) { rules.push({ path: raw.trim(), headers: [] }); continue; }
  const text = raw.trim();
  if (text.startsWith('! ')) rules.at(-1).headers.push([text.slice(2).toLowerCase(), null]);
  else { const i = text.indexOf(':'); rules.at(-1).headers.push([text.slice(0, i).toLowerCase(), text.slice(i + 1).trim()]); }
}
export function headersFor(path) {
  const headers = {};
  for (const rule of rules) {
    const pattern = new RegExp('^' + rule.path.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    if (!pattern.test(path)) continue;
    for (const [key, value] of rule.headers) {
      if (value === null) delete headers[key];
      else headers[key] = headers[key] ? headers[key] + ', ' + value : value;
    }
  }
  return headers;
}
