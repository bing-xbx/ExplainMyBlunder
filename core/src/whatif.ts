// Port of blunder/whatif.py: explain any move you try, in any position.
import { Board, moveFromUci, sameMove, squareRank, uci } from './board';
import type { Evaluator } from './engine';
import { score } from './engine';
import { judge, povWc, round3 } from './analyze';
import { explainPosition } from './explain';
import type { Facts } from './detect';

export async function explainTry(fen: string, uciStr: string, evaluator: Evaluator): Promise<Facts> {
  const board = Board.fromFen(fen);
  const move = moveFromUci(uciStr);
  if (!move.promotion && board.pieceAt(move.from)?.role === 'pawn' && [0, 7].includes(squareRank(move.to))) move.promotion = 'queen';
  if (!board.isLegal(move)) throw new Error(`Illegal move ${uciStr}.`);
  const color = board.turn;
  const lines = await evaluator.evaluate(board, 2);
  if (!lines.length) throw new Error('The game is over in this position.');
  const top = moveFromUci(lines[0].move);
  const isBest = sameMove(top, move);
  let alt = isBest && lines.length > 1 ? moveFromUci(lines[1].move) : top;
  if (sameMove(alt, move)) alt = top;

  const before = await score(evaluator, board);
  const afterBoard = board.copy();
  afterBoard.push(move);
  const after = await score(evaluator, afterBoard);
  const [judgement, drop] = judge(before, after, color);

  const card = await explainPosition(board, move, alt, evaluator);
  if (isBest) {
    card.kind = 'best';
    card.summary = `${board.san(move)} is the engine's top move. The other line shows the next best, ${board.san(alt)}, for comparison.`;
  }
  return {
    index: null, ply: board.ply() + 1, color,
    san: board.san(move), uci: uci(move), best: uci(alt), bestSan: board.san(alt),
    judgement, drop: round3(drop), isBest,
    wcBefore: round3(povWc(before, color)), wcAfter: round3(povWc(after, color)),
    card,
  };
}
