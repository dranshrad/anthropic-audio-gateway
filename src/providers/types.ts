import type { AudioFormat, Config } from "../config.js";

export type ProviderId = "anthropic" | "openai" | "gemini" | "deepgram" | "mock";

export type ProviderMessage =
	| { kind: "json"; value: unknown; raw: string }
	| { kind: "binary"; data: Buffer }
	| { kind: "close"; code: number; reason: string }
	| { kind: "error"; error: Error };

export interface ProviderSessionContext {
	sessionId: string;
	config: Config;
	audioFormat: AudioFormat;
	sampleRate: number;
	model: string;
}

export interface ProviderConnection {
	readonly providerId: ProviderId;
	sendAudioAppend(base64: string): boolean;
	sendControl(event: Record<string, unknown>): boolean;
	onMessage(handler: (msg: ProviderMessage) => void): void;
	bufferedAmount(): number;
	close(code?: number, reason?: string): void;
}

export interface ProviderAdapter {
	readonly id: ProviderId;
	connect(session: ProviderSessionContext): Promise<ProviderConnection>;
}
