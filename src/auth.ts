import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Config } from "./config.js";

export type AuthFailureReason =
	| "missing_token"
	| "invalid_token"
	| "origin_denied"
	| "quota_exceeded"
	| "rate_limited";

export interface AuthResult {
	ok: boolean;
	subject?: string;
	reason?: AuthFailureReason;
}

/** Simple in-memory rate/quota tracker (per-process; use Redis for multi-node). */
class QuotaTracker {
	private readonly hits = new Map<string, { count: number; windowStart: number }>();
	private readonly sessions = new Map<string, number>();

	constructor(
		private readonly ratePerMinute: number,
		private readonly maxSessionsPerSubject: number,
	) {}

	allowConnect(subject: string): AuthFailureReason | null {
		const now = Date.now();
		const bucket = this.hits.get(subject);
		if (!bucket || now - bucket.windowStart > 60_000) {
			this.hits.set(subject, { count: 1, windowStart: now });
		} else {
			bucket.count += 1;
			if (bucket.count > this.ratePerMinute) {
				return "rate_limited";
			}
		}
		const active = this.sessions.get(subject) ?? 0;
		if (active >= this.maxSessionsPerSubject) {
			return "quota_exceeded";
		}
		this.sessions.set(subject, active + 1);
		return null;
	}

	release(subject: string): void {
		const active = this.sessions.get(subject) ?? 0;
		if (active <= 1) {
			this.sessions.delete(subject);
		} else {
			this.sessions.set(subject, active - 1);
		}
	}
}

let quotaTracker: QuotaTracker | null = null;

export function initAuth(config: Config): void {
	quotaTracker = new QuotaTracker(
		config.AUTH_RATE_LIMIT_PER_MINUTE,
		config.AUTH_MAX_SESSIONS_PER_SUBJECT,
	);
}

/**
 * Validate WebSocket upgrade: optional JWT (HS256) + Origin allowlist.
 */
export function authenticateUpgrade(req: IncomingMessage, config: Config): AuthResult {
	if (config.AUTH_ALLOWED_ORIGINS.length > 0) {
		const origin = req.headers.origin;
		if (!origin || !config.AUTH_ALLOWED_ORIGINS.includes(origin)) {
			return { ok: false, reason: "origin_denied" };
		}
	}

	if (!config.AUTH_JWT_SECRET) {
		return { ok: true, subject: "anonymous" };
	}

	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
	const token =
		url.searchParams.get("token") ?? bearerToken(req.headers.authorization) ?? undefined;

	if (!token) {
		return { ok: false, reason: "missing_token" };
	}

	const subject = verifyHs256Jwt(token, config.AUTH_JWT_SECRET);
	if (!subject) {
		return { ok: false, reason: "invalid_token" };
	}

	if (!quotaTracker) {
		initAuth(config);
	}
	const quotaFail = quotaTracker!.allowConnect(subject);
	if (quotaFail) {
		return { ok: false, reason: quotaFail, subject };
	}

	return { ok: true, subject };
}

export function releaseAuthSubject(subject: string | undefined): void {
	if (subject && quotaTracker) {
		quotaTracker.release(subject);
	}
}

function bearerToken(header: string | undefined): string | undefined {
	if (!header) {
		return undefined;
	}
	const [scheme, token] = header.split(" ");
	if (scheme?.toLowerCase() !== "bearer" || !token) {
		return undefined;
	}
	return token;
}

/**
 * Minimal HS256 JWT verify (header.payload.signature) without external deps.
 */
export function verifyHs256Jwt(token: string, secret: string): string | null {
	const parts = token.split(".");
	if (parts.length !== 3) {
		return null;
	}
	const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
	const data = `${headerB64}.${payloadB64}`;
	const expected = createHmac("sha256", secret).update(data).digest();
	let actual: Buffer;
	try {
		actual = Buffer.from(sigB64, "base64url");
	} catch {
		return null;
	}
	if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
		return null;
	}
	try {
		const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as {
			sub?: string;
			exp?: number;
		};
		if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) {
			return null;
		}
		return typeof payload.sub === "string" ? payload.sub : "jwt-subject";
	} catch {
		return null;
	}
}
