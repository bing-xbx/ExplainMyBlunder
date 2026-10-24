// Port of blunder/annotate.py: detector facts -> per-move captions and board marks.
import type { Color } from './board';
import { Facts, truthy } from './detect';

const owner = (you: Color, color: Color, mine = true) =>
  mine ? (color === you ? 'your' : 'their') : (color === you ? 'their' : 'your');
const TACTICS = ['fork', 'lines', 'discovered', 'traps'];
const cap1 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function caption(base: string, facts: Facts, mover: Color, you: Color, mine = true): string {
  const victimOwner = owner(you, mover === 'white' ? 'black' : 'white', mine);
  const own = owner(you, mover, mine);
  const extra: string[] = [];
  if (facts.mate) return base;
  if (truthy(facts.fork)) {
    const names = facts.fork.slice(0, 3).map((x: Facts) => `${x.piece} on ${x.square}`).join(' and ');
    extra.push(`A fork: the ${facts.piece} attacks ${victimOwner} ${names} at once.`);
  }
  for (const ln of (facts.lines || []).slice(0, 1)) {
    if (ln.kind === 'pin') {
      const to = ln.absolute ? 'king' : `${ln.behindPiece} on ${ln.behind}`;
      extra.push(`It pins ${victimOwner} ${ln.pinnedPiece} on ${ln.pinned} to the ${to}.`);
    } else {
      extra.push(`A skewer: ${victimOwner} ${ln.frontPiece} on ${ln.front} must move and the ${ln.behindPiece} on ${ln.behind} behind it falls.`);
    }
  }
  for (const d of (facts.discovered || []).slice(0, 1)) {
    extra.push(`Discovered attack: the ${d.attackerPiece} on ${d.attacker} now hits ${victimOwner} ${d.piece} on ${d.square}.`);
  }
  for (const t of (facts.traps || []).slice(0, 1)) {
    extra.push(`${cap1(victimOwner)} ${t.piece} on ${t.square} is trapped: every square it can reach loses it.`);
  }
  if (!extra.length && truthy(facts.attacks)) {
    const t = facts.attacks[0];
    if (t.why !== 'check') extra.push(`It attacks ${victimOwner} ${t.piece} on ${t.square}.`);
  }
  for (const h of (facts.removes_defender || []).slice(0, 1)) {
    extra.push(`The ${facts.piece} stops guarding ${own} ${h.piece} on ${h.square}, which is now hanging.`);
  }
  if (!truthy(facts.removes_defender) && !TACTICS.some((k) => truthy(facts[k]))) {
    for (const h of (facts.leaves_hanging || []).slice(0, 1)) {
      const what = h.square === facts.to ? 'itself' : `${own} ${h.piece} on ${h.square}`;
      extra.push(`This leaves ${what} hanging (it can be taken for free or for profit).`);
    }
  }
  return [base, ...extra.slice(0, 2)].join(' ');
}

export function marks(facts: Facts): [Facts[], Facts[]] {
  const ann: Facts[] = [], arrows: Facts[] = [];
  const to = facts.to;
  for (const t of facts.fork || []) {
    ann.push({ square: t.square, kind: 'forked', label: 'forked' });
    arrows.push({ from: to, to: t.square, kind: 'forked' });
  }
  for (const ln of facts.lines || []) {
    if (ln.kind === 'pin') ann.push({ square: ln.pinned, kind: 'pinned', label: 'pinned' });
    else ann.push({ square: ln.front, kind: 'pinned', label: 'skewered' });
    arrows.push({ from: ln.attacker, to: ln.behind, kind: 'pinned' });
  }
  for (const d of facts.discovered || []) {
    ann.push({ square: d.square, kind: 'threat', label: 'attacked' });
    arrows.push({ from: d.attacker, to: d.square, kind: 'threat' });
  }
  if (!truthy(facts.fork)) {
    for (const t of facts.attacks || []) if (t.why !== 'check') arrows.push({ from: to, to: t.square, kind: 'threat' });
  }
  for (const t of facts.traps || []) {
    ann.push({ square: t.square, kind: 'trapped', label: 'trapped' });
    for (const e of t.escapes.slice(0, 6)) ann.push({ square: e, kind: 'escape', label: '✕' });
  }
  for (const h of facts.removes_defender || []) {
    ann.push({ square: h.square, kind: 'hanging', label: 'unguarded' });
    arrows.push({ from: facts.from, to: h.square, kind: 'defender' });
  }
  const shown = new Set(ann.map((a) => a.square));
  const hang = TACTICS.some((k) => truthy(facts[k])) ? [] : facts.leaves_hanging || [];
  for (const h of hang) if (!shown.has(h.square)) ann.push({ square: h.square, kind: 'hanging', label: 'hanging' });
  return [ann, arrows];
}
