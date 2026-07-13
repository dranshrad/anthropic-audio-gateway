import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";
import { authenticateUpgrade, initAuth, releaseAuthSubject } from "./auth.js";
import { type Config, type LogLevel, config } from "./config.js";
import { type GatewayLogFn, GatewaySession } from "./gateway.js";
import {
	authRejectionsTotal,
	metricsContentType,
	renderMetrics,
	sessionsActive,
} from "./metrics/prometheus.js";
import { SessionManager } from "./session/manager.js";
import { attachWebRtcIngress, handleWebRtcInfo } from "./webrtc/ingress.js";

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

function createLogger(minLevel: LogLevel): GatewayLogFn {
	const min = LOG_LEVEL_ORDER[minLevel];
	return (level, message) => {
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
	cfg: Config,
	sessions: SessionManager,
): void {
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

	if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/healthz")) {
		const agg = sessions.aggregate();
		sendJson(res, 200, {
			status: "ok",
			uptimeSeconds: Math.floor(process.uptime()),
			activeSessions: agg.activeSessions,
			speechFrames: agg.speechFrames,
			silenceDropped: agg.silenceDropped,
			vadTriggers: agg.vadTriggers,
			avgSilenceRatio: agg.avgSilenceRatio,
			provider: cfg.PROVIDER,
			audioFormat: cfg.AUDIO_FORMAT,
			sampleRate: cfg.SAMPLE_RATE,
			nodeEnv: cfg.NODE_ENV,
			adaptiveStreaming: cfg.ADAPTIVE_STREAMING,
			webrtcIngress: cfg.WEBRTC_INGRESS,
		});
		return;
	}

	if (req.method === "GET" && url.pathname === "/metrics" && cfg.METRICS_ENABLED) {
		void renderMetrics().then((body) => {
			res.writeHead(200, {
				"content-type": metricsContentType(),
				"cache-control": "no-store",
			});
			res.end(body);
		});
		return;
	}

	if (req.method === "GET" && url.pathname === "/webrtc/info") {
		handleWebRtcInfo(req, res);
		return;
	}

	if (req.method === "GET" && url.pathname === "/") {
		sendJson(res, 200, {
			name: "anthropic-audio-gateway",
			version: "0.2.0",
			license: "AGPL-3.0-only",
			provider: cfg.PROVIDER,
			websocket: "/",
			webrtc: cfg.WEBRTC_INGRESS ? "/webrtc" : null,
			health: "/health",
			metrics: cfg.METRICS_ENABLED ? "/metrics" : null,
		});
		return;
	}

	sendJson(res, 404, { error: "not_found" });
}

async function main(): Promise<void> {
	const log = createLogger(config.LOG_LEVEL);
	initAuth(config);
	const sessions = new SessionManager();

	const server = createServer((req, res) => {
		handleHttpRequest(req, res, config, sessions);
	});

	const createSession = (socket: WebSocket) =>
		new GatewaySession({
			client: socket,
			config,
			log,
		});

	const wss = new WebSocketServer({
		server,
		path: "/",
		perMessageDeflate: false,
		maxPayload: 8 * 1024 * 1024,
		verifyClient: (info, done) => {
			const auth = authenticateUpgrade(info.req, config);
			if (!auth.ok) {
				authRejectionsTotal.inc({ reason: auth.reason ?? "invalid_token" });
				done(false, 401, auth.reason ?? "unauthorized");
				return;
			}
			const req = info.req as IncomingMessage & { authSubject?: string };
			if (auth.subject !== undefined) {
				req.authSubject = auth.subject;
			}
			done(true);
		},
	});

	wss.on("connection", (socket: WebSocket, req: IncomingMessage) => {
		const remote = req.socket.remoteAddress ?? "unknown";
		const subject = (req as IncomingMessage & { authSubject?: string }).authSubject ?? "anonymous";
		const session = createSession(socket);
		sessions.add(session);
		sessionsActive.set(sessions.size);
		log("info", `client connected from ${remote} session=${session.sessionId} sub=${subject}`);

		socket.on("close", () => {
			sessions.remove(session.sessionId);
			sessionsActive.set(sessions.size);
			releaseAuthSubject(subject);
		});

		void session.start().catch((err: unknown) => {
			const message = err instanceof Error ? err.message : String(err);
			log("error", `[${session.sessionId}] failed to start: ${message}`);
			session.close(1011, "upstream_connect_failed");
			sessions.remove(session.sessionId);
			sessionsActive.set(sessions.size);
			releaseAuthSubject(subject);
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

	if (config.WEBRTC_INGRESS) {
		attachWebRtcIngress({
			server,
			config,
			sessions,
			log,
			createSession,
		});
	}

	await new Promise<void>((resolve, reject) => {
		server.listen(config.PORT, config.HOST, () => resolve());
		server.once("error", reject);
	});

	log(
		"info",
		`Audio gateway listening on ws://${config.HOST}:${config.PORT} ` +
			`provider=${config.PROVIDER} format=${config.AUDIO_FORMAT} ` +
			`metrics=${config.METRICS_ENABLED} webrtc=${config.WEBRTC_INGRESS}`,
	);

	let shuttingDown = false;
	const shutdown = (signal: string) => {
		if (shuttingDown) {
			return;
		}
		shuttingDown = true;
		log("info", `received ${signal}; draining ${sessions.size} session(s)`);
		sessions.closeAll(1001, "server_shutdown");
		sessionsActive.set(0);
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
