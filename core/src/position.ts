// Compare positional features when both lines end with equal material.
import { kingAttacks } from 'chessops/attacks';
import { Board, opposite, parseSq, sq, squareFile, squareRank } from './board';
import type { Color, Square } from './board';
import type { Facts } from './detect';

export const WEIGHTS: Record<string, number> = {
  king_centre: 60, king_cover: 20, king_attackers: 15, passed: 30, isolated: 15,
  doubled: 15, outposts: 30, rook_files: 20, seventh: 30, undeveloped: 20, activity: 2,
};
const MIN_CP = 15;
const MAX_ITEMS = 2;
const DEVELOPMENT_PLIES = 30;
const MINOR_HOME: Record<Color, Square[]> = {
  white: ['b1', 'g1', 'c1', 'f1'].map(parseSq), black: ['b8', 'g8', 'c8', 'f8'].map(parseSq),
};

type Feature = { n: number; squares: string[] };

const ahead = (color: Color, rank: number): number[] => {
  const out: number[] = [];
  if (color === 'white') for (let r = rank + 1; r < 8; r++) out.push(r);
  else for (let r = rank - 1; r >= 0; r--) out.push(r);
  return out;
};
const relRank = (color: Color, s: Square) => (color === 'white' ? squareRank(s) : 7 - squareRank(s));
const at = (f: number, r: number) => (r * 8 + f) as Square;

export function features(b: Board, color: Color): Record<string, Feature> {
  const them = opposite(color);
  const king = b.king(color)!;
  const out: Record<string, Feature> = {};
  const kf = squareFile(king), kr = squareRank(king);
  const queens = b.pieces('queen', them).nonEmpty();

  const centre = kf >= 2 && kf <= 5 && !b.hasCastlingRights(color) && queens && relRank(color, king) <= 1;
  out.king_centre = { n: centre ? 1 : 0, squares: centre ? [sq(king)] : [] };

  const cover: Square[] = [];
  for (const f of [kf - 1, kf, kf + 1]) {
    if (f < 0 || f >= 8) continue;
    for (const r of ahead(color, kr).slice(0, 2)) {
      const p = b.pieceAt(at(f, r));
      if (p && p.role === 'pawn' && p.color === color) cover.push(at(f, r));
    }
  }
  out.king_cover = { n: cover.length, squares: cover.map(sq) };

  const zone = kingAttacks(king).with(king);
  const attackers = new Set<number>();
  for (const z of zone) {
    for (const a of b.attackersMask(them, z)) {
      const role = b.pieceAt(a)?.role;
      if (role !== 'pawn' && role !== 'king') attackers.add(a);
    }
  }
  const att = [...attackers].sort((x, y) => x - y) as Square[];
  out.king_attackers = { n: att.length, squares: att.map(sq) };

  const pawns = [...b.pieces('pawn', color)];
  const files = pawns.map(squareFile);
  const enemy = [...b.pieces('pawn', them)].map((s) => [squareFile(s), squareRank(s)]);
  const passed: Square[] = [], isolated: Square[] = [], doubled: Square[] = [];
  for (const s of pawns) {
    const f = squareFile(s), r = squareRank(s);
    const front = ahead(color, r);
    if (!enemy.some(([ef, er]) => Math.abs(ef - f) <= 1 && front.includes(er))) passed.push(s);
    if (!files.includes(f - 1) && !files.includes(f + 1)) isolated.push(s);
    if (files.filter((x) => x === f).length > 1 && pawns.some((s2) => s2 !== s && squareFile(s2) === f && relRank(color, s2) < relRank(color, s))) doubled.push(s);
  }
  out.passed = { n: passed.length, squares: passed.map(sq) };
  out.isolated = { n: isolated.length, squares: isolated.map(sq) };
  out.doubled = { n: doubled.length, squares: doubled.map(sq) };

  const outposts: Square[] = [];
  for (const s of b.pieces('knight', color)) {
    const f = squareFile(s), r = squareRank(s);
    if (relRank(color, s) < 3 || relRank(color, s) > 5) continue;
    const guarded = [...b.attackersMask(color, s)].some((a) => b.pieceAt(a)?.role === 'pawn');
    const front = ahead(color, r);
    const kickable = enemy.some(([ef, er]) => Math.abs(ef - f) === 1 && front.includes(er));
    if (guarded && !kickable) outposts.push(s);
  }
  out.outposts = { n: outposts.length, squares: outposts.map(sq) };

  const rooks = [...b.pieces('rook', color)].filter((s) => !files.includes(squareFile(s)));
  out.rook_files = { n: rooks.length, squares: rooks.map(sq) };

  const seventh = [...b.pieces('rook', color).union(b.pieces('queen', color))].filter((s) => relRank(color, s) === 6);
  out.seventh = { n: seventh.length, squares: seventh.map(sq) };

  let home = MINOR_HOME[color].filter((s) => {
    const p = b.pieceAt(s);
    return p && (p.role === 'knight' || p.role === 'bishop') && p.color === color;
  });
  if (b.ply() > DEVELOPMENT_PLIES) home = [];
  out.undeveloped = { n: home.length, squares: home.map(sq) };

  const own = b.occupiedCo(color);
  let moves = 0;
  for (const role of ['knight', 'bishop', 'rook', 'queen'] as const) {
    for (const s of b.pieces(role, color)) moves += b.attacksMask(s).diff(own).size();
  }
  out.activity = { n: moves, squares: [] };
  return out;
}

const GOOD: Record<string, number> = {
  king_centre: -1, king_cover: 1, king_attackers: -1, passed: 1, isolated: -1, doubled: -1,
  outposts: 1, rook_files: 1, seventh: 1, undeveloped: -1, activity: 1,
};
const TERM: Record<string, string> = {
  king_centre: 'King stuck in the centre', king_cover: 'King cover', king_attackers: 'Pieces aiming at the king',
  passed: 'Passed pawns', isolated: 'Isolated pawns', doubled: 'Doubled pawns', outposts: 'Knight outposts',
  rook_files: 'Rooks on open files', seventh: 'Rooks and queens on the 7th rank', undeveloped: 'Undeveloped pieces',
  activity: 'Piece activity',
};
const UNIT: Record<string, [string, string]> = {
  king_cover: ['pawn', 'pawns'], king_attackers: ['piece', 'pieces'], outposts: ['knight', 'knights'],
  rook_files: ['rook', 'rooks'], seventh: ['piece', 'pieces'], undeveloped: ['piece', 'pieces'], activity: ['square', 'squares'],
};
const KING_FEATURES = ['king_centre', 'king_cover', 'king_attackers'];
const LABEL: Record<string, string> = {
  king_centre: 'centre king', king_cover: 'cover', king_attackers: 'aims at king', passed: 'passed',
  isolated: 'isolated', doubled: 'doubled', outposts: 'outpost', rook_files: 'open file',
  seventh: '7th rank', undeveloped: 'at home',
};

function value(key: string, f: Feature): string {
  if (key === 'king_centre') return f.n ? `yes (${f.squares[0]})` : 'no';
  const unit = UNIT[key];
  const text = unit ? `${f.n} ${f.n === 1 ? unit[0] : unit[1]}` : String(f.n);
  return text + (f.squares.length ? ` (${f.squares.join(', ')})` : '');
}

function phrase(key: string, owner: string, fb: Feature, fa: Feature, best: string, played: string): string {
  const whose = KING_FEATURES.includes(key) ? `${owner} king` : ({ your: 'yours', their: 'theirs' } as Record<string, string>)[owner];
  return `**${TERM[key]}** (${whose}): ${value(key, fa)} after ${played}, ${value(key, fb)} after ${best}.`;
}

export function compare(endPlayed: Board, endBest: Board, you: Color, bestSan: string, playedSan: string,
                        w: Record<string, string>): Facts | null {
  let items: Facts[] = [];
  for (const [side, owner] of [[you, w.my], [opposite(you), w.their]] as Array<[Color, string]>) {
    const fa = features(endPlayed, side), fb = features(endBest, side);
    const sign = side === you ? 1 : -1;
    for (const key of Object.keys(WEIGHTS)) {
      const gain = (fb[key].n - fa[key].n) * GOOD[key] * sign * WEIGHTS[key];
      if (gain >= MIN_CP) {
        items.push({ feature: key, owner: side === you ? 'mover' : 'opponent', cp: gain, best: fb[key], played: fa[key],
                     text: phrase(key, owner, fb[key], fa[key], bestSan, playedSan) });
      }
    }
  }
  if (!items.length) return null;
  const order = Object.keys(WEIGHTS);
  items.sort((x, y) => y.cp - x.cp || order.indexOf(x.feature) - order.indexOf(y.feature) || (x.owner < y.owner ? -1 : x.owner > y.owner ? 1 : 0));
  items = items.slice(0, MAX_ITEMS);
  return { kind: 'position', items,
           text: `What ${bestSan} does better than ${playedSan}, where the two lines end: ` + items.map((i) => i.text).join(' ') };
}

export function marks(item: Facts): [Facts[], Facts[]] {
  const label = LABEL[item.feature];
  if (!label) return [[], []];
  const tag = (squares: string[]) => squares.map((s) => ({ square: s, kind: 'feature', label }));
  return [tag(item.best.squares), tag(item.played.squares)];
}

