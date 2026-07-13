# Benchmark report (mock provider)

Generated via `npm run bench` on 2026-07-14 (developer workstation).

## Method

- Provider: in-process `mock` (no network)
- Audio: 40 ms PCM16 @ 24 kHz (440 Hz tone)
- Pipeline: ring-buffer chunking + spectral VAD + mock append
- Concurrency: 20 sessions × 50 frames

## Results

| Metric | Value |
| --- | --- |
| Elapsed | 46 ms |
| Appends | 1000 |
| Throughput | ~21.7k frames/s |
| Byte throughput | ~41.7 MB/s |
| Append p50 | ~0.0015 ms |
| Append p95 | ~0.005 ms |
| Append p99 | ~0.015 ms |
| RSS Δ / session | ~0.5 MB |

## Interpreting GC

The Zero-GC ring eliminates `Buffer.concat` in the hot ingest path. Remaining allocations are base64/JSON for the Realtime wire format (unavoidable for JSON providers).
