// Explain what the played move allowed, what the best move offered, and why the opportunity disappeared.
// All explanations are built from detector facts.
import { Board, Mv, opposite, sq, squareFile, squareRank } from './board';
import type { Color } from './board';
import type { Evaluator } from './engine';
import { Facts, NAMES, VALUES, moveFacts, threat, truthy, whyGone } from './detect';
import type { PlayedLine } from './explain';

const TACTICS = ['fork', 'lines', 'discovered', 'traps', 'mate'];

/** Pronouns for the side that made the explained move and the other side.
 *  "o" is the subject form ("they play it"), "om" the object form ("gives them time"). */
export function explainWords(mine: boolean): Record<string, string> {
  const w: Record<string, string> = mine
    ? { M: 'You', m: 'you', my: 'your', O: 'They', o: 'they', om: 'them', their: 'their', Their: 'Their' }
    : { M: 'They', m: 'they', my: 'their', O: 'You', o: 'you', om: 'you', their: 'your', Their: 'Your' };
  w.mm = mine ? 'you' : 'them'; // the mover, object form ("against them")
  w.the_move = mine ? 'your move' : 'their move';
  return w;
}
const VALUE_BY_NAME: Record<string, number> = Object.fromEntries(Object.entries(NAMES).map(([r, n]) => [n, VALUES[r as keyof typeof VALUES]]));

const sanList = (boards: Board[], moves: Mv[], upto: number) =>
  moves.slice(0, Math.min(upto, moves.length)).map((m, i) => boards[i].san(m)).join(' ');

function capturesOf(boards: Board[], moves: Mv[], end: number, color: Color): Array<[number, string, string]> {
  const out: Array<[number, string, string]> = [];
  for (let k = 1; k <= end; k++) {
    const b = boards[k - 1], m = moves[k - 1];
    if (b.turn !== color && b.isCapture(m)) {
      const victim = b.pieceAt(m.to);
      out.push([k, sq(m.to), victim ? NAMES[victim.role] : 'pawn']);
    }
  }
  return out;
}

function promotionsOf(boards: Board[], moves: Mv[], end: number, color: Color): Array<[number, string, string]> {
  const out: Array<[number, string, string]> = [];
  for (let k = 1; k <= end; k++) {
    const promo = moves[k - 1].promotion;
    if (promo && boards[k - 1].turn === color) out.push([k, sq(moves[k - 1].to), NAMES[promo]]);
  }
  return out;
}

/** 'queens on b8', or 'promotes to a rook on b8' when it is not a queen. */
export const promotes = (piece: string, square: string) => (piece === 'queen' ? `queens on ${square}` : `promotes to a ${piece} on ${square}`);

function tacticPhrase(facts: Facts): string | null {
  if (facts.mate) return 'checkmate';
  if (truthy(facts.fork)) return 'a fork of ' + facts.fork.slice(0, 3).map((t: Facts) => `the ${t.piece} on ${t.square}`).join(' and ');
  for (const ln of facts.lines || []) {
    if (ln.kind === 'pin') return `a pin of the ${ln.pinnedPiece} on ${ln.pinned}`;
    return `a skewer of the ${ln.frontPiece} on ${ln.front} and the ${ln.behindPiece} on ${ln.behind}`;
  }
  for (const d of facts.discovered || []) return `a discovered attack by the ${d.attackerPiece} on ${d.attacker} on the ${d.piece} on ${d.square}`;
  for (const t of facts.traps || []) return `trapping the ${t.piece} on ${t.square}`;
  if (facts.captures) return `winning the ${facts.captures} on ${facts.to}`;
  return null;
}

const sameHang = (a: Facts, b: Facts) => a.square === b.square && a.piece === b.piece && a.loss === b.loss && a.defended === b.defended;

/** 4a: what your move allowed. */
export async function lost(board: Board, boards: Board[], moves: Mv[], line: PlayedLine, you: Color, evaluator: Evaluator,
                           mine = true): Promise<Facts | null> {
  const w = explainWords(mine);
  if (line.mate) return { kind: 'mate', text: `Best play after ${w.the_move} ends in checkmate against ${w.mm}.` };
  const played = moveFacts(boards[0], moves[0]);
  const reply: Facts = moves.length > 1 ? moveFacts(boards[1], moves[1]) : {};
  const lostPieces = capturesOf(boards, moves, line.end, you);
  const lostSquares = new Set(lostPieces.map((x) => x[1]));

  for (const h of [...(played.removes_defender || []), ...(played.leaves_hanging || [])]) {
    if (lostSquares.has(h.square)) {
      const how = (played.removes_defender || []).some((r: Facts) => sameHang(r, h)) ? ' because it stopped guarding it' : '';
      const who = h.square === played.to ? 'itself' : `${w.my} ${h.piece} on ${h.square}`;
      return { kind: 'hanging', square: h.square, piece: h.piece, text: `${played.san} left ${who} hanging${how}, and ${w.o} take it.` };
    }
  }

  const pre = await threat(board, evaluator, opposite(you));
  if (pre && Object.keys(reply).length && (reply.move === pre.move || (reply.captures && reply.to === pre.to))) {
    const what = tacticPhrase(pre) || `the move ${pre.san}`;
    return { kind: 'ignored_threat', threat: pre,
             text: `${w.O} were already threatening ${pre.san} (${what}). ${played.san} did not deal with it, so ${w.o} play it.` };
  }

  if (Object.keys(reply).length && TACTICS.some((k) => truthy(reply[k]))) {
    return { kind: 'tactic', text: `${w.Their} reply ${reply.san} is ${tacticPhrase(reply)}.` };
  }

  const theirQueens = promotionsOf(boards, moves, line.end, opposite(you));
  if (theirQueens.length) {
    const [k, s, piece] = theirQueens[0];
    return { kind: 'promotion', square: s, text: `${cap1(w.my)} move gives ${w.om} time to promote: ${w.their} pawn ${promotes(piece, s)} (${sanList(boards, moves, k)}).` };
  }

  if (lostPieces.length && line.delta < 0) {
    let pick = lostPieces[0];
    for (const x of lostPieces) if (VALUE_BY_NAME[x[2]] > VALUE_BY_NAME[pick[2]]) pick = x; // Python max(): first maximum
    return { kind: 'loses_material', text: `With best play ${w.o} win ${w.my} ${pick[2]} on ${pick[1]}: ${sanList(boards, moves, line.end)}.` };
  }
  return null;
}

export const points = (n: number) => `${n} point${Math.abs(n) !== 1 ? 's' : ''}`;
const cap1 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Python's f"{x:+}" on a float rounded to one decimal: always shows the decimal. */
export const signed = (n: number) => (n < 0 ? '' : '+') + n.toFixed(1);

function doubled(b: Board, color: Color): number {
  const files = [...b.pieces('pawn', color)].map(squareFile);
  let n = 0;
  for (let f = 0; f < 8; f++) n += Math.max(0, files.filter((x) => x === f).length - 1);
  return n;
}

function isolated(b: Board, color: Color): number {
  const pawns = [...b.pieces('pawn', color)].map(squareFile);
  const files = new Set(pawns);
  return pawns.filter((f) => !files.has(f - 1) && !files.has(f + 1)).length;
}

function passed(b: Board, color: Color): number {
  let n = 0;
  for (const s of b.pieces('pawn', color)) {
    const f = squareFile(s), r = squareRank(s);
    const ahead = color === 'white' ? range(r + 1, 8) : range(0, r);
    let blocked = false;
    for (const ff of [f - 1, f, f + 1]) {
      if (ff < 0 || ff >= 8) continue;
      for (const rr of ahead) {
        const p = b.pieceAt(rr * 8 + ff);
        if (p && p.role === 'pawn' && p.color !== color) blocked = true;
      }
    }
    if (!blocked) n++;
  }
  return n;
}

const range = (a: number, b: number) => Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);

function concessions(start: Board, end: Board, them: Color): string[] {
  const out: string[] = [];
  const k = end.king(them);
  const castled = k !== undefined && ['g1', 'c1', 'g8', 'c8'].includes(sq(k));
  if (start.hasCastlingRights(them) && !end.hasCastlingRights(them) && !castled) out.push('the right to castle');
  for (const [label, fn] of [['a doubled pawn', doubled], ['an isolated pawn', isolated]] as const) {
    if (fn(end, them) > fn(start, them)) out.push(label);
  }
  return out;
}

/** 4b: what the best move would have given you: the idea, the cost of their defence, the payoff. */
export async function gaveUp(board: Board, boards: Board[], moves: Mv[], line: PlayedLine, you: Color, evaluator: Evaluator,
                             rivalDelta = 0, gap: Facts | null = null, mine = true): Promise<Facts> {
  void board;
  const w = explainWords(mine);
  const them = opposite(you);
  const best = moveFacts(boards[0], moves[0]);
  const out: Facts = { best: best.san };
  if (line.mate) return Object.assign(out, { kind: 'mate', text: `${best.san} leads to a forced checkmate.` });

  const idea = boards.length > 1 ? await threat(boards[1], evaluator, you) : null;
  const parts: string[] = [];
  if (TACTICS.some((k) => truthy(best[k]))) parts.push(`The idea: ${best.san} is ${tacticPhrase(best)}.`);
  else if (idea) {
    const what = tacticPhrase(idea);
    parts.push(`The idea: ${best.san} threatens ${idea.san}` + (what ? ` (${what}).` : '.'));
  } else if (best.captures) parts.push(`The idea: ${best.san} takes the ${best.captures} on ${best.to}.`);
  out.idea = idea;

  const endBoard = boards[line.end];
  const gains = capturesOf(boards, moves, line.end, them);
  const losses = capturesOf(boards, moves, line.end, you);
  const queens = promotionsOf(boards, moves, line.end, you);
  const better = line.delta > rivalDelta;
  if (better && line.delta > 0 && queens.length) {
    const [k, s, piece] = queens[0];
    parts.push(`The payoff: ${w.my} pawn ${promotes(piece, s)} with ${boards[k - 1].san(moves[k - 1])} (★), and ${w.o} cannot stop it.`);
    out.payoff = { ply: k, square: s, piece };
  } else if (better && line.delta > 0 && gains.length) {
    const k = line.cashed || gains[gains.length - 1][0];
    const net = line.delta;
    const clean = gains.length === 1 && !losses.length && VALUE_BY_NAME[gains[0][2]] === net;
    if (clean) parts.push(`The cost of ${w.their} defence: even with ${w.their} best replies ${w.o} lose the ${gains[0][2]} on ${gains[0][1]}.`);
    else parts.push(`The cost of ${w.their} defence: even with ${w.their} best replies, after the trades ${w.m} come out ${points(net)} up.`);
    parts.push(`The payoff comes with ${boards[k - 1].san(moves[k - 1])} (★).`);
    out.payoff = { ply: k, net };
  } else {
    const conc = concessions(boards[0], endBoard, them);
    if (conc.length) parts.push(`The cost of ${w.their} defence: to meet it ${w.o} give up ` + conc.join(' and ') + '.');
    else {
      const passedB = passed(endBoard, you) - passed(boards[0], you);
      const same = line.delta === rivalDelta && line.delta !== 0 ? `Material ends the same as after ${w.the_move}` : 'No material changes hands within the line';
      if (passedB > 0) parts.push(`${same}, but ${w.m} get a passed pawn.`);
      else if (gap) parts.push(`${same}; the engine still rates it ${signed(gap.afterBest)} for ${w.mm} here against ${signed(gap.afterPlayed)} after ${w.the_move}, so the edge is in the position.`);
      else parts.push(`${same}; the edge is positional, which the engine sees further ahead.`);
    }
    out.concessions = conc;
  }
  return Object.assign(out, { kind: 'gain', text: parts.join(' ') });
}

const GONE_TEXT: Record<string, string> = {
  moved_away: '{My_c} move took the {piece} away, so {idea} is no longer possible.',
  piece_gone: '{My_c} {piece} is gone, so {idea} is no longer possible.',
  target_escaped: '{Their_c} {piece} on {square} moved away first, so {idea} is no longer possible.',
  not_legal: '{idea} is no longer legal.',
  now_defended: '{O_c} used the time to defend {target} with the {piece} on {square}, so {idea} no longer works.',
  blocked: 'The {piece} on {square} now blocks the way for {idea}.',
  took_early: '{M_c} took the {piece} on {square} straight away. The best move was {idea} first, then the capture.',
  tempo: '{Their_c} reply was check, so {o} gained a move and {idea} never came.',
  still_there: '{idea} is still possible on {my} next move, but {o} get a move in first.',
};
const GONE_TAG: Record<string, string> = { took_early: 'too early', moved_away: 'moved away', piece_gone: 'gone', target_escaped: 'escaped',
                                           now_defended: 'now defends', blocked: 'blocks' };

/** 4c: why the best move's idea disappeared after your move and their reply. */
export function gone(board: Board, boardsA: Board[], bestMove: Mv, idea: Facts | null, mine = true): Facts | null {
  if (boardsA.length < 3) return null;
  const w = explainWords(mine);
  const why = whyGone(board, boardsA[2], bestMove, idea);
  const vals: Facts = { piece: 'piece', square: '', target: '', ...w,
                        My_c: cap1(w.my), Their_c: cap1(w.their), O_c: w.O, M_c: w.M, ...why };
  const text = GONE_TEXT[why.reason].replace(/\{(\w+)\}/g, (_, k) => String(vals[k]));
  return { ...why, text };
}

/** Card-level marks: the ignored threat at the start, the best move's idea, the ghost of that idea. */
export function applyMarks(start: Facts, pliesA: Facts[], pliesB: Facts[], lostR: Facts | null, gaveR: Facts, goneR: Facts | null, bestMove: Mv): void {
  if (lostR && lostR.kind === 'ignored_threat') {
    const t = lostR.threat;
    start.arrows.push({ from: t.from, to: t.to, kind: 'threat' });
    start.annotations.push({ square: t.to, kind: 'threat', label: 'threatened' });
  }
  if (gaveR.idea && pliesB.length) {
    const i = gaveR.idea;
    pliesB[0].arrows.push({ from: i.from, to: i.to, kind: 'idea' });
    pliesB[0].annotations.push({ square: i.to, kind: 'idea', label: 'threat' });
  }
  if (goneR && goneR.reason !== 'still_there') {
    const ghost = { from: sq(bestMove.from), to: sq(bestMove.to), kind: 'idea' };
    for (const rec of pliesA.slice(0, 2)) rec.arrows.push({ ...ghost });
    const tag = GONE_TAG[goneR.reason];
    if (tag && goneR.square && pliesA.length > 1) pliesA[1].annotations.push({ square: goneR.square, kind: 'defender', label: tag });
    if (pliesA.length > 1) pliesA[1].caption += ' ' + goneR.text;
  }
}
