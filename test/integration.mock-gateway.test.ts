process.env.PROVIDER = "mock";
process.env.METRICS_ENABLED = "false";
process.env.WEBRTC_INGRESS = "false";
process.env.ADAPTIVE_STREAMING = "false";
process.env.LOG_LEVEL = "error";
process.env.AUTH_JWT_SECRET = "";
process.env.AUTH_REQUIRED = "false";

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import WebSocket from "ws";

function toneFrame(samples = 960): Buffer {
	const buf = Buffer.alloc(samples * 2);
	for (let i = 0; i < samples; i += 1) {
		const sample = Math.floor(Math.sin((2 * Math.PI * 440 * i) / 24_000) * 10_000);
		buf.writeInt16LE(sample, i * 2);
	}
	return buf;
}

describe("mock gateway integration", () => {
	let port = 0;
	let closeApp: (() => Promise<void>) | null = null;

	before(async () => {
		const { loadConfig } = await import("../src/config.js");
		const { createApp, createLogger } = await import("../src/server.js");
		const cfg = loadConfig({
			...process.env,
			PROVIDER: "mock",
			HOST: "127.0.0.1",
			METRICS_ENABLED: "false",
			WEBRTC_INGRESS: "false",
			ADAPTIVE_STREAMING: "false",
			LOG_LEVEL: "error",
			HIGH_WATER_MARK: "262144",
			MAX_BUFFERED_BYTES: "1048576",
		});
		const app = createApp(cfg, createLogger("error"));
		const bound = await app.listen(0, "127.0.0.1");
		port = bound.port;
		closeApp = () => app.close();
	});

	after(async () => {
		if (closeApp) {
			await closeApp();
		}
	});

	it("emits gateway.ready and accepts PCM frames", async () => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
		const messages: unknown[] = [];

		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("timeout waiting for ready")), 5_000);
			ws.on("open", () => {
				/* wait for ready */
			});
			ws.on("message", (data) => {
				const text = data.toString();
				try {
					const json = JSON.parse(text) as { type?: string };
					messages.push(json);
					if (json.type === "gateway.ready") {
						ws.send(toneFrame());
						ws.send(toneFrame());
						clearTimeout(timer);
						setTimeout(() => {
							ws.close();
							resolve();
						}, 100);
					}
				} catch {
					// binary
				}
			});
			ws.on("error", reject);
		});

		const ready = messages.find(
			(m) =>
				typeof m === "object" && m !== null && (m as { type?: string }).type === "gateway.ready",
		);
		assert.ok(ready, "expected gateway.ready");
		assert.equal((ready as { provider?: string }).provider, "mock");
	});
});
