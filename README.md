# Anthropic Live-Audio Stream Gateway

Production-grade Node.js TypeScript WebSocket gateway that accepts raw browser audio (16-bit PCM @ 24 kHz or Opus), applies spectral-entropy Voice Activity Detection (with a 400ms hangover), and duplex-bridges the stream to Anthropic's Realtime WSS API through a Zero-GC ring buffer and Transform-stream backpressure.

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
│  src/gateway.ts               │  Transform pipeline + circuit breaker
│    ├─ vad-util.ts             │  Spectral entropy + 400ms hangover
│    └─ audio-processor.ts      │  Int16Array ring buffer (Zero-GC)
└───────────────┬───────────────┘
                │  WSS + x-api-key
                ▼
     Anthropic Realtime WSS
```

| Module | Role |
| --- | --- |
| [`src/index.ts`](src/index.ts) | HTTP server, `/health`, WebSocket accept, SIGINT/SIGTERM drain |
| [`src/gateway.ts`](src/gateway.ts) | Duplex bridge; `HIGH_WATER_MARK` pause/resume; rate-limit backoff |
| [`src/audio-processor.ts`](src/audio-processor.ts) | Pre-allocated PCM ring + Buffer pool; Opus passthrough |
| [`src/vad-util.ts`](src/vad-util.ts) | Spectral-entropy VAD + fricative rescue + hangover |
| [`src/config.ts`](src/config.ts) | Boot-time Zod validation; `sk-ant-` key prefix; `process.exit(1)` on failure |

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
| `NODE_ENV` | `development` | `development` \| `production` \| `test` |
| `PORT` | `8080` | Listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `ANTHROPIC_API_KEY` | *(required)* | Must start with `sk-ant-` |
| `ANTHROPIC_REALTIME_WSS_URL` | `wss://api.anthropic.com/v1/realtime` | Upstream WebSocket URL |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-20250514` | Model for `session.update` |
| `ANTHROPIC_API_VERSION` | `2023-06-01` | `anthropic-version` header |
| `AUDIO_FORMAT` | `pcm16` | `pcm16` or `opus` |
| `SAMPLE_RATE` | `24000` | PCM sample rate (Hz) |
| `CHUNK_DURATION_MS` | `40` | PCM chunk size target |
| `RING_BUFFER_SECONDS` | `10` | Pre-allocated Int16Array ring capacity |
| `VAD_ENTROPY_THRESHOLD` | `7.5` | Max spectral entropy (bits); `0` disables |
| `VAD_ENERGY_FLOOR` | `0.0015` | Minimum RMS so digital silence never passes |
| `VAD_FRICATIVE_RATIO` | `0.18` | High-band power ratio for s/f/th rescue |
| `VAD_HANGOVER_MS` | `400` | Hold open after last speech detection |
| `HIGH_WATER_MARK` | `262144` | Pause browser when upstream buffer exceeds this |
| `MAX_BUFFERED_BYTES` | `1048576` | Hard ceiling before circuit opens |
| `RATE_LIMIT_BASE_DELAY_MS` | `500` | Initial backoff on rate limit |
| `RATE_LIMIT_MAX_DELAY_MS` | `30000` | Cap for exponential backoff |

Misconfigured env (including a key that does not start with `sk-ant-`) prints a boot error and exits before port bind. Copy [`.env.example`](.env.example) and fill in secrets. Never commit `.env`.

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
   - Gateway events: `gateway.pause` / `gateway.resume`, `gateway.backpressure`, `gateway.rate_limited`, `gateway.upstream_closed`, `gateway.error`

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

- Audio frames flow through an object-mode `Transform` bounded by `HIGH_WATER_MARK`.
- When Anthropic `bufferedAmount` (or the transform queue) exceeds the mark, the gateway emits **`gateway.pause`**, calls `client.pause()`, and stops accepting audio so the browser queues locally.
- On drain / buffer clear it emits **`gateway.resume`** and resumes the socket. Memory on the gateway stays bounded regardless of upstream throttle.
- Upstream `429` / `rate_limit_*` / overloaded errors trigger exponential backoff plus the same pause/resume path.
- Either side disconnecting closes the peer cleanly; process `SIGINT`/`SIGTERM` drains all sessions.

## Zero-GC audio path

PCM ingest writes into a pre-allocated `Int16Array` ring (`RING_BUFFER_SECONDS`, default 10s) with a rotating Buffer pool for chunk emit. No `Buffer.concat` in the hot path — eliminating GC pauses that cause audible jitter.

## Voice Activity Detection

For `pcm16`, each chunk is analyzed with a Hann-windowed FFT:

1. **Energy floor** — reject digital silence.
2. **Spectral entropy** — structured speech scores lower than flat noise.
3. **Fricative rescue** — high-band power ratio recovers trailing “s” / “f” / “th” that RMS gates clip.
4. **400ms hangover** — after the last positive detection the gate stays open to capture breathing and inter-word pauses before sealing dispatch.

For `opus`, packets are always forwarded (no decode). Set `VAD_ENTROPY_THRESHOLD=0` to disable entropy gating.

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
