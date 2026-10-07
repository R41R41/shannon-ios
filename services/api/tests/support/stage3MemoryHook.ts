import { mindSwitches, type SwitchValues } from '@shannon/mind';
import type { MemoryWriter } from '../../src/mind/memory/memoryPorts.js';
import { memoryPortsOf, memoryWriterOf } from '../../src/wiring/memoryOutboxWiring.js';
import { stage3StoreOptions } from '../../src/wiring/peopleFactsWiring.js';
import type { Stage3Hooks } from './stage3Scenarios.js';

/**
 * The memory parts of stage 3 for the stage-3 scenarios, built from an environment the way the entries build them
 * (`stage3StoreOptions`, as `server.ts` and `worker.ts`): undefined while every one is switched off, so every scenario runs as on
 * afb38c28. With the outbox (F5) on, the scenario's store opens it and an in-process writer drains it after each proposal; `settle`
 * waits for it. Compaction (F7), people facts and the trust ledger (F6) change the store's options by their own switches.
 */
export function stage3MemoryHook(environment: SwitchValues): Stage3Hooks['memory'] {
  const switches = mindSwitches(environment);
  if (!switches.memoryOutbox && !switches.structuredCompaction && !switches.identityTiers && !switches.trustLedger) return undefined;
  return context => {
    let writer: MemoryWriter | null = null;
    return {
      storeOptions: { ...stage3StoreOptions(environment), ...(switches.memoryOutbox ? { memoryNotify: () => { void writer?.drain(); } } : {}) },
      attach(store) {
        const ports = memoryPortsOf(store, context.now);
        if (!ports) return null;
        writer = memoryWriterOf(store, { now: context.now, log: () => {} });
        return { ...ports, settle: async () => { await writer!.drain(); } };
      },
    };
  };
}
