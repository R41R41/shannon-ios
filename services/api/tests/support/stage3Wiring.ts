import { configuredMind } from '../../src/wiring/mindWiring.js';
import type { Stage3Hooks } from './stage3Scenarios.js';

/**
 * The production wiring of Syzygy ADR-0008 stage 3 as `server.ts` and `autonomyWorker.ts` build it, from the environment of
 * the test (`vi.stubEnv`), handed to the scenarios of the switched-off proof through their hooks (`stage3Scenarios.ts`). Work the
 * server defers until after a response runs at once here, so a scenario's state is the same on every run.
 */
export function stage3Hooks(environment: Readonly<Record<string, string | undefined>> = process.env): Stage3Hooks {
  return {
    kernel: () => {
      const mind = configuredMind(environment);
      return mind ? { mind: mind.mind } : {};
    },
  };
}
