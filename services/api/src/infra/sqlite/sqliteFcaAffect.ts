import { type CompanionStateEvent, type CompanionStateSnapshot } from '@shannon/cognition';
import { fcaAppraisalDelta, validFcaAffectEvidence, type FcaAffectEvidence, type FcaAffectReceipt } from '../../mind/emotion/emotionPorts.js';
import type { SQLiteStoreContext } from './sqliteStoreContext.js';

/** Receipt metadata only. The existing companion writer remains the sole owner of emotional state. */
export class SQLiteFcaAffectReceipts {
  constructor(private readonly context: SQLiteStoreContext,
    private readonly state: { snapshot(scope: string): CompanionStateSnapshot; apply(scope: string, event: CompanionStateEvent): CompanionStateSnapshot }) {}
  private ensure() {
    this.context.database.exec(`CREATE TABLE IF NOT EXISTS fca_affect_receipts (
      scope_key TEXT NOT NULL,event_id TEXT NOT NULL,revision INTEGER NOT NULL,evidence_json TEXT NOT NULL,
      state_revision INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(scope_key,event_id))`);
  }
  receipts(scope: string, eventIds?: readonly string[]): FcaAffectReceipt[] {
    this.ensure();
    const rows = eventIds ? this.context.database.prepare('SELECT evidence_json,state_revision FROM fca_affect_receipts WHERE scope_key=? AND event_id IN (SELECT value FROM json_each(?))')
      .all(scope, JSON.stringify(eventIds)) : this.context.database.prepare('SELECT evidence_json,state_revision FROM fca_affect_receipts WHERE scope_key=? ORDER BY updated_at DESC,event_id LIMIT 100').all(scope);
    return rows.map(row => ({ ...JSON.parse(String(row.evidence_json)) as FcaAffectEvidence, stateRevision: Number(row.state_revision) }));
  }
  apply(scope: string, evidence: FcaAffectEvidence, visible: () => boolean): 'applied' | 'revised' | 'duplicate' | 'stale' | 'withheld' {
    if (!validFcaAffectEvidence(evidence)) throw new Error('FCA_AFFECT_EVIDENCE_INVALID');
    this.ensure();
    return this.context.transaction(() => {
      if (!visible()) return 'withheld';
      const row = this.context.database.prepare('SELECT revision,evidence_json FROM fca_affect_receipts WHERE scope_key=? AND event_id=?').get(scope, evidence.eventId);
      if (row && evidence.revision <= Number(row.revision)) return evidence.revision === Number(row.revision) ? 'duplicate' : 'stale';
      if (evidence.revision !== Number(row?.revision ?? 0) + 1) return 'stale';
      const before = this.state.apply(scope, { type: 'awake-observed' });
      const prior = row ? JSON.parse(String(row.evidence_json)) as FcaAffectEvidence : null;
      const delta = fcaAppraisalDelta(before.emotion, evidence, prior);
      const after = this.state.apply(scope, { type: 'emotion-adjusted', delta });
      this.context.database.prepare(`INSERT INTO fca_affect_receipts(scope_key,event_id,revision,evidence_json,state_revision,updated_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(scope_key,event_id) DO UPDATE SET revision=excluded.revision,evidence_json=excluded.evidence_json,
        state_revision=excluded.state_revision,updated_at=excluded.updated_at`)
        .run(scope, evidence.eventId, evidence.revision, JSON.stringify(evidence), after.version, this.context.now());
      this.context.insertEvent(scope, 'fca.affect_appraised', this.context.now(), {
        eventId: evidence.eventId, taskId: evidence.taskId, appraisalTaskId: evidence.appraisalTaskId ?? evidence.taskId, revision: evidence.revision, stateRevision: after.version,
        revised: prior !== null, sourceCount: evidence.sources.length,
      });
      return prior ? 'revised' : 'applied';
    });
  }
}
