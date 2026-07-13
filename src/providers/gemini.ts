import WebSocket from "ws";
import type {
	ProviderAdapter,
	ProviderConnection,
	ProviderMessage,
	ProviderSessionContext,
} from "./types.js";

/**
 * Google Gemini Live / multimodal streaming adapter (WebSocket).
 * Protocol events are normalized toward the gateway's Realtime-style control plane.
 */
class GeminiConnection implements ProviderConnection {
	readonly providerId = "gemini" as const;
	private handler: ((msg: ProviderMessage) => void) | null = null;
	private pendingBytes = 0;

	constructor(private readonly ws: WebSocket) {
		ws.on("message", (data, isBinary) => {
			if (!this.handler) {
				return;
			}
			const buffer = toBuffer(data);
			if (isBinary) {
				this.handler({ kind: "binary", data: buffer });
				return;
			}
			const raw = buffer.toString("utf8");
			try {
				const value = JSON.parse(raw) as unknown;
				this.handler({ kind: "json", value: normalizeGeminiEvent(value), raw });
			} catch {
				this.handler({ kind: "binary", data: buffer });
			}
		});
		ws.on("close", (code, reason) => {
			this.handler?.({ kind: "close", code, reason: reason.toString() });
		});
		ws.on("error", (error) => {
			this.handler?.({ kind: "error", error });
		});
	}

	sendAudioAppend(base64: string): boolean {
		return this.sendControl({
			type: "input_audio_buffer.append",
			audio: base64,
		});
	}

	sendControl(event: Record<string, unknown>): boolean {
		if (this.ws.readyState !== WebSocket.OPEN) {
			return false;
		}
		const payload = JSON.stringify(mapControlToGemini(event));
		const bytes = Buffer.byteLength(payload, "utf8");
		this.pendingBytes += bytes;
		this.ws.send(payload, (err) => {
			if (!err) {
				this.pendingBytes = Math.max(0, this.pendingBytes - bytes);
			}
		});
		return true;
	}

	onMessage(handler: (msg: ProviderMessage) => void): void {
		this.handler = handler;
	}

	bufferedAmount(): number {
		return this.ws.bufferedAmount + this.pendingBytes;
	}

	close(code = 1000, reason = "provider_close"): void {
		if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
			try {
				this.ws.close(code, reason.slice(0, 123));
			} catch {
				try {
					this.ws.terminate();
				} catch {
					// ignore
				}
			}
		}
	}
}

export class GeminiProviderAdapter implements ProviderAdapter {
	readonly id = "gemini" as const;

	async connect(session: ProviderSessionContext): Promise<ProviderConnection> {
		const { config } = session;
		const url = `${config.GEMINI_REALTIME_WSS_URL}?key=${encodeURIComponent(config.GEMINI_API_KEY)}`;
		const ws = new WebSocket(url);
		await waitOpen(ws);
		const connection = new GeminiConnection(ws);
		connection.sendControl({
			type: "session.update",
			session: {
				model: config.GEMINI_MODEL || session.model,
				input_audio_format: session.audioFormat,
			},
		});
		return connection;
	}
}

function mapControlToGemini(event: Record<string, unknown>): Record<string, unknown> {
	if (event.type === "input_audio_buffer.append" && typeof event.audio === "string") {
		return {
			realtimeInput: {
				mediaChunks: [{ mimeType: "audio/pcm;rate=24000", data: event.audio }],
			},
		};
	}
	return event;
}

function normalizeGeminiEvent(value: unknown): unknown {
	if (typeof value !== "object" || value === null) {
		return value;
	}
	const obj = value as Record<string, unknown>;
	if ("serverContent" in obj) {
		return { type: "response.audio_transcript.delta", gemini: obj };
	}
	return obj;
}

function waitOpen(ws: WebSocket): Promise<void> {
	return new Promise((resolve, reject) => {
		const onOpen = () => {
			cleanup();
			resolve();
		};
		const onError = (err: Error) => {
			cleanup();
			reject(err);
		};
		const cleanup = () => {
			ws.off("open", onOpen);
			ws.off("error", onError);
		};
		ws.once("open", onOpen);
		ws.once("error", onError);
	});
}

function toBuffer(data: WebSocket.RawData): Buffer {
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
