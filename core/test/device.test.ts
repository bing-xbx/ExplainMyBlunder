// The phone-only pieces: the UCI engine wrapper and the whole-game review.
import { describe, expect, it } from 'vitest';
import { RecordedEvaluator, UciEngine, gameId, lichessScores, parseInfo, playedAt, reviewGame, splitPgns } from '../src';

describe('parseInfo', () => {
  it('turns side-to-move scores into White point of view', () => {
    const l = 'info depth 18 seldepth 25 multipv 2 score cp 35 nodes 250000 nps 500000 pv e7e5 g1f3';
    expect(parseInfo(l, true)).toEqual({ multipv: 2, move: 'e7e5', cp: 35, mate: null, pv: ['e7e5', 'g1f3'], depth: 18 });
    expect(parseInfo(l, false)!.cp).toBe(-35);
    expect(parseInfo('info depth 9 score mate 3 pv d8h4', false)!.mate).toBe(-3);
  });
  it('ignores lines without a pv', () => {
    expect(parseInfo('info string NNUE evaluation enabled', true)).toBeNull();
    expect(parseInfo('info depth 1 currmove e2e4 currmovenumber 1', true)).toBeNull();
  });
});

describe('UciEngine', () => {
  function fakeEngine() {
    const sent: string[] = [];
    let cb: (l: string) => void = () => {};
    const port = { send: (c: string) => { sent.push(c); if (c === 'isready') queueMicrotask(() => cb('readyok')); }, onLine: (f: any) => (cb = f) };
    return { sent, port, say: (l: string) => cb(l) };
  }
  it('keeps the last info per multipv and answers in order', async () => {
    const f = fakeEngine();
    const e = new UciEngine(f.port);
    const p = e.search('8/8/8/8/8/8/8/K6k b - - 0 1', { nodes: 100 }, 2);
    await new Promise((r) => setTimeout(r, 0));
    expect(f.sent.slice(-3)).toEqual(['setoption name MultiPV value 2', 'position fen 8/8/8/8/8/8/8/K6k b - - 0 1', 'go nodes 100']);
    f.say('info depth 1 multipv 1 score cp 10 pv h1g1');
    f.say('info depth 2 multipv 1 score cp 20 pv h1g2');
    f.say('info depth 2 multipv 2 score cp 5 pv h1h2');
    f.say('bestmove h1g2');
    expect((await p).map((l) => [l.move, l.cp])).toEqual([['h1g2', -20], ['h1h2', -5]]);
  });
  it('rejects an aborted search', async () => {
    const f = fakeEngine();
    const e = new UciEngine(f.port);
    const ac = new AbortController();
    const p = e.search('8/8/8/8/8/8/8/K6k w - - 0 1', { movetime: 100 }, 1, { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 0));
    ac.abort();
    expect(f.sent.at(-1)).toBe('stop');
    f.say('bestmove a1a2');
    await expect(p).rejects.toThrow('aborted');
  });
});

describe('reviews', () => {
  const pgn = '[Event "x"]\n[Site "https://lichess.org/AbCd1234"]\n[UTCDate "2026.10.18"]\n[UTCTime "20:01:02"]\n[White "Me"]\n[Black "You"]\n\n1. f3 e5 2. g4 Qh4# 0-1';
  it('ids, dates and splitting like fetch.py / review.py', () => {
    expect(gameId(pgn)).toBe('AbCd1234');
    // chess.com: Site is just "Chess.com", the URL is in Link
    expect(gameId('[Site "Chess.com"]\n[Link "https://www.chess.com/game/live/185724111430"]\n\n1. e4 *')).toBe('chesscom-185724111430');
    expect(playedAt(pgn)).toBe('2026.10.18 20:01:02');
    // a bare site URL names no game: a hash of the text, the same one fetch.py gives
    expect(gameId('[Site "https://lichess.org"]\n\n1. e4 é5 *')).toBe('gh5vrw4');
    expect(splitPgns(pgn + '\n\n\n' + pgn.replace('AbCd1234', 'Zz')).map(gameId)).toEqual(['AbCd1234', 'Zz']);
  });
  it('a whole game, judged with recorded engine answers', async () => {
    const calls: Record<string, any> = {};
    const ev = new RecordedEvaluator(calls);
    // every position: "equal", except after 2. g4 where Black mates in 1
    ev.evaluate = async (board: any) => [board.fen().startsWith('rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2')
      ? { move: 'd8h4', cp: null, mate: -1, pv: ['d8h4'] } : { move: 'a2a3', cp: 0, mate: null, pv: ['a2a3'] }];
    const r = await reviewGame(pgn, ev, 'Me', undefined, false);
    expect(r.id).toBe('AbCd1234');
    expect(r.you).toBe('white');
    expect(r.records).toHaveLength(5);
    expect(r.moments.map((m: any) => [m.index, m.san, m.judgement])).toEqual([[3, 'g4', 'blunder']]);
  });
});

describe('Lichess analysis', () => {
  const pgn = '[Event "x"]\n[Site "https://lichess.org/Lc1"]\n[White "Me"]\n[Black "You"]\n\n' +
    '1. e4 { [%eval 0.3] } 1... e5 { [%eval 0.3] } 2. Qh5 { [%eval -0.2] } 2... Ke7?? { (-0.2 → 5.1) Blunder. Nc6 was best. } { [%eval 5.1] } ' +
    '(2... Nc6 3. Bc4) 3. Qxe5+ { [%eval #4] } 1-0';
  const moves = ['e2e4', 'e7e5', 'd1h5', 'e8e7', 'h5e5'];
  const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  it('reads one score per position', () => {
    const s = lichessScores(pgn, start, moves)!;
    expect(s.map((x) => [x.cp, x.mate])).toEqual([[20, null], [30, null], [30, null], [-20, null], [510, null], [null, null]]);
    expect(s[5].terminal).toBe('1-0'); // 3. Qxe5 is mate: finished positions score as finished, whatever the comment says
  });
  it('gives up when a move has no score', () => {
    expect(lichessScores(pgn.replace('{ [%eval 0.3] } 1... e5', '1... e5'), start, moves)).toBeNull();
  });
  it('gives up on a game from another position (the opening edge is the standard start only)', () => {
    const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    const p = '[Event "x"]\n[FEN "' + fen + '"]\n[SetUp "1"]\n\n1... e5 { [%eval 0.3] } *';
    expect(lichessScores(p, fen, ['e7e5'])).toBeNull();
  });
  it('judges from them, asking the engine only for the best move before a judged move', async () => {
    const asked: string[] = [];
    const ev = { evaluate: async (b: any) => { asked.push(b.fen()); return [{ move: 'b8c6', cp: 0, mate: null, pv: ['b8c6'] }]; } };
    const r = await reviewGame(pgn, ev as any, 'Me', undefined, false, true);
    expect(r.scoresFrom).toBe('lichess');
    expect(r.moments.filter((m: any) => m.judgement === 'blunder').map((m: any) => [m.san, m.bestSan, m.pending])).toEqual([['Ke7', 'Nc6', true]]);
    expect(asked.length).toBe(r.moments.length);
  });
});
