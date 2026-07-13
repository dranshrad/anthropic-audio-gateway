import WebSocket from "ws";
import { AudioProcessor } from "./audio-processor.js";
import type { Config } from "./config.js";
import { createVadState, isSpeech } from "./vad-util.js";

export type GatewayLogFn = (level: "debug" | "info" | "warn" | "error", message: string) => void;

export interface GatewaySessionOptions {
	client: WebSocket;
	config: Config;
	log?: GatewayLogFn;
	/** Optional connection id for log correlation. */
	sessionId?: string;
}

type ClientControlMessage = {
	type?: string;
	[key: string]: unknown;
};

/**
 * Duplex bridge between a browser WebSocket client and Anthropic Realtime WSS.
 *
 * Backpressure strategy:
 * - Track estimated outbound buffered bytes toward upstream.
 * - When buffered bytes exceed MAX_BUFFERED_BYTES, pause accepting client audio
 *   (pause() on the ws readable side) and drop silence-only frames.
 * - Resume when the drain event fires or buffered estimate drops.
 */
export class GatewaySession {
	readonly sessionId: string;

	private readonly client: WebSocket;
	private readonly config: Config;
	private readonly log: GatewayLogFn;
	private readonly processor: AudioProcessor;
	private readonly vadState = createVadState();

	private upstream: WebSocket | null = null;
	private closed = false;
	private clientPaused = false;
	private bufferedBytes = 0;
	private rateLimitAttempts = 0;
	private rateLimitTimer: ReturnType<typeof setTimeout> | null = null;
	private silenceDroppedFrames = 0;
	private speechFramesSent = 0;

	constructor(options: GatewaySessionOptions) {
		this.client = options.client;
		this.config = options.config;
		this.sessionId = options.sessionId ?? crypto.randomUUID();
		this.log = options.log ?? defaultLog;
		this.processor = new AudioProcessor({
			format: this.config.AUDIO_FORMAT,
			sampleRate: this.config.SAMPLE_RATE,
			chunkDurationMs: this.config.CHUNK_DURATION_MS,
		});
	}

	/** Open upstream connection and wire duplex handlers. */
	async start(): Promise<void> {
		if (this.closed) {
			return;
		}

		this.bindClientHandlers();
		await this.connectUpstream();
	}

	/** Gracefully tear down both sockets and timers. */
	close(code = 1000, reason = "gateway_shutdown"): void {
		if (this.closed) {
			return;
		}
		this.closed = true;

		if (this.rateLimitTimer) {
			clearTimeout(this.rateLimitTimer);
			this.rateLimitTimer = null;
		}

		this.resumeClient();
		this.processor.reset();

		this.safeClose(this.client, code, reason);
		if (this.upstream) {
			this.safeClose(this.upstream, code, reason);
			this.upstream = null;
		}

		this.log(
			"info",
			`[${this.sessionId}] closed (speech=${this.speechFramesSent}, silenceDropped=${this.silenceDroppedFrames})`,
		);
	}

	private async connectUpstream(): Promise<void> {
		const url = this.config.ANTHROPIC_REALTIME_WSS_URL;
		this.log("info", `[${this.sessionId}] connecting upstream ${url}`);

		const upstream = new WebSocket(url, {
			headers: {
				"x-api-key": this.config.ANTHROPIC_API_KEY,
				authorization: `Bearer ${this.config.ANTHROPIC_API_KEY}`,
				"anthropic-version": this.config.ANTHROPIC_API_VERSION,
				"anthropic-beta": "realtime-2025-01-01",
			},
		});

		this.upstream = upstream;

		await new Promise<void>((resolve, reject) => {
			const onOpen = () => {
				cleanup();
				resolve();
			};
			const onError = (err: Error) => {
				cleanup();
				reject(err);
			};
			const cleanup = () => {
				upstream.off("open", onOpen);
				upstream.off("error", onError);
			};
			upstream.once("open", onOpen);
			upstream.once("error", onError);
		});

		this.bindUpstreamHandlers(upstream);
		this.sendSessionUpdate(upstream);
		this.sendClientEvent({
			type: "gateway.ready",
			sessionId: this.sessionId,
			audioFormat: this.config.AUDIO_FORMAT,
			sampleRate: this.config.SAMPLE_RATE,
		});
		this.log("info", `[${this.sessionId}] upstream connected`);
	}

	private sendSessionUpdate(upstream: WebSocket): void {
		const payload = {
			type: "session.update",
			session: {
				model: this.config.ANTHROPIC_MODEL,
				input_audio_format: this.config.AUDIO_FORMAT === "pcm16" ? "pcm16" : "opus",
				output_audio_format: this.config.AUDIO_FORMAT === "pcm16" ? "pcm16" : "opus",
				turn_detection: null,
			},
		};
		this.sendUpstreamRaw(upstream, JSON.stringify(payload));
	}

	private bindClientHandlers(): void {
		this.client.on("message", (data, isBinary) => {
			void this.onClientMessage(data, isBinary);
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
		this.client.on("drain", () => {
			this.resumeClient();
		});
	}

	private bindUpstreamHandlers(upstream: WebSocket): void {
		upstream.on("message", (data, isBinary) => {
			this.onUpstreamMessage(data, isBinary);
		});
		upstream.on("close", (code, reason) => {
			this.log(
				"warn",
				`[${this.sessionId}] upstream closed code=${code} reason=${reason.toString()}`,
			);
			this.sendClientEvent({
				type: "gateway.upstream_closed",
				code,
				reason: reason.toString(),
			});
			this.close(code === 1000 ? 1000 : 1011, "upstream_closed");
		});
		upstream.on("error", (err) => {
			this.log("error", `[${this.sessionId}] upstream error: ${err.message}`);
			this.sendClientEvent({
				type: "gateway.error",
				message: err.message,
			});
			this.close(1011, "upstream_error");
		});
		upstream.on("drain", () => {
			this.bufferedBytes = Math.min(this.bufferedBytes, upstream.bufferedAmount);
			this.resumeClient();
		});
	}

	private async onClientMessage(data: WebSocket.RawData, isBinary: boolean): Promise<void> {
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

		const audio = decoded.audio;
		if (!audio) {
			return;
		}

		if (this.clientPaused) {
			// Under backpressure: only keep speech frames if we somehow still receive them
			const speech = isSpeech(audio, this.vadState, {
				energyThreshold: this.config.VAD_ENERGY_THRESHOLD,
				hangoverMs: this.config.VAD_HANGOVER_MS,
				sampleRate: this.config.SAMPLE_RATE,
				encoding: this.config.AUDIO_FORMAT,
			});
			if (!speech) {
				this.silenceDroppedFrames += 1;
				return;
			}
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
			this.sendUpstreamJson({ type: "input_audio_buffer.commit" });
			return;
		}
		if (type === "input_audio_buffer.clear") {
			this.processor.reset();
			this.sendUpstreamJson({ type: "input_audio_buffer.clear" });
			return;
		}
		if (
			type === "session.update" ||
			type === "response.create" ||
			type === "conversation.item.create"
		) {
			this.sendUpstreamJson(message);
			return;
		}
		if (type === "gateway.ping") {
			this.sendClientEvent({ type: "gateway.pong", sessionId: this.sessionId });
			return;
		}

		this.log("debug", `[${this.sessionId}] ignoring unknown client control: ${String(type)}`);
	}

	private forwardAudioChunk(chunk: Buffer): void {
		const speech = isSpeech(chunk, this.vadState, {
			energyThreshold: this.config.VAD_ENERGY_THRESHOLD,
			hangoverMs: this.config.VAD_HANGOVER_MS,
			sampleRate: this.config.SAMPLE_RATE,
			encoding: this.config.AUDIO_FORMAT,
		});

		if (!speech) {
			this.silenceDroppedFrames += 1;
			return;
		}

		if (this.isBackpressured()) {
			this.pauseClient();
			this.silenceDroppedFrames += 1;
			this.log(
				"warn",
				`[${this.sessionId}] backpressure: dropping frame (buffered=${this.bufferedBytes})`,
			);
			return;
		}

		if (
			!this.sendUpstreamJson({
				type: "input_audio_buffer.append",
				audio: this.processor.toBase64(chunk),
			})
		) {
			return;
		}
		this.speechFramesSent += 1;
		this.maybeApplyBackpressure();
	}

	private onUpstreamMessage(data: WebSocket.RawData, isBinary: boolean): void {
		if (this.closed) {
			return;
		}

		const buffer = rawDataToBuffer(data);

		if (isBinary) {
			this.sendClientBinary(buffer);
			return;
		}

		const text = buffer.toString("utf8");
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			this.sendClientBinary(buffer);
			return;
		}

		if (this.isRateLimitEvent(parsed)) {
			this.handleRateLimit(parsed);
			return;
		}

		// Relay audio deltas as binary when present for lower client latency
		if (this.tryRelayAudioDelta(parsed)) {
			return;
		}

		this.sendClientText(text);
	}

	private tryRelayAudioDelta(parsed: unknown): boolean {
		if (typeof parsed !== "object" || parsed === null) {
			return false;
		}
		const event = parsed as {
			type?: string;
			delta?: string;
			audio?: string;
		};

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
			// Also forward the original JSON so clients that expect events still work
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
		if (typeof event.type === "string" && event.type.includes("rate_limit")) {
			return true;
		}
		return false;
	}

	private handleRateLimit(parsed: unknown): void {
		this.rateLimitAttempts += 1;
		const delay = Math.min(
			this.config.RATE_LIMIT_MAX_DELAY_MS,
			this.config.RATE_LIMIT_BASE_DELAY_MS * 2 ** (this.rateLimitAttempts - 1),
		);

		this.log(
			"warn",
			`[${this.sessionId}] rate limited; backing off ${delay}ms (attempt ${this.rateLimitAttempts})`,
		);

		this.pauseClient();
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
			this.resumeClient();
			this.sendClientEvent({
				type: "gateway.rate_limit_cleared",
				sessionId: this.sessionId,
			});
		}, delay);
	}

	private isBackpressured(): boolean {
		const upstreamBuffered = this.upstream?.bufferedAmount ?? 0;
		return this.bufferedBytes + upstreamBuffered >= this.config.MAX_BUFFERED_BYTES;
	}

	private maybeApplyBackpressure(): void {
		if (this.isBackpressured()) {
			this.pauseClient();
		}
	}

	private pauseClient(): void {
		if (this.clientPaused || this.closed) {
			return;
		}
		this.clientPaused = true;
		try {
			this.client.pause();
		} catch {
			// ws.pause may throw if already closed
		}
		this.sendClientEvent({
			type: "gateway.backpressure",
			paused: true,
			bufferedBytes: this.bufferedBytes,
		});
		this.log("debug", `[${this.sessionId}] client paused (backpressure)`);
	}

	private resumeClient(): void {
		if (!this.clientPaused || this.closed) {
			return;
		}
		if (this.isBackpressured()) {
			return;
		}
		this.clientPaused = false;
		this.bufferedBytes = this.upstream?.bufferedAmount ?? 0;
		try {
			this.client.resume();
		} catch {
			// ignore
		}
		this.sendClientEvent({
			type: "gateway.backpressure",
			paused: false,
			bufferedBytes: this.bufferedBytes,
		});
		this.log("debug", `[${this.sessionId}] client resumed`);
	}

	private sendUpstreamJson(payload: Record<string, unknown>): boolean {
		if (!this.upstream || this.upstream.readyState !== WebSocket.OPEN) {
			return false;
		}
		return this.sendUpstreamRaw(this.upstream, JSON.stringify(payload));
	}

	private sendUpstreamRaw(upstream: WebSocket, payload: string): boolean {
		if (upstream.readyState !== WebSocket.OPEN) {
			return false;
		}
		const bytes = Buffer.byteLength(payload, "utf8");
		this.bufferedBytes += bytes;
		upstream.send(payload, (err) => {
			if (err) {
				this.log("error", `[${this.sessionId}] upstream send failed: ${err.message}`);
			} else {
				this.bufferedBytes = Math.max(0, this.bufferedBytes - bytes);
				if (!this.isBackpressured()) {
					this.resumeClient();
				}
			}
		});
		// Node ws buffers asynchronously; use bufferedAmount as the live pressure signal.
		if (upstream.bufferedAmount + this.bufferedBytes >= this.config.MAX_BUFFERED_BYTES) {
			this.pauseClient();
		}
		return true;
	}

	private sendClientEvent(event: Record<string, unknown>): void {
		this.sendClientText(JSON.stringify(event));
	}

	private sendClientText(text: string): void {
		if (this.client.readyState !== WebSocket.OPEN) {
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
		if (this.client.readyState !== WebSocket.OPEN) {
			return;
		}
		try {
			this.client.send(data, { binary: true });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.log("error", `[${this.sessionId}] client binary send failed: ${message}`);
		}
	}

	private safeClose(socket: WebSocket, code: number, reason: string): void {
		if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
			try {
				socket.close(code, reason.slice(0, 123));
			} catch {
				try {
					socket.terminate();
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
