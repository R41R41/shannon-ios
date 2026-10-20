import type { DatabaseSync } from 'node:sqlite';
import { SCHEMA_STEP_BUSY_TIMEOUT_MS, withBusyTimeout } from './sqliteOpen.js';
import { PROVENANCE_COUNTER, PROVENANCE_TABLES, existingNames, provenanceTriggers } from './provenanceMark.js';

/** Makes the source rows' counter and the triggers of every watched table that exists (`provenanceMark.ts`): the API, after its schema. */
export function ensureProvenanceCounter(database: DatabaseSync): void {
  database.exec(`CREATE TABLE IF NOT EXISTS ${PROVENANCE_COUNTER} (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL);
    INSERT OR IGNORE INTO ${PROVENANCE_COUNTER} (id, n) VALUES (1, 0);`);
  const tables = existingNames(database, 'table');
  for (const table of Object.keys(PROVENANCE_TABLES).filter(name => tables.has(name))) {
    for (const trigger of provenanceTriggers(database, table)) database.exec(`CREATE TRIGGER IF NOT EXISTS ${trigger.name} ${trigger.sql};`);
  }
}

/** `ensureProvenanceCounter` with the wait of a schema step; a failure (a busy database) is named and leaves no narrow mark (`sourceRowsMark`). */
export function prepareSourceRowsMark(database: DatabaseSync): void {
  try {
    withBusyTimeout(database, SCHEMA_STEP_BUSY_TIMEOUT_MS, () => ensureProvenanceCounter(database));
  } catch {
    console.warn('Shannon FCA source rows mark unavailable code=provenance_counter_unavailable');
  }
}
