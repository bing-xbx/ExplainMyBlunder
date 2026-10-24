// A game link pasted instead of a PGN: Lichess (fetched by its id) or chess.com (found in the
// player's monthly archives, since chess.com's public API has no lookup of one game by its link).

export type GameLink = { site: 'lichess'; id: string } | { site: 'chess.com'; id: string };

const LICHESS = /^(?:https?:\/\/)?(?:www\.)?lichess\.org\/([A-Za-z0-9]{8})(?:[A-Za-z0-9]{4})?(?:\/(?:white|black))?\/?(?:[?#].*)?$/;
const CHESSCOM = /^(?:https?:\/\/)?(?:www\.)?chess\.com\/(?:analysis\/)?(?:game\/(?:live|daily)|live\/game|daily\/game|game)\/(\d+)\/?(?:[?#].*)?$/;
const MONTHS_SEARCHED = 3;

/** The game a pasted link points to, or null when the text is not a game link. */
export function parseGameLink(text: string): GameLink | null {
  const t = text.trim();
  let m = LICHESS.exec(t);
  if (m) return { site: 'lichess', id: m[1] };
  m = CHESSCOM.exec(t);
  if (m) return { site: 'chess.com', id: m[1] };
  return null;
}

/** Looks like a link but isn't one we can read (a study, a puzzle, another site). */
export const looksLikeUrl = (text: string) => /^(?:https?:\/\/|www\.)\S+$/.test(text.trim()) || /^(?:lichess\.org|chess\.com)\//.test(text.trim());

async function getJson(url: string) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(res.status === 404 ? 'not found' : `chess.com answered ${res.status}. Are you online?`);
  return res.json();
}

/** The PGN of a linked game. `chesscomUsers`: whose chess.com games to search (yours, from the settings). */
export async function pgnFromLink(link: GameLink, chesscomUsers: string[] = []): Promise<string> {
  if (link.site === 'lichess') {
    const params = new URLSearchParams({ evals: 'true', literate: 'true', clocks: 'false', opening: 'true' });
    const res = await fetch(`https://lichess.org/game/export/${link.id}?${params}`, { headers: { Accept: 'application/x-chess-pgn' } });
    if (res.status === 404) throw new Error('There is no Lichess game at that link.');
    if (!res.ok) throw new Error(`Lichess answered ${res.status}. Are you online?`);
    return res.text();
  }
  const users = chesscomUsers.filter(Boolean);
  if (!users.length) {
    throw new Error('For a chess.com link, add your chess.com username first: chess.com only lets the app find a game among a player\'s own games.');
  }
  for (const user of users) {
    let archives: string[] = [];
    try {
      ({ archives = [] } = await getJson(`https://api.chess.com/pub/player/${encodeURIComponent(user.toLowerCase())}/games/archives`));
    } catch (e) {
      if ((e as Error).message === 'not found') continue;
      throw e;
    }
    for (const month of [...archives].reverse().slice(0, MONTHS_SEARCHED)) {
      const { games = [] } = await getJson(month);
      const g = games.find((x: any) => typeof x.url === 'string' && x.url.replace(/\/+$/, '').endsWith(`/${link.id}`));
      if (g?.pgn) return g.pgn;
    }
  }
  throw new Error(`That chess.com game is not among the last ${MONTHS_SEARCHED} months of games of ${users.join(' or ')}.`);
}
