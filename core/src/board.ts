// A chessops adapter with UCI move notation and consistent position serialization.
// Compatibility conventions:
// - chessops encodes castling as "king takes own rook" (e1h1); here, as in
//   python-chess and UCI engines, castling is the king's two-square move (e1g1);
// - FEN/EPD write the en-passant square only when an en-passant capture is legal
//   (python-chess's default), so engine-cache keys match;
// - square iteration orders match python-chess where results depend on them.
import { Chess, castlingSide, normalizeMove } from 'chessops/chess';
import { attacks, between } from 'chessops/attacks';
import { makeBoardFen, makeCastlingFen, parseFen } from 'chessops/fen';
import { makeSan, parseSan as parseSanChessops } from 'chessops/san';
import { SquareSet } from 'chessops/squareSet';
import type { Color, NormalMove, Piece, Role, Square } from 'chessops/types';
import { kingCastlesTo, makeSquare, opposite, parseSquare, squareFile, squareRank } from 'chessops/util';

export type { Color, Piece, Role, Square };
export { SquareSet, between, makeSquare, opposite, parseSquare, squareFile, squareRank };

/** A move as python-chess sees it: castling is the king's two-square move. */
export interface Mv {
  from: Square;
  to: Square;
  promotion?: Role;
}

const PROMOS: Role[] = ['queen', 'rook', 'bishop', 'knight']; // python-chess generation order
const ROLE_CHAR: Record<Role, string> = { pawn: 'p', knight: 'n', bishop: 'b', rook: 'r', queen: 'q', king: 'k' };
const CHAR_ROLE: Record<string, Role> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

export const sq = (s: Square): string => makeSquare(s);
export const parseSq = (name: string): Square => parseSquare(name) as Square;

export function uci(m: Mv): string {
  return sq(m.from) + sq(m.to) + (m.promotion ? ROLE_CHAR[m.promotion] : '');
}

export function moveFromUci(s: string): Mv {
  const m: Mv = { from: parseSq(s.slice(0, 2)), to: parseSq(s.slice(2, 4)) };
  if (s.length > 4) m.promotion = CHAR_ROLE[s[4]];
  return m;
}

export const sameMove = (a: Mv, b: Mv) => a.from === b.from && a.to === b.to && (a.promotion ?? null) === (b.promotion ?? null);

export class Board {
  pos: Chess;

  private constructor(pos: Chess) {
    this.pos = pos;
  }

  static fromFen(fen: string): Board {
    const setup = parseFen(fen).unwrap();
    return new Board(Chess.fromSetup(setup).unwrap());
  }

  /** The same position with the other side to move and no en-passant square: a "pass". */
  passed(): Board {
    const setup = this.pos.toSetup();
    setup.turn = opposite(setup.turn);
    setup.epSquare = undefined;
    return new Board(Chess.fromSetup(setup).unwrap());
  }

  copy(): Board {
    return new Board(this.pos.clone());
  }

  get turn(): Color {
    return this.pos.turn;
  }

  get occupied(): SquareSet {
    return this.pos.board.occupied;
  }

  occupiedCo(color: Color): SquareSet {
    return this.pos.board[color];
  }

  pieceAt(s: Square): Piece | undefined {
    return this.pos.board.get(s);
  }

  pieces(role: Role, color: Color): SquareSet {
    return this.pos.board.pieces(color, role);
  }

  king(color: Color): Square | undefined {
    return this.pos.board.kingOf(color);
  }

  /** Squares attacked by the piece on `s` (empty if none). */
  attacksMask(s: Square): SquareSet {
    const p = this.pieceAt(s);
    return p ? attacks(p, s, this.occupied) : SquareSet.empty();
  }

  /** Pieces of `color` attacking `s`, sliders seeing through squares missing from `occupied`. */
  attackersMask(color: Color, s: Square, occupied: SquareSet = this.occupied): SquareSet {
    return this.pos.kingAttackers(s, color, occupied);
  }

  /** Occupied squares, highest first: python-chess's piece_map() order. */
  pieceMapDesc(): Array<[Square, Piece]> {
    const out: Array<[Square, Piece]> = [];
    for (const s of this.occupied.reversed()) out.push([s, this.pieceAt(s)!]);
    return out;
  }

  // ---- moves ----

  private toChessops(m: Mv): NormalMove {
    return normalizeMove(this.pos, { from: m.from, to: m.to, promotion: m.promotion }) as NormalMove;
  }

  /** A chessops move (castling as king-takes-rook) as a python-style move. */
  fromChessops(m: NormalMove): Mv {
    const side = castlingSide(this.pos, m);
    if (side) return { from: m.from, to: kingCastlesTo(this.pos.turn, side) };
    return m.promotion ? { from: m.from, to: m.to, promotion: m.promotion } : { from: m.from, to: m.to };
  }

  /** Legal moves, python-style (castling e1g1, four promotions per promoting move). */
  legalMoves(): Mv[] {
    const out: Mv[] = [];
    const seen = new Set<string>();
    for (const [from, dests] of this.pos.allDests()) {
      const piece = this.pieceAt(from)!;
      for (const to of dests) {
        const base = this.fromChessops({ from, to });
        const lastRank = squareRank(base.to) === (piece.color === 'white' ? 7 : 0);
        const variants = piece.role === 'pawn' && lastRank ? PROMOS.map((r) => ({ ...base, promotion: r })) : [base];
        for (const v of variants) {
          const key = uci(v);
          if (!seen.has(key)) {
            seen.add(key);
            out.push(v);
          }
        }
      }
    }
    return out;
  }

  isLegal(m: Mv): boolean {
    return this.legalMoves().some((x) => sameMove(x, m));
  }

  push(m: Mv): void {
    this.pos.play(this.toChessops(m));
  }

  san(m: Mv): string {
    return makeSan(this.pos, this.toChessops(m));
  }

  /** python-chess parse_san: a legal move, or null if illegal, ambiguous or not SAN. */
  parseSan(san: string): Mv | null {
    const s = san.trim().replace(/[!?]+$/, '').replace(/^0-0-0/, 'O-O-O').replace(/^0-0/, 'O-O');
    const m = parseSanChessops(this.pos, s);
    if (!m || !('from' in m)) return null;
    return this.fromChessops(m);
  }

  isCastling(m: Mv): boolean {
    return castlingSide(this.pos, this.toChessops(m)) !== undefined;
  }

  isEnPassant(m: Mv): boolean {
    const p = this.pieceAt(m.from);
    return !!p && p.role === 'pawn' && m.to === this.pos.epSquare && squareFile(m.from) !== squareFile(m.to) && !this.pieceAt(m.to);
  }

  isCapture(m: Mv): boolean {
    if (this.isCastling(m)) return false;
    const victim = this.pieceAt(m.to);
    return (!!victim && victim.color !== this.turn) || this.isEnPassant(m);
  }

  // ---- state ----

  isCheck(): boolean {
    return this.pos.isCheck();
  }

  isCheckmate(): boolean {
    return this.pos.isCheckmate();
  }

  /** python-chess is_game_over() without repetition: mate, stalemate, insufficient material, 75 moves. */
  isGameOver(): boolean {
    return this.pos.isEnd() || this.pos.halfmoves >= 150;
  }

  outcomeResult(): string | null {
    if (!this.isGameOver()) return null;
    if (this.pos.isCheckmate()) return this.turn === 'white' ? '0-1' : '1-0';
    return '1/2-1/2';
  }

  ply(): number {
    return 2 * (this.pos.fullmoves - 1) + (this.turn === 'black' ? 1 : 0);
  }

  hasCastlingRights(color: Color): boolean {
    return this.pos.castles.castlingRights.intersect(SquareSet.backrank(color)).nonEmpty();
  }

  private legalEp(): string {
    const ep = this.pos.epSquare;
    if (ep === undefined) return '-';
    const ok = this.legalMoves().some((m) => m.to === ep && this.isEnPassant(m));
    return ok ? sq(ep) : '-';
  }

  /** python-chess epd(): no move counters, en passant only when legal. */
  epd(): string {
    const castling = makeCastlingFen(this.pos.board, this.pos.castles.castlingRights);
    return `${makeBoardFen(this.pos.board)} ${this.turn === 'white' ? 'w' : 'b'} ${castling} ${this.legalEp()}`;
  }

  fen(): string {
    return `${this.epd()} ${this.pos.halfmoves} ${this.pos.fullmoves}`;
  }
}
