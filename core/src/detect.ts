// Find concrete tactical reasons directly from board positions, without an LLM.
import { Board, Mv, SquareSet, between, moveFromUci, opposite, parseSq, sq, squareFile, uci } from './board';
import type { Color, Role, Square } from './board';
import type { Evaluator } from './engine';

export const VALUES: Record<Role, number> = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 1000 };
export const NAMES: Record<Role, string> = { pawn: 'pawn', knight: 'knight', bishop: 'bishop', rook: 'rook', queen: 'queen', king: 'king' };
const SLIDERS: Partial<Record<Role, number[]>> = {
  bishop: [7, 9, -7, -9],
  rook: [1, -1, 8, -8],
  queen: [1, -1, 8, -8, 7, 9, -7, -9],
};

export type Facts = Record<string, any>;

export function pieceName(board: Board, s: Square): string {
  const p = board.pieceAt(s);
  return p ? NAMES[p.role] : 'square';
}

/** Least valuable attacker of `color` on `square`, given an occupancy (sees x-rays). */
function lva(board: Board, square: Square, color: Color, occupied: SquareSet): Square | undefined {
  const attackers = board.attackersMask(color, square, occupied).intersect(occupied).intersect(board.occupiedCo(color));
  let best: Square | undefined;
  let bestVal: number | undefined;
  for (const s of attackers) {
    const v = VALUES[board.pieceAt(s)!.role];
    if (bestVal === undefined || v < bestVal) {
      best = s;
      bestVal = v;
    }
  }
  return best;
}

/** Static exchange evaluation: material `side` wins by starting captures on `square`. */
export function see(board: Board, square: Square, side: Color): number {
  const target = board.pieceAt(square);
  if (!target || target.color === side) return 0;
  let occupied = board.occupied;
  let attacker = lva(board, square, side, occupied);
  if (attacker === undefined) return 0;
  const gain = [VALUES[target.role]];
  let pieceVal = VALUES[board.pieceAt(attacker)!.role];
  occupied = occupied.without(attacker);
  let color = opposite(side);
  for (;;) {
    attacker = lva(board, square, color, occupied);
    if (attacker === undefined) break;
    gain.push(pieceVal - gain[gain.length - 1]);
    pieceVal = VALUES[board.pieceAt(attacker)!.role];
    occupied = occupied.without(attacker);
    color = opposite(color);
  }
  for (let d = gain.length - 1; d > 0; d--) gain[d - 1] = -Math.max(-gain[d - 1], gain[d]);
  return Math.max(0, gain[0]);
}

export function hanging(board: Board, color: Color, minValue = 1): Facts[] {
  const out: Facts[] = [];
  for (const [s, p] of board.pieceMapDesc()) {
    if (p.color !== color || p.role === 'king' || VALUES[p.role] < minValue) continue;
    const loss = see(board, s, opposite(color));
    if (loss > 0) out.push({ square: sq(s), piece: NAMES[p.role], loss, defended: board.attackersMask(color, s).nonEmpty() });
  }
  return out;
}

function captureWins(board: Board, fromSq: Square, toSq: Square): boolean {
  const victim = VALUES[board.pieceAt(toSq)!.role];
  const attacker = VALUES[board.pieceAt(fromSq)!.role];
  const defended = board.attackersMask(opposite(board.pieceAt(fromSq)!.color), toSq).nonEmpty();
  return !defended || victim > attacker;
}

function valuableTargets(board: Board, fromSq: Square, color: Color): Facts[] {
  const attacker = board.pieceAt(fromSq)!;
  const out: Facts[] = [];
  for (const s of board.attacksMask(fromSq).intersect(board.occupiedCo(opposite(color)))) {
    const p = board.pieceAt(s)!;
    if (p.role === 'king') out.push({ square: sq(s), piece: 'king', why: 'check' });
    else if (VALUES[p.role] > VALUES[attacker.role]) out.push({ square: sq(s), piece: NAMES[p.role], why: 'bigger' });
    else if (see(board, s, color) > 0 && captureWins(board, fromSq, s)) out.push({ square: sq(s), piece: NAMES[p.role], why: 'undefended' });
  }
  return out;
}

function rayPieces(board: Board, start: Square, step: number): Square[] {
  const out: Square[] = [];
  let s = start;
  for (;;) {
    const f = squareFile(s);
    const n = s + step;
    if (n < 0 || n >= 64) return out;
    if (Math.abs(squareFile(n) - f) > 1) return out; // wrapped around the board edge
    s = n;
    if (board.pieceAt(s)) out.push(s);
  }
}

export function linesThrough(board: Board, fromSq: Square, color: Color): Facts[] {
  const p = board.pieceAt(fromSq);
  const steps = p && SLIDERS[p.role];
  if (!p || !steps) return [];
  const out: Facts[] = [];
  for (const step of steps) {
    const hits = rayPieces(board, fromSq, step);
    if (hits.length < 2) continue;
    const [front, back] = hits;
    const fp = board.pieceAt(front)!, bp = board.pieceAt(back)!;
    if (fp.color === color || bp.color === color) continue;
    const fv = VALUES[fp.role], bv = VALUES[bp.role];
    if (bp.role === 'king' || bv > fv) {
      if (fp.role === 'pawn' && bp.role !== 'king') continue;
      out.push({ kind: 'pin', attacker: sq(fromSq), pinned: sq(front), pinnedPiece: NAMES[fp.role],
                 behind: sq(back), behindPiece: NAMES[bp.role], absolute: bp.role === 'king' });
    } else if ((fv > bv && fv > VALUES[p.role]) || fp.role === 'king') {
      out.push({ kind: 'skewer', attacker: sq(fromSq), front: sq(front), frontPiece: NAMES[fp.role],
                 behind: sq(back), behindPiece: NAMES[bp.role] });
    }
  }
  return out;
}

export function trapped(board: Board, color: Color, minValue = 3): Facts[] {
  if (board.turn !== color) return [];
  const out: Facts[] = [];
  const legal = board.legalMoves();
  for (const [s, p] of board.pieceMapDesc()) {
    if (p.color !== color || p.role === 'king' || p.role === 'pawn' || VALUES[p.role] < minValue) continue;
    if (see(board, s, opposite(color)) <= 0) continue;
    const escapes: string[] = [];
    let safe = false;
    for (const m of legal) {
      if (m.from !== s) continue;
      const b = board.copy();
      const gained = b.pieceAt(m.to) ? VALUES[b.pieceAt(m.to)!.role] : 0;
      b.push(m);
      if (see(b, m.to, opposite(color)) - gained <= 0) {
        safe = true;
        break;
      }
      escapes.push(sq(m.to));
    }
    if (!safe) out.push({ square: sq(s), piece: NAMES[p.role], escapes: escapes.sort() });
  }
  return out;
}

/** Everything one move does, from the mover's side. `board` is the position before. */
export function moveFacts(board: Board, move: Mv): Facts {
  const color = board.turn;
  const after = board.copy();
  after.push(move);
  const to = move.to;
  const facts: Facts = { move: uci(move), san: board.san(move), piece: pieceName(board, move.from), from: sq(move.from), to: sq(to) };

  if (board.isCapture(move)) {
    const victim = board.pieceAt(to);
    facts.captures = victim ? NAMES[victim.role] : 'pawn';
  }
  if (after.isCheckmate()) {
    facts.mate = true;
    return facts;
  }
  facts.check = after.isCheck();

  const targets = valuableTargets(after, to, color);
  if (targets.length >= 2) facts.fork = targets;
  else if (targets.length) facts.attacks = targets;

  const lines = linesThrough(after, to, color);
  if (lines.length) facts.lines = lines;

  const disc: Facts[] = [];
  for (const s of after.occupiedCo(color)) {
    if (s === to || !SLIDERS[after.pieceAt(s)!.role]) continue;
    const beforeHits = board.pieceAt(s) ? board.attacksMask(s) : SquareSet.empty();
    for (const t of valuableTargets(after, s, color)) {
      if (!beforeHits.has(parseSq(t.square))) disc.push({ attacker: sq(s), attackerPiece: NAMES[after.pieceAt(s)!.role], ...t });
    }
  }
  if (disc.length) facts.discovered = disc;

  const beforeHang = new Set(board.isCheck() ? [] : hanging(board, color).map((h) => h.square));
  const taken = board.pieceAt(to) ? VALUES[board.pieceAt(to)!.role] : board.isEnPassant(move) ? 1 : 0;
  const newly = hanging(after, color).filter((h) => !beforeHang.has(h.square) && !(h.square === sq(to) && h.loss <= taken));
  if (newly.length) {
    facts.leaves_hanging = newly;
    const guarded = board.attacksMask(move.from);
    const unguarded = newly.filter((h) => guarded.has(parseSq(h.square)) && h.square !== sq(to));
    if (unguarded.length) facts.removes_defender = unguarded;
  }

  const theirTrapped = trapped(after, opposite(color));
  if (theirTrapped.length) facts.traps = theirTrapped;
  return facts;
}

/** Null-move probe: if the side to move passed, what would `side` play, and how much would it be worth? */
export async function threat(board: Board, evaluator: Evaluator, side: Color): Promise<Facts | null> {
  if (board.turn === side || board.isCheck()) return null;
  const real = await evaluator.evaluate(board);
  if (!real.length) return null;
  const probe = board.passed();
  const lines = await evaluator.evaluate(probe);
  if (!lines.length) return null;
  const top = lines[0];
  const pov = (line: { cp: number | null; mate: number | null }) => {
    if (line.mate !== null) return (line.mate > 0) === (side === 'white') ? 100_000 : -100_000;
    return side === 'white' ? line.cp! : -line.cp!;
  };
  const swing = pov(top) - pov(real[0]);
  const move = moveFromUci(top.move);
  const mates = top.mate !== null && (top.mate > 0) === (side === 'white');
  if (swing < 150 && !mates) return null;
  const facts = moveFacts(probe, move);
  if (!mates && !['captures', 'check', 'fork', 'lines', 'discovered', 'traps', 'mate'].some((k) => truthy(facts[k]))) return null;
  facts.swing = swing;
  facts.mateThreat = mates;
  return facts;
}

/** Python truthiness for fact values (empty lists and false are falsy). */
export function truthy(v: unknown): boolean {
  return Array.isArray(v) ? v.length > 0 : !!v;
}

function defenders(board: Board, square: Square, color: Color): Set<Square> {
  return new Set(board.attackersMask(color, square));
}

const samePiece = (a?: { role: Role; color: Color }, b?: { role: Role; color: Color }) =>
  (!a && !b) || (!!a && !!b && a.role === b.role && a.color === b.color);

/** 4c: why the best move's idea no longer works in `now` (same side to move as `before`). */
export function whyGone(before: Board, now: Board, idea: Mv, ideaThreat: Facts | null): Facts {
  const color = before.turn;
  const piece = before.pieceAt(idea.from)!;
  const out: Facts = { idea: before.san(idea), ideaFrom: sq(idea.from), ideaTo: sq(idea.to) };
  const nowPiece = now.pieceAt(idea.from);
  if (!samePiece(nowPiece, piece)) {
    let movedTo: string | null = null;
    for (const s of now.pieces(piece.role, color)) {
      if (!before.pieceAt(s) || !samePiece(before.pieceAt(s), piece)) movedTo = sq(s);
    }
    return Object.assign(out, { reason: movedTo ? 'moved_away' : 'piece_gone', square: movedTo || sq(idea.from), piece: NAMES[piece.role] });
  }
  const victim = before.pieceAt(idea.to);
  if (victim && victim.color !== color && !samePiece(now.pieceAt(idea.to), victim)) {
    const mine = now.pieceAt(idea.to);
    return Object.assign(out, { reason: mine && mine.color === color ? 'took_early' : 'target_escaped', square: sq(idea.to), piece: NAMES[victim.role] });
  }
  const targetSq = ideaThreat ? parseSq(ideaThreat.to) : idea.to;
  const targetBefore = before.pieceAt(targetSq), targetNow = now.pieceAt(targetSq);
  if (targetBefore && targetBefore.color !== color && targetNow && targetNow.color === color) {
    return Object.assign(out, { reason: 'took_early', square: sq(targetSq), piece: NAMES[targetBefore.role] });
  }
  if (now.isCheck()) return Object.assign(out, { reason: 'tempo', square: sq(now.king(color)!) });
  if (targetBefore && targetBefore.color !== color && !samePiece(targetNow, targetBefore)) {
    return Object.assign(out, { reason: 'target_escaped', square: sq(targetSq), piece: NAMES[targetBefore.role] });
  }
  if (!now.isLegal(idea)) return Object.assign(out, { reason: 'not_legal', square: sq(idea.to) });
  const was = defenders(before, targetSq, opposite(color));
  const newDef = [...defenders(now, targetSq, opposite(color))].filter((s) => !was.has(s)).sort((a, b) => a - b);
  if (newDef.length) {
    let d = newDef[0];
    for (const s of newDef) if (VALUES[now.pieceAt(s)!.role] < VALUES[now.pieceAt(d)!.role]) d = s;
    return Object.assign(out, { reason: 'now_defended', square: sq(d), piece: pieceName(now, d), target: sq(targetSq) });
  }
  const blockers = between(idea.from, idea.to).intersect(now.occupied.diff(before.occupied));
  const b = blockers.first();
  if (b !== undefined) return Object.assign(out, { reason: 'blocked', square: sq(b), piece: pieceName(now, b) });
  return Object.assign(out, { reason: 'still_there' });
}
