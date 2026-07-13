# Manual smoke test — real provider

Automated CI uses `PROVIDER=mock` only (no cloud secrets). Use this checklist to verify a live Anthropic or OpenAI session on your machine.

## Anthropic

1. Copy `.env.example` → `.env`
2. Set:
   ```bash
   PROVIDER=anthropic
   ANTHROPIC_API_KEY=sk-ant-...   # real key
   AUTH_JWT_SECRET=               # leave empty only on localhost
   ```
3. `npm run dev`
4. Open [`examples/demo-client.html`](../examples/demo-client.html) in a browser (or serve the `examples/` folder)
5. Connect to `ws://127.0.0.1:8080`
6. Confirm:
   - Status shows `gateway.ready` with `provider: anthropic`
   - Tone or mic audio produces upstream activity / transcript-like events
   - Optional: force backpressure by lowering `HIGH_WATER_MARK` and watch `gateway.pause` / `gateway.resume`

## OpenAI

Same steps with:

```bash
PROVIDER=openai
OPENAI_API_KEY=sk-...
```

## Evidence for reviewers

Capture a short screen recording or screenshot of the demo client showing `gateway.ready` and live events. Do **not** commit API keys or `.env`.

## Security reminder

If you smoke-test on a non-loopback interface, set `AUTH_JWT_SECRET` (and consider `AUTH_REQUIRED=true`). An unset secret is an **open relay** to your provider API key.
