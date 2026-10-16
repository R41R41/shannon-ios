import { observeSync, withScopedObserverTask } from '../../../../infra/observer/observerContext.js';
import type { DatabaseSync } from 'node:sqlite';
import { AffectCoordinator, validFcaAffectEvidence, type FcaAffectEvidence, type FcaAffectWriter } from '../../../emotion/emotionPorts.js';
import { compareFcaOutcome, validFcaExpectation, type FcaActionExpectation, type FcaExpectationComparison } from '../../../prediction/predictionPorts.js';
import type { TaskSource, TaskStep } from '../../taskRuntime/taskRuntimePorts.js';
import type { ToolResult } from '../../../tools/toolRegistryPorts.js';
import type { FcaModelOutput, FcaToolCall } from '../fcaPorts.js';
import type { FcaAffectAppraisal, FcaDurableOutcome, FcaEvidence, FcaOutcomeContext, FcaSharedContext } from '../fcaEvidencePorts.js';
import { durableOutcomeOf, FCA_SEGMENT_STALE_MINUTES, heldRows, heldSegmentsToClose, HELD_FOR_SEGMENT, segmentDisposition } from './fcaEvidenceSegments.js';
import { enableFcaProvenanceSets, readStoredSources, requireStoredSources, storedSourcesJson } from '../../../../infra/sqlite/fcaProvenanceSets.js';
import { FcaPrepareTrace, visibleEvidenceRows, type FcaEvidenceJudge, type FcaVisibleRows } from './fcaEvidenceRows.js';

export interface FcaEvidenceOptions {
  db: DatabaseSync; state: FcaAffectWriter; now(): string;
  /** Runs synchronously inside this connection's write transaction; must check exact step + original live lease. */
  validStep(step: TaskStep): boolean;
  sourcesVisible(scopeKey: string, taskId: string, sources: readonly TaskSource[]): boolean;
  /**
   * Whether `verified`, the task's sources `sourcesVisible` has just found visible, implies that `candidate` (an earlier step's sources
   * of the same task) is visible too, without a walk (`FcaSourceGuard.covers`). Absent: every row is walked.
   */
  sourcesCovered?(scopeKey: string, taskId: string, verified: readonly TaskSource[], candidate: readonly TaskSource[]): boolean;
  /** Minutes a segment of held body actions may stay open after its newest (`SHANNON_FCA_SEGMENT_STALE_MINUTES`, default 30). */
  segmentStaleMinutes?: number;
  /** A flush at least this slow (ms) is logged, content-free (default 500). */
  slowFlushMilliseconds?: number;
  /** What a walk of `candidate` still checks once `verified` was found visible (`FcaSourceGuard.residual`); null: walk it whole. */
  sourcesResidual?(scopeKey: string, taskId: string, verified: readonly TaskSource[], candidate: readonly TaskSource[]): readonly TaskSource[] | null;
  /** The source guard's walk counts (`FcaSourceGuard.walks`), for the prepare line only. */
  walkCounts?(): { walked: number; reused: number; partial?: number };
  taskVisible(scopeKey: string, taskId: string): boolean;
  /** Persist lineage for other tasks whose public outcomes/causes enter this task's native history. */
  observeContext?(step: TaskStep, taskIds: readonly string[]): boolean;
  /** Idempotent existing memory outbox admission. Receipt is retried after a crash, never the original action. */
  onOutcome?(outcome: FcaDurableOutcome): void;
  /**
   * `SHANNON_FCA_PROVENANCE_REFS`: a row stores its sources as a provenance set when it can (`fcaProvenanceSets.ts`), not a copy.
   * Rows by reference are read whatever this says, through the same checks as a copy.
   */
  provenanceRefs?: boolean;
}
interface EvidenceRow {
  /** The row's rowid, where a query selects it (`deliverOutcomes`). */
  seq: number;
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
    if (options.provenanceRefs) enableFcaProvenanceSets(options.db);
    this.affect = new AffectCoordinator(options.state, options.sourcesVisible);
  }
  /**
   * The shared context of one decision: the affect and the newest visible outcomes of this task and its visible children. Asynchronous
   * only between row walks (`visibleEvidenceRows`); the flush, the step's checks, the lineage write and the return keep their order.
   * When it yielded, everything it admitted is asked again at its end, synchronously with the lineage write and the return: the
   * lease, the step's verified sources (which covered rows rest on) and each walked source set; a row no longer visible is left out.
   */
  async prepare(step: TaskStep): Promise<FcaSharedContext> {
    const trace = new FcaPrepareTrace(this.options.walkCounts);
    let outcome = 'error';
    try {
      const context = await this.prepared(step, trace);
      outcome = 'ok';
      return context;
    } catch (error) {
      outcome = error instanceof Error && /^FCA_[A-Z_]+$/u.test(error.message) ? error.message : 'error';
      throw error;
    } finally { trace.report(outcome); }
  }
  private async prepared(step: TaskStep, trace: FcaPrepareTrace): Promise<FcaSharedContext> {
    // Receipt/delivery failures are retried by maintenance; they must never poison a fresh native step.
    trace.time('flush', () => { try { this.flush(); } catch { /* Both outboxes retain their original idempotency keys. */ } });
    if (!this.options.validStep(step) || !trace.time('precheck', () => trace.check(() => this.visible(step)))) throw new Error('FCA_EVIDENCE_HELD');
    // The sources just found visible; `observeContext` below may replace the step's list, never this one.
    const verified = step.snapshot.sources;
    const ids = [step.taskId, ...step.snapshot.task.childIds].filter(id => this.options.taskVisible(step.scopeKey, id));
    const rows = trace.time('select', () => this.options.db.prepare(`SELECT * FROM fca_action_evidence WHERE scope_key=? AND observation!='pending'
      AND task_id IN (SELECT value FROM json_each(?)) ORDER BY rowid DESC LIMIT 24`).all(step.scopeKey, JSON.stringify(ids)) as unknown as EvidenceRow[]);
    // walk includes the event loop's waits between walks (yieldWait); stillVisible is the re-check after a yield (0 without one).
    const walkStarted = performance.now();
    const chosen = await visibleEvidenceRows(rows, this.judge(step, verified), trace).finally(() => trace.add('walk', performance.now() - walkStarted));
    const visibleRows = trace.time('stillVisible', () => chosen.yielded ? this.stillVisible(step, verified, chosen, trace) : chosen.rows);
    const { affect, affectReceipts } = trace.time('affect', () => {
      const affect = this.affect.snapshot(step.scopeKey);
      const eventIds = [...visibleRows.map(row => row.event_id), ...affect.causes.map(cause => cause.eventId)];
      return { affect, affectReceipts: this.options.state.fcaAffectReceipts(step.scopeKey, eventIds) };
    });
    const receipts = new Map(affectReceipts.map(item => [item.eventId, item.revision]));
    const recentOutcomes: FcaOutcomeContext[] = visibleRows.map(row => outcomeContext(row, receipts.get(row.event_id) ?? 0));
    const consumed = [...new Set([...recentOutcomes.map(item => item.taskId), ...affectReceipts
      .filter(item => affect.causes.some(cause => cause.eventId === item.eventId)).flatMap(item => [item.taskId, ...item.appraisalTaskId ? [item.appraisalTaskId] : []])])].filter(id => id !== step.taskId);
    if (consumed.length && !trace.time('observe', () => this.options.observeContext?.(step, consumed))) throw new Error('FCA_CONTEXT_SOURCE_UNPINNED');
    if (!trace.time('finalCheck', () => trace.check(() => this.visible(step)))) throw new Error('FCA_EVIDENCE_HELD');
    return { affect, recentOutcomes };
  }
  /** How this prepare judges a stored row: the guard's walk, and for the step's own task its coverage by the verified sources. */
  private judge(step: TaskStep, verified: readonly TaskSource[]): FcaEvidenceJudge {
    const covered = this.options.sourcesCovered, residual = this.options.sourcesResidual;
    return { taskId: step.taskId, walk: (row, sources) => this.options.sourcesVisible(row.scope_key, row.task_id, sources),
      sources: row => readStoredSources(this.options.db, row.scope_key, row.sources_json),
      ...(covered ? { covered: (sources: readonly TaskSource[]) => covered(step.scopeKey, step.taskId, verified, sources) } : {}),
      ...(residual ? { residual: (sources: readonly TaskSource[]) => residual(step.scopeKey, step.taskId, verified, sources) } : {}) };
  }
  /** After a yield: the lease and the verified sources again (or the step is held), then each walked set (or its rows are left out). */
  private stillVisible(step: TaskStep, verified: readonly TaskSource[], chosen: FcaVisibleRows<EvidenceRow>, trace: FcaPrepareTrace): EvidenceRow[] {
    if (!this.options.validStep(step) || !trace.check(() => this.options.sourcesVisible(step.scopeKey, step.taskId, verified))) {
      throw new Error('FCA_EVIDENCE_HELD');
    }
    const gone = new Set<EvidenceRow>();
    // A child task's visibility is asked again too: what it holds now may have been withheld during the yield (review F3).
    const childVisible = new Map<string, boolean>();
    for (const row of chosen.rows) {
      if (row.task_id === step.taskId) continue;
      if (!childVisible.has(row.task_id)) childVisible.set(row.task_id, this.options.taskVisible(row.scope_key, row.task_id));
      if (!childVisible.get(row.task_id)) gone.add(row);
    }
    for (const set of chosen.walked) {
      const first = set.rows[0]!;
      if (!trace.rowCheck(() => this.options.sourcesVisible(first.scope_key, first.task_id, set.sources))) set.rows.forEach(row => gone.add(row));
    }
    return chosen.rows.filter(row => !gone.has(row));
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
          this.storedSources(step), this.options.now(), expectation ? new Date(Date.parse(this.options.now()) + expectation.withinMs).toISOString() : null,
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
  /** Content-free: logs a flush slower than slowFlushMilliseconds (default 500) with the segments it closed. */
  flush(): void {
    const at = performance.now();
    this.closedSegments = 0;
    try { this.flushed(); } finally {
      const spent = performance.now() - at;
      if (spent >= (this.options.slowFlushMilliseconds ?? SLOW_FLUSH_MILLISECONDS)) {
        console.info(`Shannon FCA evidence flush slow ms=${Math.round(spent)} segmentsClosed=${this.closedSegments}`);
      }
    }
  }
  private closedSegments = 0;
  private flushed(): void {
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
          this.storedSources(step), this.options.now(), step.scopeKey, row.event_id);
    });
  }
  private queueAppraisal(step: TaskStep, appraisal: FcaAffectAppraisal) {
    const row = this.row(step.scopeKey, appraisal.eventId);
    if (!row || row.observation !== 'observed' || !this.options.taskVisible(step.scopeKey, row.task_id) || !this.rowVisible(row)) throw new Error('FCA_APPRAISAL_UNOBSERVED');
    const expected = parse<FcaActionExpectation>(row.expectation_json), comparison = parse<FcaExpectationComparison>(row.comparison_json);
    const probability = expected?.probability;
    const unexpected = probability !== null && probability !== undefined && comparison?.mismatch !== null && comparison?.mismatch !== undefined
      ? comparison.mismatch ? probability : 1 - probability : null;
    const sources = [...requireStoredSources(this.options.db, row.scope_key, row.sources_json), ...step.snapshot.sources];
    const evidence: FcaAffectEvidence = { ...appraisal, taskId: row.task_id, appraisalTaskId: step.taskId, observedAt: row.observed_at!,
      expectedValue: expected?.expectedValue ?? null, unexpected, sources: [...new Map(sources.map(source => [JSON.stringify(source), source])).values()] };
    if (!validFcaAffectEvidence(evidence)) throw new Error('FCA_APPRAISAL_INVALID');
    this.options.db.prepare(`INSERT OR IGNORE INTO fca_affect_outbox(scope_key,event_id,revision,step_id,task_id,evidence_json) VALUES(?,?,?,?,?,?)`)
      .run(step.scopeKey, appraisal.eventId, appraisal.revision, step.id, step.taskId, JSON.stringify(evidence));
  }
  private deliverOutcomes() {
    const rows = this.options.db.prepare(`SELECT e.rowid AS seq,e.* FROM fca_action_evidence e WHERE e.outcome_delivered=0 AND e.observation!='pending'
      AND EXISTS (SELECT 1 FROM fca_task_history h JOIN agent_tasks t ON t.task_id=h.task_id
      WHERE h.step_id=e.step_id AND h.task_id=e.task_id AND t.scope_key=e.scope_key) ORDER BY e.rowid`).all() as unknown as EvidenceRow[];
    for (const row of rows) {
      if (!this.rowVisible(row)) continue;
      // A routine body action waits for its segment's episode (owner decision 2026-10-14, `fcaEvidenceSegments.ts`).
      const disposition = segmentDisposition(this.options.db, row);
      if (disposition === 'hold') {
        this.markDelivered([row], HELD_FOR_SEGMENT);
        continue;
      }
      const held = disposition === 'close' ? this.visibleHeld(heldRows<EvidenceRow>(this.options.db, row.scope_key, row.task_id, row.seq), row) : [];
      // A held action that cannot be shown now keeps its segment open: the closing outcome stays undelivered and is asked again.
      if (!held) continue;
      const outcome = durableOutcomeOf(this.options.db, row, held);
      if (outcome.segment || !this.routineOutcome(row)) this.options.onOutcome!(outcome);
      this.markDelivered([...held, row], 1);
    }
    this.closeEndedSegments();
  }
  /** A lookup, or a wait with nothing observed since the last delivered wait or completion: not an episode of its own. */
  private routineOutcome(row: EvidenceRow): boolean {
    return ['tool.open', 'task.list', 'task.get'].includes(row.name) || row.name === 'fca.wait' && !this.options.db.prepare(
      `SELECT 1 FROM fca_action_evidence e WHERE e.scope_key=? AND e.task_id=? AND e.observation='observed'
      AND e.name NOT IN ('tool.open','task.list','task.get','fca.wait','fca.complete') AND e.observed_at<=?
      AND e.rowid>COALESCE((SELECT MAX(p.rowid) FROM fca_action_evidence p WHERE p.scope_key=e.scope_key AND p.task_id=e.task_id
        AND p.name IN ('fca.wait','fca.complete') AND p.outcome_delivered=1),0) LIMIT 1`).get(row.scope_key, row.task_id, row.observed_at!);
  }
  /**
   * The held rows, when every one is visible now (each stored source set judged once, covered by `anchor`'s just-verified sources
   * where it can be, as in `prepare`); null when any is not, and every row stays held for the next flush (owner not alone: review of
   * 5d492ae8, F1). Nothing held is marked remembered unseen.
   */
  private visibleHeld(rows: readonly EvidenceRow[], anchor: EvidenceRow | null): EvidenceRow[] | null {
    const verdicts = new Map<string, boolean>(), anchorSources = anchor ? this.sourcesOf(anchor) : null;
    const visible = rows.filter(row => {
      const key = `${row.task_id}\u0000${row.sources_json}`;
      if (!verdicts.has(key)) {
        const sources = this.sourcesOf(row);
        const covered = sources && anchorSources && anchor!.task_id === row.task_id
          && this.options.sourcesCovered?.(row.scope_key, row.task_id, anchorSources, sources) === true;
        verdicts.set(key, Boolean(sources) && (covered || this.options.sourcesVisible(row.scope_key, row.task_id, sources!)));
      }
      return verdicts.get(key)!;
    });
    return visible.length === rows.length ? visible : null;
  }
  /** A task paused, stopped, failed or completed, or quiet too long, with body actions still held: their segment closes. */
  private closeEndedSegments() {
    const staleBefore = new Date(Date.parse(this.options.now()) - (this.options.segmentStaleMinutes ?? FCA_SEGMENT_STALE_MINUTES) * 60_000).toISOString();
    for (const ended of heldSegmentsToClose(this.options.db, staleBefore)) {
      const held = this.visibleHeld(heldRows<EvidenceRow>(this.options.db, ended.scopeKey, ended.taskId), null), last = held?.at(-1);
      if (!held || !last) continue;
      this.options.onOutcome!(durableOutcomeOf(this.options.db, last, held.slice(0, -1), { closedBy: ended.closedBy, outcomeId: `${last.event_id}:segment` }));
      this.markDelivered(held, 1);
      this.closedSegments += 1;
    }
  }
  private markDelivered(rows: readonly EvidenceRow[], value: number) {
    for (const row of rows) {
      this.options.db.prepare('UPDATE fca_action_evidence SET outcome_delivered=? WHERE scope_key=? AND event_id=?').run(value, row.scope_key, row.event_id);
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
  private rowVisible(row: EvidenceRow) {
    const sources = this.sourcesOf(row);
    return sources !== null && this.options.sourcesVisible(row.scope_key, row.task_id, sources);
  }
  /** A row's stored sources, its copy or its provenance set read now; null (not visible) when a reference cannot be resolved. */
  private sourcesOf(row: EvidenceRow) { return readStoredSources(this.options.db, row.scope_key, row.sources_json); }
  /** What a row stores of the step's sources: a reference when the switch is on and the list can be read back exactly, else a copy. */
  private storedSources(step: TaskStep) {
    return storedSourcesJson(this.options.db, step.scopeKey, step.snapshot.sources, this.options.provenanceRefs === true);
  }
  private transaction<T>(work: () => T): T {
    const db = this.options.db;
    if (db.isTransaction) return work();
    db.exec('BEGIN IMMEDIATE');
    try { const result = work(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
}
const SLOW_FLUSH_MILLISECONDS = 500;
function outcomeContext(row: EvidenceRow, appraisalRevision: number): FcaOutcomeContext {
  const result = parse<{ ok: boolean; text: string }>(row.result_json);
  return { eventId: row.event_id, taskId: row.task_id, operationId: row.event_id, name: row.name,
    observation: row.observation as 'observed' | 'unknown', result: result ? { ok: result.ok, text: result.text.slice(0, 1_500) } : null,
    expectation: parse<FcaActionExpectation>(row.expectation_json), comparison: publicComparison(parse<FcaExpectationComparison>(row.comparison_json)),
    appraisalRevision };
}
function parse<T>(json: string | null): T | null { return json === null ? null : JSON.parse(json) as T; }
function publicComparison(comparison: FcaExpectationComparison | null): FcaExpectationComparison | null {
  return comparison && typeof comparison.actual === 'string' ? { ...comparison, actual: comparison.actual.slice(0, 240) } : comparison;
}
