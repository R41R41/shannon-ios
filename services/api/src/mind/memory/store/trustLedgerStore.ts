import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { TRUST_KINDS, trustFold, type TrustEntry, type TrustKind, type TrustParameters } from '@shannon/mind';

/**
 * The trust ledger (Syzygy ADR-0008 stage 3 and §14, step F6; structure only, inert). Closed kinds of evidence, one row each,
 * settled once per conversation by `trustFold` (`packages/mind/src/trustFold.ts`). Its parameters are unset, so every row's
 * `trust_after` is null and nothing reaches a prompt; setting them is an owner approval. Created only while
 * `SHANNON_TRUST_LEDGER` is on; nothing writes to it yet but this store.
 */
export function ensureTrustLedgerSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS shannon_trust_ledger (
      entry_id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('promise_kept', 'promise_broken', 'owner_confirmed', 'owner_corrected')),
      conversation_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      trust_after REAL
    );
    CREATE INDEX IF NOT EXISTS shannon_trust_ledger_scope ON shannon_trust_ledger(scope_key, occurred_at);
  `);
}

export class SQLiteTrustLedger {
  constructor(private readonly database: DatabaseSync, private readonly parameters: TrustParameters | null = null) {
    ensureTrustLedgerSchema(database);
  }

  /** One piece of evidence of a closed kind; `trust_after` is what the fold gives (null while the parameters are unset). */
  record(scopeKey: string, kind: TrustKind, conversationId: string, at: string): number | null {
    if (!(TRUST_KINDS as readonly string[]).includes(kind)) throw new Error('TRUST_KIND');
    const after = trustFold([...this.entries(scopeKey), { kind, conversationId, at }], this.parameters);
    this.database.prepare(`INSERT INTO shannon_trust_ledger (entry_id, scope_key, kind, conversation_id, occurred_at, trust_after) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), scopeKey, kind, conversationId, at, after);
    return after;
  }

  entries(scopeKey: string): readonly TrustEntry[] {
    return (this.database.prepare('SELECT kind, conversation_id, occurred_at FROM shannon_trust_ledger WHERE scope_key = ? ORDER BY occurred_at, entry_id LIMIT 10000')
      .all(scopeKey) as Array<{ kind: TrustKind; conversation_id: string; occurred_at: string }>).map(row => ({ kind: row.kind, conversationId: row.conversation_id, at: row.occurred_at }));
  }

  /** Trust now: null while the parameters are unset. */
  trust(scopeKey: string): number | null { return trustFold(this.entries(scopeKey), this.parameters); }
}
