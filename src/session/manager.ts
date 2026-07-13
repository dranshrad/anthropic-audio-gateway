import type { GatewaySession } from "../gateway.js";

/**
 * Lightweight session registry for health aggregates and lifecycle hooks.
 * Session migration across nodes is deferred to a shared store (v2+).
 */
export class SessionManager {
	private readonly sessions = new Map<string, GatewaySession>();

	add(session: GatewaySession): void {
		this.sessions.set(session.sessionId, session);
	}

	remove(sessionId: string): void {
		this.sessions.delete(sessionId);
	}

	get(sessionId: string): GatewaySession | undefined {
		return this.sessions.get(sessionId);
	}

	get size(): number {
		return this.sessions.size;
	}

	values(): IterableIterator<GatewaySession> {
		return this.sessions.values();
	}

	closeAll(code: number, reason: string): void {
		for (const session of this.sessions.values()) {
			session.close(code, reason);
		}
		this.sessions.clear();
	}

	aggregate(): {
		activeSessions: number;
		speechFrames: number;
		silenceDropped: number;
		vadTriggers: number;
		avgSilenceRatio: number;
	} {
		let speechFrames = 0;
		let silenceDropped = 0;
		let vadTriggers = 0;
		let silenceRatioSum = 0;
		let n = 0;
		for (const session of this.sessions.values()) {
			const snap = session.getStats();
			speechFrames += snap.speechFramesSent;
			silenceDropped += snap.silenceDroppedFrames;
			vadTriggers += snap.vadTriggers;
			silenceRatioSum += snap.silenceRatio;
			n += 1;
		}
		return {
			activeSessions: this.sessions.size,
			speechFrames,
			silenceDropped,
			vadTriggers,
			avgSilenceRatio: n === 0 ? 0 : silenceRatioSum / n,
		};
	}
}
