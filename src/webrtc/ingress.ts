import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";
import type { Config } from "../config.js";
import type { GatewayLogFn } from "../gateway.js";
import type { GatewaySession } from "../gateway.js";
import type { SessionManager } from "../session/manager.js";

/**
 * WebRTC ingress path (signaling + PCM bridge onto GatewaySession).
 *
 * Production: terminate DTLS/SRTP at a media edge, forward 24 kHz PCM here.
 * This module speaks offer/answer over `/webrtc`, then hands the socket to
 * the same duplex pipeline used by raw WS clients.
 */
export function attachWebRtcIngress(options: {
	server: Server;
	config: Config;
	sessions: SessionManager;
	log: GatewayLogFn;
	createSession: (socket: WebSocket) => GatewaySession;
}): WebSocketServer {
	const wss = new WebSocketServer({
		server: options.server,
		path: "/webrtc",
		perMessageDeflate: false,
		maxPayload: 8 * 1024 * 1024,
	});

	wss.on("connection", (socket: WebSocket) => {
		const onOffer = (data: WebSocket.RawData, isBinary: boolean) => {
			if (isBinary) {
				socket.send(
					JSON.stringify({
						type: "error",
						message: "Send a JSON offer before streaming media",
					}),
				);
				return;
			}
			const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
			let msg: { type?: string; sdp?: string };
			try {
				msg = JSON.parse(text) as { type?: string; sdp?: string };
			} catch {
				socket.send(JSON.stringify({ type: "error", message: "invalid_json" }));
				return;
			}
			if (msg.type !== "offer") {
				socket.send(JSON.stringify({ type: "error", message: "expected offer" }));
				return;
			}

			socket.off("message", onOffer);

			const session = options.createSession(socket);
			options.sessions.add(session);
			socket.send(
				JSON.stringify({
					type: "answer",
					sdp: synthesizeAnswerSdp(options.config),
					sessionId: session.sessionId,
					transport: "pcm-over-ws",
					note: "Media edge should forward 24kHz PCM after DTLS termination",
				}),
			);

			void session.start().catch((err: unknown) => {
				const message = err instanceof Error ? err.message : String(err);
				options.log("error", `[webrtc] session start failed: ${message}`);
				session.close(1011, "webrtc_start_failed");
				options.sessions.remove(session.sessionId);
			});

			socket.on("close", () => {
				options.sessions.remove(session.sessionId);
			});
		};

		socket.on("message", onOffer);
	});

	return wss;
}

function synthesizeAnswerSdp(config: Config): string {
	return [
		"v=0",
		"o=- 0 0 IN IP4 127.0.0.1",
		"s=anthropic-audio-gateway-webrtc",
		"t=0 0",
		"a=group:BUNDLE 0",
		"a=msid-semantic: WMS *",
		"m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
		"c=IN IP4 0.0.0.0",
		"a=ice-ufrag:gateway",
		"a=ice-pwd:gatewayicepassword123",
		"a=fingerprint:sha-256 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00",
		"a=setup:passive",
		"a=mid:0",
		"a=sctp-port:5000",
		`a=pcm-rate:${config.SAMPLE_RATE}`,
		`a=pcm-format:${config.AUDIO_FORMAT}`,
		"a=sendrecv",
	].join("\r\n");
}

export function handleWebRtcInfo(_req: IncomingMessage, res: ServerResponse): void {
	const body = JSON.stringify({
		path: "/webrtc",
		protocol: "offer-answer + PCM binary frames",
		recommendation:
			"Terminate WebRTC at a media edge and forward PCM to this gateway for provider routing",
	});
	res.writeHead(200, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
	});
	res.end(body);
}
