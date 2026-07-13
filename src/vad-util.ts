/**
 * Lightweight energy-based Voice Activity Detection (VAD).
 *
 * For 16-bit little-endian PCM mono frames, computes normalized RMS energy
 * and applies a hangover window so speech tails are not clipped.
 *
 * Opus packets are compressed; energy cannot be measured without decoding.
 * Non-empty Opus packets are treated as speech (always forward).
 */

export type AudioEncoding = "pcm16" | "opus";

export interface VadOptions {
	/** Normalized RMS threshold in [0, 1]. 0 disables filtering (always speech). */
	energyThreshold: number;
	/** Keep reporting speech for this many ms after energy drops below threshold. */
	hangoverMs: number;
	/** Sample rate used to convert hangover ms → remaining frames (PCM only). */
	sampleRate: number;
	encoding: AudioEncoding;
}

export interface VadState {
	hangoverSamplesRemaining: number;
}

export function createVadState(): VadState {
	return { hangoverSamplesRemaining: 0 };
}

/**
 * Compute normalized RMS energy for a 16-bit LE PCM buffer.
 * Returns a value in [0, 1] where 1 ≈ full-scale sine.
 */
export function computePcm16RmsEnergy(pcm: Buffer): number {
	if (pcm.byteLength < 2) {
		return 0;
	}

	const sampleCount = Math.floor(pcm.byteLength / 2);
	if (sampleCount === 0) {
		return 0;
	}

	let sumSquares = 0;
	for (let i = 0; i < sampleCount; i += 1) {
		const sample = pcm.readInt16LE(i * 2);
		sumSquares += sample * sample;
	}

	const rms = Math.sqrt(sumSquares / sampleCount);
	// Full-scale 16-bit peak is 32768; normalize to ~[0, 1]
	return Math.min(1, rms / 32_768);
}

/**
 * Decide whether a frame contains speech, mutating hangover state.
 */
export function isSpeech(frame: Buffer, state: VadState, options: VadOptions): boolean {
	if (frame.byteLength === 0) {
		return false;
	}

	if (options.encoding === "opus") {
		// Cannot measure energy on compressed Opus without a decoder; forward packets.
		return true;
	}

	if (options.energyThreshold <= 0) {
		return true;
	}

	const energy = computePcm16RmsEnergy(frame);
	const sampleCount = Math.floor(frame.byteLength / 2);
	const hangoverSamples = Math.max(
		0,
		Math.floor((options.hangoverMs / 1_000) * options.sampleRate),
	);

	if (energy >= options.energyThreshold) {
		state.hangoverSamplesRemaining = hangoverSamples;
		return true;
	}

	if (state.hangoverSamplesRemaining > 0) {
		state.hangoverSamplesRemaining = Math.max(0, state.hangoverSamplesRemaining - sampleCount);
		return true;
	}

	return false;
}

/**
 * Stateless helper for one-shot checks without hangover tracking.
 */
export function isSpeechOnce(
	frame: Buffer,
	options: Pick<VadOptions, "energyThreshold" | "encoding">,
): boolean {
	if (frame.byteLength === 0) {
		return false;
	}
	if (options.encoding === "opus") {
		return true;
	}
	if (options.energyThreshold <= 0) {
		return true;
	}
	return computePcm16RmsEnergy(frame) >= options.energyThreshold;
}
