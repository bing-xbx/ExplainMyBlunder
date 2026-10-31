import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isSafeReview } from '../src/review-input';

const reviews = JSON.parse(readFileSync(new URL('./ui/reviews-public.json', import.meta.url), 'utf8'));
const fresh = () => structuredClone(reviews[0]);

describe('saved review input', () => {
  it('accepts complete public-game reviews, including explanation variations', () => {
    for (const review of reviews) expect(isSafeReview(review), review.id).toBe(true);
  });
  it('rejects script markup in the game result', () => {
    const r = fresh();
    r.records.at(-1).outcome = '<img src=x onerror=alert(1)>';
    expect(isSafeReview(r)).toBe(false);
  });
  it('rejects HTML attributes in judgement and card-kind values', () => {
    const r = fresh();
    r.moments[0].judgement = 'blunder" onclick="alert(1)';
    expect(isSafeReview(r)).toBe(false);
    const c = fresh();
    c.moments.find((m: any) => m.card).card.kind = '<img src=x>';
    expect(isSafeReview(c)).toBe(false);
  });
  it('validates nested variation results and numeric material', () => {
    const r = fresh();
    r.moments.find((m: any) => m.card).card.lineA.plies[0].outcome = '<svg onload=alert(1)>';
    expect(isSafeReview(r)).toBe(false);
    const c = fresh();
    c.moments.find((m: any) => m.card).card.lineA.delta = '<img src=x>';
    expect(isSafeReview(c)).toBe(false);
    const n = fresh(); n.records[0].material.white = '<img src=x>';
    expect(isSafeReview(n)).toBe(false);
  });
  it('rejects invalid positions, coordinates and moment indexes', () => {
    const r = fresh(); r.records[0].fen = 'not-a-position';
    expect(isSafeReview(r)).toBe(false);
    const c = fresh(); c.records[0].dests = { '<svg>': ['e4'] };
    expect(isSafeReview(c)).toBe(false);
    const m = fresh(); m.moments[0].index = m.records.length;
    expect(isSafeReview(m)).toBe(false);
  });
  it('rejects non-finite numbers, prototype keys and excessive nesting', () => {
    const r = fresh(); r.records[0].material.white = Infinity;
    expect(isSafeReview(r)).toBe(false);
    const p = fresh(); p.extra = JSON.parse('{"__proto__":{"polluted":true}}');
    expect(isSafeReview(p)).toBe(false);
    const d = fresh(); let nested = d;
    for (let i = 0; i < 40; i++) nested = nested.extra = {};
    expect(isSafeReview(d)).toBe(false);
    expect(({} as any).polluted).toBeUndefined();
  });
});
