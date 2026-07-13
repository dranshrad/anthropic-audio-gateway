/**
 * Spectral-entropy Voice Activity Detection with a 400ms hangover.
 *
 * Why not RMS alone: trailing fricatives ("s", "f", "th") have low amplitude but
 * structured high-band energy. Pure volume gates clip them ("S-drop"), hurting
 * LLM comprehension. Spectral entropy + a high-band fricative ratio catch those
 * phones; the hangover keeps the gate open through natural inter-word pauses.
 *
 * Hot path uses pre-allocated Float64Arrays — no per-frame heap growth.
 */

export type AudioEncoding = "pcm16" | "opus";

export interface VadOptions {
	/** Max spectral entropy (bits) to classify as speech structure. 0 = disable. */
	entropyThreshold: number;
	/** Minimum normalized RMS so digital silence never passes. */
	energyFloor: number;
	/** High-band power / total power threshold for fricative rescue. */
	fricativeRatio: number;
	/** Keep reporting speech this many ms after last positive detection. */
	hangoverMs: number;
	sampleRate: number;
	encoding: AudioEncoding;
}

export interface VadState {
	hangoverSamplesRemaining: number;
	/** Pre-allocated analysis workspace (owned by the detector). */
	workspace: VadWorkspace;
}

export interface VadWorkspace {
	windowed: Float64Array;
	real: Float64Array;
	imag: Float64Array;
	power: Float64Array;
	hann: Float64Array;
	fftSize: number;
}

const DEFAULT_FFT_SIZE = 512;

export function createVadWorkspace(fftSize = DEFAULT_FFT_SIZE): VadWorkspace {
	const size = nextPowerOfTwo(Math.max(64, fftSize));
	const hann = new Float64Array(size);
	for (let i = 0; i < size; i += 1) {
		hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
	}
	return {
		windowed: new Float64Array(size),
		real: new Float64Array(size),
		imag: new Float64Array(size),
		power: new Float64Array(size / 2),
		hann,
		fftSize: size,
	};
}

export function createVadState(fftSize = DEFAULT_FFT_SIZE): VadState {
	return {
		hangoverSamplesRemaining: 0,
		workspace: createVadWorkspace(fftSize),
	};
}

/**
 * Normalized RMS energy for a 16-bit LE PCM buffer. Alloc-free over the buffer.
 */
export function computePcm16RmsEnergy(pcm: Buffer): number {
	const sampleCount = Math.floor(pcm.byteLength / 2);
	if (sampleCount === 0) {
		return 0;
	}
	let sumSquares = 0;
	for (let i = 0; i < sampleCount; i += 1) {
		const sample = pcm.readInt16LE(i * 2);
		sumSquares += sample * sample;
	}
	return Math.min(1, Math.sqrt(sumSquares / sampleCount) / 32_768);
}

/**
 * Spectral entropy in bits over a Hann-windowed real FFT of the PCM frame.
 * Lower entropy ⇒ more tonal / speech-like; higher ⇒ noise-like / flat.
 */
export function computeSpectralEntropy(pcm: Buffer, workspace: VadWorkspace): number {
	return analyzeSpectrum(pcm, workspace, 24_000).entropy;
}

/**
 * Fraction of spectral power above ~4 kHz (fricative / sibilant band).
 */
export function computeHighBandRatio(
	pcm: Buffer,
	workspace: VadWorkspace,
	sampleRate: number,
): number {
	return analyzeSpectrum(pcm, workspace, sampleRate).highBandRatio;
}

/**
 * Frame-level speech decision with hangover mutation.
 * Returns true while speech is active or hangover is holding the gate open.
 */
export function isSpeech(frame: Buffer, state: VadState, options: VadOptions): boolean {
	if (frame.byteLength === 0) {
		return false;
	}

	if (options.encoding === "opus") {
		return true;
	}

	const sampleCount = Math.floor(frame.byteLength / 2);
	const hangoverSamples = Math.max(
		0,
		Math.floor((options.hangoverMs / 1_000) * options.sampleRate),
	);

	const energy = computePcm16RmsEnergy(frame);
	const active = detectSpeechFrame(frame, energy, state.workspace, options);

	if (active) {
		state.hangoverSamplesRemaining = hangoverSamples;
		return true;
	}

	if (state.hangoverSamplesRemaining > 0) {
		state.hangoverSamplesRemaining = Math.max(0, state.hangoverSamplesRemaining - sampleCount);
		return true;
	}

	return false;
}

function detectSpeechFrame(
	frame: Buffer,
	energy: number,
	workspace: VadWorkspace,
	options: VadOptions,
): boolean {
	if (energy < options.energyFloor) {
		return false;
	}

	// Entropy gate disabled → energy floor alone (still better than raw RMS thresholding).
	if (options.entropyThreshold <= 0) {
		return true;
	}

	const { entropy, highBandRatio } = analyzeSpectrum(frame, workspace, options.sampleRate);
	if (entropy <= options.entropyThreshold) {
		return true;
	}

	// Fricative rescue: low-amplitude but high-band structured energy (s/f/th).
	return highBandRatio >= options.fricativeRatio && energy >= options.energyFloor * 0.5;
}

/** Single FFT pass producing spectral entropy and high-band ratio. */
function analyzeSpectrum(
	pcm: Buffer,
	workspace: VadWorkspace,
	sampleRate: number,
): { entropy: number; highBandRatio: number } {
	const { fftSize, windowed, real, imag, power, hann } = workspace;
	const sampleCount = Math.floor(pcm.byteLength / 2);
	if (sampleCount === 0) {
		return { entropy: Number.POSITIVE_INFINITY, highBandRatio: 0 };
	}

	windowed.fill(0);
	const copyCount = Math.min(sampleCount, fftSize);
	for (let i = 0; i < copyCount; i += 1) {
		windowed[i] = (pcm.readInt16LE(i * 2) / 32_768) * hann[i]!;
	}
	real.set(windowed);
	imag.fill(0);
	fftInPlace(real, imag);

	const bins = fftSize / 2;
	const hzPerBin = sampleRate / fftSize;
	const highStart = Math.min(bins - 1, Math.max(1, Math.floor(4_000 / hzPerBin)));

	let totalPower = 0;
	let high = 0;
	for (let k = 0; k < bins; k += 1) {
		const re = real[k]!;
		const im = imag[k]!;
		const p = re * re + im * im;
		power[k] = p;
		totalPower += p;
		if (k >= highStart && k > 0) {
			high += p;
		}
	}

	if (totalPower <= 1e-20) {
		return { entropy: Number.POSITIVE_INFINITY, highBandRatio: 0 };
	}

	let entropy = 0;
	for (let k = 0; k < bins; k += 1) {
		const p = power[k]! / totalPower;
		if (p > 1e-20) {
			entropy -= p * Math.log2(p);
		}
	}

	return { entropy, highBandRatio: high / totalPower };
}

/**
 * Stateless one-shot check without hangover (no workspace mutation beyond FFT scratch).
 */
export function isSpeechOnce(
	frame: Buffer,
	options: Pick<
		VadOptions,
		"entropyThreshold" | "energyFloor" | "fricativeRatio" | "encoding" | "sampleRate"
	>,
	workspace: VadWorkspace = createVadWorkspace(),
): boolean {
	if (frame.byteLength === 0) {
		return false;
	}
	if (options.encoding === "opus") {
		return true;
	}
	const energy = computePcm16RmsEnergy(frame);
	return detectSpeechFrame(frame, energy, workspace, {
		...options,
		hangoverMs: 0,
	});
}

/** In-place Cooley–Tukey radix-2 FFT. real/imag length must be power of two. */
function fftInPlace(real: Float64Array, imag: Float64Array): void {
	const n = real.length;
	let j = 0;
	for (let i = 1; i < n; i += 1) {
		let bit = n >> 1;
		for (; j & bit; bit >>= 1) {
			j ^= bit;
		}
		j ^= bit;
		if (i < j) {
			const tr = real[i]!;
			real[i] = real[j]!;
			real[j] = tr;
			const ti = imag[i]!;
			imag[i] = imag[j]!;
			imag[j] = ti;
		}
	}

	for (let len = 2; len <= n; len <<= 1) {
		const ang = (-2 * Math.PI) / len;
		const wlenRe = Math.cos(ang);
		const wlenIm = Math.sin(ang);
		for (let i = 0; i < n; i += len) {
			let wRe = 1;
			let wIm = 0;
			for (let k = 0; k < len / 2; k += 1) {
				const uRe = real[i + k]!;
				const uIm = imag[i + k]!;
				const vRe = real[i + k + len / 2]! * wRe - imag[i + k + len / 2]! * wIm;
				const vIm = real[i + k + len / 2]! * wIm + imag[i + k + len / 2]! * wRe;
				real[i + k] = uRe + vRe;
				imag[i + k] = uIm + vIm;
				real[i + k + len / 2] = uRe - vRe;
				imag[i + k + len / 2] = uIm - vIm;
				const nextWRe = wRe * wlenRe - wIm * wlenIm;
				wIm = wRe * wlenIm + wIm * wlenRe;
				wRe = nextWRe;
			}
		}
	}
}

function nextPowerOfTwo(n: number): number {
	let v = 1;
	while (v < n) {
		v <<= 1;
	}
	return v;
}
