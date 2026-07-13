# Contributing

Thanks for helping improve the Anthropic Live-Audio Stream Gateway.

## Prerequisites

- Node.js **20+**
- npm

## Setup

```bash
cp .env.example .env
# Keep PROVIDER=mock for local work (no cloud keys required)
npm install
```

## Required checks before a PR

```bash
npm run check
npm run typecheck
npm test
npm run build
```

CI runs the same four steps on Node 20 and 22 (see `.github/workflows/ci.yml`). `npm run bench` is optional/local.

## Tests

- Unit and integration tests live under [`test/`](test/)
- Runner: Node.js built-in test runner via `node --import tsx --test`
- Prefer pure helpers (e.g. ring buffer, VAD, `shouldPause`) for concurrency/timing logic
- Use `PROVIDER=mock` and `createApp` for WebSocket integration tests — do not put real API keys in CI

```bash
npm test
npm run test:watch
```

## Code style

- TypeScript strict ESM
- Format/lint with Biome (`npm run check`)

## License (AGPL-3.0)

This project is licensed under the **GNU Affero General Public License v3.0 only**. If you modify the software and provide it as a network service, you must offer the corresponding source to users of that service. See [LICENSE](LICENSE).

## Pull requests

1. Keep changes focused; include tests for ring/VAD/backpressure behavior when touched.
2. Update README or `.env.example` when adding env vars.
3. Do not commit `.env` or secrets.
