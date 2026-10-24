// Port of blunder/records.py: the per-move records the board UI renders.
import { parsePgn, startingPosition } from 'chessops/pgn';
import { parseSan } from 'chessops/san';
import { makeFen } from 'chessops/fen';
import { Board, Mv, parseSq, sq, uci } from './board';
import type { Role } from './board';

const VALUES: Record<Role, number> = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 0 };
const HEADERS = ['White', 'Black', 'WhiteElo', 'BlackElo', 'Result', 'Date', 'Event', 'Site', 'TimeControl'];
const MAX_INPUT_CHARS = 200_000;

export type Rec = Record<string, any>;

export class InputError extends Error {}

export function material(board: Board): { white: number; black: number } {
  const out = { white: 0, black: 0 };
  for (const [, p] of board.pieceMapDesc()) out[p.color] += VALUES[p.role];
  return out;
}

/** Legal moves in chessground's movable.dests shape: {from: [to, ...]}. */
export function legalDests(board: Board): Record<string, string[]> {
  const dests: Record<string, string[]> = {};
  for (const m of board.legalMoves()) {
    const targets = (dests[sq(m.from)] ??= []);
    if (!targets.includes(sq(m.to))) targets.push(sq(m.to));
  }
  return dests;
}

export function positionRecord(board: Board, ply: number, move: Mv | null, san: string | null): Rec {
  return {
    ply,
    san,
    uci: move ? uci(move) : null,
    lastMove: move ? [sq(move.from), sq(move.to)] : null,
    fen: board.fen(),
    turn: board.turn,
    check: board.isCheck(),
    dests: legalDests(board),
    outcome: board.outcomeResult(),
    material: material(board),
  };
}

/** Parse a FEN or a PGN into {headers, records}; records[0] is the start position. */
export function load(text: string): { headers: Record<string, string>; records: Rec[] } {
  text = (text || '').trim();
  if (!text) throw new InputError('Paste a PGN or a FEN.');
  if (text.length > MAX_INPUT_CHARS) throw new InputError('Input is too long.');
  if (!text.includes('\n') && !text.includes('[') && text.includes('/')) {
    let board: Board;
    try {
      board = Board.fromFen(text);
    } catch (e) {
      throw new InputError(`Not a valid FEN: ${(e as Error).message}`);
    }
    return { headers: {}, records: [positionRecord(board, board.ply(), null, null)] };
  }
  const games = parsePgn(text);
  if (!games.length) throw new InputError('Could not read a PGN game.');
  const game = games[0];
  const start = startingPosition(game.headers);
  if (start.isErr) throw new InputError(`PGN error: ${start.error.message}`);
  const board = Board.fromFen(makeFen(start.value.toSetup()));
  const records = [positionRecord(board, board.ply(), null, null)];
  for (const node of game.moves.mainline()) {
    const m = parseSan(board.pos, node.san);
    if (!m || !('from' in m)) throw new InputError(`PGN error: illegal san: '${node.san}' in ${board.fen()}`);
    const mv = board.fromChessops(m);
    const san = board.san(mv);
    board.push(mv);
    records.push(positionRecord(board, board.ply(), mv, san));
  }
  if (records.length === 1 && !game.headers.get('FEN')) throw new InputError('The PGN has no moves.');
  const headers: Record<string, string> = {};
  for (const k of HEADERS) {
    const v = game.headers.get(k);
    if (v !== undefined) headers[k] = v;
  }
  return { headers, records };
}

export function play(fen: string, uciStr: string): Rec {
  let board: Board;
  try {
    board = Board.fromFen(fen);
  } catch (e) {
    throw new InputError((e as Error).message);
  }
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uciStr)) throw new InputError(`Invalid move ${uciStr}.`);
  let promo = uciStr.slice(4);
  const fromPiece = board.pieceAt(parseSq(uciStr.slice(0, 2)));
  if (!promo && fromPiece?.role === 'pawn' && /[18]$/.test(uciStr.slice(2, 4))) promo = 'q'; // auto-queen
  const mv = board.legalMoves().find((x) => uci(x) === uciStr.slice(0, 4) + promo);
  if (!mv) throw new InputError(`Illegal move ${uciStr}.`);
  const san = board.san(mv);
  board.push(mv);
  return positionRecord(board, board.ply(), mv, san);
}
