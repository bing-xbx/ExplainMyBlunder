// Communicate with Stockfish over UCI in browser Workers and Node-based tests.
import { Board, moveFromUci } from './board';
import type { Evaluator, Line } from './engine';
import { engineKey } from './engine';
import { winningChances } from './analyze';

/** Anything that takes UCI commands and calls back with each output line. */
export interface UciPort {
  send(cmd: string): void;
  onLine(cb: (line: string) => void): void;
}

export type Limit = { nodes: number } | { movetime: number };

interface Job {
  fen: string;
  limit: Limit;
  multipv: number;
  resolve: (lines: Line[]) => void;
  reject: (e: Error) => void;
  signal?: AbortSignal;
}

const PV_PLIES = 12;

/** Parse one `info` line; scores are turned from side-to-move into White's point of view. */
export function parseInfo(line: string, whiteToMove: boolean): (Line & { multipv: number }) | null {
  const t = line.split(' ');
  if (t[0] !== 'info') return null;
  const at = (k: string) => t.indexOf(k);
  const pvAt = at('pv'), scoreAt = at('score');
  if (pvAt < 0 || scoreAt < 0) return null;
  const sign = whiteToMove ? 1 : -1;
  const kind = t[scoreAt + 1], value = Number(t[scoreAt + 2]);
  const pv = t.slice(pvAt + 1).filter(Boolean);
  if (!pv.length) return null;
  const mpv = at('multipv');
  const depth = at('depth');
  return {
    multipv: mpv >= 0 ? Number(t[mpv + 1]) : 1,
    move: pv[0],
    cp: kind === 'cp' ? sign * value : null,
    mate: kind === 'mate' ? sign * value : null,
    pv,
    depth: depth >= 0 ? Number(t[depth + 1]) : null,
  };
}

/** One engine, one search at a time; searches queue up (urgent ones go first). */
export class UciEngine {
  name = 'Stockfish';
  private queue: Job[] = [];
  private current: Job | null = null;
  private lines = new Map<number, Line>();
  private whiteToMove = true;
  private ready: Promise<void>;

  constructor(private port: UciPort, options: Record<string, string | number> = {}) {
    let markReady!: () => void;
    this.ready = new Promise((r) => (markReady = r));
    port.onLine((line) => {
      if (line.startsWith('id name ')) this.name = line.slice(8).trim();
      else if (line === 'readyok' && markReady) { markReady(); markReady = null as any; }
      else if (line.startsWith('info ') && this.current) {
        const info = parseInfo(line, this.whiteToMove);
        // python-chess keeps the last info per multipv; so do we (bounds included, like it).
        if (info) { const { multipv, ...rest } = info; this.lines.set(multipv, rest); }
      } else if (line.startsWith('bestmove') && this.current) this.finish();
    });
    port.send('uci');
    for (const [k, v] of Object.entries(options)) port.send(`setoption name ${k} value ${v}`);
    port.send('isready');
  }

  search(fen: string, limit: Limit, multipv = 1, opts: { urgent?: boolean; signal?: AbortSignal } = {}): Promise<Line[]> {
    return new Promise((resolve, reject) => {
      const job: Job = { fen, limit, multipv, resolve, reject, signal: opts.signal };
      if (opts.urgent) this.queue.unshift(job);
      else this.queue.push(job);
      opts.signal?.addEventListener('abort', () => {
        const i = this.queue.indexOf(job);
        if (i >= 0) { this.queue.splice(i, 1); reject(abortError()); }
        else if (this.current === job) this.port.send('stop'); // finish() rejects it
      });
      this.pump();
    });
  }

  /** Stop the running search and drop everything queued. */
  stopAll() {
    for (const j of this.queue.splice(0)) j.reject(abortError());
    if (this.current) this.port.send('stop');
  }

  private async pump() {
    if (this.current || !this.queue.length) return;
    const job = (this.current = this.queue.shift()!);
    await this.ready;
    if (job.signal?.aborted) { this.current = null; job.reject(abortError()); this.pump(); return; }
    this.lines.clear();
    this.whiteToMove = job.fen.split(' ')[1] !== 'b';
    this.port.send(`setoption name MultiPV value ${job.multipv}`);
    this.port.send(`position fen ${job.fen}`);
    this.port.send('nodes' in job.limit ? `go nodes ${job.limit.nodes}` : `go movetime ${job.limit.movetime}`);
  }

  private finish() {
    const job = this.current!;
    this.current = null;
    const lines = [...this.lines.entries()].sort((a, b) => a[0] - b[0]).map(([, l]) => l);
    if (job.signal?.aborted) job.reject(abortError());
    else job.resolve(lines);
    this.pump();
  }
}

function abortError() {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

export interface EvalStore {
  get(key: string): Promise<Line[] | undefined>;
  put(key: string, lines: Line[]): Promise<void>;
}

/** Fixed-node search with a cache, the Evaluator the core expects (analyze.Evaluator). */
export class EngineEvaluator implements Evaluator {
  private memo = new Map<string, Line[]>();

  constructor(private engine: UciEngine, public nodes: number, private store?: EvalStore, private urgent = false) {}

  async evaluate(board: Board, multipv = 1): Promise<Line[]> {
    const key = `${this.nodes}|${engineKey(board, multipv)}`;
    let lines = this.memo.get(key) ?? (await this.store?.get(key));
    if (!lines) {
      if (board.isGameOver()) lines = [];
      else {
        lines = await this.engine.search(board.fen(), { nodes: this.nodes }, multipv, { urgent: this.urgent });
        lines = lines.map((l) => ({ ...l, pv: legalPrefix(board, l.pv) }));
        await this.store?.put(key, lines);
      }
    }
    this.memo.set(key, lines);
    return lines;
  }
}

/** Keep the PV only as far as it is legal (a stopped search can end mid-line). */
function legalPrefix(board: Board, pv: string[]): string[] {
  const b = board.copy();
  const out: string[] = [];
  for (const u of pv) {
    const m = moveFromUci(u);
    if (!b.isLegal(m)) break;
    b.push(m);
    out.push(u);
  }
  return out;
}

/** Live analysis results for the board. */
export async function analyse(engine: UciEngine, fen: string, movetimeMs = 700, signal?: AbortSignal) {
  const board = Board.fromFen(fen);
  if (board.isGameOver()) return { fen, gameOver: board.outcomeResult(), best: null, pv: [], pvUci: [] };
  const lines = await engine.search(fen, { movetime: Math.max(50, Math.min(movetimeMs, 5000)) }, 1, { signal });
  const top = lines[0];
  if (!top) throw new Error('The engine gave no line.');
  const pvUci = legalPrefix(board, top.pv).slice(0, PV_PLIES);
  const pv: string[] = [];
  const b = board.copy();
  for (const u of pvUci) { const m = moveFromUci(u); pv.push(b.san(m)); b.push(m); }
  const wc = top.mate !== null ? (top.mate > 0 ? 1 : -1) : winningChances(top.cp!);
  return { fen, engine: engine.name, depth: top.depth, cp: top.cp, mate: top.mate, wc, best: top.move, pv, pvUci, startPly: board.ply() };
}
