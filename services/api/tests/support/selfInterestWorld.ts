import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OWNER_AUDIENCE, disclosureFor, type SelfInterestOwnerCommand, type SelfInterestProposal } from '@shannon/cognition';
import { SQLiteShannonStore } from '../../src/infra/sqlite/sqliteStore.js';
import { STORE_MEMORY_PARTS } from '../../src/infra/sqlite/storeMemoryParts.js';
import { MemoryCommands, MemoryWriter } from '../../src/mind/memory/memoryWriter.js';
import { memoryTargetsOf } from '../../src/wiring/memoryOutboxWiring.js';
import { selfInterestOwnerPort, selfInterestStoreOptions } from '../../src/wiring/selfInterestWiring.js';

/** Two real store connections can share one memory outbox, self history and actual-night budget. */
export function selfInterestWorld(enabled = true) {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-self-interest-'));
  const path = join(directory, 'shannon.sqlite');
  const clock = { at: Date.parse('2026-10-07T19:00:00.000Z') };
  const now = () => new Date(clock.at).toISOString();
  let sequence = 0;
  const connections: SQLiteShannonStore[] = [];
  const open = (holder = 'writer') => {
    const store = new SQLiteShannonStore({ path, now, memoryOutbox: true, ...selfInterestStoreOptions(enabled, STORE_MEMORY_PARTS),
      moodHistory: null, predictionShadow: false, decisionTraces: false, predictionLedger: false, choiceLedger: false });
    connections.push(store);
    const memory = store.selfInterests();
    const outbox = store.memoryOutbox()!;
    const proposals = store.memoryProposals()!;
    const targets = memoryTargetsOf(store, { now });
    const commands = new MemoryCommands(outbox, targets);
    const owner = selfInterestOwnerPort(memory, commands, now);
    const writer = (beforeLock?: ConstructorParameters<typeof MemoryWriter>[0]['beforeLock']) =>
      new MemoryWriter({ outbox, targets, now, owner: holder, log: () => {}, ...(beforeLock ? { beforeLock } : {}) });
    const source = (text = '星の観測を試してみたい。') => store.appendTurn('owner', 'thread', text, '覚えました。', now()).id;
    const propose = (input: Omit<SelfInterestProposal, 'candidateId' | 'disclosure' | 'evidenceRefs'> & { evidenceRefs?: readonly string[] }) => {
      const opId = `candidate-${++sequence}`;
      proposals.propose({ opId, scopeKey: 'owner', kind: 'self.interest.propose', origin: 'sleep', subjectKey: input.itemId ?? opId,
        payload: { ...input, provenance: 'sleep_self' }, episodeIds: input.evidenceRefs ?? [source()], disclosure: disclosureFor(input.title ?? '', OWNER_AUDIENCE) });
      return opId;
    };
    const night = async () => {
      proposals.propose({ opId: `night-${++sequence}`, scopeKey: 'owner', kind: 'self.interest.night', origin: 'sleep', subjectKey: 'self-interest-night', payload: {} });
      await writer().drain();
    };
    const add = (title: string, evidenceRefs?: readonly string[]) => propose({ kind: 'add', title, description: `${title}について調べる`, reason: '会話に共鳴した', ...(evidenceRefs ? { evidenceRefs } : {}) });
    const mutate = (input: Omit<SelfInterestOwnerCommand, 'operationId'> & { operationId?: string }) => owner!.mutate('owner', { ...input, operationId: input.operationId ?? `owner-${++sequence}` });
    return { store, memory, outbox, proposals, commands, owner, writer, source, propose, night, add, mutate };
  };
  return { ...open(), path, clock, now, open,
    advance: (milliseconds: number) => { clock.at += milliseconds; },
    close: () => { for (const store of connections) store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
