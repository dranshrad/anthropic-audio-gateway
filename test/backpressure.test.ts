import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldPause, shouldResume } from "../src/backpressure.js";

const base = {
	upstreamBuffered: 0,
	pendingBytes: 0,
	queueDepth: 0,
	highWaterMark: 1000,
	maxBuffered: 5000,
	transformHwm: 10,
};

describe("backpressure helpers", () => {
	it("does not pause under all watermarks", () => {
		assert.equal(shouldPause({ ...base, upstreamBuffered: 100 }), false);
		assert.equal(shouldResume({ ...base, upstreamBuffered: 100 }), true);
	});

	it("pauses when upstream buffered hits highWaterMark", () => {
		assert.equal(shouldPause({ ...base, upstreamBuffered: 1000 }), true);
		assert.equal(shouldPause({ ...base, upstreamBuffered: 1001 }), true);
	});

	it("pauses when pending + upstream hits maxBuffered", () => {
		assert.equal(shouldPause({ ...base, upstreamBuffered: 2000, pendingBytes: 3000 }), true);
	});

	it("pauses when transform queue depth hits transformHwm", () => {
		assert.equal(shouldPause({ ...base, queueDepth: 10 }), true);
		assert.equal(shouldPause({ ...base, queueDepth: 9 }), false);
	});

	it("resumes only when fully under marks after drain", () => {
		const pressured = { ...base, upstreamBuffered: 2000 };
		assert.equal(shouldPause(pressured), true);
		const drained = { ...base, upstreamBuffered: 100 };
		assert.equal(shouldResume(drained), true);
	});
});
