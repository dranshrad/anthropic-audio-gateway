import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { authenticateUpgrade, initAuth, verifyHs256Jwt } from "../src/auth.js";
import type { Config } from "../src/config.js";

function b64url(data: string | Buffer): string {
	return Buffer.from(data)
		.toString("base64")
		.replace(/=/g, "")
		.replace(/\+/g, "-")
		.replace(/\//g, "_");
}

function signHs256Jwt(payload: Record<string, unknown>, secret: string): string {
	const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
	const body = b64url(JSON.stringify(payload));
	const data = `${header}.${body}`;
	const sig = createHmac("sha256", secret).update(data).digest("base64url");
	return `${data}.${sig}`;
}

function mockReq(url: string, headers: Record<string, string> = {}) {
	return {
		url,
		headers: { host: "localhost", ...headers },
	} as import("node:http").IncomingMessage;
}

function baseConfig(overrides: Partial<Config> = {}): Config {
	return {
		AUTH_JWT_SECRET: "",
		AUTH_ALLOWED_ORIGINS: [],
		AUTH_RATE_LIMIT_PER_MINUTE: 120,
		AUTH_MAX_SESSIONS_PER_SUBJECT: 5,
		...overrides,
	} as Config;
}

describe("verifyHs256Jwt", () => {
	it("accepts a valid token and returns sub", () => {
		const token = signHs256Jwt(
			{ sub: "user-1", exp: Math.floor(Date.now() / 1000) + 60 },
			"secret",
		);
		assert.equal(verifyHs256Jwt(token, "secret"), "user-1");
	});

	it("rejects tampered signature", () => {
		const token = signHs256Jwt({ sub: "user-1" }, "secret");
		assert.equal(verifyHs256Jwt(`${token}x`, "secret"), null);
	});

	it("rejects expired token", () => {
		const token = signHs256Jwt(
			{ sub: "user-1", exp: Math.floor(Date.now() / 1000) - 10 },
			"secret",
		);
		assert.equal(verifyHs256Jwt(token, "secret"), null);
	});
});

describe("authenticateUpgrade", () => {
	it("allows anonymous when secret unset", () => {
		const cfg = baseConfig();
		const result = authenticateUpgrade(mockReq("/"), cfg);
		assert.equal(result.ok, true);
		assert.equal(result.subject, "anonymous");
	});

	it("rejects missing token when secret set", () => {
		const cfg = baseConfig({ AUTH_JWT_SECRET: "secret" });
		initAuth(cfg);
		const result = authenticateUpgrade(mockReq("/"), cfg);
		assert.equal(result.ok, false);
		assert.equal(result.reason, "missing_token");
	});

	it("accepts valid bearer token", () => {
		const cfg = baseConfig({ AUTH_JWT_SECRET: "secret" });
		initAuth(cfg);
		const token = signHs256Jwt({ sub: "alice" }, "secret");
		const result = authenticateUpgrade(mockReq("/", { authorization: `Bearer ${token}` }), cfg);
		assert.equal(result.ok, true);
		assert.equal(result.subject, "alice");
	});

	it("rejects disallowed origin", () => {
		const cfg = baseConfig({ AUTH_ALLOWED_ORIGINS: ["https://app.example"] });
		const result = authenticateUpgrade(mockReq("/", { origin: "https://evil.example" }), cfg);
		assert.equal(result.ok, false);
		assert.equal(result.reason, "origin_denied");
	});
});
