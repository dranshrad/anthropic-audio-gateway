export interface SessionStatsSnapshot {
	sessionId: string;
	providerId: string;
	startedAtMs: number;
	uptimeMs: number;
	speechFramesSent: number;
	silenceDroppedFrames: number;
	vadTriggers: number;
	reconnects: number;
	rateLimitEvents: number;
	pauseEvents: number;
	bytesAppended: number;
	audioDurationMs: number;
	silenceRatio: number;
	speakingRateFramesPerSec: number;
	queueDepth: number;
	bufferOccupancyBytes: number;
	lastRttMs: number | null;
	avgRttMs: number | null;
	providerErrors: number;
}

/**
 * Per-session operational intelligence (transport + signal quality).
 */
export class SessionStats {
	readonly sessionId: string;
	readonly providerId: string;
	readonly startedAtMs = Date.now();

	speechFramesSent = 0;
	silenceDroppedFrames = 0;
	vadTriggers = 0;
	reconnects = 0;
	rateLimitEvents = 0;
	pauseEvents = 0;
	bytesAppended = 0;
	audioSamplesForwarded = 0;
	providerErrors = 0;
	queueDepth = 0;
	bufferOccupancyBytes = 0;

	private lastSpeech = false;
	private rttSamples: number[] = [];
	private pendingPingAt: number | null = null;

	constructor(sessionId: string, providerId: string) {
		this.sessionId = sessionId;
		this.providerId = providerId;
	}

	recordVad(isSpeech: boolean): void {
		if (isSpeech && !this.lastSpeech) {
			this.vadTriggers += 1;
		}
		this.lastSpeech = isSpeech;
	}

	recordSpeechFrame(byteLength: number, sampleRate: number): void {
		this.speechFramesSent += 1;
		this.bytesAppended += byteLength;
		this.audioSamplesForwarded += Math.floor(byteLength / 2);
		void sampleRate;
	}

	recordSilenceDrop(): void {
		this.silenceDroppedFrames += 1;
	}

	recordPause(): void {
		this.pauseEvents += 1;
	}

	recordRateLimit(): void {
		this.rateLimitEvents += 1;
	}

	recordReconnect(): void {
		this.reconnects += 1;
	}

	recordProviderError(): void {
		this.providerErrors += 1;
	}

	updateQueue(queueDepth: number, bufferOccupancyBytes: number): void {
		this.queueDepth = queueDepth;
		this.bufferOccupancyBytes = bufferOccupancyBytes;
	}

	markPing(): void {
		this.pendingPingAt = Date.now();
	}

	markPong(): void {
		if (this.pendingPingAt === null) {
			return;
		}
		const rtt = Date.now() - this.pendingPingAt;
		this.pendingPingAt = null;
		this.rttSamples.push(rtt);
		if (this.rttSamples.length > 64) {
			this.rttSamples.shift();
		}
	}

	snapshot(sampleRate: number): SessionStatsSnapshot {
		const uptimeMs = Math.max(1, Date.now() - this.startedAtMs);
		const totalFrames = this.speechFramesSent + this.silenceDroppedFrames;
		const silenceRatio = totalFrames === 0 ? 0 : this.silenceDroppedFrames / totalFrames;
		const audioDurationMs = (this.audioSamplesForwarded / sampleRate) * 1_000;
		const speakingRateFramesPerSec = (this.speechFramesSent / uptimeMs) * 1_000;
		const lastRttMs =
			this.rttSamples.length > 0 ? (this.rttSamples[this.rttSamples.length - 1] ?? null) : null;
		const avgRttMs =
			this.rttSamples.length > 0
				? this.rttSamples.reduce((a, b) => a + b, 0) / this.rttSamples.length
				: null;

		return {
			sessionId: this.sessionId,
			providerId: this.providerId,
			startedAtMs: this.startedAtMs,
			uptimeMs,
			speechFramesSent: this.speechFramesSent,
			silenceDroppedFrames: this.silenceDroppedFrames,
			vadTriggers: this.vadTriggers,
			reconnects: this.reconnects,
			rateLimitEvents: this.rateLimitEvents,
			pauseEvents: this.pauseEvents,
			bytesAppended: this.bytesAppended,
			audioDurationMs,
			silenceRatio,
			speakingRateFramesPerSec,
			queueDepth: this.queueDepth,
			bufferOccupancyBytes: this.bufferOccupancyBytes,
			lastRttMs,
			avgRttMs,
			providerErrors: this.providerErrors,
		};
	}
}
