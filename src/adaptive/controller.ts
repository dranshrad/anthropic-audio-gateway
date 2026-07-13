import type { Config } from "../config.js";
import type { SessionStats } from "../session/stats.js";

export interface AdaptiveParams {
	chunkDurationMs: number;
	highWaterMark: number;
	vadHangoverMs: number;
	vadEntropyThreshold: number;
}

/**
 * Adapt chunk size, HWM, and VAD sensitivity from live session conditions.
 */
export class AdaptiveStreamingController {
	private params: AdaptiveParams;

	constructor(private readonly base: Config) {
		this.params = {
			chunkDurationMs: base.CHUNK_DURATION_MS,
			highWaterMark: base.HIGH_WATER_MARK,
			vadHangoverMs: base.VAD_HANGOVER_MS,
			vadEntropyThreshold: base.VAD_ENTROPY_THRESHOLD,
		};
	}

	get current(): AdaptiveParams {
		return { ...this.params };
	}

	update(stats: SessionStats): AdaptiveParams {
		if (!this.base.ADAPTIVE_STREAMING) {
			return this.current;
		}

		const snap = stats.snapshot(this.base.SAMPLE_RATE);
		let { chunkDurationMs, highWaterMark, vadHangoverMs, vadEntropyThreshold } = this.params;

		// High queue → increase HWM slightly then rely on pause; shrink chunks for lower latency recover
		if (snap.queueDepth > 8 || snap.bufferOccupancyBytes > this.base.HIGH_WATER_MARK * 0.8) {
			chunkDurationMs = Math.min(100, chunkDurationMs + 10);
			highWaterMark = Math.min(this.base.MAX_BUFFERED_BYTES, Math.floor(highWaterMark * 1.1));
		} else if (snap.avgRttMs !== null && snap.avgRttMs < 50 && snap.queueDepth < 2) {
			chunkDurationMs = Math.max(20, chunkDurationMs - 5);
			highWaterMark = Math.max(65_536, Math.floor(highWaterMark * 0.95));
		}

		// Noisy / high silence → tighten hangover; active speech → preserve fricatives
		if (snap.silenceRatio > 0.7) {
			vadHangoverMs = Math.max(200, vadHangoverMs - 25);
			vadEntropyThreshold = Math.min(10, vadEntropyThreshold + 0.1);
		} else if (snap.vadTriggers > 0) {
			vadHangoverMs = Math.min(600, Math.max(this.base.VAD_HANGOVER_MS, vadHangoverMs));
			vadEntropyThreshold = Math.max(6, vadEntropyThreshold - 0.05);
		}

		this.params = { chunkDurationMs, highWaterMark, vadHangoverMs, vadEntropyThreshold };
		return this.current;
	}
}
