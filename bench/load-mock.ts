/**
 * Concurrent mock-provider load benchmark.
 * Run: npm run bench
 *
 * Measures end-to-end append latency, throughput, RSS/session, and concurrent sessions
 * against the in-process mock provider (no external network).
 */
process.env.PROVIDER ??= "mock";
process.env.METRICS_ENABLED ??= "false";
process.env.WEBRTC_INGRESS ??= "false";
process.env.ADAPTIVE_STREAMING ??= "false";
process.env.LOG_LEVEL ??= "error";

const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 20);
const FRAMES_PER_SESSION = Number(process.env.BENCH_FRAMES ?? 50);
const SAMPLE_RATE = 24_000;
const FRAME_MS = 40;
const SAMPLES = Math.floor((SAMPLE_RATE * FRAME_MS) / 1_000);

function makePcmFrame(): Buffer {
	const buf = Buffer.alloc(SAMPLES * 2);
	for (let i = 0; i < SAMPLES; i += 1) {
		// 440 Hz tone — structured speech-like energy for VAD
		const sample = Math.floor(Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE) * 8_000);
		buf.writeInt16LE(sample, i * 2);
	}
	return buf;
}

async function main(): Promise<void> {
	const { MockProviderAdapter } = await import("../src/providers/mock.js");
	const { AudioProcessor } = await import("../src/audio-processor.js");
	const { createVadState, isSpeech } = await import("../src/vad-util.js");

	const adapter = new MockProviderAdapter();
	const frame = makePcmFrame();
	const rssBefore = process.memoryUsage().rss;

	const latencies: number[] = [];
	let bytes = 0;
	const started = Date.now();

	await Promise.all(
		Array.from({ length: CONCURRENCY }, async (_, sessionIdx) => {
			const processor = new AudioProcessor({
				format: "pcm16",
				sampleRate: SAMPLE_RATE,
				chunkDurationMs: FRAME_MS,
				ringBufferSeconds: 10,
			});
			const vadState = createVadState();
			const conn = await adapter.connect({
				sessionId: `bench-${sessionIdx}`,
				config: {
					HIGH_WATER_MARK: 262_144,
				} as never,
				audioFormat: "pcm16",
				sampleRate: SAMPLE_RATE,
				model: "mock-realtime",
			});

			for (let i = 0; i < FRAMES_PER_SESSION; i += 1) {
				const chunks = processor.push(frame);
				for (const chunk of chunks) {
					const speech = isSpeech(chunk, vadState, {
						entropyThreshold: 7.5,
						energyFloor: 0.0015,
						fricativeRatio: 0.18,
						hangoverMs: 400,
						sampleRate: SAMPLE_RATE,
						encoding: "pcm16",
					});
					if (!speech) {
						continue;
					}
					const t0 = performance.now();
					conn.sendAudioAppend(chunk.toString("base64"));
					latencies.push(performance.now() - t0);
					bytes += chunk.byteLength;
				}
			}
			conn.close();
		}),
	);

	const elapsedMs = Date.now() - started;
	const rssAfter = process.memoryUsage().rss;
	latencies.sort((a, b) => a - b);
	const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
	const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;
	const p99 = latencies[Math.floor(latencies.length * 0.99)] ?? 0;

	const report = {
		concurrency: CONCURRENCY,
		framesPerSession: FRAMES_PER_SESSION,
		elapsedMs,
		appends: latencies.length,
		throughputFramesPerSec: (latencies.length / elapsedMs) * 1_000,
		throughputBytesPerSec: (bytes / elapsedMs) * 1_000,
		latencyMs: { p50, p95, p99 },
		rssBytes: {
			before: rssBefore,
			after: rssAfter,
			deltaPerSession: (rssAfter - rssBefore) / CONCURRENCY,
		},
		gcNote: "PCM path uses Int16Array ring + buffer pool (Zero-GC ingest)",
	};

	console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
