import { setTimeout as delay } from 'node:timers/promises';
import { SQLiteShannonStore } from '../../src/infra/sqlite/sqliteStore.js';
import { memoryPortsOf, memoryWriterOf } from '../../src/wiring/memoryOutboxWiring.js';
import { STORE_MEMORY_PARTS } from '../../src/infra/sqlite/storeMemoryParts.js';

/**
 * One of the processes of `memoryWriterContention.test.ts`: on its own connection it proposes its ops (each fourth one followed
 * by a writer run), then runs the writer until nothing is pending anywhere, releases the lease and prints what it saw: errors by
 * code (a SQLITE_BUSY among them would fail the test) and its lock waits.
 */
const [path, indexText, countText] = process.argv.slice(2);
const index = Number(indexText);
const count = Number(countText);
const now = () => new Date().toISOString();
const errors: string[] = [];
const caught = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  errors.push(`${error instanceof Error ? error.message : String(error)}${typeof code === 'string' ? ` ${code}` : ''}`.slice(0, 200));
};
const store = new SQLiteShannonStore({ path: path!, now, memoryOutbox: true, memoryParts: STORE_MEMORY_PARTS, moodHistory: null, predictionShadow: false, decisionTraces: false,
  predictionLedger: false, choiceLedger: false });
const ports = memoryPortsOf(store, now)!;
const writer = memoryWriterOf(store, { now, owner: `writer-${index}`, log: line => errors.push(line) })!;
const outbox = store.memoryOutbox()!;
const at = now();
let worked = 0;
for (let item = 0; item < count; item += 1) {
  // Every fifth op of every process is about one shared fact; the rest are this process's own.
  const shared = item % 5 === 0;
  const id = shared ? 'user-fact-shared' : `user-fact-${index}-${item}`;
  try {
    ports.proposals.propose({ opId: `w${index}-op${item}`, scopeKey: 'owner', kind: 'fact.upsert', origin: 'turn', subjectKey: `fact:${id}`,
      payload: { fact: { id, statement: `ユーザーの事実${index}-${item}`, confidence: 0.9, observedAt: at, evidence: `事実${index}-${item}`,
        disclosure: { audience: { kind: 'owner' }, sensitivity: 'ordinary' } }, source: 'conversation' } });
  } catch (error) { caught(error); }
  if (item % 4 === 3) {
    try { if (await writer.runOnce() === 'worked') worked += 1; } catch (error) { caught(error); }
  }
}
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  try {
    if (await writer.runOnce() === 'worked') worked += 1;
    if (!outbox.rows({ status: 'pending', limit: 1 }).length) break;
  } catch (error) { caught(error); }
  await delay(5);
}
try { writer.releaseLease(); } catch (error) { caught(error); }
const waits = outbox.meter!.summary();
store.close();
process.stdout.write(`${JSON.stringify({ index, errors, worked, waits })}\n`);
