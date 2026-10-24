// Ports of the Python unit tests (tests/test_detect.py, test_analyze.py, test_records.py,
// test_explain.py) that need no engine.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Board, InputError, classify, describe as describeMove, diffFor, hanging, judge, linesThrough, load, material, moveFacts,
  parseGameLink, parseSq, passLine, pgnFromLink, play, povWc, promotes, runCoachTool, see, settlePoint, summarize, trapped, whyGone,
} from '../src';

const facts = (fen: string, san: string) => {
  const b = Board.fromFen(fen);
  return moveFacts(b, b.legalMoves().find((m) => b.san(m) === san)!);
};
const cp = (v: number) => ({ cp: v, mate: null });
const mate = (n: number) => ({ cp: null, mate: n });
const SHILLING_BEFORE = 'r1bqkbnr/pppp1ppp/8/4p3/2BnP3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';

describe('detect', () => {
  it('static exchange evaluation', () => {
    expect(see(Board.fromFen('4k3/8/4p3/3n4/2P5/8/8/4K3 w - - 0 1'), parseSq('d5'), 'white')).toBe(2);
    expect(see(Board.fromFen('4k3/8/8/3n4/8/8/8/3QK3 w - - 0 1'), parseSq('d5'), 'white')).toBe(3);
    expect(see(Board.fromFen('4k3/8/4p3/3n4/8/8/8/3QK3 w - - 0 1'), parseSq('d5'), 'white')).toBe(0);
  });
  it('knight fork', () => {
    expect(new Set(facts('r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1', 'Nc7+').fork.map((t: any) => t.square))).toEqual(new Set(['e8', 'a8']));
  });
  it('absolute pin', () => {
    const pin = facts('4k3/8/2n5/8/8/8/8/4KB2 w - - 0 1', 'Bb5').lines[0];
    expect([pin.kind, pin.pinned, pin.absolute]).toEqual(['pin', 'c6', true]);
  });
  it('skewer', () => {
    const sk = facts('8/8/8/4k2q/8/8/8/R3K3 w - - 0 1', 'Ra5+').lines[0];
    expect([sk.kind, sk.front, sk.behind]).toEqual(['skewer', 'e5', 'h5']);
  });
  it('removed defender leaves a pawn hanging', () => {
    expect(facts('4k3/8/2n5/4P3/8/3N4/8/4K3 w - - 0 1', 'Nf4').removes_defender.map((h: any) => h.square)).toEqual(['e5']);
  });
  it('a trade is not hanging', () => {
    expect(facts(SHILLING_BEFORE, 'Nxd4').leaves_hanging).toBeUndefined();
  });
  it('trapped bishop', () => {
    const t = trapped(Board.fromFen('4k3/8/8/8/8/1P6/b1P5/R3K3 b - - 0 1'), 'black');
    expect(t[0].square).toBe('a2');
    expect(new Set(t[0].escapes)).toEqual(new Set(['b1', 'b3']));
  });
  it('why the idea is gone: moved away', () => {
    const before = Board.fromFen(SHILLING_BEFORE);
    const now = before.copy();
    for (const san of ['Nxe5', 'Qg5']) now.push(now.legalMoves().find((m) => now.san(m) === san)!);
    const idea = before.legalMoves().find((m) => before.san(m) === 'Nxd4')!;
    const why = whyGone(before, now, idea, null);
    expect([why.reason, why.square]).toEqual(['moved_away', 'e5']);
  });
  it('hanging pieces are listed highest square first (python-chess order)', () => {
    const h = hanging(Board.fromFen('4k3/8/8/1n4n1/8/8/8/1Q2K1Q1 b - - 0 1'), 'black');
    expect(h.map((x) => x.square)).toEqual(['g5', 'b5']);
  });
  it('lines through ignores a pawn shielding a bigger piece', () => {
    expect(linesThrough(Board.fromFen('4k3/8/8/3q4/3p4/8/8/3RK3 w - - 0 1'), parseSq('d1'), 'white')).toEqual([]);
  });
});

describe('analyze', () => {
  it('Lichess thresholds', () => {
    expect(judge(cp(50), cp(-200), 'white')[0]).toBe('blunder');
    expect(judge(cp(50), cp(-70), 'white')[0]).toBe('mistake');
    expect(judge(cp(50), cp(-20), 'white')[0]).toBe('inaccuracy');
    expect(judge(cp(50), cp(30), 'white')[0]).toBeNull();
    expect(judge(cp(50), cp(-200), 'black')[0]).toBeNull();
    expect(judge(cp(2000), cp(1100), 'white')[0]).toBeNull();
  });
  it('mate rules', () => {
    expect(judge(cp(0), mate(-3), 'white')[0]).toBe('blunder');
    expect(judge(cp(-800), mate(-3), 'white')[0]).toBe('mistake');
    expect(judge(mate(2), cp(1200), 'white')[0]).toBe('inaccuracy');
    expect(judge(mate(2), cp(100), 'white')[0]).toBe('blunder');
    expect(judge(mate(2), mate(4), 'white')[0]).toBeNull();
  });
  it('terminal scores', () => {
    const won = { cp: null, mate: null, terminal: '1-0' as const };
    expect(povWc(won, 'white')).toBe(1);
    expect(povWc(won, 'black')).toBe(-1);
  });
});

describe('records', () => {
  const SHILLING = '1. e4 e5 2. Nf3 Nc6 3. Bc4 Nd4 4. Nxe5 Qg5 5. Bxf7+ Ke7 6. O-O Qxe5 7. Bxg8 Rxg8 *';
  it('PGN gives the start plus one record per move', () => {
    const recs = load(SHILLING).records;
    expect(recs.length).toBe(15);
    expect(recs.slice(1, 4).map((r) => r.san)).toEqual(['e4', 'e5', 'Nf3']);
    expect([recs[9].san, recs[9].check]).toEqual(['Bxf7+', true]);
    expect(recs[11].san).toBe('O-O');
    expect(recs[11].uci).toBe('e1g1'); // standard castling notation, not chessops' e1h1
    expect(recs[1].lastMove).toEqual(['e2', 'e4']);
  });
  it('headers and FEN input', () => {
    expect(load('[White "Me"]\n[Black "You"]\n\n1. e4 *').headers.White).toBe('Me');
    expect(load('8/8/8/8/8/8/4K3/7k w - - 0 1').records.length).toBe(1);
  });
  it('promotion destinations are not repeated; play() auto-queens', () => {
    expect(load('8/P7/8/8/8/8/8/k6K w - - 0 1').records[0].dests.a7).toEqual(['a8']);
    const rec = play('8/P7/8/8/8/8/8/k6K w - - 0 1', 'a7a8');
    expect([rec.san, rec.uci]).toEqual(['a8=Q+', 'a7a8q']);
  });
  it('bad input', () => {
    for (const bad of ['', '1. e4 e5 2. Ke3 Ke6 3. Qh8 *']) expect(() => load(bad)).toThrow(InputError);
    expect(() => play('8/8/8/8/8/8/4K3/7k w - - 0 1', 'e2e5')).toThrow(InputError);
  });
  it('checkmate outcome', () => {
    const last = load('1. f3 e5 2. g4 Qh4# 0-1').records.at(-1)!;
    expect(last.outcome).toBe('0-1');
    expect(last.dests).toEqual({});
  });
  it('en passant is written only when legal (python-chess epd)', () => {
    const b = Board.fromFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    b.push(b.legalMoves().find((m) => b.san(m) === 'e4')!);
    expect(b.epd()).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -');
  });
});

describe('explain (no engine)', () => {
  it('material and diff', () => {
    expect(material(Board.fromFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'))).toEqual({ white: 39, black: 39 });
    expect(diffFor({ white: 39, black: 36 }, 'black')).toBe(-3);
  });
  it('settle waits for material to hold', () => {
    const boards = [Board.fromFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')];
    const moves = [];
    for (const san of ['e4', 'd5', 'exd5', 'Qxd5', 'Nc3', 'Qa5', 'd4', 'Nf6', 'Nf3']) {
      const b = boards.at(-1)!.copy();
      const m = b.legalMoves().find((x: any) => b.san(x) === san)!;
      moves.push(m);
      b.push(m);
      boards.push(b);
    }
    const diffs = boards.map((b) => diffFor(material(b), 'white'));
    expect(diffs.slice(0, 5)).toEqual([0, 0, 0, 1, 0]);
    expect(settlePoint(diffs, boards, moves, 1)).toBe(4);
    expect(settlePoint(diffs, boards, moves, 3)).toBe(4);
  });
  it('captions', () => {
    const b = Board.fromFen('rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2');
    expect(describeMove(b, b.legalMoves().find((m) => b.san(m) === 'exd5')!, 'white')).toBe('You take the pawn on d5 with the pawn.');
    const m = Board.fromFen('6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1');
    expect(describeMove(m, m.legalMoves().find((x) => m.san(x) === 'Rd8#')!, 'black')).toBe('They move the rook to d8: checkmate.');
  });
  it('summary wording', () => {
    const line = (delta: number) => ({ delta, mate: false, plies: [], extra: [], end: 1, cashed: null });
    expect(classify(line(-3), line(0), null)).toBe('allowed');
    const s = summarize('allowed', line(-3), line(0), 'Nxe5', 'Nxd4');
    expect(s).toContain('lets them win material');
    expect(s).toContain('Nxd4 keeps material level');
    expect(classify(line(0), line(3), null)).toBe('missed');
    expect(summarize('missed', line(0), line(3), 'a3', 'Bxf7+')).toContain('You missed Bxf7+, which wins 3 points');
    expect(classify(line(0), line(0), { kind: 'tactic' })).toBe('allowed');
    expect(s).not.toContain('Line A');
  });
  it('pass line shows the threat', () => {
    const board = Board.fromFen('r1b1kbnr/pppp1ppp/8/4N1q1/2BnP3/8/PPPP1PPP/RNBQK2R w KQkq - 1 5');
    const [first, second] = passLine(board, { move: 'g5g2', from: 'g5', to: 'g2' }, 'white');
    expect([first.san, first.turn, first.lastMove]).toEqual(['(pass)', 'black', null]);
    expect(first.caption.startsWith('Imagine you skip your move')).toBe(true);
    expect([second.san, second.delta]).toEqual(['Qxg2', -1]);
  });
});

describe('coach tools', () => {
  const fixed = (lines: any[]) => ({ evaluate: async () => lines });
  const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  it('formats evaluations from the player side', async () => {
    const lines = [
      { move: 'e2e4', cp: 35, mate: null, pv: ['e2e4'] },
      { move: 'd2d4', cp: null, mate: 2, pv: ['d2d4'] },
      { move: 'g1f3', cp: null, mate: -1, pv: ['g1f3'] },
    ];
    const w: any = await runCoachTool('engine_analyse', { fen: start }, 'white', fixed(lines));
    expect(w.candidates.map((c: any) => c.eval_for_player)).toEqual(['+0.35', 'mate in 2', 'mated in 1']);
    const b: any = await runCoachTool('engine_analyse', { fen: start }, 'black', fixed(lines));
    expect(b.candidates.map((c: any) => c.eval_for_player)).toEqual(['-0.35', 'mated in 2', 'mate in 1']);
  });
  it('rejects unknown tools', async () => {
    await expect(runCoachTool('nope', { fen: start }, 'white', fixed([]))).rejects.toThrow('unknown tool nope');
  });
  it('accepts castling written with zeros', async () => {
    const fen = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
    const r: any = await runCoachTool('play_moves', { fen, moves: ['0-0'] }, 'white', fixed([]));
    expect(r.steps[0].fen.startsWith('r3k2r/8/8/8/8/8/8/R4RK1 b')).toBe(true);
  });
});

describe('game links', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads Lichess and chess.com game links, and nothing else', () => {
    expect(parseGameLink('https://lichess.org/AbCd1234')).toEqual({ site: 'lichess', id: 'AbCd1234' });
    expect(parseGameLink('lichess.org/AbCd1234WxYz/black')).toEqual({ site: 'lichess', id: 'AbCd1234' });
    expect(parseGameLink('https://lichess.org/AbCd1234#32')).toEqual({ site: 'lichess', id: 'AbCd1234' });
    expect(parseGameLink('https://www.chess.com/game/live/123456789')).toEqual({ site: 'chess.com', id: '123456789' });
    expect(parseGameLink('https://www.chess.com/game/daily/987?move=3')).toEqual({ site: 'chess.com', id: '987' });
    expect(parseGameLink('https://www.chess.com/live/game/42')).toEqual({ site: 'chess.com', id: '42' });
    expect(parseGameLink('https://lichess.org/study/AbCd1234')).toBeNull();
    expect(parseGameLink('1. e4 e5 2. Nf3')).toBeNull();
  });

  it('fetches a Lichess game by its id', async () => {
    const fetch = vi.fn(async (_url: string) => new Response('[Event "x"]\n\n1. e4 *'));
    vi.stubGlobal('fetch', fetch);
    expect(await pgnFromLink({ site: 'lichess', id: 'AbCd1234' })).toContain('1. e4');
    expect(String(fetch.mock.calls[0][0])).toMatch(/^https:\/\/lichess\.org\/game\/export\/AbCd1234\?/);
  });

  it('finds a chess.com game in the player\'s recent months', async () => {
    const months = ['https://api.chess.com/pub/player/me/games/2026/09', 'https://api.chess.com/pub/player/me/games/2026/10'];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(
      url.endsWith('/archives') ? { archives: months }
        : url.endsWith('/10') ? { games: [{ url: 'https://www.chess.com/game/live/111', pgn: 'newer' }] }
          : { games: [{ url: 'https://www.chess.com/game/live/123', pgn: 'the game' }] })));
    expect(await pgnFromLink({ site: 'chess.com', id: '123' }, ['Me'])).toBe('the game');
    await expect(pgnFromLink({ site: 'chess.com', id: '999' }, ['Me'])).rejects.toThrow(/not among the last 3 months/);
    await expect(pgnFromLink({ site: 'chess.com', id: '123' }, [])).rejects.toThrow(/add your chess.com username/);
  });
});

describe('promotion wording', () => {
  it('names an under-promotion as what it is (reasons.py _promotes)', () => {
    expect(promotes('queen', 'b8')).toBe('queens on b8');
    expect(promotes('rook', 'b8')).toBe('promotes to a rook on b8');
  });
});
