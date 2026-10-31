// Regression checks replay recorded engine answers and compare analysis results with fixtures.
// Famous-game fixtures are included; additional local fixtures are used when available.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Board, RecordedEvaluator, explainPosition, explainTry, findMoments, moveFromUci, runCoachTool } from '../src';

const SETS = [['public games', 'fixtures-public'], ['local fixtures', 'fixtures']]
  .filter(([, dir]) => existsSync(new URL(`./${dir}/cards.json`, import.meta.url)));

/** JSON-normalise: sort the legal-destination lists (move generation order differs). */
function norm(x: any): any {
  if (Array.isArray(x)) return x.map(norm);
  if (x && typeof x === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(x)) {
      if (v === undefined) continue;
      out[k] = k === 'dests' ? Object.fromEntries(Object.entries(v as Record<string, string[]>).map(([f, t]) => [f, [...t].sort()]).sort()) : norm(v);
    }
    return out;
  }
  return x;
}

for (const [label, dir] of SETS) {
const load = (name: string) => JSON.parse(readFileSync(new URL(`./${dir}/${name}.json`, import.meta.url), 'utf-8'));

describe(`cards (${label})`, () => {
  for (const c of load('cards')) {
    it(c.id, async () => {
      const ev = new RecordedEvaluator(c.engine);
      const card = await explainPosition(Board.fromFen(c.fen), moveFromUci(c.played), moveFromUci(c.best), ev, c.mine ?? true);
      expect(norm(JSON.parse(JSON.stringify(card)))).toEqual(norm(c.expected));
    });
  }
});

describe(`what-if tries (${label})`, () => {
  for (const t of load('whatif')) {
    it(`${t.fen} ${t.uci}`, async () => {
      const out = await explainTry(t.fen, t.uci, new RecordedEvaluator(t.engine));
      expect(norm(JSON.parse(JSON.stringify(out)))).toEqual(norm(t.expected));
    });
  }
});

const coachFile = new URL(`./${dir}/coach.json`, import.meta.url);
describe.skipIf(!existsSync(coachFile))(`coach tools (${label})`, () => {
  const cases = existsSync(coachFile) ? JSON.parse(readFileSync(coachFile, 'utf-8')) : [];
  cases.forEach((c: any, i: number) => {
    it(`${i} ${c.tool} ${c.input.fen}`, async () => {
      const out = await runCoachTool(c.tool, c.input, c.you, new RecordedEvaluator(c.engine));
      expect(norm(JSON.parse(JSON.stringify(out)))).toEqual(norm(c.expected));
    });
  });
});

describe(`judging whole games (${label})`, () => {
  for (const g of load('games')) {
    it(g.id, async () => {
      const { moments } = await findMoments(g.start, g.moves, new RecordedEvaluator(g.engine));
      expect(norm(moments)).toEqual(norm(g.expected));
    });
  }
});
}
