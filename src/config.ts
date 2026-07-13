import { z } from "zod";

const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);
const audioFormatSchema = z.enum(["pcm16", "opus"]);

/**
 * Strict environment schema. The process must not bind :8080 until this passes.
 */
const envSchema = z
	.object({
		NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
		PORT: z.coerce.number().int().positive().max(65535).default(8080),
		HOST: z.string().min(1).default("0.0.0.0"),
		LOG_LEVEL: logLevelSchema.default("info"),

		ANTHROPIC_API_KEY: z
			.string({
				required_error: "Fatal: ANTHROPIC_API_KEY is missing from the environment.",
			})
			.min(1, "Fatal: ANTHROPIC_API_KEY is missing from the environment.")
			.startsWith("sk-ant-", {
				message: "Fatal: Invalid Anthropic API Key format. It must strictly begin with 'sk-ant-'.",
			}),

		ANTHROPIC_REALTIME_WSS_URL: z
			.string()
			.url()
			.refine((value) => value.startsWith("ws://") || value.startsWith("wss://"), {
				message: "ANTHROPIC_REALTIME_WSS_URL must be a ws:// or wss:// URL",
			})
			.default("wss://api.anthropic.com/v1/realtime"),
		ANTHROPIC_MODEL: z.string().min(1).default("claude-sonnet-4-20250514"),
		ANTHROPIC_API_VERSION: z.string().min(1).default("2023-06-01"),

		AUDIO_FORMAT: audioFormatSchema.default("pcm16"),
		SAMPLE_RATE: z.coerce.number().int().positive().default(24_000),
		CHUNK_DURATION_MS: z.coerce.number().int().min(10).max(200).default(40),

		/** Pre-allocated PCM ring capacity in seconds (Zero-GC pipeline). */
		RING_BUFFER_SECONDS: z.coerce.number().positive().max(60).default(10),

		/**
		 * Spectral-entropy speech threshold in bits (lower = more tonal/structured).
		 * Frames with entropy below this (and sufficient energy) are treated as speech.
		 * Set to 0 to disable entropy gating (always speech when energy passes floor).
		 */
		VAD_ENTROPY_THRESHOLD: z.coerce.number().min(0).max(16).default(7.5),
		/** Minimum normalized RMS floor so absolute digital silence is never speech. */
		VAD_ENERGY_FLOOR: z.coerce.number().min(0).max(1).default(0.0015),
		/**
		 * High-band energy ratio gate for fricatives (s/f/th) that RMS alone drops.
		 * Ratio of power above ~4 kHz to total power.
		 */
		VAD_FRICATIVE_RATIO: z.coerce.number().min(0).max(1).default(0.18),
		/** Hold open after last speech detection to preserve trailing consonants / pauses. */
		VAD_HANGOVER_MS: z.coerce.number().int().min(0).max(5_000).default(400),

		/**
		 * Transform / upstream highWaterMark in bytes. When the Anthropic socket
		 * bufferedAmount exceeds this, the gateway pauses the browser WebSocket.
		 */
		HIGH_WATER_MARK: z.coerce.number().int().positive().default(262_144),
		MAX_BUFFERED_BYTES: z.coerce.number().int().positive().default(1_048_576),
		RATE_LIMIT_BASE_DELAY_MS: z.coerce.number().int().positive().default(500),
		RATE_LIMIT_MAX_DELAY_MS: z.coerce.number().int().positive().default(30_000),
	})
	.superRefine((data, ctx) => {
		if (data.RATE_LIMIT_BASE_DELAY_MS > data.RATE_LIMIT_MAX_DELAY_MS) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["RATE_LIMIT_BASE_DELAY_MS"],
				message: "must be less than or equal to RATE_LIMIT_MAX_DELAY_MS",
			});
		}
		if (data.HIGH_WATER_MARK > data.MAX_BUFFERED_BYTES) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["HIGH_WATER_MARK"],
				message: "must be less than or equal to MAX_BUFFERED_BYTES",
			});
		}
	});

export type Config = z.infer<typeof envSchema>;
export type LogLevel = z.infer<typeof logLevelSchema>;
export type AudioFormat = z.infer<typeof audioFormatSchema>;

/**
 * Validate process.env and return a typed runtime config.
 * Prefer importing {@link config} for boot paths that must die on misconfiguration.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const result = envSchema.safeParse(env);
	if (!result.success) {
		const details = result.error.issues
			.map((issue) => {
				const path = issue.path.length > 0 ? issue.path.join(".") : "env";
				return `   - [${path}] ${issue.message}`;
			})
			.join("\n");
		throw new Error(`Invalid Environment Configuration\n${details}`);
	}
	return result.data;
}

/**
 * Boot-time validation: pretty-print failures and terminate before the server binds.
 * Matches production defense-in-depth — never open :8080 with a bad env.
 */
function bootConfig(): Config {
	const parsedEnv = envSchema.safeParse(process.env);

	if (!parsedEnv.success) {
		console.error("❌ Boot Error: Invalid Environment Configuration");
		for (const issue of parsedEnv.error.issues) {
			const path = issue.path.length > 0 ? issue.path.join(".") : "env";
			console.error(`   - [${path}] ${issue.message}`);
		}
		process.exit(1);
	}

	return Object.freeze(parsedEnv.data);
}

/** Strictly typed, immutable configuration object validated at module load. */
export const config: Config = bootConfig();
