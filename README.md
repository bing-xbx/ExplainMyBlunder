# ExplainMyBlunder

The standalone ExplainMyBlunder app, distilled from the complete private project.

Find the moments you threw away in your chess games, and see why, on your phone.

Stockfish finds the moment; code finds the concrete reason: a piece left hanging, a threat you ignored, a fork or a pin, a trapped piece, a mate. Every explained moment shows two lines side by side, what you played and the best move, each run until the position is quiet, so you see the material you lost, and the gain you missed.

Everything runs on your device: Stockfish 19 lite in WebAssembly, the explanations, and your reviews (stored in the browser). There is no account and no server. Fetch your recent games from Lichess or chess.com, or paste a PGN.

## Use it

Open the app in your phone's browser and add it to the home screen; it then works offline.

## Optional hosted AI coach

The free ExplainMyBlunder app is open source under GPL-3.0. Game reviews, on-board explanations and What-if analysis run on your device, with no account required.

For players who want to ask follow-up questions about a position, we are developing an optional hosted AI coach. The coach's backend is proprietary, closed-source software and is not included in this repository. The browser interface is included here; the model runs through the hosted service, not on your device. AI coaching is optional: the free app remains complete on its own.

The coach is currently a preview, and paid subscriptions are not yet available. Try the free app and follow this repository for coach preview and launch announcements.

## Build it

You need Node.js 22 or newer.

```
cd core
npm ci
npm test              # unit tests
npm run build         # bundles core/src into web/core.js, copies the Stockfish WebAssembly engine, writes web/sw.js
npm run test:update   # the installed app's updates, in Chrome or Edge
npm run test:plus     # the coach card in the chat panel, in Chrome or Edge
```

`web/` is then a static site. Any static host works; for the multi-threaded engine it must send the cross-origin isolation headers in `web/_headers` (Cloudflare Pages and Workers read that file). Without them the engine runs on one thread, more slowly.

For a quick local look: `npx serve web` (single-threaded) and open the address it prints.

## Layout

- `web/`: the page (`index.html`, `app.js`, `style.css`), `config.json` (see below), and Lichess's board, chessground, vendored in `web/vendor/chessground/`.
- `core/src/`: the chess logic in TypeScript on top of chessops: game records, the engine over UCI in a Web Worker, judging moves the way Lichess does, finding and explaining the blunders, "What if" mode, and the in-page answers to every `/api` route of the page.
- `core/src/sw.js`: the offline service worker. The build stamps it with a hash of every app file, so each deploy is a new version that downloads whole and switches at the next launch.

## config.json

```
{ "backend": null, "upgrade_url": null }
```

- `backend`: the address of an optional paid service (the coach). `null` keeps the app fully free and standalone.
- `upgrade_url`: a page about the paid coach, linked from the chat panel. `null` shows "Coming soon".

## Licence

GPL-3.0 (see `LICENSE`), the licence of Stockfish, chessops and chessground, which this app bundles. See `THIRD-PARTY.md`.
