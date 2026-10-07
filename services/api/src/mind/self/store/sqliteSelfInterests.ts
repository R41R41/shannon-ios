import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { SelfInterest, SelfInterestChange, SelfInterestOwnerCommand, SelfInterestProposal, SelfInterestSnapshot } from '@shannon/cognition';

export interface StoredInterestCandidate {
  proposal: SelfInterestProposal; status: 'pending' | 'accepted' | 'rejected' | 'held'; code: string; createdAt: string;
}
export interface InterestNightBudget { added: number; removed: number; baseline: Record<string, number> }
export interface InterestOwnerReceipt { requestHash: string; code: string; item: SelfInterest | null; revision: number }
export const selfInterestId = (candidateId: string) => `si-${createHash('sha256').update(candidateId).digest('hex').slice(0, 16)}`;
export const selfInterestRequestHash = (request: SelfInterestOwnerCommand) => createHash('sha256')
  .update(JSON.stringify([request.operationId, request.itemId, request.expectedRevision, request.action, request.changeId ?? null])).digest('hex');

/** No independent writer: mutations require the memory writer's enclosing transaction and connection. */
export class SQLiteSelfInterests {
  constructor(private readonly database: DatabaseSync, options: { createsSchema?: boolean } = {}) {
    if (options.createsSchema === false) return;
    database.exec(`
      CREATE TABLE IF NOT EXISTS self_interest_heads (scope_key TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS self_interest_items (
        scope_key TEXT NOT NULL, item_id TEXT NOT NULL, topic_key TEXT NOT NULL, item_json TEXT NOT NULL,
        PRIMARY KEY(scope_key,item_id), UNIQUE(scope_key,topic_key));
      CREATE TABLE IF NOT EXISTS self_interest_changes (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, scope_key TEXT NOT NULL, change_id TEXT NOT NULL,
        item_id TEXT NOT NULL, change_json TEXT NOT NULL, UNIQUE(scope_key,change_id));
      CREATE TABLE IF NOT EXISTS self_interest_candidates (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, scope_key TEXT NOT NULL, candidate_id TEXT NOT NULL, proposal_json TEXT NOT NULL,
        status TEXT NOT NULL, code TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(scope_key,candidate_id));
      CREATE TABLE IF NOT EXISTS self_interest_nights (
        scope_key TEXT NOT NULL, night_key TEXT NOT NULL, budget_json TEXT NOT NULL, PRIMARY KEY(scope_key,night_key));
      CREATE TABLE IF NOT EXISTS self_interest_owner_receipts (
        scope_key TEXT NOT NULL, operation_id TEXT NOT NULL, receipt_json TEXT NOT NULL, PRIMARY KEY(scope_key,operation_id));
    `);
  }
  private writing(): void { if (!this.database.isTransaction) throw new Error('SELF_INTEREST_WRITER_TRANSACTION_REQUIRED'); }
  revision(scopeKey: string): number {
    return Number((this.database.prepare('SELECT revision FROM self_interest_heads WHERE scope_key=?').get(scopeKey) as { revision?: number } | undefined)?.revision ?? 0);
  }
  scopes(): string[] {
    return this.database.prepare('SELECT scope_key FROM self_interest_items UNION SELECT scope_key FROM self_interest_candidates')
      .all().map(row => String(row.scope_key));
  }
  all(scopeKey: string): SelfInterest[] {
    return this.database.prepare('SELECT item_json FROM self_interest_items WHERE scope_key=? ORDER BY item_id').all(scopeKey)
      .map(row => JSON.parse(String(row.item_json)) as SelfInterest);
  }
  get(scopeKey: string, id: string): SelfInterest | null {
    const row = this.database.prepare('SELECT item_json FROM self_interest_items WHERE scope_key=? AND item_id=?').get(scopeKey, id);
    return row ? JSON.parse(String(row.item_json)) as SelfInterest : null;
  }
  save(scopeKey: string, item: SelfInterest): void {
    this.writing();
    this.database.prepare(`INSERT INTO self_interest_items VALUES(?,?,?,?) ON CONFLICT(scope_key,item_id)
      DO UPDATE SET topic_key=excluded.topic_key,item_json=excluded.item_json`).run(scopeKey, item.id, item.topicKey, JSON.stringify(item));
    this.database.prepare(`INSERT INTO self_interest_heads VALUES(?,1) ON CONFLICT(scope_key) DO UPDATE SET revision=revision+1`).run(scopeKey);
  }
  change(scopeKey: string, id: string): SelfInterestChange | null {
    const row = this.database.prepare('SELECT seq,change_json FROM self_interest_changes WHERE scope_key=? AND change_id=?').get(scopeKey, id);
    return row ? { ...JSON.parse(String(row.change_json)), seq: Number(row.seq) } as SelfInterestChange : null;
  }
  changes(scopeKey: string, limit = 100, beforeSeq = Number.MAX_SAFE_INTEGER, itemId?: string): SelfInterestChange[] {
    return this.database.prepare(`SELECT seq,change_json FROM self_interest_changes WHERE scope_key=? AND seq<? ${itemId ? 'AND item_id=?' : ''} ORDER BY seq DESC LIMIT ?`)
      .all(scopeKey, beforeSeq, ...(itemId ? [itemId] : []), limit)
      .map(row => ({ ...JSON.parse(String(row.change_json)), seq: Number(row.seq) }) as SelfInterestChange);
  }
  appendChange(scopeKey: string, change: Omit<SelfInterestChange, 'seq'>): void {
    this.writing();
    this.database.prepare('INSERT INTO self_interest_changes(scope_key,change_id,item_id,change_json) VALUES(?,?,?,?)')
      .run(scopeKey, change.changeId, change.itemId, JSON.stringify(change));
  }
  laterContentChange(scopeKey: string, itemId: string, seq: number): boolean {
    return Boolean(this.database.prepare(`SELECT 1 FROM self_interest_changes WHERE scope_key=? AND item_id=? AND seq>?
      AND (json_extract(change_json,'$.actor')='sleep' OR json_extract(change_json,'$.kind')='undo') LIMIT 1`).get(scopeKey, itemId, seq));
  }
  propose(scopeKey: string, proposal: SelfInterestProposal, at: string): void {
    this.writing();
    this.database.prepare(`INSERT OR IGNORE INTO self_interest_candidates(scope_key,candidate_id,proposal_json,status,code,created_at)
      VALUES(?,?,?,'pending','pending',?)`).run(scopeKey, proposal.candidateId, JSON.stringify(proposal), at);
  }
  candidates(scopeKey: string, pendingOnly = true): StoredInterestCandidate[] {
    return this.database.prepare(`SELECT proposal_json,status,code,created_at FROM self_interest_candidates
      WHERE scope_key=? ${pendingOnly ? "AND status IN ('pending','held')" : ''} ORDER BY seq LIMIT 200`).all(scopeKey)
      .map(row => ({ proposal: JSON.parse(String(row.proposal_json)) as SelfInterestProposal,
        status: String(row.status) as StoredInterestCandidate['status'], code: String(row.code), createdAt: String(row.created_at) }));
  }
  /** Cleanup and partial edits remain reachable even if the old addition backlog fills a batch. */
  adoptableCandidates(scopeKey: string): StoredInterestCandidate[] {
    return this.database.prepare(`SELECT proposal_json,status,code,created_at FROM self_interest_candidates
      WHERE scope_key=? AND status IN ('pending','held') AND code!='provenance_unknown'
      ORDER BY CASE json_extract(proposal_json,'$.kind') WHEN 'remove' THEN 0 WHEN 'patch' THEN 1 ELSE 2 END,seq LIMIT 200`).all(scopeKey)
      .map(row => ({ proposal: JSON.parse(String(row.proposal_json)) as SelfInterestProposal,
        status: String(row.status) as StoredInterestCandidate['status'], code: String(row.code), createdAt: String(row.created_at) }));
  }
  candidateCounts(scopeKey: string): SelfInterestSnapshot['pending'] {
    const rows = this.database.prepare(`SELECT status,code,COUNT(*) AS count FROM self_interest_candidates
      WHERE scope_key=? AND status IN ('pending','held') GROUP BY status,code`).all(scopeKey);
    return rows.reduce<SelfInterestSnapshot['pending']>((counts, row) => ({ total: counts.total + Number(row.count), held: counts.held + (row.status === 'held' ? Number(row.count) : 0),
      capacityBlocked: counts.capacityBlocked + (row.code === 'over_capacity' ? Number(row.count) : 0),
      provenanceUnknown: counts.provenanceUnknown + (row.code === 'provenance_unknown' ? Number(row.count) : 0) }),
    { total: 0, held: 0, capacityBlocked: 0, provenanceUnknown: 0 });
  }
  settleCandidate(scopeKey: string, id: string, status: StoredInterestCandidate['status'], code: string): void {
    this.writing();
    this.database.prepare('UPDATE self_interest_candidates SET status=?,code=? WHERE scope_key=? AND candidate_id=?').run(status, code, scopeKey, id);
  }
  night(scopeKey: string, key: string): InterestNightBudget | null {
    const row = this.database.prepare('SELECT budget_json FROM self_interest_nights WHERE scope_key=? AND night_key=?').get(scopeKey, key);
    return row ? JSON.parse(String(row.budget_json)) as InterestNightBudget : null;
  }
  saveNight(scopeKey: string, key: string, budget: InterestNightBudget): void {
    this.writing();
    this.database.prepare(`INSERT INTO self_interest_nights VALUES(?,?,?) ON CONFLICT(scope_key,night_key) DO UPDATE SET budget_json=excluded.budget_json`)
      .run(scopeKey, key, JSON.stringify(budget));
  }
  receipt(scopeKey: string, operationId: string): InterestOwnerReceipt | null {
    const row = this.database.prepare('SELECT receipt_json FROM self_interest_owner_receipts WHERE scope_key=? AND operation_id=?').get(scopeKey, operationId);
    return row ? JSON.parse(String(row.receipt_json)) as InterestOwnerReceipt : null;
  }
  saveReceipt(scopeKey: string, operationId: string, receipt: InterestOwnerReceipt): void {
    this.writing();
    this.database.prepare('INSERT INTO self_interest_owner_receipts VALUES(?,?,?)').run(scopeKey, operationId, JSON.stringify(receipt));
  }
}
