import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AudioProcessor, PcmRingBuffer } from "../src/audio-processor.js";

function pcmSilence(samples: number): Buffer {
	return Buffer.alloc(samples * 2);
}

function pcmTone(samples: number, sampleRate = 24_000, hz = 440, amp = 8_000): Buffer {
	const buf = Buffer.alloc(samples * 2);
	for (let i = 0; i < samples; i += 1) {
		const sample = Math.floor(Math.sin((2 * Math.PI * hz * i) / sampleRate) * amp);
		buf.writeInt16LE(sample, i * 2);
	}
	return buf;
}

describe("PcmRingBuffer", () => {
	it("tracks available after write and drains on read", () => {
		const ring = new PcmRingBuffer(100);
		const written = ring.writeFromLeBuffer(pcmTone(40));
		assert.equal(written, 40);
		assert.equal(ring.available, 40);

		const dest = new Int16Array(40);
		const read = ring.readInto(dest, 40);
		assert.equal(read, 40);
		assert.equal(ring.available, 0);
	});

	it("overwrites oldest on overflow without growing capacity", () => {
		const capacity = 50;
		const ring = new PcmRingBuffer(capacity);
		ring.writeFromLeBuffer(pcmTone(40));
		ring.writeFromLeBuffer(pcmTone(40));
		assert.equal(ring.capacitySamples, capacity);
		assert.equal(ring.available, capacity);
	});
});

describe("AudioProcessor ring path", () => {
	it("emits fixed-size chunks from push without growing ring capacity", () => {
		const processor = new AudioProcessor({
			format: "pcm16",
			sampleRate: 24_000,
			chunkDurationMs: 40,
			ringBufferSeconds: 2,
		});
		const capacityBefore = processor.ringCapacitySamples;
		const frame = pcmTone(processor.samplesPerChunk * 3);
		const chunks = processor.push(frame);
		assert.equal(chunks.length, 3);
		for (const c of chunks) {
			assert.equal(c.byteLength, processor.bytesPerChunk);
		}
		assert.equal(processor.ringCapacitySamples, capacityBefore);
	});

	it("reuses pooled buffers with stable byteLength", () => {
		const processor = new AudioProcessor({
			format: "pcm16",
			sampleRate: 24_000,
			chunkDurationMs: 40,
			ringBufferSeconds: 2,
		});
		const a = processor.push(pcmTone(processor.samplesPerChunk));
		const b = processor.push(pcmTone(processor.samplesPerChunk));
		assert.equal(a[0]!.byteLength, b[0]!.byteLength);
		assert.equal(a[0]!.byteLength, processor.bytesPerChunk);
	});

	it("handles silence frames without throwing", () => {
		const processor = new AudioProcessor({
			format: "pcm16",
			sampleRate: 24_000,
			chunkDurationMs: 40,
			ringBufferSeconds: 1,
		});
		const chunks = processor.push(pcmSilence(processor.samplesPerChunk));
		assert.equal(chunks.length, 1);
	});
});
