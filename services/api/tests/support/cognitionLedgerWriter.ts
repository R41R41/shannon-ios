import { DatabaseSync } from 'node:sqlite';
import { DecisionTraces } from '../../src/mind/inhibition/decisionTraces.js';
import { PredictionLedger } from '../../src/mind/learning/predictionLedger.js';

/**
 * One writer process of `cognitionLedgerContention.test.ts`: its own connection, as the API and the activity loop have, writing
 * predictions, their outcomes and traces as fast as it can. Prints one JSON line: how many failures were logged, and the waits.
 * Arguments: database path, writer number, rounds.
 */
const [path, writer, rounds] = [process.argv[2]!, Number(process.argv[3]), Number(process.argv[4])];
const failures: string[] = [];
console.error = (...parts: unknown[]) => { failures.push(parts.map(String).join(' ')); };
const database = new DatabaseSync(path);
database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
const now = () => new Date().toISOString();
const ledger = new PredictionLedger({ database, createsSchema: false, defer: task => task(), log: () => undefined });
const traces = new DecisionTraces({ database, createsSchema: false, defer: task => task(), now, log: () => undefined });
for (let round = 0; round < rounds; round += 1) {
  const at = now();
  const id = ledger.open('owner', { domain: 'reading_used', key: writer % 2 ? 'public' : 'notion', context: '', sourceKind: 'reading', sourceId: `w${writer}-r${round}` }, at);
  ledger.settle('owner', id, round % 3 ? 1 : 0, at);
  traces.record('owner', {
    surface: 'autonomy', decision: 'autonomy_think', decider: 'model', model: 'gpt-5.6-luna', questions: null, contextChars: 100, latencyMs: 10,
    outcome: 'ok', fallbackDecider: null, answers: { steps: ['read'] }, costUsd: null, relatedId: null, at,
  });
}
process.stdout.write(`${JSON.stringify({ failures, ledger: ledger.lockWaits(), traces: traces.lockWaits() })}\n`);
database.close();
