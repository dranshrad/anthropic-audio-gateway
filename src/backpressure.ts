export interface BackpressureSnapshot {
	upstreamBuffered: number;
	pendingBytes: number;
	queueDepth: number;
	highWaterMark: number;
	maxBuffered: number;
	transformHwm: number;
}

/**
 * Pure backpressure decision — pause when upstream, pending, or transform queue
 * exceeds configured marks. Used by GatewaySession and unit tests.
 */
export function shouldPause(s: BackpressureSnapshot): boolean {
	return (
		s.upstreamBuffered >= s.highWaterMark ||
		s.pendingBytes + s.upstreamBuffered >= s.maxBuffered ||
		s.queueDepth >= s.transformHwm
	);
}

/** Resume only when fully under all watermarks (hysteresis can be added later). */
export function shouldResume(s: BackpressureSnapshot): boolean {
	return !shouldPause(s);
}
