// Run the coach's analysis tools on the device using the same engine and facts as the board.
// The hosted service requests tools; the app returns the analysis results.
import { Board, moveFromUci } from './board';
import type { Color } from './board';
import { VALUES, hanging, moveFacts, threat } from './detect';
import type { Evaluator, Line } from './engine';

export const COACH_TOOLS = ['engine_analyse', 'play_moves', 'move_facts', 'threats'] as const;

const sideName = (c: Color) => (c === 'white' ? 'white' : 'black');

/** An evaluation from the player's side: "+0.35", "mate in 2", "mated in 1". */
function pov(line: Line, you: Color): string {
  if (line.mate !== null) {
    const m = you === 'white' ? line.mate : -line.mate;
    return m > 0 ? `mate in ${m}` : `mated in ${-m}`;
  }
  const x = (you === 'white' ? line.cp! : -line.cp!) / 100;
  return `${x >= 0 ? '+' : '-'}${Math.abs(x).toFixed(2)}`;
}

/** One tool call; throws on an unknown tool or a bad FEN (the caller reports it to the model). */
export async function runCoachTool(name: string, input: any, you: 'white' | 'black', evaluator: Evaluator): Promise<object> {
  const board = Board.fromFen(String(input.fen));
  if (name === 'engine_analyse') {
    const n = Math.max(1, Math.min(Math.trunc(Number(input.lines ?? 3)) || 0, 3));
    const candidates = [];
    for (const line of await evaluator.evaluate(board, n)) {
      const b = board.copy();
      const sans: string[] = [];
      for (const u of line.pv.slice(0, 8)) {
        const m = moveFromUci(u);
        sans.push(b.san(m));
        b.push(m);
      }
      candidates.push({ move: sans[0], eval_for_player: pov(line, you), line: sans.join(' ') });
    }
    return { side_to_move: sideName(board.turn), candidates };
  }
  if (name === 'play_moves') {
    const steps = [];
    for (const san of (input.moves as string[]).slice(0, 20)) {
      const m = board.parseSan(san);
      if (!m) return { steps, error: `${san} is not legal here (${sideName(board.turn)} to move)` };
      board.push(m);
      const material = { white: 0, black: 0 };
      for (const [, p] of board.pieceMapDesc()) material[p.color] += p.role !== 'king' ? VALUES[p.role] : 0;
      steps.push({ move: san, fen: board.fen(), material, check: board.isCheck(), checkmate: board.isCheckmate() });
    }
    return { steps };
  }
  if (name === 'move_facts') {
    const m = board.parseSan(String(input.move));
    if (!m) return { error: `${input.move} is not legal here` };
    return moveFacts(board, m);
  }
  if (name === 'threats') {
    const side: Color = board.turn === 'white' ? 'black' : 'white';
    const t = !board.isCheck() ? await threat(board, evaluator, side) : null;
    return {
      threatening_side: sideName(side),
      threat: t,
      hanging_white: hanging(board, 'white'),
      hanging_black: hanging(board, 'black'),
    };
  }
  throw new Error(`unknown tool ${name}`);
}
