import { z } from "zod";

const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);
const audioFormatSchema = z.enum(["pcm16", "opus"]);
const providerSchema = z.enum(["anthropic", "openai", "gemini", "deepgram", "mock"]);

const envSchema = z
	.object({
		NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
		PORT: z.coerce.number().int().positive().max(65535).default(8080),
		HOST: z.string().min(1).default("0.0.0.0"),
		LOG_LEVEL: logLevelSchema.default("info"),

		PROVIDER: providerSchema.default("anthropic"),
		METRICS_ENABLED: z
			.enum(["true", "false"])
			.default("true")
			.transform((v) => v === "true"),
		ADAPTIVE_STREAMING: z
			.enum(["true", "false"])
			.default("true")
			.transform((v) => v === "true"),
		VAD_ENGINE: z.string().min(1).default("spectral-entropy"),
		WEBRTC_INGRESS: z
			.enum(["true", "false"])
			.default("true")
			.transform((v) => v === "true"),

		ANTHROPIC_API_KEY: z.string().optional().default(""),
		ANTHROPIC_REALTIME_WSS_URL: z
			.string()
			.default("wss://api.anthropic.com/v1/realtime")
			.refine((value) => value.startsWith("ws://") || value.startsWith("wss://"), {
				message: "ANTHROPIC_REALTIME_WSS_URL must be a ws:// or wss:// URL",
			}),
		ANTHROPIC_MODEL: z.string().min(1).default("claude-sonnet-4-20250514"),
		ANTHROPIC_API_VERSION: z.string().min(1).default("2023-06-01"),

		OPENAI_API_KEY: z.string().optional().default(""),
		OPENAI_REALTIME_WSS_URL: z
			.string()
			.default("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview"),
		OPENAI_MODEL: z.string().min(1).default("gpt-4o-realtime-preview"),

		GEMINI_API_KEY: z.string().optional().default(""),
		GEMINI_REALTIME_WSS_URL: z
			.string()
			.default(
				"wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent",
			),
		GEMINI_MODEL: z.string().min(1).default("gemini-2.0-flash-live"),

		DEEPGRAM_API_KEY: z.string().optional().default(""),
		DEEPGRAM_REALTIME_WSS_URL: z.string().default("wss://api.deepgram.com/v1/listen"),
		DEEPGRAM_MODEL: z.string().min(1).default("nova-2"),

		AUDIO_FORMAT: audioFormatSchema.default("pcm16"),
		SAMPLE_RATE: z.coerce.number().int().positive().default(24_000),
		CHUNK_DURATION_MS: z.coerce.number().int().min(10).max(200).default(40),
		RING_BUFFER_SECONDS: z.coerce.number().positive().max(60).default(10),

		VAD_ENTROPY_THRESHOLD: z.coerce.number().min(0).max(16).default(7.5),
		VAD_ENERGY_FLOOR: z.coerce.number().min(0).max(1).default(0.0015),
		VAD_FRICATIVE_RATIO: z.coerce.number().min(0).max(1).default(0.18),
		VAD_HANGOVER_MS: z.coerce.number().int().min(0).max(5_000).default(400),

		HIGH_WATER_MARK: z.coerce.number().int().positive().default(262_144),
		MAX_BUFFERED_BYTES: z.coerce.number().int().positive().default(1_048_576),
		RATE_LIMIT_BASE_DELAY_MS: z.coerce.number().int().positive().default(500),
		RATE_LIMIT_MAX_DELAY_MS: z.coerce.number().int().positive().default(30_000),

		AUTH_JWT_SECRET: z.string().optional().default(""),
		AUTH_ALLOWED_ORIGINS: z
			.string()
			.optional()
			.default("")
			.transform((v) =>
				v
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean),
			),
		AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),
		AUTH_MAX_SESSIONS_PER_SUBJECT: z.coerce.number().int().positive().default(5),
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
		if (data.PROVIDER === "anthropic") {
			if (!data.ANTHROPIC_API_KEY.startsWith("sk-ant-")) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["ANTHROPIC_API_KEY"],
					message:
						"Fatal: Invalid Anthropic API Key format. It must strictly begin with 'sk-ant-'.",
				});
			}
		}
		if (data.PROVIDER === "openai" && !data.OPENAI_API_KEY.startsWith("sk-")) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["OPENAI_API_KEY"],
				message: "OPENAI_API_KEY is required for PROVIDER=openai",
			});
		}
		if (data.PROVIDER === "gemini" && data.GEMINI_API_KEY.length < 8) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["GEMINI_API_KEY"],
				message: "GEMINI_API_KEY is required for PROVIDER=gemini",
			});
		}
		if (data.PROVIDER === "deepgram" && data.DEEPGRAM_API_KEY.length < 8) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["DEEPGRAM_API_KEY"],
				message: "DEEPGRAM_API_KEY is required for PROVIDER=deepgram",
			});
		}
	});

export type Config = z.infer<typeof envSchema>;
export type LogLevel = z.infer<typeof logLevelSchema>;
export type AudioFormat = z.infer<typeof audioFormatSchema>;
export type ProviderName = z.infer<typeof providerSchema>;

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

export const config: Config = bootConfig();
