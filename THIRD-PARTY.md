# Third-party software

This app bundles the following, each under the GNU General Public License version 3 (GPL-3.0), which is why the app itself is GPL-3.0.

- **Stockfish 19** (the chess engine, lite network, WebAssembly build from the `stockfish` npm package 19.0.1), GPL-3.0, by the Stockfish developers: https://stockfishchess.org, source https://github.com/official-stockfish/Stockfish and https://github.com/nmrugg/stockfish.js. Copied into `web/vendor/stockfish/` by the build, with its licence text.
- **chessops** 0.15.1 (chess rules, notation, PGN), GPL-3.0-or-later, by Niklas Fiekas: https://github.com/niklasf/chessops. Bundled into `web/core.js` by the build.
- **chessground** 10.4.2 (the board), GPL-3.0, by Lichess: https://github.com/lichess-org/chessground. Vendored in `web/vendor/chessground/` with its licence.
- **Piece set "cburnett"** (in `chessground.cburnett.css`), by Colin M.L. Burnett, as distributed with chessground and Lichess (Lichess lists it as GPLv2+).

Games are fetched from the Lichess and chess.com public APIs on the user's own device; this app is not affiliated with either site.
