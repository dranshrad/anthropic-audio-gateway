import { Transform, type TransformCallback } from "node:stream";
import type WebSocket from "ws";
import { AdaptiveStreamingController } from "./adaptive/controller.js";
import { AudioProcessor } from "./audio-processor.js";
import type { Config } from "./config.js";
import {
	bufferOccupancyGauge,
	bytesAppendedTotal,
	pauseTotal,
	providerErrorsTotal,
	queueDepthGauge,
	rateLimitTotal,
	reconnectsTotal,
	rttHistogram,
	silenceDroppedTotal,
	speechFramesTotal,
	vadTriggersTotal,
} from "./metrics/prometheus.js";
import { pluginRegistry } from "./plugins/registry.js";
import { getProviderAdapter, resolveProviderModel } from "./providers/registry.js";
import type { ProviderConnection, ProviderMessage } from "./providers/types.js";
import { SessionStats } from "./session/stats.js";
import { getVadEngine } from "./vad/spectral.js";

export type GatewayLogFn = (level: "debug" | "info" | "warn" | "error", message: string) => void;

export interface GatewaySessionOptions {
	client: WebSocket;
	config: Config;
	log?: GatewayLogFn;
	sessionId?: string;
}

type ClientControlMessage = {
	type?: string;
	[key: string]: unknown;
};

interface UpstreamAudioFrame {
	base64: string;
	byteLength: number;
}

class UpstreamAudioTransform extends Transform {
	constructor(highWaterMark: number) {
		super({
			objectMode: true,
			allowHalfOpen: false,
			highWaterMark: Math.max(1, Math.floor(highWaterMark / 4_096)),
		});
	}

	override _transform(
		chunk: UpstreamAudioFrame,
		_encoding: BufferEncoding,
		callback: TransformCallback,
	): void {
		callback(null, chunk);
	}
}

/**
 * Duplex bridge: browser (or WebRTC-bridged) WS ↔ provider adapter.
 * Keeps Zero-GC processor, Transform backpressure, and VAD gating.
 */
export class GatewaySession {
	readonly sessionId: string;
	readonly stats: SessionStats;

	private readonly client: WebSocket;
	private readonly config: Config;
	private readonly log: GatewayLogFn;
	private readonly processor: AudioProcessor;
	private readonly vad;
	private readonly vadState;
	private readonly outbound: UpstreamAudioTransform;
	private readonly adaptive: AdaptiveStreamingController;
	private readonly providerId;
	private lastVadSpeech = false;

	private connection: ProviderConnection | null = null;
	private closed = false;
	private clientPaused = false;
	private circuitOpen = false;
	private bufferedBytes = 0;
	private rateLimitAttempts = 0;
	private rateLimitTimer: ReturnType<typeof setTimeout> | null = null;
	private pressureTimer: ReturnType<typeof setInterval> | null = null;
	private adaptiveTimer: ReturnType<typeof setInterval> | null = null;
	private hangoverMs: number;
	private entropyThreshold: number;
	private highWaterMark: number;

	constructor(options: GatewaySessionOptions) {
		this.client = options.client;
		this.config = options.config;
		this.sessionId = options.sessionId ?? crypto.randomUUID();
		this.log = options.log ?? defaultLog;
		this.providerId = this.config.PROVIDER;
		this.stats = new SessionStats(this.sessionId, this.providerId);
		this.vad = getVadEngine(this.config.VAD_ENGINE);
		this.vadState = this.vad.createState();
		this.hangoverMs = this.config.VAD_HANGOVER_MS;
		this.entropyThreshold = this.config.VAD_ENTROPY_THRESHOLD;
		this.highWaterMark = this.config.HIGH_WATER_MARK;
		this.adaptive = new AdaptiveStreamingController(this.config);
		this.processor = new AudioProcessor({
			format: this.config.AUDIO_FORMAT,
			sampleRate: this.config.SAMPLE_RATE,
			chunkDurationMs: this.config.CHUNK_DURATION_MS,
			ringBufferSeconds: this.config.RING_BUFFER_SECONDS,
		});
		this.outbound = new UpstreamAudioTransform(this.highWaterMark);
		this.wireOutboundPipeline();
	}

	getStats() {
		return this.stats.snapshot(this.config.SAMPLE_RATE);
	}

	async start(): Promise<void> {
		if (this.closed) {
			return;
		}

		await pluginRegistry.startAll({
			sessionId: this.sessionId,
			sampleRate: this.config.SAMPLE_RATE,
			audioFormat: this.config.AUDIO_FORMAT,
		});

		this.bindClientHandlers();
		await this.connectProvider();
		this.startPressureMonitor();
		this.startAdaptiveLoop();
	}

	close(code = 1000, reason = "gateway_shutdown"): void {
		if (this.closed) {
			return;
		}
		this.closed = true;

		if (this.rateLimitTimer) {
			clearTimeout(this.rateLimitTimer);
			this.rateLimitTimer = null;
		}
		if (this.pressureTimer) {
			clearInterval(this.pressureTimer);
			this.pressureTimer = null;
		}
		if (this.adaptiveTimer) {
			clearInterval(this.adaptiveTimer);
			this.adaptiveTimer = null;
		}

		this.resumeClient("shutdown");
		this.processor.reset();
		this.outbound.destroy();
		this.connection?.close(code, reason);
		this.connection = null;

		void pluginRegistry.endAll({
			sessionId: this.sessionId,
			sampleRate: this.config.SAMPLE_RATE,
			audioFormat: this.config.AUDIO_FORMAT,
		});
		pluginRegistry.emitStats(this.getStats() as unknown as Record<string, unknown>);

		this.safeCloseClient(code, reason);
		this.log(
			"info",
			`[${this.sessionId}] closed provider=${this.providerId} speech=${this.stats.speechFramesSent} silenceDropped=${this.stats.silenceDroppedFrames}`,
		);
	}

	private wireOutboundPipeline(): void {
		this.outbound.on("data", (frame: UpstreamAudioFrame) => {
			this.dispatchUpstreamFrame(frame);
		});
		this.outbound.on("drain", () => {
			this.evaluateBackpressure("transform_drain");
		});
		this.outbound.on("error", (err: Error) => {
			this.log("error", `[${this.sessionId}] outbound transform error: ${err.message}`);
			this.close(1011, "outbound_error");
		});
	}

	private startPressureMonitor(): void {
		this.pressureTimer = setInterval(() => {
			this.evaluateBackpressure("monitor");
			const buffered = this.providerBuffered();
			this.stats.updateQueue(this.outbound.writableLength, buffered);
			queueDepthGauge.set({ provider: this.providerId }, this.outbound.writableLength);
			bufferOccupancyGauge.set({ provider: this.providerId }, buffered);
		}, 25);
		this.pressureTimer.unref();
	}

	private startAdaptiveLoop(): void {
		if (!this.config.ADAPTIVE_STREAMING) {
			return;
		}
		this.adaptiveTimer = setInterval(() => {
			const next = this.adaptive.update(this.stats);
			this.hangoverMs = next.vadHangoverMs;
			this.entropyThreshold = next.vadEntropyThreshold;
			this.highWaterMark = next.highWaterMark;
		}, 1_000);
		this.adaptiveTimer.unref();
	}

	private async connectProvider(): Promise<void> {
		const adapter = getProviderAdapter(this.providerId);
		this.log("info", `[${this.sessionId}] connecting provider=${adapter.id}`);
		const connection = await adapter.connect({
			sessionId: this.sessionId,
			config: this.config,
			audioFormat: this.config.AUDIO_FORMAT,
			sampleRate: this.config.SAMPLE_RATE,
			model: resolveProviderModel(this.config),
		});
		this.connection = connection;
		connection.onMessage((msg) => this.onProviderMessage(msg));
		this.sendClientEvent({
			type: "gateway.ready",
			sessionId: this.sessionId,
			provider: this.providerId,
			audioFormat: this.config.AUDIO_FORMAT,
			sampleRate: this.config.SAMPLE_RATE,
			ringBufferSamples: this.processor.ringCapacitySamples,
			highWaterMark: this.highWaterMark,
			vadEngine: this.vad.id,
		});
		this.log("info", `[${this.sessionId}] provider connected`);
	}

	private bindClientHandlers(): void {
		this.client.on("message", (data, isBinary) => {
			this.onClientMessage(data, isBinary);
		});
		this.client.on("close", (code, reason) => {
			this.log(
				"info",
				`[${this.sessionId}] client closed code=${code} reason=${reason.toString()}`,
			);
			this.close(code, reason.toString() || "client_closed");
		});
		this.client.on("error", (err) => {
			this.log("error", `[${this.sessionId}] client error: ${err.message}`);
			this.close(1011, "client_error");
		});
	}

	private onClientMessage(data: WebSocket.RawData, isBinary: boolean): void {
		if (this.closed) {
			return;
		}

		const buffer = rawDataToBuffer(data);
		const decoded = this.processor.decodeClientMessage(buffer);

		if (decoded.kind === "json") {
			this.handleClientControl(decoded.json as ClientControlMessage);
			return;
		}

		if (!isBinary && decoded.kind === "audio" && decoded.audio === undefined) {
			return;
		}

		let audio = decoded.audio;
		if (!audio) {
			return;
		}

		audio = pluginRegistry.processFrame(audio, {
			sessionId: this.sessionId,
			sampleRate: this.config.SAMPLE_RATE,
			audioFormat: this.config.AUDIO_FORMAT,
		});

		if (this.clientPaused || this.circuitOpen) {
			this.stats.recordSilenceDrop();
			silenceDroppedTotal.inc({ provider: this.providerId });
			return;
		}

		const chunks = this.processor.push(audio);
		for (const chunk of chunks) {
			this.forwardAudioChunk(chunk);
		}
	}

	private handleClientControl(message: ClientControlMessage): void {
		const type = message.type;
		if (type === "input_audio_buffer.commit") {
			for (const chunk of this.processor.flush()) {
				this.forwardAudioChunk(chunk);
			}
			this.connection?.sendControl({ type: "input_audio_buffer.commit" });
			return;
		}
		if (type === "input_audio_buffer.clear") {
			this.processor.reset();
			this.connection?.sendControl({ type: "input_audio_buffer.clear" });
			return;
		}
		if (
			type === "session.update" ||
			type === "response.create" ||
			type === "conversation.item.create"
		) {
			this.connection?.sendControl(message);
			return;
		}
		if (type === "gateway.ping") {
			this.stats.markPing();
			this.sendClientEvent({ type: "gateway.pong", sessionId: this.sessionId, t: Date.now() });
			this.stats.markPong();
			const snap = this.stats.snapshot(this.config.SAMPLE_RATE);
			if (snap.lastRttMs !== null) {
				rttHistogram.observe({ provider: this.providerId }, snap.lastRttMs);
			}
			return;
		}

		this.log("debug", `[${this.sessionId}] ignoring unknown client control: ${String(type)}`);
	}

	private forwardAudioChunk(chunk: Buffer): void {
		const speech = this.vad.isSpeech(chunk, this.vadState, {
			entropyThreshold: this.entropyThreshold,
			energyFloor: this.config.VAD_ENERGY_FLOOR,
			fricativeRatio: this.config.VAD_FRICATIVE_RATIO,
			hangoverMs: this.hangoverMs,
			sampleRate: this.config.SAMPLE_RATE,
			encoding: this.config.AUDIO_FORMAT,
		});
		this.stats.recordVad(speech);
		if (speech && !this.lastVadSpeech) {
			vadTriggersTotal.inc({ provider: this.providerId });
		}
		this.lastVadSpeech = speech;

		if (!speech) {
			this.stats.recordSilenceDrop();
			silenceDroppedTotal.inc({ provider: this.providerId });
			return;
		}

		if (this.isBackpressured()) {
			this.pauseClient("high_water");
			this.stats.recordSilenceDrop();
			silenceDroppedTotal.inc({ provider: this.providerId });
			return;
		}

		const frame: UpstreamAudioFrame = {
			base64: this.processor.toBase64(chunk),
			byteLength: chunk.byteLength,
		};
		const ok = this.outbound.write(frame);
		if (!ok) {
			this.pauseClient("transform_high_water");
		}
	}

	private dispatchUpstreamFrame(frame: UpstreamAudioFrame): void {
		if (!this.connection?.sendAudioAppend(frame.base64)) {
			return;
		}
		this.stats.recordSpeechFrame(frame.byteLength, this.config.SAMPLE_RATE);
		speechFramesTotal.inc({ provider: this.providerId });
		bytesAppendedTotal.inc({ provider: this.providerId }, frame.byteLength);
		this.evaluateBackpressure("after_send");
	}

	private onProviderMessage(msg: ProviderMessage): void {
		if (this.closed) {
			return;
		}
		if (msg.kind === "close") {
			this.stats.recordReconnect();
			reconnectsTotal.inc({ provider: this.providerId });
			this.sendClientEvent({
				type: "gateway.upstream_closed",
				code: msg.code,
				reason: msg.reason,
			});
			this.close(msg.code === 1000 ? 1000 : 1011, "upstream_closed");
			return;
		}
		if (msg.kind === "error") {
			this.stats.recordProviderError();
			providerErrorsTotal.inc({ provider: this.providerId });
			this.sendClientEvent({ type: "gateway.error", message: msg.error.message });
			this.close(1011, "upstream_error");
			return;
		}
		if (msg.kind === "binary") {
			this.sendClientBinary(msg.data);
			return;
		}

		if (this.isRateLimitEvent(msg.value)) {
			this.handleRateLimit(msg.value);
			return;
		}
		if (this.tryRelayAudioDelta(msg.value)) {
			return;
		}
		this.sendClientText(msg.raw || JSON.stringify(msg.value));
	}

	private tryRelayAudioDelta(parsed: unknown): boolean {
		if (typeof parsed !== "object" || parsed === null) {
			return false;
		}
		const event = parsed as { type?: string; delta?: string; audio?: string };
		const audioB64 =
			(event.type === "response.audio.delta" || event.type === "response.output_audio.delta") &&
			typeof event.delta === "string"
				? event.delta
				: typeof event.audio === "string" && event.type?.includes("audio")
					? event.audio
					: null;
		if (!audioB64) {
			return false;
		}
		try {
			const audio = this.processor.fromBase64(audioB64);
			this.sendClientBinary(audio);
			this.sendClientText(JSON.stringify(parsed));
			return true;
		} catch {
			return false;
		}
	}

	private isRateLimitEvent(parsed: unknown): boolean {
		if (typeof parsed !== "object" || parsed === null) {
			return false;
		}
		const event = parsed as {
			type?: string;
			error?: { type?: string; code?: string; message?: string };
			status?: number;
		};
		if (event.status === 429) {
			return true;
		}
		if (event.type === "error" && event.error) {
			const code =
				`${event.error.type ?? ""} ${event.error.code ?? ""} ${event.error.message ?? ""}`.toLowerCase();
			return (
				code.includes("rate_limit") ||
				code.includes("rate limit") ||
				code.includes("429") ||
				code.includes("overloaded")
			);
		}
		return typeof event.type === "string" && event.type.includes("rate_limit");
	}

	private handleRateLimit(parsed: unknown): void {
		this.rateLimitAttempts += 1;
		this.stats.recordRateLimit();
		rateLimitTotal.inc({ provider: this.providerId });
		const delay = Math.min(
			this.config.RATE_LIMIT_MAX_DELAY_MS,
			this.config.RATE_LIMIT_BASE_DELAY_MS * 2 ** (this.rateLimitAttempts - 1),
		);
		this.log(
			"warn",
			`[${this.sessionId}] rate limited; backing off ${delay}ms (attempt ${this.rateLimitAttempts})`,
		);
		this.pauseClient("rate_limit");
		this.sendClientEvent({
			type: "gateway.rate_limited",
			delayMs: delay,
			attempt: this.rateLimitAttempts,
			upstream: parsed,
		});
		if (this.rateLimitTimer) {
			clearTimeout(this.rateLimitTimer);
		}
		this.rateLimitTimer = setTimeout(() => {
			this.rateLimitTimer = null;
			this.rateLimitAttempts = Math.max(0, this.rateLimitAttempts - 1);
			this.resumeClient("rate_limit_cleared");
			this.sendClientEvent({
				type: "gateway.rate_limit_cleared",
				sessionId: this.sessionId,
			});
		}, delay);
	}

	private providerBuffered(): number {
		return this.connection?.bufferedAmount() ?? 0;
	}

	private isBackpressured(): boolean {
		const upstream = this.providerBuffered();
		return (
			upstream >= this.highWaterMark ||
			this.bufferedBytes + upstream >= this.config.MAX_BUFFERED_BYTES ||
			this.outbound.writableLength >= this.outbound.writableHighWaterMark
		);
	}

	private evaluateBackpressure(_reason: string): void {
		if (this.closed) {
			return;
		}
		if (this.isBackpressured()) {
			this.pauseClient("high_water");
		} else {
			this.resumeClient("drained");
		}
	}

	private pauseClient(reason: string): void {
		if (this.closed) {
			return;
		}
		this.circuitOpen = true;
		if (this.clientPaused) {
			return;
		}
		this.clientPaused = true;
		this.stats.recordPause();
		pauseTotal.inc({ provider: this.providerId, reason });
		try {
			this.client.pause();
		} catch {
			// ignore
		}
		const bufferedBytes = this.bufferedBytes + this.providerBuffered();
		this.sendClientEvent({
			type: "gateway.pause",
			reason,
			bufferedBytes,
			highWaterMark: this.highWaterMark,
		});
		this.sendClientEvent({
			type: "gateway.backpressure",
			paused: true,
			reason,
			bufferedBytes,
		});
		this.log("warn", `[${this.sessionId}] pause client (${reason}, buffered=${bufferedBytes})`);
	}

	private resumeClient(reason: string): void {
		if (this.closed) {
			return;
		}
		if (this.isBackpressured() && reason !== "shutdown") {
			return;
		}
		this.circuitOpen = false;
		if (!this.clientPaused) {
			return;
		}
		this.clientPaused = false;
		this.bufferedBytes = this.providerBuffered();
		try {
			this.client.resume();
		} catch {
			// ignore
		}
		this.sendClientEvent({
			type: "gateway.resume",
			reason,
			bufferedBytes: this.bufferedBytes,
		});
		this.sendClientEvent({
			type: "gateway.backpressure",
			paused: false,
			reason,
			bufferedBytes: this.bufferedBytes,
		});
		this.log("info", `[${this.sessionId}] resume client (${reason})`);
	}

	private sendClientEvent(event: Record<string, unknown>): void {
		this.sendClientText(JSON.stringify(event));
	}

	private sendClientText(text: string): void {
		if (this.client.readyState !== 1 /* OPEN */) {
			return;
		}
		try {
			this.client.send(text);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.log("error", `[${this.sessionId}] client send failed: ${message}`);
		}
	}

	private sendClientBinary(data: Buffer): void {
		if (this.client.readyState !== 1) {
			return;
		}
		try {
			this.client.send(data, { binary: true });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.log("error", `[${this.sessionId}] client binary send failed: ${message}`);
		}
	}

	private safeCloseClient(code: number, reason: string): void {
		if (this.client.readyState === 0 || this.client.readyState === 1) {
			try {
				this.client.close(code, reason.slice(0, 123));
			} catch {
				try {
					this.client.terminate();
				} catch {
					// ignore
				}
			}
		}
	}
}

function rawDataToBuffer(data: WebSocket.RawData): Buffer {
	if (Buffer.isBuffer(data)) {
		return data;
	}
	if (Array.isArray(data)) {
		return Buffer.concat(data);
	}
	if (data instanceof ArrayBuffer) {
		return Buffer.from(data);
	}
	return Buffer.from(data);
}

function defaultLog(level: "debug" | "info" | "warn" | "error", message: string): void {
	const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}`;
	if (level === "error") {
		console.error(line);
	} else if (level === "warn") {
		console.warn(line);
	} else {
		console.log(line);
	}
}
