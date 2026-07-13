/**
 * Plugin registry for codecs, VAD, preprocessing, analytics, and exporters.
 * Transforms the gateway into an extensible real-time audio platform.
 */

export type PluginKind = "codec" | "vad" | "preprocess" | "analytics" | "exporter" | "provider";

export interface PluginContext {
	sessionId: string;
	sampleRate: number;
	audioFormat: string;
}

export interface AudioPlugin {
	readonly id: string;
	readonly kind: PluginKind;
	/** Optional lifecycle hooks — no-op defaults via base helpers. */
	onSessionStart?(ctx: PluginContext): void | Promise<void>;
	onSessionEnd?(ctx: PluginContext): void | Promise<void>;
	/** Preprocess PCM/Opus frame; return same or transformed buffer. */
	processFrame?(frame: Buffer, ctx: PluginContext): Buffer;
	/** Observe stats snapshots for analytics exporters. */
	onStats?(stats: Record<string, unknown>): void;
}

class PluginRegistry {
	private readonly plugins = new Map<string, AudioPlugin>();

	register(plugin: AudioPlugin): void {
		this.plugins.set(`${plugin.kind}:${plugin.id}`, plugin);
	}

	unregister(kind: PluginKind, id: string): boolean {
		return this.plugins.delete(`${kind}:${id}`);
	}

	list(kind?: PluginKind): AudioPlugin[] {
		const all = [...this.plugins.values()];
		return kind ? all.filter((p) => p.kind === kind) : all;
	}

	get(kind: PluginKind, id: string): AudioPlugin | undefined {
		return this.plugins.get(`${kind}:${id}`);
	}

	async startAll(ctx: PluginContext): Promise<void> {
		for (const plugin of this.plugins.values()) {
			await plugin.onSessionStart?.(ctx);
		}
	}

	async endAll(ctx: PluginContext): Promise<void> {
		for (const plugin of this.plugins.values()) {
			await plugin.onSessionEnd?.(ctx);
		}
	}

	processFrame(frame: Buffer, ctx: PluginContext): Buffer {
		let out = frame;
		for (const plugin of this.list("preprocess")) {
			if (plugin.processFrame) {
				out = plugin.processFrame(out, ctx);
			}
		}
		return out;
	}

	emitStats(stats: Record<string, unknown>): void {
		for (const plugin of this.list("analytics")) {
			plugin.onStats?.(stats);
		}
		for (const plugin of this.list("exporter")) {
			plugin.onStats?.(stats);
		}
	}
}

export const pluginRegistry = new PluginRegistry();

/** Built-in no-op noise suppressor placeholder (interface-first). */
export const noiseSuppressStub: AudioPlugin = {
	id: "noise-suppress-stub",
	kind: "preprocess",
	processFrame(frame: Buffer): Buffer {
		return frame;
	},
};

/** Silence analytics plugin — tracks silence ratio via onStats. */
export const silenceAnalyticsPlugin: AudioPlugin = {
	id: "silence-analytics",
	kind: "analytics",
	onStats(stats) {
		if (typeof stats.silenceRatio === "number" && stats.silenceRatio > 0.95) {
			// Intentionally quiet — exporters can subscribe; avoid log spam in hot path.
		}
	},
};

pluginRegistry.register(noiseSuppressStub);
pluginRegistry.register(silenceAnalyticsPlugin);
