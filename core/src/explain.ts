// Compare the played move with the best move, following both lines to a quiet position.
import { Board, Mv, moveFromUci, sq, squareFile, uci } from './board';
import type { Color } from './board';
import type { Evaluator } from './engine';
import { povWc, round1 } from './analyze';
import { caption as annotateCaption, marks } from './annotate';
import { Facts, NAMES, moveFacts } from './detect';
import { material, positionRecord } from './records';
import { applyMarks, gaveUp, gone, lost, points, signed } from './reasons';
import * as position from './position';

export const LINE_CAP = 12;
// When material ends level in both lines, show only this many plies: playing on just to
// reach "the edge is positional" made the longest lines in the app.
export const LEVEL_PLIES = 4;
const QUIET_WINDOW = 4;

export interface PlayedLine {
  plies: Facts[];
  extra: Facts[];
  end: number;
  delta: number;
  cashed: number | null;
  mate: boolean;
}

export const diffFor = (mat: { white: number; black: number }, color: Color) =>
  color === 'white' ? mat.white - mat.black : mat.black - mat.white;

/** `first`, then engine best moves for both sides, up to `cap` plies. */
export async function playOut(board: Board, first: Mv, evaluator: Evaluator, cap = LINE_CAP): Promise<Mv[]> {
  const b = board.copy();
  b.push(first);
  const moves = [first];
  while (moves.length < cap && !b.isGameOver()) {
    const lines = await evaluator.evaluate(b);
    if (!lines.length) break;
    for (const u of lines[0].pv) {
      const move = moveFromUci(u);
      if (moves.length >= cap || b.isGameOver() || !b.isLegal(move)) break;
      b.push(move);
      moves.push(move);
    }
  }
  return moves;
}

export function settlePoint(diffs: number[], boards: Board[], moves: Mv[], minK = 1): number {
  const last = diffs.length - 1;
  if (boards[last].isCheckmate()) return last;
  for (let k = minK; k <= last; k++) {
    if (diffs.slice(k, k + QUIET_WINDOW + 1).some((d) => d !== diffs[k])) continue;
    if (boards[k].isCheck()) continue;
    if (k < moves.length && boards[k].isCapture(moves[k])) continue;
    return k;
  }
  return last;
}

/** Pronouns for the side that made the explained move (`M`) and the other side (`O`). */
export function words(mine: boolean): Record<string, string> {
  return mine
    ? { M: 'You', m: 'you', mm: 'you', my: 'your', O: 'They', o: 'they', om: 'them', their: 'their' }
    : { M: 'They', m: 'they', mm: 'them', my: 'their', O: 'You', o: 'you', om: 'you', their: 'your' };
}

/** Show the line only up to `end`; the rest stays in `extra` (greyed, still clickable). */
export function clamp(line: PlayedLine, end: number): PlayedLine {
  if (end >= line.end) return line;
  const plies = [...line.plies, ...line.extra];
  const cashed = line.cashed && line.cashed <= end ? line.cashed : null;
  return { ...line, plies: plies.slice(0, end), extra: plies.slice(end), end,
           delta: end ? plies[end - 1].delta : 0, cashed, mate: false };
}

/** The engine's verdict on the two positions, in pawns from the mover's side (already cached). */
export async function evalGap(afterPlayed: Board, afterBest: Board, evaluator: Evaluator, you: Color): Promise<Facts | null> {
  const pawns = async (b: Board): Promise<number | null> => {
    const lines = await evaluator.evaluate(b);
    if (!lines.length) return null;
    const top = lines[0];
    if (top.mate !== null) return (top.mate > 0) === (you === 'white') ? 100 : -100;
    const cp = you === 'white' ? top.cp! : -top.cp!;
    return round1(cp / 100);
  };
  const a = await pawns(afterPlayed), b = await pawns(afterBest);
  if (a === null || b === null) return null;
  return { afterPlayed: a, afterBest: b, diff: round1(b - a) };
}

/** Template caption for one move. */
export function describe(board: Board, move: Mv, you: Color, mine = true): string {
  const w = words(mine);
  const who = board.turn === you ? w.M : w.O;
  const name = NAMES[board.pieceAt(move.from)!.role];
  const to = sq(move.to);
  let text: string;
  if (board.isCastling(move)) text = `${who} castle ${squareFile(move.to) > 4 ? 'kingside' : 'queenside'}`;
  else if (board.isCapture(move)) {
    const victim = board.pieceAt(move.to);
    text = `${who} take the ${victim ? NAMES[victim.role] : 'pawn'} on ${to} with the ${name}`;
  } else text = `${who} move the ${name} to ${to}`;
  if (move.promotion) text += `, promoting to a ${NAMES[move.promotion]}`;
  const after = board.copy();
  after.push(move);
  if (after.isCheckmate()) text += ': checkmate';
  else if (after.isCheck()) text += ', with check';
  return text + '.';
}

export async function buildLine(board: Board, first: Mv, evaluator: Evaluator, you: Color, minPlies = 1, cap = LINE_CAP,
                                mine = true): Promise<[PlayedLine, Board[], Mv[]]> {
  const moves = await playOut(board, first, evaluator, cap);
  const boards = [board.copy()];
  for (const m of moves) {
    const nb = boards[boards.length - 1].copy();
    nb.push(m);
    boards.push(nb);
  }
  const diffs = boards.map((b) => diffFor(material(b), you));
  const end = settlePoint(diffs, boards, moves, Math.min(minPlies, moves.length));

  const plies: Facts[] = [];
  moves.forEach((move, i) => {
    const k = i + 1;
    const rec = positionRecord(boards[k], boards[k].ply(), move, boards[k - 1].san(move));
    rec.material = material(boards[k]);
    rec.diff = diffs[k];
    rec.delta = diffs[k] - diffs[0];
    const facts = moveFacts(boards[k - 1], move);
    rec.facts = facts;
    rec.caption = annotateCaption(describe(boards[k - 1], move, you, mine), facts, boards[k - 1].turn, you, mine);
    [rec.annotations, rec.arrows] = marks(facts);
    plies.push(rec);
  });

  const final = diffs[end];
  let cashed: number | null = null;
  if (final !== diffs[0]) {
    let k = end;
    while (k > 1 && diffs[k - 1] === final) k--;
    cashed = k;
  }
  const line: PlayedLine = { plies: plies.slice(0, end), extra: plies.slice(end), end, delta: final - diffs[0], cashed, mate: boards[end].isCheckmate() };
  return [line, boards, moves];
}

/** Which kind of wrong this is: "allowed" (your move gives them a chance) or
 *  "missed" (your move loses nothing, but the best move wins something or is better). */
export function classify(a: PlayedLine, b: PlayedLine, lostR: Facts | null): 'allowed' | 'missed' {
  if (a.mate) return 'allowed';
  if (b.mate) return 'missed';
  if (a.delta < 0 && a.delta < b.delta) return 'allowed';
  if (b.delta > a.delta) return 'missed';
  return lostR ? 'allowed' : 'missed';
}

export function summarize(kind: string, A: PlayedLine, B: PlayedLine, playedSan: string, bestSan: string,
                          gap: Facts | null = null, mine = true): string {
  const a = A.delta, b = B.delta;
  const w = words(mine);
  const them = w.om, their = w.their;
  if (kind === 'allowed') {
    if (A.mate) return `${playedSan} lets ${them} force checkmate. ${bestSan} avoids it.`;
    if (a < 0) {
      const instead = b === 0 ? `${bestSan} keeps material level.`
        : b > 0 ? `With ${bestSan} ${w.m} would come out ${points(b)} up instead.`
        : `${bestSan} loses less (${points(-b)}).`;
      return `${playedSan} lets ${them} win material: with ${their} best replies ${w.m} lose ${points(-a)}. ${instead}`;
    }
    if (gap) {
      return `${playedSan} gives ${them} a strong reply, even though material ends level: the engine rates it ` +
        `${signed(gap.afterPlayed)} for ${w.mm} after ${playedSan} against ${signed(gap.afterBest)} after ${bestSan}.`;
    }
    return `${playedSan} gives ${them} a strong reply, even though material ends level. ${bestSan} avoids it.`;
  }
  const missed = mine ? 'You missed' : 'They missed';
  if (B.mate) return `${missed} ${bestSan}, which forces checkmate.`;
  if (b > a) {
    if (a === 0) return `${missed} ${bestSan}, which wins ${points(b)}. ${playedSan} loses nothing, but that chance is gone.`;
    if (a > 0) return `${missed} ${bestSan}, which wins ${points(b)}; ${playedSan} wins only ${points(a)}.`;
    return `${missed} ${bestSan}, which wins ${points(b)}; after ${playedSan} ${w.m} are ${points(-a)} down.`;
  }
  if (gap) {
    return `${missed} a better move: the engine prefers ${bestSan}. No material changes hands either way, but the engine ` +
      `rates the position after ${playedSan} at ${signed(gap.afterPlayed)} for ${w.mm} and after ${bestSan} at ` +
      `${signed(gap.afterBest)}, so the gain comes later than these moves.`;
  }
  return `${missed} a better move: the engine prefers ${bestSan}. Material ends the same, so the difference is in the position, not the pieces.`;
}

// Was the best move the only one, or one of several? From the engine's top 3 moves before the
// judged move, in winning chances (the scale the judging uses: 0.2 is a mistake). explain.alternatives
const ALT_LINES = 3;
const ONLY_GAP = 0.2;      // the next best move would itself be a mistake: only the best move held
const HOLD_WITHIN = 0.05;  // moves this close to the best one held just as well, for a human

export async function alternatives(board: Board, played: Mv, best: Mv, evaluator: Evaluator, you: Color): Promise<Facts | null> {
  const lines = await evaluator.evaluate(board, ALT_LINES);
  const playedUci = uci(played), bestUci = uci(best);
  if (lines.length < 2 || lines[0].move !== bestUci) return null; // forced, or this search disagrees with the judging
  const wcs = lines.map((l) => povWc({ cp: l.cp, mate: l.mate }, you));
  const sans = lines.map((l) => board.san(moveFromUci(l.move)));
  const holds = lines.map((_, i) => wcs[i] >= wcs[0] - HOLD_WITHIN);
  if (lines.some((l, i) => holds[i] && l.move === playedUci)) return null; // the played move held too, by this search
  const held = sans.filter((_, i) => holds[i] && lines[i].move !== playedUci);
  return { only: wcs[0] - wcs[1] >= ONLY_GAP, held, second: sans[1] };
}

const orList = (items: string[]) => (items.length === 1 ? items[0] : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`);

export function alternativesText(alts: Facts | null, playedSan: string, bestSan: string): string | null {
  if (!alts) return null;
  if (alts.only) return `Only ${bestSan} held here.`;
  if (alts.held.length >= 2) return `Several moves held here (${orList(alts.held)}); ${playedSan} was not one of them.`;
  return null;
}

/** The null-move picture: the side to move skips its move, the other side plays its threat. */
export function passLine(board: Board, threat: Facts, you: Color, mine = true): Facts[] {
  const probe = board.passed();
  const w = words(mine);
  const passerIsYou = board.turn === you;
  const first = positionRecord(probe, probe.ply(), null, '(pass)');
  Object.assign(first, {
    material: material(probe), diff: diffFor(material(probe), you), delta: 0,
    annotations: [{ square: threat.to, kind: passerIsYou ? 'threat' : 'idea', label: 'threat' }],
    arrows: [{ from: threat.from, to: threat.to, kind: passerIsYou ? 'threat' : 'idea' }],
    caption: `Imagine ${passerIsYou ? w.m : w.o} skip${passerIsYou ? '' : 's'} ${passerIsYou ? w.my : w.their} move. ` +
      `It is ${passerIsYou ? w.their : w.my} turn again, and the arrow shows what ${passerIsYou ? w.o : w.m} would play.`,
  });
  const move = moveFromUci(threat.move);
  const facts = moveFacts(probe, move);
  const after = probe.copy();
  after.push(move);
  const second = positionRecord(after, after.ply(), move, probe.san(move));
  Object.assign(second, {
    material: material(after), diff: diffFor(material(after), you),
    delta: diffFor(material(after), you) - diffFor(material(probe), you),
    caption: annotateCaption(describe(probe, move, you, mine), facts, probe.turn, you, mine),
  });
  [second.annotations, second.arrows] = marks(facts);
  return [first, second];
}

/** The card for any move in any position. */
export async function explainPosition(board: Board, played: Mv, best: Mv, evaluator: Evaluator, mine = true): Promise<Facts> {
  const you = board.turn;
  const playedSan = board.san(played), bestSan = board.san(best);
  let [lineA, boardsA, movesA] = await buildLine(board, played, evaluator, you, 2, LINE_CAP, mine);
  let [lineB, boardsB, movesB] = await buildLine(board, best, evaluator, you, 1, LINE_CAP, mine);
  let gap: Facts | null = null;
  if (lineA.delta === lineB.delta && !(lineA.mate || lineB.mate)) {
    // Material ends the same either way, so playing on only reaches "it is positional".
    gap = await evalGap(boardsA[1], boardsB[1], evaluator, you);
    lineA = clamp(lineA, LEVEL_PLIES);
    lineB = clamp(lineB, LEVEL_PLIES);
  }
  const start: Facts = { ...positionRecord(board, board.ply(), null, null), material: material(board),
                         diff: diffFor(material(board), you), annotations: [], arrows: [] };
  const lostR = await lost(board, boardsA, movesA, lineA, you, evaluator, mine);
  const gaveR = await gaveUp(board, boardsB, movesB, lineB, you, evaluator, lineA.delta, gap, mine);
  const goneR = gone(board, boardsA, best, gaveR.idea ?? null, mine);
  applyMarks(start, [...lineA.plies, ...lineA.extra], [...lineB.plies, ...lineB.extra], lostR, gaveR, goneR, best);
  const kind = classify(lineA, lineB, lostR);
  // Material ends the same: name the clearest positional differences where the lines end.
  const posR = gap ? position.compare(boardsA[lineA.end], boardsB[lineB.end], you, bestSan, playedSan, words(mine)) : null;
  for (const item of posR?.items ?? []) {
    const [onBest, onPlayed] = position.marks(item);
    if (lineB.end) (lineB.plies[lineB.end - 1].annotations ??= []).push(...onBest);
    if (lineA.end) (lineA.plies[lineA.end - 1].annotations ??= []).push(...onPlayed);
  }
  const passes: Facts = {};
  if (gaveR.idea && boardsB.length > 1) passes.idea = passLine(boardsB[1], gaveR.idea, you, mine);
  if (lostR && lostR.kind === 'ignored_threat') passes.threat = passLine(board, lostR.threat, you, mine);
  const alts = await alternatives(board, played, best, evaluator, you);
  let summary = summarize(kind, lineA, lineB, playedSan, bestSan, gap, mine);
  const altText = alternativesText(alts, playedSan, bestSan);
  if (altText) summary = `${summary} ${altText}`;
  return {
    passes,
    start,
    you,
    lineA,
    lineB,
    kind,
    mine,
    mover: you,
    evalGap: gap,
    summary,
    alternatives: alts,
    reasons: { lost: lostR ? lostR.text : null, gaveUp: gaveR.text, gone: goneR ? goneR.text : null, position: posR ? posR.text : null },
    facts: { lost: lostR, gaveUp: gaveR, gone: goneR, position: posR },
  };
}

/** The card for one judged move of a game (`moves`: UCI, `index`: position after the move). */
export async function explainMoment(startFen: string, moves: string[], moment: Facts, evaluator: Evaluator,
                                   mine = true): Promise<Facts> {
  const board = Board.fromFen(startFen);
  for (const u of moves.slice(0, moment.index - 1)) board.push(moveFromUci(u));
  return explainPosition(board, moveFromUci(moment.uci), moveFromUci(moment.best), evaluator, mine);
}
