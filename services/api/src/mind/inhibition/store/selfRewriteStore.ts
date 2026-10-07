import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { SelfRewriteCandidate, SelfRewriteGate, SelfRewriteSnapshot, SelfRewriteWork } from '../selfRewritePorts.js';

/** Work identity comes from the canonical source authority, never the model's diff ID. */
export class SelfRewriteStore {
  constructor(private readonly database: DatabaseSync) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS self_rewrite_work (
        scope_key TEXT NOT NULL,work_id TEXT NOT NULL,work_json TEXT NOT NULL,PRIMARY KEY(scope_key,work_id));
      CREATE TABLE IF NOT EXISTS self_rewrite_candidates (
        scope_key TEXT NOT NULL,candidate_id TEXT PRIMARY KEY,work_id TEXT NOT NULL,candidate_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'proposed',before_json TEXT,after_json TEXT);
      CREATE TABLE IF NOT EXISTS self_rewrite_grants (
        scope_key TEXT NOT NULL,candidate_id TEXT PRIMARY KEY,diff_hash TEXT NOT NULL,base_revision TEXT NOT NULL,
        work_generation INTEGER NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS self_rewrite_audit (
        id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,work_id TEXT NOT NULL,candidate_id TEXT,gate TEXT NOT NULL,
        result TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS self_rewrite_proposals (
        candidate_id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,proposal_id TEXT NOT NULL);
    `);
  }
  work(scope: string, workId: string): SelfRewriteWork {
    const row = this.database.prepare('SELECT work_json FROM self_rewrite_work WHERE scope_key=? AND work_id=?').get(scope, workId) as { work_json: string } | undefined;
    return row ? JSON.parse(row.work_json) as SelfRewriteWork : { scopeKey: scope, workId, failures: 0, frozen: false, generation: 1, activeCandidate: null, state: 'idle' };
  }
  candidate(scope: string, id: string): SelfRewriteCandidate | null {
    const row = this.database.prepare('SELECT candidate_json FROM self_rewrite_candidates WHERE scope_key=? AND candidate_id=?').get(scope, id) as { candidate_json: string } | undefined;
    return row ? JSON.parse(row.candidate_json) as SelfRewriteCandidate : null;
  }
  proposalFor(scope: string, id: string): string | null {
    return (this.database.prepare('SELECT proposal_id FROM self_rewrite_proposals WHERE scope_key=? AND candidate_id=?').get(scope, id) as { proposal_id: string } | undefined)?.proposal_id ?? null;
  }
  attachProposal(scope: string, id: string, proposalId: string): void {
    if (!this.candidate(scope, id)) throw new Error('REWRITE_CANDIDATE_NOT_FOUND');
    this.database.prepare('INSERT OR IGNORE INTO self_rewrite_proposals VALUES(?,?,?)').run(id, scope, proposalId);
  }
  add(candidate: SelfRewriteCandidate, at: string): void {
    this.transaction(() => {
      const old = this.candidate(candidate.scopeKey, candidate.id);
      if (old) { if (JSON.stringify(old) !== JSON.stringify(candidate)) throw new Error('REWRITE_CANDIDATE_CONFLICT'); return; }
      this.database.prepare('INSERT INTO self_rewrite_candidates(scope_key,candidate_id,work_id,candidate_json) VALUES(?,?,?,?)')
        .run(candidate.scopeKey, candidate.id, candidate.workId, JSON.stringify(candidate));
      this.putWork(this.work(candidate.scopeKey, candidate.workId)); this.audit(candidate, 'provenance', 'proposed', at);
    });
  }
  grant(scope: string, id: string, diffHash: string, baseRevision: string, expectedGeneration: number, at: string): boolean {
    return this.transaction(() => {
      const candidate = this.candidate(scope, id); if (!candidate || candidate.diffHash !== diffHash || candidate.baseRevision !== baseRevision) return false;
      const work = this.work(scope, candidate.workId); if (work.generation !== expectedGeneration || work.state !== 'idle' || work.frozen) return false;
      this.database.prepare('INSERT INTO self_rewrite_grants VALUES(?,?,?,?,?,?) ON CONFLICT(candidate_id) DO UPDATE SET diff_hash=excluded.diff_hash,base_revision=excluded.base_revision,work_generation=excluded.work_generation,created_at=excluded.created_at')
        .run(scope, id, diffHash, baseRevision, expectedGeneration, at);
      this.audit(candidate, 'approval', 'owner_approved', at); return true;
    });
  }
  hasGrant(candidate: SelfRewriteCandidate, generation: number): boolean {
    return !!this.database.prepare('SELECT 1 FROM self_rewrite_grants WHERE scope_key=? AND candidate_id=? AND diff_hash=? AND base_revision=? AND work_generation=?')
      .get(candidate.scopeKey, candidate.id, candidate.diffHash, candidate.baseRevision, generation);
  }
  claim(candidate: SelfRewriteCandidate, at: string): SelfRewriteWork | null {
    return this.transaction(() => {
      const work = this.work(candidate.scopeKey, candidate.workId);
      const row = this.database.prepare('SELECT state FROM self_rewrite_candidates WHERE scope_key=? AND candidate_id=?').get(candidate.scopeKey, candidate.id) as { state: string } | undefined;
      if (!row || row.state !== 'proposed' || work.frozen || work.state !== 'idle') return null;
      work.state = 'validating'; work.activeCandidate = candidate.id; this.putWork(work);
      this.setCandidate(candidate.id, 'validating'); this.audit(candidate, 'provenance', 'claimed', at); return work;
    });
  }
  beginApply(candidate: SelfRewriteCandidate, generation: number, before: SelfRewriteSnapshot, at: string): boolean {
    // The executor may run only after this boundary commits, never inside someone else's uncommitted transaction.
    if (this.database.isTransaction) return false;
    return this.transaction(() => {
      const work = this.work(candidate.scopeKey, candidate.workId);
      if (work.generation !== generation || work.activeCandidate !== candidate.id || work.state !== 'validating' || work.frozen) return false;
      this.database.prepare('UPDATE self_rewrite_candidates SET before_json=? WHERE candidate_id=?').run(JSON.stringify(before), candidate.id);
      work.state = 'applying'; this.putWork(work); this.setCandidate(candidate.id, 'applying'); this.audit(candidate, 'dispatch', 'applying', at); return true;
    });
  }
  close(candidate: SelfRewriteCandidate, outcome: 'completed' | 'failed' | 'unknown' | 'refused', gate: SelfRewriteGate, code: string, at: string, after?: SelfRewriteSnapshot): void {
    this.transaction(() => {
      const work = this.work(candidate.scopeKey, candidate.workId);
      if (work.activeCandidate !== candidate.id) return;
      if (outcome === 'completed') work.failures = 0;
      if (outcome === 'failed') { work.failures += 1; work.frozen ||= work.failures >= 5; }
      work.state = outcome === 'unknown' ? 'unknown' : 'idle';
      if (outcome !== 'unknown') work.activeCandidate = null;
      this.putWork(work); this.setCandidate(candidate.id, outcome);
      if (after) this.database.prepare('UPDATE self_rewrite_candidates SET after_json=? WHERE candidate_id=?').run(JSON.stringify(after), candidate.id);
      this.audit(candidate, gate, code, at);
    });
  }
  ownerResume(scope: string, workId: string, expectedGeneration: number, at: string): boolean {
    return this.transaction(() => {
      const work = this.work(scope, workId);
      if (work.generation !== expectedGeneration || work.state !== 'idle' || !work.frozen) return false;
      work.frozen = false; work.failures = 0; work.generation += 1; this.putWork(work);
      this.database.prepare('INSERT INTO self_rewrite_audit VALUES(?,?,?,?,?,?,?)').run(randomUUID(), scope, workId, null, 'freeze', 'owner_resumed', at); return true;
    });
  }
  /** Called once by the owning executor lifecycle. Only durable applying can have crossed the executor boundary. */
  recoverInterrupted(at: string): number {
    return this.transaction(() => {
      const rows = this.database.prepare('SELECT work_json FROM self_rewrite_work').all() as { work_json: string }[];
      let count = 0;
      for (const row of rows) {
        const work = JSON.parse(row.work_json) as SelfRewriteWork;
        if (!['validating', 'applying'].includes(work.state) || !work.activeCandidate) continue;
        const candidate = this.candidate(work.scopeKey, work.activeCandidate); if (!candidate) continue;
        if (work.state === 'applying') this.close(candidate, 'unknown', 'unknown', 'restart_outcome_unknown', at);
        else this.close(candidate, 'refused', 'dispatch', 'restart_not_dispatched', at);
        count += 1;
      }
      return count;
    });
  }
  private putWork(work: SelfRewriteWork): void {
    this.database.prepare('INSERT INTO self_rewrite_work VALUES(?,?,?) ON CONFLICT(scope_key,work_id) DO UPDATE SET work_json=excluded.work_json').run(work.scopeKey, work.workId, JSON.stringify(work));
  }
  private setCandidate(id: string, state: string): void { this.database.prepare('UPDATE self_rewrite_candidates SET state=? WHERE candidate_id=?').run(state, id); }
  private audit(candidate: SelfRewriteCandidate, gate: SelfRewriteGate, result: string, at: string): void {
    this.database.prepare('INSERT INTO self_rewrite_audit VALUES(?,?,?,?,?,?,?)').run(randomUUID(), candidate.scopeKey, candidate.workId, candidate.id, gate, result, at);
  }
  private transaction<T>(operation: () => T): T {
    if (this.database.isTransaction) return operation();
    this.database.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.database.exec('COMMIT'); return result; }
    catch (error) { if (this.database.isTransaction) this.database.exec('ROLLBACK'); throw error; }
  }
}
