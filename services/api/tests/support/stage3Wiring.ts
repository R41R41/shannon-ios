import { configuredMind, configuredMindInbox } from '../../src/wiring/mindWiring.js';
import { configuredProactiveGate } from '../../src/wiring/proactiveGateWiring.js';
import { configuredWithheldActions } from '../../src/wiring/withheldWiring.js';
import type { Stage3Hooks } from './stage3Scenarios.js';
import { stage3MemoryHook } from './stage3MemoryHook.js';

/**
 * The production wiring of Syzygy ADR-0008 stage 3 as `server.ts` and `autonomyWorker.ts` build it, from the environment of
 * the test (`vi.stubEnv`), handed to the scenarios of the switched-off proof through their hooks (`stage3Scenarios.ts`). Work the
 * server defers until after a response runs at once here, so a scenario's state is the same on every run.
 */
export function stage3Hooks(environment: Readonly<Record<string, string | undefined>> = process.env): Stage3Hooks {
  // The memory parts (F5–F7), as the entries build them; undefined while they are all off.
  const memory = stage3MemoryHook(environment);
  return {
    ...(memory ? { memory } : {}),
    kernel: ({ databasePath, now }) => {
      const mind = configuredMind(environment, { databasePath, now, schedule: task => task() });
      return mind ? { mind: mind.mind } : {};
    },
    reachOutGate: ({ databasePath }) => {
      const withheld = configuredWithheldActions(environment, { databasePath, createsSchema: false });
      const inbox = configuredMindInbox(environment, { databasePath });
      return configuredProactiveGate(environment, { databasePath, withheld: withheld?.withheld.sink ?? null, emit: inbox?.emit ?? null })?.gate ?? null;
    },
    loop: ({ databasePath }) => {
      const inbox = configuredMindInbox(environment, { databasePath });
      return inbox ? { emitMindEvent: inbox.emit } : {};
    },
  };
}
