import WebSocket from "ws";
import type {
	ProviderAdapter,
	ProviderConnection,
	ProviderMessage,
	ProviderSessionContext,
} from "./types.js";

class AnthropicConnection implements ProviderConnection {
	readonly providerId = "anthropic" as const;
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
				this.handler({ kind: "json", value: JSON.parse(raw), raw });
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
		ws.on("drain", () => {
			this.pendingBytes = Math.min(this.pendingBytes, ws.bufferedAmount);
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
		const payload = JSON.stringify(event);
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

export class AnthropicProviderAdapter implements ProviderAdapter {
	readonly id = "anthropic" as const;

	async connect(session: ProviderSessionContext): Promise<ProviderConnection> {
		const { config } = session;
		const url = config.ANTHROPIC_REALTIME_WSS_URL;
		const ws = new WebSocket(url, {
			headers: {
				"x-api-key": config.ANTHROPIC_API_KEY,
				authorization: `Bearer ${config.ANTHROPIC_API_KEY}`,
				"anthropic-version": config.ANTHROPIC_API_VERSION,
				"anthropic-beta": "realtime-2025-01-01",
			},
		});

		await waitOpen(ws);
		const connection = new AnthropicConnection(ws);
		connection.sendControl({
			type: "session.update",
			session: {
				model: session.model,
				input_audio_format: session.audioFormat === "pcm16" ? "pcm16" : "opus",
				output_audio_format: session.audioFormat === "pcm16" ? "pcm16" : "opus",
				turn_detection: null,
			},
		});
		return connection;
	}
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
