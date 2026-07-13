export { SpectralVadEngine, PassthroughVadEngine } from "./types.js";
export type { VadEngine } from "./types.js";

import { PassthroughVadEngine, SpectralVadEngine, type VadEngine } from "./types.js";

const engines: Record<string, VadEngine> = {
	"spectral-entropy": new SpectralVadEngine(),
	passthrough: new PassthroughVadEngine(),
};

export function getVadEngine(id: string): VadEngine {
	const engine = engines[id] ?? engines["spectral-entropy"];
	return engine!;
}

export function registerVadEngine(engine: VadEngine): void {
	engines[engine.id] = engine;
}
