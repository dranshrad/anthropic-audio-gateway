import type { AudioFormat } from "./config.js";

export interface AudioProcessorOptions {
	format: AudioFormat;
	sampleRate: number;
	/** Target chunk duration in milliseconds (PCM only). */
	chunkDurationMs: number;
	/** Ring capacity in seconds of PCM (pre-allocated once). */
	ringBufferSeconds?: number;
}

/**
 * Fixed-capacity circular buffer over a single Int16Array.
 * Write/read pointers overwrite oldest samples — no per-frame Buffer allocations.
 */
export class PcmRingBuffer {
	readonly capacitySamples: number;
	private readonly samples: Int16Array;
	private writePos = 0;
	private readable = 0;

	constructor(capacitySamples: number) {
		if (capacitySamples < 1) {
			throw new Error("PcmRingBuffer capacity must be >= 1");
		}
		this.capacitySamples = capacitySamples;
		this.samples = new Int16Array(capacitySamples);
	}

	get available(): number {
		return this.readable;
	}

	get free(): number {
		return this.capacitySamples - this.readable;
	}

	reset(): void {
		this.writePos = 0;
		this.readable = 0;
	}

	/**
	 * Copy PCM samples from a little-endian Buffer into the ring.
	 * If the ring is full, oldest samples are overwritten (drop-tail circuit).
	 * Returns number of samples written.
	 */
	writeFromLeBuffer(data: Buffer): number {
		const sampleCount = Math.floor(data.byteLength / 2);
		if (sampleCount === 0) {
			return 0;
		}

		for (let i = 0; i < sampleCount; i += 1) {
			this.samples[this.writePos] = data.readInt16LE(i * 2);
			this.writePos += 1;
			if (this.writePos >= this.capacitySamples) {
				this.writePos = 0;
			}
			if (this.readable < this.capacitySamples) {
				this.readable += 1;
			}
		}
		return sampleCount;
	}

	/**
	 * Copy `count` samples into `dest` (must be length >= count) starting at destOffset.
	 * Returns samples actually read.
	 */
	readInto(dest: Int16Array, count: number, destOffset = 0): number {
		const toRead = Math.min(count, this.readable, dest.length - destOffset);
		if (toRead <= 0) {
			return 0;
		}

		const readPos = (this.writePos - this.readable + this.capacitySamples) % this.capacitySamples;

		for (let i = 0; i < toRead; i += 1) {
			const idx = (readPos + i) % this.capacitySamples;
			dest[destOffset + i] = this.samples[idx]!;
		}

		this.readable -= toRead;
		return toRead;
	}

	/** Peek without consuming — used by VAD against the next emit window. */
	peekInto(dest: Int16Array, count: number, destOffset = 0): number {
		const toPeek = Math.min(count, this.readable, dest.length - destOffset);
		if (toPeek <= 0) {
			return 0;
		}
		const readPos = (this.writePos - this.readable + this.capacitySamples) % this.capacitySamples;
		for (let i = 0; i < toPeek; i += 1) {
			dest[destOffset + i] = this.samples[(readPos + i) % this.capacitySamples]!;
		}
		return toPeek;
	}
}

/**
 * Zero-allocation PCM chunking via a pre-sized Int16Array ring + Buffer pool.
 * Opus frames pass through without re-chunking (no ring).
 *
 * Note: base64 / JSON wire encoding still allocates strings (unavoidable for the
 * Realtime JSON protocol). The hot ingest path itself does not Buffer.concat.
 */
export class AudioProcessor {
	readonly format: AudioFormat;
	readonly sampleRate: number;
	readonly chunkDurationMs: number;
	readonly samplesPerChunk: number;
	readonly bytesPerChunk: number;

	private readonly ring: PcmRingBuffer | null;
	/** Scratch Int16 window reused for every emitted PCM chunk. */
	private readonly chunkSamples: Int16Array;
	/** Pre-allocated LE byte buffers — rotated so we never allocate per frame. */
	private readonly chunkPool: Buffer[];
	private poolIndex = 0;
	private readonly emitScratch: Buffer[] = [];

	constructor(options: AudioProcessorOptions) {
		this.format = options.format;
		this.sampleRate = options.sampleRate;
		this.chunkDurationMs = options.chunkDurationMs;

		this.samplesPerChunk = Math.max(
			1,
			Math.floor((options.sampleRate * options.chunkDurationMs) / 1_000),
		);
		this.bytesPerChunk = this.samplesPerChunk * 2;
		this.chunkSamples = new Int16Array(this.samplesPerChunk);

		const ringSeconds = options.ringBufferSeconds ?? 10;
		const capacitySamples = Math.max(
			this.samplesPerChunk * 2,
			Math.floor(options.sampleRate * ringSeconds),
		);
		this.ring = options.format === "pcm16" ? new PcmRingBuffer(capacitySamples) : null;

		// Pool sized for a burst of frames within one event-loop turn before base64.
		const poolSize = 32;
		this.chunkPool = Array.from({ length: poolSize }, () =>
			Buffer.allocUnsafeSlow(this.bytesPerChunk),
		);
	}

	get pendingBytes(): number {
		if (!this.ring) {
			return 0;
		}
		return this.ring.available * 2;
	}

	get ringCapacitySamples(): number {
		return this.ring?.capacitySamples ?? 0;
	}

	/**
	 * Ingest a binary frame from the browser.
	 * Returns pooled Buffer views of complete chunks (valid until the next push cycle
	 * that reuses the same pool slots — encode/send synchronously before the next push).
	 */
	push(data: Buffer): Buffer[] {
		this.emitScratch.length = 0;
		if (data.byteLength === 0) {
			return this.emitScratch;
		}

		if (this.format === "opus") {
			this.emitScratch.push(data);
			return this.emitScratch;
		}

		if (!this.ring) {
			return this.emitScratch;
		}

		this.ring.writeFromLeBuffer(data);

		while (this.ring.available >= this.samplesPerChunk) {
			this.ring.readInto(this.chunkSamples, this.samplesPerChunk);
			this.emitScratch.push(this.packChunkSamples());
		}
		return this.emitScratch;
	}

	/**
	 * Flush remaining PCM samples as a (possibly short) final chunk into a pooled buffer.
	 */
	flush(): Buffer[] {
		this.emitScratch.length = 0;
		if (!this.ring || this.format === "opus" || this.ring.available === 0) {
			return this.emitScratch;
		}

		const remaining = this.ring.available;
		this.chunkSamples.fill(0);
		this.ring.readInto(this.chunkSamples, remaining);
		const buf = this.nextPoolBuffer();
		for (let i = 0; i < this.samplesPerChunk; i += 1) {
			buf.writeInt16LE(this.chunkSamples[i] ?? 0, i * 2);
		}
		// Short flush: return a subarray view of the valid prefix only.
		this.emitScratch.push(
			remaining === this.samplesPerChunk ? buf : buf.subarray(0, remaining * 2),
		);
		return this.emitScratch;
	}

	reset(): void {
		this.ring?.reset();
		this.poolIndex = 0;
		this.emitScratch.length = 0;
	}

	/** Encode a binary audio chunk as base64 for JSON transport. */
	toBase64(chunk: Buffer): string {
		return chunk.toString("base64");
	}

	fromBase64(encoded: string): Buffer {
		return Buffer.from(encoded, "base64");
	}

	toAppendEvent(chunk: Buffer): string {
		return JSON.stringify({
			type: "input_audio_buffer.append",
			audio: this.toBase64(chunk),
		});
	}

	decodeClientMessage(data: Buffer | ArrayBuffer | Buffer[]): {
		kind: "audio" | "json";
		audio?: Buffer;
		json?: unknown;
	} {
		const buffer = normalizeToBuffer(data);

		if (buffer.byteLength > 0 && buffer[0] === 0x7b /* '{' */) {
			const text = buffer.toString("utf8");
			try {
				const json: unknown = JSON.parse(text);
				if (
					typeof json === "object" &&
					json !== null &&
					"audio" in json &&
					typeof (json as { audio: unknown }).audio === "string"
				) {
					return {
						kind: "audio" as const,
						audio: this.fromBase64((json as { audio: string }).audio),
					};
				}
				return { kind: "json" as const, json };
			} catch {
				// Fall through as binary audio
			}
		}

		return { kind: "audio" as const, audio: buffer };
	}

	private packChunkSamples(): Buffer {
		const buf = this.nextPoolBuffer();
		for (let i = 0; i < this.samplesPerChunk; i += 1) {
			buf.writeInt16LE(this.chunkSamples[i]!, i * 2);
		}
		return buf;
	}

	private nextPoolBuffer(): Buffer {
		const buf = this.chunkPool[this.poolIndex]!;
		this.poolIndex = (this.poolIndex + 1) % this.chunkPool.length;
		return buf;
	}
}

function normalizeToBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
	if (Buffer.isBuffer(data)) {
		return data;
	}
	if (Array.isArray(data)) {
		return Buffer.concat(data);
	}
	return Buffer.from(data);
}
