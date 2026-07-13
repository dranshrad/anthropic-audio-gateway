import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

const register = new Registry();
collectDefaultMetrics({ register, prefix: "audio_gateway_" });

export const sessionsActive = new Gauge({
	name: "audio_gateway_sessions_active",
	help: "Active WebSocket gateway sessions",
	registers: [register],
});

export const speechFramesTotal = new Counter({
	name: "audio_gateway_speech_frames_total",
	help: "Speech audio frames forwarded upstream",
	labelNames: ["provider"] as const,
	registers: [register],
});

export const silenceDroppedTotal = new Counter({
	name: "audio_gateway_silence_dropped_total",
	help: "Frames dropped by VAD or backpressure",
	labelNames: ["provider"] as const,
	registers: [register],
});

export const vadTriggersTotal = new Counter({
	name: "audio_gateway_vad_triggers_total",
	help: "Speech onset detections from VAD",
	labelNames: ["provider"] as const,
	registers: [register],
});

export const reconnectsTotal = new Counter({
	name: "audio_gateway_reconnects_total",
	help: "Upstream reconnect attempts",
	labelNames: ["provider"] as const,
	registers: [register],
});

export const rateLimitTotal = new Counter({
	name: "audio_gateway_rate_limit_total",
	help: "Upstream rate-limit events",
	labelNames: ["provider"] as const,
	registers: [register],
});

export const pauseTotal = new Counter({
	name: "audio_gateway_pause_total",
	help: "Client pause / circuit-open events",
	labelNames: ["provider", "reason"] as const,
	registers: [register],
});

export const providerErrorsTotal = new Counter({
	name: "audio_gateway_provider_errors_total",
	help: "Provider connection or stream errors",
	labelNames: ["provider"] as const,
	registers: [register],
});

export const bytesAppendedTotal = new Counter({
	name: "audio_gateway_bytes_appended_total",
	help: "Audio bytes appended upstream",
	labelNames: ["provider"] as const,
	registers: [register],
});

export const rttHistogram = new Histogram({
	name: "audio_gateway_rtt_ms",
	help: "Client gateway.ping RTT in milliseconds",
	labelNames: ["provider"] as const,
	buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500],
	registers: [register],
});

export const queueDepthGauge = new Gauge({
	name: "audio_gateway_queue_depth",
	help: "Outbound transform queue depth (object frames)",
	labelNames: ["provider"] as const,
	registers: [register],
});

export const bufferOccupancyGauge = new Gauge({
	name: "audio_gateway_buffer_occupancy_bytes",
	help: "Upstream buffered bytes",
	labelNames: ["provider"] as const,
	registers: [register],
});

export const authRejectionsTotal = new Counter({
	name: "audio_gateway_auth_rejections_total",
	help: "Rejected WebSocket upgrades",
	labelNames: ["reason"] as const,
	registers: [register],
});

export async function renderMetrics(): Promise<string> {
	return register.metrics();
}

export function metricsContentType(): string {
	return register.contentType;
}
