import type { AudioFormat } from "./config.js";

export interface AudioProcessorOptions {
	format: AudioFormat;
	sampleRate: number;
	/** Target chunk duration in milliseconds (PCM only). */
	chunkDurationMs: number;
}

/**
 * Handles binary buffer accumulation, fixed-size PCM chunking, and base64
 * encoding for upstream Realtime JSON messages.
 */
export class AudioProcessor {
	readonly format: AudioFormat;
	readonly sampleRate: number;
	readonly chunkDurationMs: number;
	readonly bytesPerChunk: number;

	private pending = Buffer.alloc(0);

	constructor(options: AudioProcessorOptions) {
		this.format = options.format;
		this.sampleRate = options.sampleRate;
		this.chunkDurationMs = options.chunkDurationMs;

		if (options.format === "pcm16") {
			// 16-bit mono = 2 bytes/sample
			const samplesPerChunk = Math.max(
				1,
				Math.floor((options.sampleRate * options.chunkDurationMs) / 1_000),
			);
			this.bytesPerChunk = samplesPerChunk * 2;
		} else {
			// Opus: emit whole packets as they arrive (no re-chunking)
			this.bytesPerChunk = 0;
		}
	}

	/** Bytes currently held awaiting a full PCM chunk. */
	get pendingBytes(): number {
		return this.pending.byteLength;
	}

	/**
	 * Ingest a binary frame from the browser client.
	 * Returns zero or more complete chunks ready for upstream encoding.
	 */
	push(data: Buffer): Buffer[] {
		if (data.byteLength === 0) {
			return [];
		}

		if (this.format === "opus") {
			return [Buffer.from(data)];
		}

		this.validatePcmAlignment(data);
		this.pending = Buffer.concat([this.pending, data]);

		const chunks: Buffer[] = [];
		while (this.pending.byteLength >= this.bytesPerChunk) {
			const chunk = this.pending.subarray(0, this.bytesPerChunk);
			this.pending = this.pending.subarray(this.bytesPerChunk);
			chunks.push(Buffer.from(chunk));
		}
		return chunks;
	}

	/**
	 * Flush any remaining PCM samples as a final (possibly short) chunk.
	 * Opus has nothing to flush.
	 */
	flush(): Buffer[] {
		if (this.format === "opus" || this.pending.byteLength === 0) {
			this.pending = Buffer.alloc(0);
			return [];
		}

		// Drop a trailing odd byte if present (corrupt stream)
		const usableLength = this.pending.byteLength - (this.pending.byteLength % 2);
		if (usableLength === 0) {
			this.pending = Buffer.alloc(0);
			return [];
		}

		const chunk = Buffer.from(this.pending.subarray(0, usableLength));
		this.pending = Buffer.alloc(0);
		return [chunk];
	}

	reset(): void {
		this.pending = Buffer.alloc(0);
	}

	/** Encode a binary audio chunk as base64 for JSON transport. */
	toBase64(chunk: Buffer): string {
		return chunk.toString("base64");
	}

	/** Decode a base64 audio payload back to a Buffer. */
	fromBase64(encoded: string): Buffer {
		return Buffer.from(encoded, "base64");
	}

	/**
	 * Build an upstream Realtime-style input_audio_buffer.append event.
	 */
	toAppendEvent(chunk: Buffer): string {
		return JSON.stringify({
			type: "input_audio_buffer.append",
			audio: this.toBase64(chunk),
		});
	}

	/**
	 * Decode inbound client frames that may be raw binary or JSON wrappers.
	 * Returns null when the message is a control JSON event (caller should handle).
	 */
	decodeClientMessage(data: Buffer | ArrayBuffer | Buffer[]): {
		kind: "audio" | "json";
		audio?: Buffer;
		json?: unknown;
	} {
		const buffer = normalizeToBuffer(data);

		// Heuristic: if it looks like JSON (starts with '{'), parse it
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
				// Fall through to treat as binary audio
			}
		}

		return { kind: "audio" as const, audio: buffer };
	}

	private validatePcmAlignment(data: Buffer): void {
		if (this.format !== "pcm16") {
			return;
		}
		// Allow odd-length frames; we accumulate and only emit even-sized chunks.
		// Warn via thrown Error only if somehow non-Buffer slipped through (defensive).
		if (!Buffer.isBuffer(data)) {
			throw new TypeError("PCM frames must be Node.js Buffer instances");
		}
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
