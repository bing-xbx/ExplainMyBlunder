// Validate saved-review data before it reaches storage or the board renderer.
import { Board } from './board';
import type { Review } from './review';

export const REVIEW_ID = /^[A-Za-z0-9_-]{1,60}$/;
const RESULT = new Set([null, '1-0', '0-1', '1/2-1/2']);
const JUDGEMENT = new Set(['blunder', 'mistake', 'inaccuracy']);
const square = (s: unknown) => typeof s === 'string' && /^[a-h][1-8]$/.test(s);
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 1000) => typeof v === 'string' && v.length <= max;

function safeTree(v: unknown, budget: { nodes: number }, depth = 0): boolean {
  if (++budget.nodes > 120_000 || depth > 32) return false;
  if (v === null || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') return v.length <= 100_000;
  if (Array.isArray(v)) return v.length <= 10_000 && v.every((x) => safeTree(x, budget, depth + 1));
  if (!object(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return false;
  return Object.entries(v).every(([key, value]) => !['__proto__', 'prototype', 'constructor'].includes(key) &&
    (key !== 'outcome' || RESULT.has(value)) &&
    (key !== 'judgement' || JUDGEMENT.has(value)) && safeTree(value, budget, depth + 1));
}

function record(r: unknown): boolean {
  if (!object(r) || !text(r.fen, 150) || !Number.isInteger(r.ply) || r.ply < 0 || r.ply > 10_000 ||
      !['white', 'black'].includes(r.turn) || !RESULT.has(r.outcome) ||
      !(r.san === null || text(r.san, 40))) return false;
  try { Board.fromFen(r.fen); } catch { return false; }
  for (const key of ['delta', 'diff']) if (r[key] !== undefined && typeof r[key] !== 'number') return false;
  if (r.material && (!object(r.material) || !['white', 'black'].every((c) => typeof r.material[c] === 'number'))) return false;
  if (r.dests && (!object(r.dests) || !Object.entries(r.dests).every(([s, dests]) =>
    square(s) && Array.isArray(dests) && dests.length <= 64 && dests.every(square)))) return false;
  if (r.annotations && (!Array.isArray(r.annotations) || !r.annotations.every((a: any) =>
    object(a) && square(a.square) && (a.label === undefined || text(a.label, 100))))) return false;
  if (r.arrows && (!Array.isArray(r.arrows) || !r.arrows.every((a: any) => object(a) && square(a.from) && square(a.to)))) return false;
  return true;
}

function line(v: unknown): boolean {
  return object(v) && Array.isArray(v.plies) && Array.isArray(v.extra) &&
    v.plies.every(record) && v.extra.every(record) && typeof v.delta === 'number' &&
    (v.cashed == null || Number.isInteger(v.cashed)) && Number.isInteger(v.end) && v.end >= 0 && v.end <= v.plies.length;
}

export function isSafeReview(v: unknown): v is Review {
  if (!object(v) || !safeTree(v, { nodes: 0 }) || !text(v.id, 60) || !REVIEW_ID.test(v.id) ||
      !object(v.headers) || !Object.values(v.headers).every((s) => text(s)) ||
      !Array.isArray(v.records) || !v.records.length || v.records.length > 5000 || !v.records.every(record) ||
      !Array.isArray(v.moments) || v.moments.length > v.records.length ||
      !(v.you == null || ['white', 'black'].includes(v.you))) return false;
  return v.moments.every((m: any) => {
    if (!object(m) || !Number.isInteger(m.index) || m.index < 1 || m.index >= v.records.length ||
        !JUDGEMENT.has(m.judgement) || !['white', 'black'].includes(m.color)) return false;
    if (!m.card) return true;
    const c = m.card;
    return object(c) && ['allowed', 'missed'].includes(c.kind) && record(c.start) && line(c.lineA) && line(c.lineB) &&
      (!c.passes || ['idea', 'threat'].every((key) => !c.passes[key] || (Array.isArray(c.passes[key]) && c.passes[key].every(record))));
  });
}
