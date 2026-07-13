import type { AudioEncoding, VadOptions, VadState } from "../vad-util.js";
import { createVadState, isSpeech as spectralIsSpeech } from "../vad-util.js";

export type { AudioEncoding, VadOptions, VadState };

export interface VadEngine {
	readonly id: string;
	createState(): VadState;
	isSpeech(frame: Buffer, state: VadState, options: VadOptions): boolean;
}

export class SpectralVadEngine implements VadEngine {
	readonly id = "spectral-entropy";

	createState(): VadState {
		return createVadState();
	}

	isSpeech(frame: Buffer, state: VadState, options: VadOptions): boolean {
		return spectralIsSpeech(frame, state, options);
	}
}

/** Passthrough VAD — always speech (useful for benchmarks / debugging). */
export class PassthroughVadEngine implements VadEngine {
	readonly id = "passthrough";

	createState(): VadState {
		return createVadState();
	}

	isSpeech(frame: Buffer, _state: VadState, _options: VadOptions): boolean {
		return frame.byteLength > 0;
	}
}
