// Builds what the page needs into ../web: core.js (the TypeScript core + the in-page
// backend), a copy of the Stockfish WebAssembly engine, and sw.js (the offline service worker,
// stamped with a hash of every app file). Cloudflare Pages runs this.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
await build({ entryPoints: ['src/browser.ts'], bundle: true, format: 'esm', target: 'es2020', minify: true,
              outfile: '../web/core.js', logLevel: 'warning' });

const sfDir = join(dirname(require.resolve('stockfish/package.json')), 'bin');
const out = '../web/vendor/stockfish';
mkdirSync(out, { recursive: true });
for (const f of ['stockfish-19-lite-single.js', 'stockfish-19-lite-single.wasm', 'stockfish-19-lite.js', 'stockfish-19-lite.wasm']) copyFileSync(join(sfDir, f), join(out, f));
copyFileSync(join(sfDir, '..', 'Copying.txt'), join(out, 'Copying.txt'));

// The service worker: every file the app needs offline, and a version that changes whenever one does.
const FILES = [
  '/', '/app.js', '/account.js', '/core.js', '/style.css', '/config.json', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png',
  '/vendor/chessground/chessground.min.js', '/vendor/chessground/chessground.base.css',
  '/vendor/chessground/chessground.brown.css', '/vendor/chessground/chessground.cburnett.css',
  '/vendor/stockfish/stockfish-19-lite-single.js', '/vendor/stockfish/stockfish-19-lite-single.wasm',
  '/vendor/stockfish/stockfish-19-lite.js', '/vendor/stockfish/stockfish-19-lite.wasm',
];
const template = readFileSync('src/sw.js', 'utf8');
const hash = createHash('sha256').update(template);
for (const f of FILES) hash.update(f).update(readFileSync(join('../web', f === '/' ? 'index.html' : f.slice(1))));
const version = hash.digest('hex').slice(0, 12);
// About shows when the app last changed: the last commit touching what the build reads, so a push
// that changes only docs keeps the same stamp (and the same sw.js: no needless update on phones).
// Builds without Git history can supply the version timestamp through APP_COMMIT.
const APP_PATHS = ['web', 'core/src', 'core/tools', 'core/package.json', 'core/package-lock.json'];
function built() {
  if (process.env.APP_COMMIT) return JSON.parse(process.env.APP_COMMIT);
  const git = (...a) => execFileSync('git', a, { cwd: '..', encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    // a shallow clone would date every file to its one commit and give each push a new stamp
    if (git('rev-parse', '--is-shallow-repository') === 'true') git('fetch', '--quiet', '--unshallow');
    const [time, commit] = git('log', '-1', '--format=%cI %h', '--', ...APP_PATHS).split(' ');
    return { time, commit, local: git('status', '--porcelain', '--', ...APP_PATHS) !== '' };
  } catch {
    console.warn('no git history: About shows the version hash only');
    return null;
  }
}
const stamp = built();
writeFileSync('../web/sw.js', template.replace('__FILES__', JSON.stringify(FILES)).replace('__VERSION__', JSON.stringify(version))
  .replace('__BUILT__', JSON.stringify(stamp)));
console.log(`built web/core.js, web/vendor/stockfish/ and web/sw.js (version ${version}${stamp ? `, commit ${stamp.commit} of ${stamp.time}${stamp.local ? ' + local changes' : ''}` : ''})`);
