import { DatabaseSync } from 'node:sqlite';
import { normalizeDisclosure, ownerSpoke, restoreCompanionState } from '@shannon/cognition';
import { parseTurnPayload } from '../infra/sqlite/sqliteStoreCodecs.js';
import { SelfInterestMemory, type SelfInterestContextPort, type SelfInterestSources } from '../mind/self/selfPorts.js';
import { SQLiteSelfInterests } from '../mind/self/store/sqliteSelfInterests.js';

/** A worker receives just this read function. OFF opens nothing; ON never creates a table or grants write authority. */
export function configuredSelfInterestContext(databasePath: string, options: { enabled: boolean; now: () => string }):
  { context: SelfInterestContextPort; close(): void } | null {
  if (!options.enabled) return null;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  database.exec('PRAGMA busy_timeout=5000');
  const sources: SelfInterestSources = {
    snapshot(scope) {
      const row = database.prepare('SELECT snapshot_json FROM companion_states WHERE scope_key=?').get(scope);
      if (!row) throw new Error('SELF_INTEREST_CONTEXT_UNAVAILABLE');
      return restoreCompanionState(scope, JSON.parse(String(row.snapshot_json)), options.now());
    },
    evidence(scope, refs) {
      if (!refs.length || refs.length > 16) return null;
      return database.prepare(`SELECT event_id,payload_json FROM experience_events WHERE scope_key=? AND event_type='turn.completed'
        AND event_id IN (${refs.map(() => '?').join(',')})`).all(scope, ...refs).flatMap(row => {
        const turn = parseTurnPayload(String(row.payload_json));
        if (!turn) return [];
        const disclosure = normalizeDisclosure(turn.disclosure);
        return [{ id: String(row.event_id), text: turn.userMessage, disclosure, owner: ownerSpoke(disclosure) }];
      });
    },
  };
  let memory: SelfInterestMemory | null = null;
  return {
    context: { read(scope, audience) {
      try {
        // The API may create the additive schema after this reader starts. A missing schema is retried, never created here.
        if (!memory) {
          if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='self_interest_items'").get()) return null;
          memory = new SelfInterestMemory(new SQLiteSelfInterests(database, { createsSchema: false }), sources);
        }
        return memory.context(scope, audience);
      } catch { return null; }
    } },
    close() { if (database.isOpen) database.close(); },
  };
}
