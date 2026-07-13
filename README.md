# Anthropic Live-Audio Stream Gateway

Production-grade Node.js TypeScript WebSocket gateway that accepts raw browser audio (16-bit PCM @ 24 kHz or Opus), applies energy-based Voice Activity Detection to skip silence, and duplex-bridges the stream to Anthropic's Realtime WSS API with explicit backpressure handling.

**License:** [GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`)

> **Upstream note:** Anthropic's public Messages API is HTTP/SSE today. This gateway speaks a Realtime-style WebSocket event protocol (`session.update`, `input_audio_buffer.append`, audio deltas, rate-limit errors) against a configurable `ANTHROPIC_REALTIME_WSS_URL`. Point that URL at a compatible Realtime endpoint (or your own adapter) before production use.

## Architecture

```
Browser mic (PCM16 / Opus)
        │  WebSocket binary or JSON
        ▼
┌───────────────────────────────┐
│  src/index.ts  (:8080)        │  HTTP /health + WS upgrade
│  per-connection GatewaySession│
└───────────────┬───────────────┘
                │
                ▼
┌───────────────────────────────┐
│  src/gateway.ts               │  Duplex bridge + backpressure
│    ├─ vad-util.ts             │  Drop pure silence (PCM energy)
│    └─ audio-processor.ts      │  Chunk + base64 encode
└───────────────┬───────────────┘
                │  WSS + x-api-key
                ▼
     Anthropic Realtime WSS
```

| Module | Role |
| --- | --- |
| [`src/index.ts`](src/index.ts) | HTTP server, `/health`, WebSocket accept, SIGINT/SIGTERM drain |
| [`src/gateway.ts`](src/gateway.ts) | One client ↔ one upstream session; backpressure; rate-limit backoff |
| [`src/audio-processor.ts`](src/audio-processor.ts) | PCM framing, Opus passthrough, base64, client message decode |
| [`src/vad-util.ts`](src/vad-util.ts) | RMS energy VAD with hangover; Opus packets always forward |
| [`src/config.ts`](src/config.ts) | Strict Zod validation of environment variables |

## Requirements

- Node.js **20+**
- An Anthropic API key
- A reachable Realtime-compatible WSS endpoint (`ANTHROPIC_REALTIME_WSS_URL`)

## Quick start

```bash
git clone <your-fork-url> anthropic-audio-gateway
cd anthropic-audio-gateway
cp .env.example .env
# Edit .env — set ANTHROPIC_API_KEY and ANTHROPIC_REALTIME_WSS_URL

npm install
npm run dev
```

The gateway listens on `ws://0.0.0.0:8080` by default.

```bash
curl -s http://127.0.0.1:8080/health
```

### Production

```bash
npm run build
npm start
```

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | Listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `ANTHROPIC_API_KEY` | *(required)* | API key sent as `x-api-key` / Bearer |
| `ANTHROPIC_REALTIME_WSS_URL` | `wss://api.anthropic.com/v1/realtime` | Upstream WebSocket URL |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-20250514` | Model for `session.update` |
| `ANTHROPIC_API_VERSION` | `2023-06-01` | `anthropic-version` header |
| `AUDIO_FORMAT` | `pcm16` | `pcm16` or `opus` |
| `SAMPLE_RATE` | `24000` | PCM sample rate (Hz) |
| `CHUNK_DURATION_MS` | `40` | PCM chunk size target |
| `VAD_ENERGY_THRESHOLD` | `0.01` | Normalized RMS; `0` disables VAD |
| `VAD_HANGOVER_MS` | `300` | Keep streaming after energy drops |
| `MAX_BUFFERED_BYTES` | `1048576` | Pause client when upstream buffer exceeds this |
| `RATE_LIMIT_BASE_DELAY_MS` | `500` | Initial backoff on rate limit |
| `RATE_LIMIT_MAX_DELAY_MS` | `30000` | Cap for exponential backoff |

Copy [`.env.example`](.env.example) and fill in secrets. Never commit `.env`.

## Client protocol

1. Open a WebSocket to the gateway (`ws://host:8080`).
2. Wait for `{ "type": "gateway.ready", ... }`.
3. Stream audio as **binary frames** (preferred) or JSON `{ "audio": "<base64>" }`.
4. Optional control JSON (relayed or handled locally):
   - `input_audio_buffer.commit`
   - `input_audio_buffer.clear`
   - `session.update` / `response.create` / `conversation.item.create`
   - `gateway.ping` → `gateway.pong`
5. Receive:
   - Binary audio deltas from the model (when present)
   - Upstream JSON events (transcripts, errors, etc.)
   - Gateway events: `gateway.backpressure`, `gateway.rate_limited`, `gateway.upstream_closed`, `gateway.error`

### Browser sketch (PCM)

```js
const ws = new WebSocket("ws://localhost:8080");
ws.binaryType = "arraybuffer";

ws.onmessage = (ev) => {
  if (typeof ev.data === "string") {
    console.log(JSON.parse(ev.data));
  } else {
    // play PCM / Opus chunk
  }
};

// After gateway.ready, send Int16Array PCM buffers:
// ws.send(pcmInt16.buffer);
```

## Backpressure & resilience

- Outbound upstream send size is tracked; when `bufferedAmount` / queued bytes exceed `MAX_BUFFERED_BYTES`, the client socket is **paused** and silence continues to be dropped.
- On `drain` (or when the buffer clears), the client is **resumed** and a `gateway.backpressure` event is emitted.
- Upstream `429` / `rate_limit_*` / overloaded errors trigger exponential backoff, client pause, and `gateway.rate_limited` / `gateway.rate_limit_cleared` events.
- Either side disconnecting closes the peer cleanly; process `SIGINT`/`SIGTERM` drains all sessions.

## Voice Activity Detection

For `pcm16`, each chunk's RMS energy is compared to `VAD_ENERGY_THRESHOLD`. Frames below the threshold are not forwarded (saving tokens), except during a hangover window after recent speech. For `opus`, packets are always forwarded because energy cannot be measured without decoding.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Run with `tsx` watch |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run compiled server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run check` | Biome lint + format check |
| `npm run lint` | Biome lint only |
| `npm run format` | Biome format write |

CI runs typecheck, Biome, and build on Node 20 and 22 ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

## AGPL-3.0 obligations

This software is licensed under the **GNU Affero General Public License v3.0 only**. If you modify it and provide it as a network service (e.g. host this gateway publicly), you must offer the corresponding source code to users of that service under AGPL-3.0. See [LICENSE](LICENSE) for the full terms.

## Security

- Keep `ANTHROPIC_API_KEY` server-side only; never expose it to the browser.
- Terminate TLS in front of the gateway in production (`wss://`).
- Restrict who can open WebSocket connections (auth proxy, IP allowlist, or tokens) before exposing this on the public internet.

## Contributing

1. Fork and branch from `main` / `master`.
2. Run `npm run check && npm run typecheck && npm run build`.
3. Open a pull request.

## Disclaimer

This project is not affiliated with Anthropic PBC. “Anthropic” and “Claude” are trademarks of their respective owners. The Realtime WSS path and event schema are designed for forward compatibility; verify against Anthropic's current documentation before deploying.
