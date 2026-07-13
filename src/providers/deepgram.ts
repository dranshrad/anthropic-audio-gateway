import WebSocket from "ws";
import type {
	ProviderAdapter,
	ProviderConnection,
	ProviderMessage,
	ProviderSessionContext,
} from "./types.js";

/**
 * Deepgram live transcription / voice agent WebSocket adapter.
 */
class DeepgramConnection implements ProviderConnection {
	readonly providerId = "deepgram" as const;
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
				this.handler({ kind: "json", value: normalizeDeepgram(value), raw });
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
		if (this.ws.readyState !== WebSocket.OPEN) {
			return false;
		}
		const audio = Buffer.from(base64, "base64");
		this.pendingBytes += audio.byteLength;
		this.ws.send(audio, { binary: true }, (err) => {
			if (!err) {
				this.pendingBytes = Math.max(0, this.pendingBytes - audio.byteLength);
			}
		});
		return true;
	}

	sendControl(event: Record<string, unknown>): boolean {
		if (this.ws.readyState !== WebSocket.OPEN) {
			return false;
		}
		if (event.type === "input_audio_buffer.commit") {
			this.ws.send(JSON.stringify({ type: "CloseStream" }));
			return true;
		}
		this.ws.send(JSON.stringify(event));
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

export class DeepgramProviderAdapter implements ProviderAdapter {
	readonly id = "deepgram" as const;

	async connect(session: ProviderSessionContext): Promise<ProviderConnection> {
		const { config } = session;
		const params = new URLSearchParams({
			encoding: "linear16",
			sample_rate: String(session.sampleRate),
			channels: "1",
			model: config.DEEPGRAM_MODEL,
		});
		const url = `${config.DEEPGRAM_REALTIME_WSS_URL}?${params.toString()}`;
		const ws = new WebSocket(url, {
			headers: {
				authorization: `Token ${config.DEEPGRAM_API_KEY}`,
			},
		});
		await waitOpen(ws);
		return new DeepgramConnection(ws);
	}
}

function normalizeDeepgram(value: unknown): unknown {
	if (typeof value !== "object" || value === null) {
		return value;
	}
	const obj = value as {
		type?: string;
		channel?: { alternatives?: Array<{ transcript?: string }> };
	};
	const transcript = obj.channel?.alternatives?.[0]?.transcript;
	if (typeof transcript === "string" && transcript.length > 0) {
		return {
			type: "response.audio_transcript.delta",
			delta: transcript,
			deepgram: obj,
		};
	}
	return { type: obj.type ?? "deepgram.event", deepgram: obj };
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
