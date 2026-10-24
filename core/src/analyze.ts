// Port of blunder/analyze.py: judge every move like Lichess does.
import { Board, moveFromUci } from './board';
import type { Color } from './board';
import { Evaluator, Score, score } from './engine';

const WC_JUDGEMENTS: Array<[number, string]> = [[0.3, 'blunder'], [0.2, 'mistake'], [0.1, 'inaccuracy']];
const CP_CEILING = 1000;

/** Lichess formula, in [-1, 1] from White's point of view. */
export const winningChances = (cp: number) => 2 / (1 + Math.exp(-0.00368208 * cp)) - 1;

/** Python's round(x, n): round half to even, but only on an exact binary tie, and
 *  otherwise round the stored double's true decimal value (what toFixed gives).
 *  Scaling by 10^n first would be wrong: 91.45 * 10 is exactly 914.5 in binary even
 *  though the stored 91.45 is slightly above, so Python rounds it up and we must too. */
function roundTo(x: number, digits: number): number {
  if (x === 0) return x; // keep -0: Python's round(-0.0, n) is -0.0, and toFixed drops the sign
  const exact = x.toFixed(20); // the stored value, written out in decimal
  const start = exact.indexOf('.') + 1 + digits;
  if (/^50*$/.test(exact.slice(start))) {
    const truncated = Number(exact.slice(0, start));
    const unit = 10 ** -digits;
    const low = Number(exact[start - 1]);
    const r = low % 2 === 0 ? truncated : truncated + (x < 0 ? -unit : unit);
    return r === 0 ? (x < 0 ? -0 : 0) : Number(r.toFixed(digits));
  }
  return Number(x.toFixed(digits));
}

export const round1 = (x: number) => roundTo(x, 1);
export const round3 = (x: number) => roundTo(x, 3);

export function povWc(s: Score, color: Color): number {
  let wc: number;
  if (s.terminal) wc = s.terminal === '1-0' ? 1 : s.terminal === '0-1' ? -1 : 0;
  else if (s.mate !== null) wc = s.mate > 0 ? 1 : -1;
  else wc = winningChances(Math.max(-CP_CEILING, Math.min(CP_CEILING, s.cp!)));
  return color === 'white' ? wc : -wc;
}

function povMate(s: Score, color: Color): number | null {
  if (s.terminal === '1-0' || s.terminal === '0-1') return (s.terminal === '1-0') === (color === 'white') ? 1 : -1;
  if (s.mate === null || s.mate === undefined) return null;
  return color === 'white' ? s.mate : -s.mate;
}

const povCp = (s: Score, color: Color) => (color === 'white' ? 1 : -1) * (s.cp || 0);

export function judge(before: Score, after: Score, color: Color): [string | null, number] {
  const mb = povMate(before, color), ma = povMate(after, color);
  const drop = povWc(before, color) - povWc(after, color);
  if (ma !== null && ma < 0 && mb === null) {
    const cp = povCp(before, color);
    return [cp < -999 ? 'inaccuracy' : cp < -700 ? 'mistake' : 'blunder', drop];
  }
  if (mb !== null && mb > 0) {
    if (ma === null) {
      const cp = povCp(after, color);
      return [cp > 999 ? 'inaccuracy' : cp > 700 ? 'mistake' : 'blunder', drop];
    }
    if (ma < 0) return ['blunder', drop];
    return [null, drop];
  }
  if (mb !== null || ma !== null) return [null, drop];
  for (const [threshold, label] of WC_JUDGEMENTS) if (drop >= threshold) return [label, drop];
  return [null, drop];
}

export type Moment = Record<string, any>;

/** Evaluate every position of a game and judge every move. `moves` are UCI strings. */
export async function findMoments(startFen: string, moves: string[], evaluator: Evaluator,
                                  progress?: (done: number, total: number) => void,
                                  given?: Score[]): Promise<{ scores: Score[]; moments: Moment[] }> {
  let board = Board.fromFen(startFen);
  let scores: Score[];
  if (given) {
    // Scores supplied (e.g. Lichess's own analysis): no engine search except for the best
    // move before each judged move, below.
    scores = given;
  } else {
    scores = [await score(evaluator, board)];
    for (let i = 0; i < moves.length; i++) {
      board.push(moveFromUci(moves[i]));
      scores.push(await score(evaluator, board));
      progress?.(i + 1, moves.length);
    }
  }
  board = Board.fromFen(startFen);
  const moments: Moment[] = [];
  for (let i = 0; i < moves.length; i++) {
    const move = moveFromUci(moves[i]);
    const color = board.turn;
    const before = scores[i], after = scores[i + 1];
    const [judgement, drop] = judge(before, after, color);
    if (judgement) {
      if (given && !before.best && !before.terminal) {
        const top = (await evaluator.evaluate(board))[0];
        if (top) Object.assign(before, { best: top.move, pv: top.pv });
      }
      const best = before.best ?? null;
      const wcBefore = povWc(before, color), wcAfter = povWc(after, color);
      moments.push({
        index: i + 1,
        ply: board.ply() + 1,
        color,
        san: board.san(move),
        uci: moves[i],
        best,
        bestSan: best ? board.san(moveFromUci(best)) : null,
        judgement,
        drop: round3(drop),
        wcBefore: round3(wcBefore),
        wcAfter: round3(wcAfter),
        kind: wcBefore >= 0.3 && wcAfter > -0.1 ? 'missed_win' : 'blunder',
      });
    }
    board.push(move);
  }
  return { scores, moments };
}
