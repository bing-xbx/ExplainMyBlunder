// The engine as the core sees it: the same shape as blunder/analyze.py's Evaluator.
// Scores are from White's point of view; `move` and `pv` are UCI strings.
import { Board } from './board';

export interface Line {
  move: string;
  cp: number | null;
  mate: number | null;
  pv: string[];
  depth?: number | null;
}

export interface Score {
  cp: number | null;
  mate: number | null;
  best?: string;
  pv?: string[];
  terminal?: '1-0' | '0-1' | '1/2-1/2';
}

export interface Evaluator {
  evaluate(board: Board, multipv?: number): Promise<Line[]>;
}

/** The cache key the Python side uses: python-chess epd() + multipv. */
export const engineKey = (board: Board, multipv: number) => `${board.epd()}|${multipv}`;

/** White-POV score of a position, including finished games (analyze.Evaluator.score). */
export async function score(evaluator: Evaluator, board: Board): Promise<Score> {
  if (board.isCheckmate()) return { cp: null, mate: null, terminal: board.turn === 'black' ? '1-0' : '0-1' };
  if (board.isGameOver()) return { cp: 0, mate: null, terminal: '1/2-1/2' };
  const top = (await evaluator.evaluate(board))[0];
  return { cp: top.cp, mate: top.mate, best: top.move, pv: top.pv };
}

/** Replays engine answers recorded by the Python side (parity tests, offline demos). */
export class RecordedEvaluator implements Evaluator {
  missing: string[] = [];

  constructor(private calls: Record<string, Line[]>) {}

  async evaluate(board: Board, multipv = 1): Promise<Line[]> {
    const key = engineKey(board, multipv);
    const lines = this.calls[key];
    if (!lines) {
      this.missing.push(key);
      throw new Error(`no recorded engine answer for ${key}`);
    }
    return lines;
  }
}
