// Parse PGN games and assemble complete game reviews.
import { parsePgn } from 'chessops/pgn';
import type { Evaluator, Score } from './engine';
import { Board, moveFromUci } from './board';
import { findMoments } from './analyze';
import { explainMoment } from './explain';
import { load } from './records';

export type Review = Record<string, any>;

const STANDARD_START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';

export function userColor(headers: Record<string, string>, user: string | null | undefined): 'white' | 'black' | null {
  if (!user) return null;
  const u = user.toLowerCase();
  if ((headers.White || '').toLowerCase() === u) return 'white';
  if ((headers.Black || '').toLowerCase() === u) return 'black';
  return null;
}

/** fetch.game_id: the last part of the game's URL. Lichess puts it in Site; chess.com's Site is
 *  just "Chess.com", its URL is in Link, and its ids get a "chesscom-" prefix. */
export function gameId(pgn: string): string {
  const m = /\[Link "([^"]+)"\]/.exec(pgn) || /\[Site "([^"]+)"\]/.exec(pgn);
  const url = m ? m[1].replace(/\/+$/, '') : '';
  // only a URL with a path names a game; a bare site would make every such game the same review
  const tail = /^[a-z]+:\/\/[^/]+\/./i.test(url) ? url.split('/').pop()! : hashId(pgn);
  return (url.includes('chess.com/') ? 'chesscom-' : '') + tail.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
}

function hashId(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return 'g' + (h >>> 0).toString(36);
}

/** review.played_at: when the game was played, "YYYY.MM.DD HH:MM:SS", for sorting. */
export function playedAt(pgn: string): string {
  const head = pgn.slice(0, 2000);
  const date = /\[UTCDate "([^"]+)"\]/.exec(head) || /\[Date "([^"]+)"\]/.exec(head);
  const time = /\[UTCTime "([^"]+)"\]/.exec(head);
  return `${date ? date[1] : ''} ${time ? time[1] : ''}`.trim();
}

/** Split a multi-game PGN export into one string per game. */
export function splitPgns(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split(/\n\s*\n(?=\[Event )/).map((g) => g.trim()).filter(Boolean);
}

/** Lichess's own engine scores, from the `[%eval 0.54]` / `[%eval #-3]` comments of an analysed
 *  game (White's point of view), one per position; null unless every move has one. The start
 *  position has none, so it gets the usual opening edge (so a game from another position gets
 *  null and is analysed here); finished positions score as finished. */
export function lichessScores(pgn: string, startFen: string, moves: string[]): Score[] | null {
  const game = parsePgn(pgn)[0];
  if (!game) return null;
  const evals: Array<Score | null> = [];
  for (const node of game.moves.mainline()) {
    const text = (node.comments || []).join(' ');
    const m = /\[%eval\s+(#?)(-?[\d.]+)/.exec(text);
    evals.push(!m ? null : m[1] ? { cp: null, mate: Number(m[2]) } : { cp: Math.round(Number(m[2]) * 100), mate: null });
  }
  if (evals.length !== moves.length) return null;
  // the opening edge below is the standard start's; a game from another position is analysed here
  if (Board.fromFen(startFen).epd() !== STANDARD_START) return null;
  const scores: Score[] = [{ cp: 20, mate: null }];
  const board = Board.fromFen(startFen);
  for (let i = 0; i < moves.length; i++) {
    board.push(moveFromUci(moves[i]));
    if (board.isCheckmate()) scores.push({ cp: null, mate: null, terminal: board.turn === 'black' ? '1-0' : '0-1' });
    else if (board.isGameOver()) scores.push({ cp: 0, mate: null, terminal: '1/2-1/2' });
    else if (evals[i]) scores.push(evals[i]!);
    else return null;
  }
  return scores;
}

export async function reviewGame(pgn: string, evaluator: Evaluator & { nodes?: number }, user?: string | null,
                                 progress?: (done: number, total: number) => void, explain = true,
                                 useLichess = false, inaccuracies = false): Promise<Review> {
  const loaded = load(pgn);
  const recs = loaded.records;
  const start = recs[0].fen;
  const moves = recs.slice(1).map((r) => r.uci as string);
  const lichess = useLichess ? lichessScores(pgn, start, moves) : null;
  const found = await findMoments(start, moves, evaluator, progress, lichess ?? undefined);
  const you = userColor(loaded.headers, user);
  for (const m of found.moments) {
    if (m.judgement === 'blunder' || m.judgement === 'mistake' || (inaccuracies && m.judgement === 'inaccuracy')) {
      m.mine = you === null || m.color === you;
      if (explain) m.card = await explainMoment(start, moves, m, evaluator, m.mine);
      else m.pending = true; // the card comes later (explainPending)
    }
  }
  return {
    id: gameId(pgn),
    headers: loaded.headers,
    you,
    records: recs,
    scores: found.scores,
    moments: found.moments,
    nodes: evaluator.nodes ?? null,
    played: playedAt(pgn),
    scoresFrom: lichess ? 'lichess' : 'engine',
  };
}

/** The judged moves still waiting for their card: yours first (blunders, mistakes, inaccuracies), then theirs. */
export function pendingCards(review: Review): number[] {
  const rank = (m: any) => (m.mine ? 0 : 3) + (({ blunder: 0, mistake: 1 } as Record<string, number>)[m.judgement] ?? 2);
  return review.moments.filter((m: any) => m.pending).sort((a: any, b: any) => rank(a) - rank(b) || a.index - b.index)
    .map((m: any) => m.index);
}

/** Inaccuracies without a card get one queued (the "Also explain inaccuracies" setting, for games
 *  reviewed before it was on). Returns how many were added. */
export function markInaccuracies(review: Review): number {
  let n = 0;
  for (const m of review.moments as any[]) {
    if (m.judgement !== 'inaccuracy' || m.card || m.pending) continue;
    m.mine = review.you == null || m.color === review.you;
    m.pending = true;
    n++;
  }
  return n;
}

/** Build the card of one pending judged move, in place. */
export async function explainPending(review: Review, index: number, evaluator: Evaluator): Promise<void> {
  const m = review.moments.find((x: any) => x.index === index && x.pending);
  if (!m) return;
  const start = review.records[0].fen;
  const moves = review.records.slice(1).map((r: Record<string, any>) => r.uci as string);
  m.card = await explainMoment(start, moves, m, evaluator, m.mine);
  delete m.pending;
}
