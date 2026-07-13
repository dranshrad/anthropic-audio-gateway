import type { Config } from "../config.js";
import { AnthropicProviderAdapter } from "./anthropic.js";
import { DeepgramProviderAdapter } from "./deepgram.js";
import { GeminiProviderAdapter } from "./gemini.js";
import { MockProviderAdapter } from "./mock.js";
import { OpenAiProviderAdapter } from "./openai.js";
import type { ProviderAdapter, ProviderId } from "./types.js";

const adapters: Record<ProviderId, ProviderAdapter> = {
	anthropic: new AnthropicProviderAdapter(),
	openai: new OpenAiProviderAdapter(),
	gemini: new GeminiProviderAdapter(),
	deepgram: new DeepgramProviderAdapter(),
	mock: new MockProviderAdapter(),
};

export function getProviderAdapter(id: ProviderId): ProviderAdapter {
	const adapter = adapters[id];
	if (!adapter) {
		throw new Error(`Unknown provider: ${id}`);
	}
	return adapter;
}

export function resolveProviderModel(config: Config): string {
	switch (config.PROVIDER) {
		case "openai":
			return config.OPENAI_MODEL;
		case "gemini":
			return config.GEMINI_MODEL;
		case "deepgram":
			return config.DEEPGRAM_MODEL;
		case "mock":
			return "mock-realtime";
		default:
			return config.ANTHROPIC_MODEL;
	}
}

export type { ProviderAdapter, ProviderConnection, ProviderId, ProviderMessage } from "./types.js";
