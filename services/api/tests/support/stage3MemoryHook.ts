import type { SwitchValues } from '@shannon/mind';
import type { MemoryWriter } from '../../src/mind/memory/memoryPorts.js';
import { memoryOutboxOn, memoryPortsOf, memoryWriterOf } from '../../src/wiring/memoryOutboxWiring.js';
import { peopleFactsStoreOptions } from '../../src/wiring/peopleFactsWiring.js';
import type { Stage3Hooks } from './stage3Scenarios.js';

/**
 * The memory outbox of step F5 for the stage-3 scenarios, built from an environment the way the entries build it
 * (`memoryOutboxOn`): undefined while it is switched off, so every scenario runs as on afb38c28. On, the scenario's store opens
 * the outbox (and F6's people facts by their own switches) and an in-process writer drains it after each proposal; `settle` waits for it.
 */
export function stage3MemoryHook(environment: SwitchValues): Stage3Hooks['memory'] {
  if (!memoryOutboxOn(environment)) return undefined;
  return context => {
    let writer: MemoryWriter | null = null;
    return {
      // F6's options too (people facts, identity, the trust ledger), each from its own switch.
      storeOptions: { memoryOutbox: true, memoryNotify: () => { void writer?.drain(); }, ...peopleFactsStoreOptions(environment) },
      attach(store) {
        const ports = memoryPortsOf(store, context.now)!;
        writer = memoryWriterOf(store, { now: context.now, log: () => {} });
        return { ...ports, settle: async () => { await writer!.drain(); } };
      },
    };
  };
}
