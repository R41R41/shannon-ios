import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENTRY_FILES, runtimeClosure, runtimeCycles } from './support/runtimeClosure.js';

/**
 * What each process of the API loads at run time (Syzygy ADR-0008 stage 3, pre-deploy review: "new modules in old processes").
 * Every entry's runtime closure (`runtimeClosure`, type-only imports dropped as tsx drops them) must stay inside the allow-list
 * recorded in `fixtures/entry-closures-v1.json`; a module a process starts loading has to be added there on purpose
 * (`UPDATE_ENTRY_CLOSURES=1 vitest run tests/entryClosures.test.ts`, then review the diff). The allow-list may shrink freely.
 *
 * Beyond the list, the processes that never run the mind's workspace or memory writer are pinned by name: the activity loop's
 * worker (`autonomyWorker.ts`) and the world worker load no workspace host, no perception, no memory outbox, writer or proposer,
 * and no people facts; they load the mind's inbox and the proactive gate only (with the gate's withheld-actions store).
 */
const FIXTURE = resolve(import.meta.dirname, 'fixtures/entry-closures-v1.json');

const NEVER_IN_WORKERS: readonly RegExp[] = [
  // The workspace host, its state, text, prompt layout and journal (F3); the turn context and the inbox store were moved or are the inbox.
  /^mind\/workspace\/(mindHost|promptLayout|workspacePorts|workspaceState|workspaceText|store\/workspaceJournalStore)\.ts$/,
  // Perception (F2) and its notice producers; the modules moved into perception in S2/S3 (guest names, room looks, presence) are older.
  /^mind\/perception\/(perceiver|perceptionCommon|perceptionPorts|textPerception|voicePerception|bodyPerception|inboxPerception|minecraftPerception|platformPerception|noticeProducers)\.ts$/,
  /^mind\/memory\/(memoryWriter|memoryOps|memoryProposer|memoryOpCodec|personFacts|personFactsPorts)\.ts$/,
  /^mind\/memory\/store\/(memoryOutboxStore|personFactsStore|trustLedgerStore)\.ts$/,
  /^infra\/sqlite\/storeMemoryParts\.ts$/,
  /^wiring\/(mindWiring|memoryOutboxWiring|peopleFactsWiring|compactionWiring)\.ts$/,
];

describe('the runtime closure of each entry', () => {
  const closures = Object.fromEntries(ENTRY_FILES.map(entry => [entry, runtimeClosure(entry)]));

  if (process.env.UPDATE_ENTRY_CLOSURES === '1') writeFileSync(FIXTURE, `${JSON.stringify(closures, null, 2)}\n`);
  const allowed = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, string[]>;

  it.each(ENTRY_FILES)('%s loads nothing outside its recorded allow-list', entry => {
    const list = new Set(allowed[entry] ?? []);
    expect(closures[entry]!.filter(file => !list.has(file))).toEqual([]);
  });

  it.each(['autonomyWorker.ts', 'worldWorker.ts'])('%s loads no workspace host, perception, memory writer or people facts', entry => {
    expect(closures[entry]!.filter(file => NEVER_IN_WORKERS.some(pattern => pattern.test(file)))).toEqual([]);
  });

  it('the inbox and the gate are what those workers load of stage 3', () => {
    for (const entry of ['autonomyWorker.ts', 'worldWorker.ts']) {
      expect(closures[entry]).toEqual(expect.arrayContaining([
        'wiring/mindInboxWiring.ts', 'mind/workspace/store/mindInboxStore.ts', 'wiring/proactiveGateWiring.ts', 'mind/attention/proactiveDelivery.ts',
      ]));
    }
  });

  it('her store loads no stage 3 memory part itself: wiring hands them (`storeMemoryParts.ts`)', () => {
    const store = runtimeClosure('infra/sqlite/sqliteStore.ts');
    expect(store.filter(file => /memoryOutboxStore|memoryProposer|memoryOpCodec|personFactsStore|trustLedgerStore|storeMemoryParts/.test(file))).toEqual([]);
  });

  it('no window (`*Ports.ts`) sits in a runtime import cycle (review L2: memoryOps → peopleMemory → … → memoryPorts → memoryWriter)', () => {
    expect(runtimeCycles().filter(cycle => cycle.some(file => /Ports\.ts$/.test(file)))).toEqual([]);
  });
});
