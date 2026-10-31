# ExplainMyBlunder

[![Tests](https://github.com/bing-xbx/ExplainMyBlunder/actions/workflows/ci.yml/badge.svg)](https://github.com/bing-xbx/ExplainMyBlunder/actions/workflows/ci.yml)

Understand mistakes in your chess games, and see better moves on the board.

Stockfish finds the moment; code finds the concrete reason: a piece left hanging, a threat you ignored, a fork or a pin, a trapped piece, a mate. Every explained moment shows two lines side by side, what you played and the best move, each run until the position is quiet, so you see the material you lost, and the gain you missed.

Everything runs on your device: Stockfish 19 lite in WebAssembly, the explanations, and your reviews (stored in the browser). There is no account and no server. Fetch your recent games from Lichess or chess.com, or paste a PGN.

## Use it

Open [ExplainMyBlunder](https://explainmyblunder.pages.dev/) in your phone's browser and add it to the home screen; it can then work offline.

## Optional hosted AI coach

The free ExplainMyBlunder app is open source under GPL-3.0. Game reviews, on-board explanations and the **Explain moves I try** feature run on your device, with no account required.

For players who want to ask follow-up questions about a position, we are developing an optional hosted AI coach. The coach is a separate online service; it does not run on your device and is not included in the GPL-licensed app. This repository includes the browser interface for connecting to a compatible service. The free app works fully without it.

The coach is currently a preview, and paid subscriptions are not yet available. Try the free app and follow this repository for coach preview and launch announcements.

## Build it

You need Node.js 22 or newer.

```
cd core
npm ci
npm test              # unit, analysis-parity and input-validation tests
npm run build         # bundles core/src into web/core.js, copies the Stockfish WebAssembly engine, writes web/sw.js
npm run test:update   # the installed app's updates, in Chrome or Edge
npm run test:plus     # the coach card in the chat panel, in Chrome or Edge
```

`web/` is then a static site. Any static host works; for the multi-threaded engine it must send the cross-origin isolation headers in `web/_headers` (Cloudflare Pages and Workers read that file). Without them the engine runs on one thread, more slowly.

For a quick local look: `npx serve web` (single-threaded) and open the address it prints.

## Tests and contributions

Automated checks run on every branch push and pull request. The test suite includes:

| Checks | Coverage |
| --- | --- |
| Unit and device tests | Chess rules, tactics, game parsing, engine messages and review behavior |
| Analysis parity | Recorded results for six famous games, with expected explanations and board annotations |
| Security regressions | Review validation, script-injection defenses, enforced browser policy and session handling |
| Browser tests | Offline updates, account flows against a fake service, coach UI and interactions on desktop and phone |

From `core/`, run `npm test`, `npm run typecheck`, then `npm run build`. With Chrome or Edge installed, run `npm run test:security`, `npm run test:account`, `npm run test:update` and `npm run test:plus`. The CI also runs a repeatable UI interaction test on desktop and phone. All test accounts and services are simulated; no paid account or service credentials are required.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow and complete check commands.

## Layout

- `web/`: the page (`index.html`, `app.js`, `style.css`), `config.json` (see below), and Lichess's board, chessground, vendored in `web/vendor/chessground/`.
- `core/src/`: the chess logic in TypeScript on top of chessops: game records, the engine over UCI in a Web Worker, judging moves the way Lichess does, finding and explaining the blunders, interactive move exploration ("Explain moves I try"), and the in-page answers to every `/api` route of the page.
- `core/test/`: unit, parity and browser tests; public-game fixtures provide repeatable examples.
- `core/src/sw.js`: the offline service worker. The build stamps it with a hash of every app file, so each deploy is a new version that downloads whole and switches at the next launch.

## config.json

```
{ "backend": null, "upgrade_url": null }
```

- `backend`: configuration for an optional coach service. It must expose the account/session API on the same origin; sessions use secure HttpOnly cookies. `null` keeps the app fully free and standalone. If configuring sign-in in another region, update the connection allowlist in `web/_headers` as well.
- `upgrade_url`: a page about the paid coach, linked from the chat panel. `null` shows "Coming soon".

## Licence

GPL-3.0 (see `LICENSE`), the licence of Stockfish, chessops and chessground, which this app bundles. See `THIRD-PARTY.md`.
