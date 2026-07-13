import { EventEmitter } from "node:events";
import type {
	ProviderAdapter,
	ProviderConnection,
	ProviderMessage,
	ProviderSessionContext,
} from "./types.js";

/**
 * In-process mock provider for CI, benchmarks, and local development.
 * Echoes audio appends as synthetic transcript + audio delta events.
 */
class MockConnection implements ProviderConnection {
	readonly providerId = "mock" as const;
	private readonly bus = new EventEmitter();
	private closed = false;
	private queueBytes = 0;
	private readonly maxQueue: number;

	constructor(maxQueue: number) {
		this.maxQueue = maxQueue;
	}

	emitReady(sessionId: string): void {
		this.publish({
			kind: "json",
			value: {
				type: "session.created",
				session: { id: sessionId, model: "mock-realtime" },
			},
			raw: "",
		});
	}

	sendAudioAppend(base64: string): boolean {
		if (this.closed) {
			return false;
		}
		const bytes = Buffer.byteLength(base64, "utf8");
		this.queueBytes += bytes;
		queueMicrotask(() => {
			this.queueBytes = Math.max(0, this.queueBytes - bytes);
			this.publish({
				kind: "json",
				value: {
					type: "response.audio_transcript.delta",
					delta: ".",
					mock: true,
					bytes,
				},
				raw: "",
			});
			this.publish({
				kind: "json",
				value: {
					type: "response.audio.delta",
					delta: base64.slice(0, Math.min(64, base64.length)),
				},
				raw: "",
			});
		});
		return this.queueBytes < this.maxQueue;
	}

	sendControl(event: Record<string, unknown>): boolean {
		if (this.closed) {
			return false;
		}
		if (event.type === "input_audio_buffer.commit") {
			queueMicrotask(() => {
				this.publish({
					kind: "json",
					value: { type: "input_audio_buffer.committed", mock: true },
					raw: "",
				});
			});
		}
		return true;
	}

	onMessage(handler: (msg: ProviderMessage) => void): void {
		this.bus.on("message", handler);
	}

	bufferedAmount(): number {
		return this.queueBytes;
	}

	close(code = 1000, reason = "mock_close"): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.publish({ kind: "close", code, reason });
		this.bus.removeAllListeners();
	}

	private publish(msg: ProviderMessage): void {
		this.bus.emit("message", msg);
	}
}

export class MockProviderAdapter implements ProviderAdapter {
	readonly id = "mock" as const;

	async connect(session: ProviderSessionContext): Promise<ProviderConnection> {
		const connection = new MockConnection(session.config.HIGH_WATER_MARK);
		queueMicrotask(() => {
			connection.emitReady(session.sessionId);
		});
		return connection;
	}
}
