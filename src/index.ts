import { config, warnOpenRelay } from "./config.js";
import { createApp, createLogger } from "./server.js";

warnOpenRelay(config);

const log = createLogger(config.LOG_LEVEL);
const app = createApp(config, log);

try {
	await app.listen();
} catch (err: unknown) {
	const message = err instanceof Error ? err.message : String(err);
	console.error(`Fatal: ${message}`);
	process.exit(1);
}

let shuttingDown = false;
const shutdown = (signal: string) => {
	if (shuttingDown) {
		return;
	}
	shuttingDown = true;
	log("info", `received ${signal}; draining ${app.sessions.size} session(s)`);
	void app.close().then(() => {
		log("info", "shutdown complete");
		process.exit(0);
	});
	setTimeout(() => {
		log("warn", "forced exit after drain timeout");
		process.exit(1);
	}, 10_000).unref();
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
