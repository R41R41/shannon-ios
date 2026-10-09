import { observeSync, withScopedObserverTask } from '../../../../infra/observer/observerContext.js';
import type { DatabaseSync } from 'node:sqlite';
import { AffectCoordinator, validFcaAffectEvidence, type FcaAffectEvidence, type FcaAffectWriter } from '../../../emotion/emotionPorts.js';
import { compareFcaOutcome, validFcaExpectation, type FcaActionExpectation, type FcaExpectationComparison } from '../../../prediction/predictionPorts.js';
import type { TaskSource, TaskStep } from '../../taskRuntime/taskRuntimePorts.js';
import type { ToolResult } from '../../../tools/toolRegistryPorts.js';
import type { FcaModelOutput, FcaToolCall } from '../fcaPorts.js';
import type { FcaAffectAppraisal, FcaDurableOutcome, FcaEvidence, FcaOutcomeContext, FcaSharedContext } from '../fcaEvidencePorts.js';

export interface FcaEvidenceOptions {
  db: DatabaseSync; state: FcaAffectWriter; now(): string;
  /** Runs synchronously inside this connection's write transaction; must check exact step + original live lease. */
  validStep(step: TaskStep): boolean;
  sourcesVisible(scopeKey: string, taskId: string, sources: readonly TaskSource[]): boolean;
  taskVisible(scopeKey: string, taskId: string): boolean;
  /** Persist lineage for other tasks whose public outcomes/causes enter this task's native history. */
  observeContext?(step: TaskStep, taskIds: readonly string[]): boolean;
  /** Idempotent existing memory outbox admission. Receipt is retried after a crash, never the original action. */
  onOutcome?(outcome: FcaDurableOutcome): void;
}
interface EvidenceRow {
  scope_key: string; event_id: string; task_id: string; step_id: string; call_id: string; name: string;
  expectation_json: string | null; comparison_json: string | null; observation: 'pending' | 'observed' | 'unknown';
  result_json: string | null; sources_json: string; observed_at: string | null; deadline_at: string | null;
  goal: string; action_json: string;
}
/** FCA working evidence/outbox only: task status and emotional state retain their existing writers. */
export class SQLiteFcaEvidenceStore implements FcaEvidence {
  private readonly affect: AffectCoordinator;
  constructor(private readonly options: FcaEvidenceOptions) {
    options.db.exec(`CREATE TABLE IF NOT EXISTS fca_action_evidence (
      scope_key TEXT NOT NULL,event_id TEXT NOT NULL,task_id TEXT NOT NULL,step_id TEXT NOT NULL,call_id TEXT NOT NULL,name TEXT NOT NULL,
      expectation_json TEXT,comparison_json TEXT,observation TEXT NOT NULL DEFAULT 'pending',result_json TEXT,sources_json TEXT NOT NULL,
      registered_at TEXT NOT NULL,deadline_at TEXT,observed_at TEXT,goal TEXT NOT NULL,action_json TEXT NOT NULL,
      outcome_delivered INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(scope_key,event_id));
      CREATE TABLE IF NOT EXISTS fca_affect_outbox (
      scope_key TEXT NOT NULL,event_id TEXT NOT NULL,revision INTEGER NOT NULL,step_id TEXT NOT NULL,task_id TEXT NOT NULL,
      evidence_json TEXT NOT NULL,done INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(scope_key,event_id,revision,step_id));`);
    this.affect = new AffectCoordinator(options.state, options.sourcesVisible);
  }
  prepare(step: TaskStep): FcaSharedContext {
    // Receipt/delivery failures are retried by maintenance; they must never poison a fresh native step.
    try { this.flush(); } catch { /* Both outboxes retain their original idempotency keys. */ }
    if (!this.options.validStep(step) || !this.visible(step)) throw new Error('FCA_EVIDENCE_HELD');
    const ids = [step.taskId, ...step.snapshot.task.childIds].filter(id => this.options.taskVisible(step.scopeKey, id));
    const rows = this.options.db.prepare(`SELECT * FROM fca_action_evidence WHERE scope_key=? AND observation!='pending'
      AND task_id IN (SELECT value FROM json_each(?)) ORDER BY rowid DESC LIMIT 24`).all(step.scopeKey, JSON.stringify(ids)) as unknown as EvidenceRow[];
    const affect = this.affect.snapshot(step.scopeKey), visibleRows = rows.filter(row => this.rowVisible(row)).slice(0, 8);
    const affectReceipts = this.options.state.fcaAffectReceipts(step.scopeKey, [...visibleRows.map(row => row.event_id), ...affect.causes.map(cause => cause.eventId)]);
    const receipts = new Map(affectReceipts.map(item => [item.eventId, item.revision]));
    const recentOutcomes: FcaOutcomeContext[] = visibleRows.map(row => ({
      eventId: row.event_id, taskId: row.task_id, operationId: row.event_id, name: row.name,
      observation: row.observation as 'observed' | 'unknown',
      result: row.result_json ? (() => { const result = JSON.parse(row.result_json) as { ok: boolean; text: string }; return { ok: result.ok, text: result.text.slice(0, 1_500) }; })() : null,
      expectation: parse<FcaActionExpectation>(row.expectation_json), comparison: publicComparison(parse<FcaExpectationComparison>(row.comparison_json)),
      appraisalRevision: receipts.get(row.event_id) ?? 0,
    }));
    const consumed = [...new Set([...recentOutcomes.map(item => item.taskId), ...affectReceipts
      .filter(item => affect.causes.some(cause => cause.eventId === item.eventId)).flatMap(item => [item.taskId, ...item.appraisalTaskId ? [item.appraisalTaskId] : []])])].filter(id => id !== step.taskId);
    if (consumed.length && !this.options.observeContext?.(step, consumed)) throw new Error('FCA_CONTEXT_SOURCE_UNPINNED');
    if (!this.visible(step)) throw new Error('FCA_EVIDENCE_HELD');
    return { affect, recentOutcomes };
  }
  beforeActions(step: TaskStep, output: FcaModelOutput): boolean {
    return this.transaction(() => {
      if (!this.options.validStep(step) || !this.visible(step)) return false;
      const calls = output.decision.kind === 'tools' ? output.decision.calls : [];
      const expectations = output.expectations ?? [];
      if (expectations.length > calls.length || new Set(expectations.map(item => item.callId)).size !== expectations.length
        || expectations.some(item => !validFcaExpectation(item) || !calls.some(call => call.id === item.callId))) throw new Error('FCA_EXPECTATION_INVALID');
      const tracked = output.decision.kind === 'tools' ? calls : [{ id: 'lifecycle', name: `fca.${output.decision.kind}`, input: { summary: output.decision.summary } }];
      for (const call of tracked) {
        const eventId = `${step.id}:${call.id}`, expectation = expectations.find(item => item.callId === call.id);
        const previous = this.row(step.scopeKey, eventId);
        if (previous) {
          if (previous.task_id !== step.taskId || previous.name !== call.name || previous.action_json !== JSON.stringify(call)
            || previous.expectation_json !== (expectation ? JSON.stringify(expectation) : null)) throw new Error('FCA_EVIDENCE_CONFLICT');
          continue;
        }
        this.options.db.prepare(`INSERT INTO fca_action_evidence(scope_key,event_id,task_id,step_id,call_id,name,expectation_json,comparison_json,
          sources_json,registered_at,deadline_at,goal,action_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(step.scopeKey, eventId, step.taskId, step.id, call.id, call.name,
          expectation ? JSON.stringify(expectation) : null, expectation ? JSON.stringify({ status: 'pending', actual: null, mismatch: null }) : null,
          JSON.stringify(step.snapshot.sources), this.options.now(), expectation ? new Date(Date.parse(this.options.now()) + expectation.withinMs).toISOString() : null,
          step.snapshot.task.goal, JSON.stringify(call));
      }
      if ((output.appraisals?.length ?? 0) > 8 || new Set(output.appraisals?.map(item => item.eventId)).size !== (output.appraisals?.length ?? 0)) throw new Error('FCA_APPRAISAL_INVALID');
      for (const appraisal of output.appraisals ?? []) this.queueAppraisal(step, appraisal);
      return true;
    });
  }
  observed(step: TaskStep, call: FcaToolCall, result: ToolResult): void { this.settle(step, call, result); }
  unknown(step: TaskStep, call: FcaToolCall): void {
    // An expired original lease cannot be replaced by a new writer. Its pre-action prediction remains pending/unobserved.
    if (this.options.validStep(step)) this.settle(step, call, null);
  }
  committed(_step: TaskStep): void { this.flush(); }
  flush(): void {
    this.settleLifecycle();
    const pending = this.options.db.prepare("SELECT * FROM fca_action_evidence WHERE deadline_at<=? AND json_extract(comparison_json,'$.status')='pending'")
      .all(this.options.now()) as unknown as EvidenceRow[];
    for (const row of pending) this.options.db.prepare(`UPDATE fca_action_evidence SET comparison_json=?,
      observation=CASE WHEN observation='pending' THEN 'unknown' ELSE observation END,observed_at=COALESCE(observed_at,deadline_at)
      WHERE scope_key=? AND event_id=? AND comparison_json=?`)
      .run(JSON.stringify({ status: 'unobserved', actual: null, mismatch: null }), row.scope_key, row.event_id, row.comparison_json);
    const queued = this.options.db.prepare(`SELECT o.* FROM fca_affect_outbox o WHERE o.done=0 AND EXISTS (
      SELECT 1 FROM fca_task_history h JOIN agent_tasks t ON t.task_id=h.task_id
      WHERE h.step_id=o.step_id AND h.task_id=o.task_id AND t.scope_key=o.scope_key) ORDER BY o.revision,o.rowid`).all();
    for (const row of queued) {
      const evidence = JSON.parse(String(row.evidence_json)) as FcaAffectEvidence;
      const result = withScopedObserverTask(String(row.scope_key), { taskId: String(row.task_id), stepId: String(row.step_id) }, () =>
        observeSync('emotion', { phase: 'apply_appraisal', revision: Number(row.revision) }, () => this.affect.submit(String(row.scope_key), evidence), status => ({ status })));
      if (result !== 'withheld') this.options.db.prepare('UPDATE fca_affect_outbox SET done=1 WHERE scope_key=? AND event_id=? AND revision=? AND step_id=?')
        .run(String(row.scope_key), String(row.event_id), Number(row.revision), String(row.step_id));
    }
    if (this.options.onOutcome) this.deliverOutcomes();
  }
  private settle(step: TaskStep, call: FcaToolCall, result: ToolResult | null) {
    this.transaction(() => {
      if (!this.options.validStep(step) || !this.visible(step)) throw new Error('FCA_EVIDENCE_HELD');
      const row = this.row(step.scopeKey, `${step.id}:${call.id}`);
      if (!row || row.task_id !== step.taskId || row.name !== call.name) throw new Error('FCA_EVIDENCE_MISSING');
      const recorded = result ? JSON.stringify({ ok: result.ok, text: result.text }) : null;
      if (row.observation === 'observed') {
        if (row.result_json !== recorded) throw new Error('FCA_EVIDENCE_CONFLICT');
        return;
      }
      const expectation = parse<FcaActionExpectation>(row.expectation_json);
      const comparison = expectation ? compareFcaOutcome(expectation, result, !!row.deadline_at && row.deadline_at <= this.options.now()) : null;
      this.options.db.prepare(`UPDATE fca_action_evidence SET observation=?,result_json=?,comparison_json=?,sources_json=?,observed_at=?
        WHERE scope_key=? AND event_id=?`).run(result ? 'observed' : 'unknown', recorded, comparison ? JSON.stringify(comparison) : null,
          JSON.stringify(step.snapshot.sources), this.options.now(), step.scopeKey, row.event_id);
    });
  }
  private queueAppraisal(step: TaskStep, appraisal: FcaAffectAppraisal) {
    const row = this.row(step.scopeKey, appraisal.eventId);
    if (!row || row.observation !== 'observed' || !this.options.taskVisible(step.scopeKey, row.task_id) || !this.rowVisible(row)) throw new Error('FCA_APPRAISAL_UNOBSERVED');
    const expected = parse<FcaActionExpectation>(row.expectation_json), comparison = parse<FcaExpectationComparison>(row.comparison_json);
    const probability = expected?.probability;
    const unexpected = probability !== null && probability !== undefined && comparison?.mismatch !== null && comparison?.mismatch !== undefined
      ? comparison.mismatch ? probability : 1 - probability : null;
    const sources = [...JSON.parse(row.sources_json) as TaskSource[], ...step.snapshot.sources];
    const evidence: FcaAffectEvidence = { ...appraisal, taskId: row.task_id, appraisalTaskId: step.taskId, observedAt: row.observed_at!,
      expectedValue: expected?.expectedValue ?? null, unexpected, sources: [...new Map(sources.map(source => [JSON.stringify(source), source])).values()] };
    if (!validFcaAffectEvidence(evidence)) throw new Error('FCA_APPRAISAL_INVALID');
    this.options.db.prepare(`INSERT OR IGNORE INTO fca_affect_outbox(scope_key,event_id,revision,step_id,task_id,evidence_json) VALUES(?,?,?,?,?,?)`)
      .run(step.scopeKey, appraisal.eventId, appraisal.revision, step.id, step.taskId, JSON.stringify(evidence));
  }
  private deliverOutcomes() {
    const rows = this.options.db.prepare(`SELECT e.* FROM fca_action_evidence e WHERE e.outcome_delivered=0 AND e.observation!='pending'
      AND EXISTS (SELECT 1 FROM fca_task_history h JOIN agent_tasks t ON t.task_id=h.task_id
      WHERE h.step_id=e.step_id AND h.task_id=e.task_id AND t.scope_key=e.scope_key) ORDER BY e.rowid`).all() as unknown as EvidenceRow[];
    for (const row of rows) {
      if (!this.rowVisible(row)) continue;
      const result = parse<{ ok: boolean; text: string }>(row.result_json);
      const lifecycle = row.name === 'fca.complete' || row.name === 'fca.wait';
      const actualTaskStatus = lifecycle && result ? String((JSON.parse(result.text) as { actualStatus: string }).actualStatus) : undefined;
      const routine = ['tool.open', 'task.list', 'task.get'].includes(row.name) || row.name === 'fca.wait' && !this.options.db.prepare(
        `SELECT 1 FROM fca_action_evidence e WHERE e.scope_key=? AND e.task_id=? AND e.observation='observed'
        AND e.name NOT IN ('tool.open','task.list','task.get','fca.wait','fca.complete') AND e.observed_at<=?
        AND e.rowid>COALESCE((SELECT MAX(p.rowid) FROM fca_action_evidence p WHERE p.scope_key=e.scope_key AND p.task_id=e.task_id
          AND p.name IN ('fca.wait','fca.complete') AND p.outcome_delivered=1),0) LIMIT 1`).get(row.scope_key, row.task_id, row.observed_at!);
      if (!routine) this.options.onOutcome!({ scopeKey: row.scope_key, taskId: row.task_id, stepId: row.step_id, outcomeId: row.event_id, goal: row.goal,
        action: JSON.parse(row.action_json) as FcaToolCall, expectation: parse<FcaActionExpectation>(row.expectation_json),
        comparison: parse<FcaExpectationComparison>(row.comparison_json), observation: row.observation as 'observed' | 'unknown',
        result, observedAt: row.observed_at!, sources: JSON.parse(row.sources_json) as TaskSource[], ...(actualTaskStatus ? { actualTaskStatus } : {}) });
      this.options.db.prepare('UPDATE fca_action_evidence SET outcome_delivered=1 WHERE scope_key=? AND event_id=?').run(row.scope_key, row.event_id);
    }
  }
  private settleLifecycle() {
    const rows = this.options.db.prepare(`SELECT e.*,h.committed_status,h.committed_at FROM fca_action_evidence e
      JOIN fca_task_history h ON h.step_id=e.step_id AND h.task_id=e.task_id JOIN agent_tasks t ON t.task_id=h.task_id AND t.scope_key=e.scope_key
      WHERE e.observation='pending' AND e.name IN ('fca.wait','fca.complete')`).all();
    for (const row of rows) {
      const action = JSON.parse(String(row.action_json)) as { input: { summary: string } };
      const result = { ok: true, text: JSON.stringify({ requestedDecision: String(row.name).slice(4), actualStatus: row.committed_status, summary: action.input.summary }) };
      this.options.db.prepare("UPDATE fca_action_evidence SET observation='observed',result_json=?,observed_at=? WHERE scope_key=? AND event_id=? AND observation='pending'")
        .run(JSON.stringify(result), String(row.committed_at), String(row.scope_key), String(row.event_id));
    }
  }
  private row(scope: string, eventId: string): EvidenceRow | null {
    return this.options.db.prepare('SELECT * FROM fca_action_evidence WHERE scope_key=? AND event_id=?').get(scope, eventId) as unknown as EvidenceRow ?? null;
  }
  private visible(step: TaskStep) { return this.options.sourcesVisible(step.scopeKey, step.taskId, step.snapshot.sources); }
  private rowVisible(row: EvidenceRow) { return this.options.sourcesVisible(row.scope_key, row.task_id, JSON.parse(row.sources_json) as TaskSource[]); }
  private transaction<T>(work: () => T): T {
    const db = this.options.db;
    if (db.isTransaction) return work();
    db.exec('BEGIN IMMEDIATE');
    try { const result = work(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
}
function parse<T>(json: string | null): T | null { return json === null ? null : JSON.parse(json) as T; }
function publicComparison(comparison: FcaExpectationComparison | null): FcaExpectationComparison | null {
  return comparison && typeof comparison.actual === 'string' ? { ...comparison, actual: comparison.actual.slice(0, 240) } : comparison;
}
