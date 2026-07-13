import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createVadState, isSpeech } from "../src/vad-util.js";

const sampleRate = 24_000;
const hangoverMs = 400;
const samplesPerFrame = Math.floor((sampleRate * 40) / 1_000); // 40ms

function silenceFrame(): Buffer {
	return Buffer.alloc(samplesPerFrame * 2);
}

function toneFrame(amp = 10_000): Buffer {
	const buf = Buffer.alloc(samplesPerFrame * 2);
	for (let i = 0; i < samplesPerFrame; i += 1) {
		const sample = Math.floor(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * amp);
		buf.writeInt16LE(sample, i * 2);
	}
	return buf;
}

const baseOpts = {
	entropyThreshold: 7.5,
	energyFloor: 0.0015,
	fricativeRatio: 0.18,
	hangoverMs,
	sampleRate,
	encoding: "pcm16" as const,
};

describe("VAD hangover", () => {
	it("rejects digital silence below energy floor", () => {
		const state = createVadState();
		assert.equal(isSpeech(silenceFrame(), state, baseOpts), false);
	});

	it("detects structured tone as speech", () => {
		const state = createVadState();
		assert.equal(isSpeech(toneFrame(), state, baseOpts), true);
	});

	it("holds open through hangover after speech then releases", () => {
		const state = createVadState();
		assert.equal(isSpeech(toneFrame(), state, baseOpts), true);

		const hangoverFrames = Math.ceil(hangoverMs / 40);
		let stillOpen = 0;
		for (let i = 0; i < hangoverFrames; i += 1) {
			if (isSpeech(silenceFrame(), state, baseOpts)) {
				stillOpen += 1;
			}
		}
		assert.ok(stillOpen >= hangoverFrames - 1, `expected hangover hold, got ${stillOpen}`);

		// Drain remaining hangover samples
		for (let i = 0; i < hangoverFrames + 5; i += 1) {
			isSpeech(silenceFrame(), state, baseOpts);
		}
		assert.equal(isSpeech(silenceFrame(), state, baseOpts), false);
	});

	it("keeps hangover after speech even when following frames are quiet", () => {
		const state = createVadState();
		assert.equal(isSpeech(toneFrame(), state, baseOpts), true);
		// First silence frame must still be speech (hangover)
		assert.equal(isSpeech(silenceFrame(), state, baseOpts), true);
	});
});
