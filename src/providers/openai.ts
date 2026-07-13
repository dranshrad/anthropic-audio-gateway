import WebSocket from "ws";
import type {
	ProviderAdapter,
	ProviderConnection,
	ProviderMessage,
	ProviderSessionContext,
} from "./types.js";

/**
 * OpenAI Realtime API adapter (ga/beta websocket).
 * @see https://platform.openai.com/docs/guides/realtime
 */
class OpenAiConnection implements ProviderConnection {
	readonly providerId = "openai" as const;
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
	}

	sendAudioAppend(base64: string): boolean {
		return this.sendControl({ type: "input_audio_buffer.append", audio: base64 });
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
		safeClose(this.ws, code, reason);
	}
}

export class OpenAiProviderAdapter implements ProviderAdapter {
	readonly id = "openai" as const;

	async connect(session: ProviderSessionContext): Promise<ProviderConnection> {
		const { config } = session;
		const url = config.OPENAI_REALTIME_WSS_URL;
		const ws = new WebSocket(url, {
			headers: {
				authorization: `Bearer ${config.OPENAI_API_KEY}`,
				"openai-beta": "realtime=v1",
			},
		});
		await waitOpen(ws);
		const connection = new OpenAiConnection(ws);
		connection.sendControl({
			type: "session.update",
			session: {
				modalities: ["text", "audio"],
				model: config.OPENAI_MODEL || session.model,
				input_audio_format: session.audioFormat === "pcm16" ? "pcm16" : "pcm16",
				output_audio_format: "pcm16",
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

function safeClose(ws: WebSocket, code: number, reason: string): void {
	if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
		try {
			ws.close(code, reason.slice(0, 123));
		} catch {
			try {
				ws.terminate();
			} catch {
				// ignore
			}
		}
	}
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
