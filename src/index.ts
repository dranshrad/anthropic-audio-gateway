import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";
import { type Config, type LogLevel, getConfig } from "./config.js";
import { GatewaySession } from "./gateway.js";

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

function createLogger(minLevel: LogLevel) {
	const min = LOG_LEVEL_ORDER[minLevel];
	return (level: LogLevel, message: string): void => {
		if (LOG_LEVEL_ORDER[level] < min) {
			return;
		}
		const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}`;
		if (level === "error") {
			console.error(line);
		} else if (level === "warn") {
			console.warn(line);
		} else {
			console.log(line);
		}
	};
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(payload),
		"cache-control": "no-store",
	});
	res.end(payload);
}

function handleHttpRequest(
	req: IncomingMessage,
	res: ServerResponse,
	config: Config,
	activeSessions: number,
): void {
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

	if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/healthz")) {
		sendJson(res, 200, {
			status: "ok",
			uptimeSeconds: Math.floor(process.uptime()),
			activeSessions,
			audioFormat: config.AUDIO_FORMAT,
			sampleRate: config.SAMPLE_RATE,
		});
		return;
	}

	if (req.method === "GET" && url.pathname === "/") {
		sendJson(res, 200, {
			name: "anthropic-audio-gateway",
			version: "1.0.0",
			license: "AGPL-3.0-only",
			websocket: "Connect via WebSocket to this host to stream audio",
			health: "/health",
		});
		return;
	}

	sendJson(res, 404, { error: "not_found" });
}

async function main(): Promise<void> {
	const config = getConfig();
	const log = createLogger(config.LOG_LEVEL);
	const sessions = new Map<string, GatewaySession>();

	const server = createServer((req, res) => {
		handleHttpRequest(req, res, config, sessions.size);
	});

	const wss = new WebSocketServer({
		server,
		perMessageDeflate: false,
		maxPayload: 8 * 1024 * 1024,
	});

	wss.on("connection", (socket: WebSocket, req: IncomingMessage) => {
		const remote = req.socket.remoteAddress ?? "unknown";
		const session = new GatewaySession({
			client: socket,
			config,
			log,
		});
		sessions.set(session.sessionId, session);
		log("info", `client connected from ${remote} session=${session.sessionId}`);

		socket.on("close", () => {
			sessions.delete(session.sessionId);
		});

		void session.start().catch((err: unknown) => {
			const message = err instanceof Error ? err.message : String(err);
			log("error", `[${session.sessionId}] failed to start: ${message}`);
			session.close(1011, "upstream_connect_failed");
			sessions.delete(session.sessionId);
			if (socket.readyState === socket.OPEN) {
				socket.send(
					JSON.stringify({
						type: "gateway.error",
						message: `Failed to connect upstream: ${message}`,
					}),
				);
			}
		});
	});

	wss.on("error", (err) => {
		log("error", `WebSocket server error: ${err.message}`);
	});

	await new Promise<void>((resolve, reject) => {
		server.listen(config.PORT, config.HOST, () => resolve());
		server.once("error", reject);
	});

	log(
		"info",
		`Anthropic Live-Audio Stream Gateway listening on ws://${config.HOST}:${config.PORT} ` +
			`(format=${config.AUDIO_FORMAT}, rate=${config.SAMPLE_RATE}Hz)`,
	);

	let shuttingDown = false;
	const shutdown = (signal: string) => {
		if (shuttingDown) {
			return;
		}
		shuttingDown = true;
		log("info", `received ${signal}; draining ${sessions.size} session(s)`);

		for (const session of sessions.values()) {
			session.close(1001, "server_shutdown");
		}
		sessions.clear();

		wss.close();
		server.close((err) => {
			if (err) {
				log("error", `HTTP server close error: ${err.message}`);
				process.exit(1);
			}
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
}

main().catch((err: unknown) => {
	const message = err instanceof Error ? err.message : String(err);
	console.error(`Fatal: ${message}`);
	process.exit(1);
});
