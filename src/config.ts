import { z } from "zod";

const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);
const audioFormatSchema = z.enum(["pcm16", "opus"]);

const envSchema = z.object({
	PORT: z.coerce.number().int().min(1).max(65535).default(8080),
	HOST: z.string().min(1).default("0.0.0.0"),
	LOG_LEVEL: logLevelSchema.default("info"),

	ANTHROPIC_API_KEY: z
		.string()
		.min(1, "ANTHROPIC_API_KEY is required")
		.refine((value) => !value.includes("your-key-here"), {
			message: "ANTHROPIC_API_KEY must be a real API key",
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

	VAD_ENERGY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.01),
	VAD_HANGOVER_MS: z.coerce.number().int().min(0).max(5_000).default(300),

	MAX_BUFFERED_BYTES: z.coerce.number().int().positive().default(1_048_576),
	RATE_LIMIT_BASE_DELAY_MS: z.coerce.number().int().positive().default(500),
	RATE_LIMIT_MAX_DELAY_MS: z.coerce.number().int().positive().default(30_000),
});

export type Config = z.infer<typeof envSchema>;
export type LogLevel = z.infer<typeof logLevelSchema>;
export type AudioFormat = z.infer<typeof audioFormatSchema>;

function formatZodError(error: z.ZodError): string {
	return error.issues
		.map((issue) => {
			const path = issue.path.length > 0 ? issue.path.join(".") : "env";
			return `  - ${path}: ${issue.message}`;
		})
		.join("\n");
}

/**
 * Validate process.env and return a typed runtime config.
 * Throws a readable error listing every invalid field.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const result = envSchema.safeParse(env);
	if (!result.success) {
		throw new Error(
			`Invalid environment configuration:\n${formatZodError(result.error)}\n\nCopy .env.example to .env and set required values.`,
		);
	}

	const config = result.data;
	if (config.RATE_LIMIT_BASE_DELAY_MS > config.RATE_LIMIT_MAX_DELAY_MS) {
		throw new Error(
			"RATE_LIMIT_BASE_DELAY_MS must be less than or equal to RATE_LIMIT_MAX_DELAY_MS",
		);
	}

	return config;
}

/** Lazily load config so importing modules does not crash before env is ready (e.g. tests). */
let cachedConfig: Config | undefined;

export function getConfig(): Config {
	if (!cachedConfig) {
		cachedConfig = loadConfig();
	}
	return cachedConfig;
}

/** Reset cached config (useful for tests). */
export function resetConfigCache(): void {
	cachedConfig = undefined;
}
