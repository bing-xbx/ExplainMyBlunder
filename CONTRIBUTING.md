# Contributing

Issues and pull requests are welcome. Small, focused changes with a reproducible example are easiest to review.

## Get started

Fork the repository, create a branch and install Node.js 22 or newer. From the repository root:

```sh
cd core
npm ci
npm test
npm run typecheck
npm run build
```

The build creates the static app in `web/`. See the README for local serving and the response headers needed by the engine.

## Tests

Unit and analysis-parity tests run without a browser. Their recorded fixtures use famous public games, so results are repeatable without downloading player accounts or using a hosted service.

Browser tests require Chrome or Edge. They discover common installation locations; set `CHROME_PATH` when your browser is elsewhere. After building, run these from `core/`:

```sh
node test/ui/update.mjs
node test/ui/plus.mjs
node test/ui/account.mjs
node test/ui/security.mjs
node test/ui/monkey.mjs --seed 1 --actions 60 --screens desktop,phone
```

Account and coach-interface tests use fake services and synthetic accounts. They never require payment details or real sign-in credentials. The security tests exercise input validation, browser script policy, offline behavior and a mocked checkout loader.

## Before opening a pull request

- Explain the problem and the resulting behavior. For a bug, include steps to reproduce it.
- Add a regression test that fails before the fix. For chess changes, include the relevant position, moves and expected explanation.
- Keep test data public or synthetic. Do not include account credentials, tokens, personal game histories or browser-storage exports.
- Run the relevant tests and the full CI checks above. For UI changes, check both phone and desktop layouts.
- Keep expected fixture changes focused and explain why the new result is correct.

Changes are reviewed through pull requests; the CI workflow checks branch pushes and pull requests. Contributions are licensed under the repository's GPL-3.0 licence.
