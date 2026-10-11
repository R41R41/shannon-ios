import { writeFileSync } from 'node:fs';
import { SQLiteActionStore } from '../../src/mind/action/threads/store/actionStore.js';
import { applySchemaSteps, appliedSchemaSteps } from '../../src/infra/sqlite/migrations/schemaSteps.js';
import { EXECUTION_STEPS } from '../../src/infra/sqlite/migrations/executionSteps.js';
import { openDatabase } from '../../src/infra/sqlite/sqliteOpen.js';

/**
 * One process of `executionSchemaSteps.test.ts`: it opens the file as the mind worker does, writes its marker (when given one),
 * applies every execution step through the action store and the runner, and prints how long that took and the ledger it saw.
 */
const [path, marker] = process.argv.slice(2);
const db = openDatabase(path!, 'mindWorker');
if (marker) writeFileSync(marker, 'ready');
const started = performance.now();
try {
  new SQLiteActionStore(db);
  applySchemaSteps(db, EXECUTION_STEPS);
  const waitedMs = performance.now() - started;
  console.log(JSON.stringify({ ok: true, waitedMs, ledger: appliedSchemaSteps(db) }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
} finally {
  db.close();
}
