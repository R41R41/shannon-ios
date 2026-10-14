import type { ObserverDraft } from '../src/contracts/observerContract.js';
import { installObserverSink, withObserverRunSync } from '../src/infra/observer/observerContext.js';
import { afterEach, describe, expect, it } from 'vitest';
import { actionResource, leaseOf } from '../src/contracts/actionThreadContract.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import type { TaskStep } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import { SQLiteFcaEvidenceStore } from '../src/mind/action/fca/store/fcaEvidenceStore.js';
import type { FcaDurableOutcome } from '../src/mind/action/fca/fcaEvidencePorts.js';
import type { FcaModelOutput, FcaToolCall } from '../src/mind/action/fca/fcaPorts.js';
import { compareFcaOutcome, fcaExpectationProblem, validFcaExpectation, type FcaActionExpectation } from '../src/mind/prediction/predictionPorts.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { memoryWorld } from './support/memoryWorld.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const call: FcaToolCall = { id: 'lookup', name: 'web.search', input: { query: 'public facts' } };
const expectation: FcaActionExpectation = { callId: call.id, source: 'tool_result', observable: { kind: 'json_pointer', path: '/count' },
  expected: 2, probability: 0.8, expectedValue: 0.2, withinMs: 1000 };
const output = (withPrediction = true): FcaModelOutput => ({ decision: { kind: 'tools', calls: [call] }, history: [],
  ...(withPrediction ? { expectations: [expectation] } : {}) });
const observed = (count = 3) => ({ ok: true, retryable: false, text: JSON.stringify({ count }) });
function fixture() {
  const world = memoryWorld(); cleanup.push(world.close);
  const h = actionHarness(world.now, world.path); cleanup.push(h.close); migrateAgentTasks(h.db);
  let allowed = true, visible = true;
  const runtime = new SQLiteTaskRuntimeStore(h.db, { authority: new SQLiteFcaTaskAuthority(h.db), now: world.now,
    leaseValid: (_scope, _task, lease, at) => allowed && !!h.store.check(lease, at) });
  const root = runtime.ensureRoot('owner');
  const task = runtime.createChild('owner', root.id, { title: 'Research', goal: 'Compare the observed measurements' }, 'research');
  const deliveries: FcaDurableOutcome[] = [];
  const options = { db: h.db, state: world.store, now: world.now,
    validStep: (step: TaskStep) => allowed && !!h.store.check(step.lease, world.now())
      && h.db.prepare('SELECT step_id FROM fca_task_checkpoints WHERE task_id=?').get(step.taskId)?.step_id === step.id,
    sourcesVisible: (_scope: string, _id: string, _sources: readonly import('../src/mind/action/taskRuntime/taskRuntimePorts.js').TaskSource[]) => visible,
    taskVisible: () => visible, observeContext: (_step: TaskStep, _ids: readonly string[]) => visible,
    onOutcome: (outcome: FcaDurableOutcome) => { deliveries.push(outcome); } };
  let evidence = new SQLiteFcaEvidenceStore(options);
  async function begin(taskId = task.id, scope = 'owner') {
    const current = runtime.get(scope, taskId)!;
    const action = await h.actions.claim((await h.actions.enqueue({ scopeKey: scope, kind: 'agentTask', origin: 'owner_request',
      sourceId: `fca:${taskId}:${current.revision}`, resources: [actionResource(scope, `fca:${taskId}`)] })).id);
    expect(action).not.toBeNull(); const step = runtime.beginStep(scope, taskId, leaseOf(action!)); expect(step).not.toBeNull(); return step!;
  }
  async function commit(step: TaskStep, disposition: 'continue' | 'complete' | 'wait' = 'continue') {
    const saved = runtime.commitStep(step, { disposition, history: [{ role: 'assistant', content: 'public durable round' }] });
    expect(saved).not.toBeNull(); await h.actions.finish(step.lease, 'completed', 'fca_segment_committed');
    runtime.acknowledgeReceipt(step.scopeKey, step.id); return saved!;
  }
  const row = (step: TaskStep, id = call.id) => h.db.prepare('SELECT * FROM fca_action_evidence WHERE event_id=?').get(`${step.id}:${id}`)!;
  return { ...world, ...h, runtime, root, task, options, begin, commit, row, deliveries,
    get evidence() { return evidence; }, restart: () => { evidence = new SQLiteFcaEvidenceStore(options); return evidence; },
    allow: (value: boolean) => { allowed = value; }, visible: (value: boolean) => { visible = value; } };
}

describe('concrete optional FCA predictions', () => {
  it('compares the named fact rather than the transport flag and distinguishes missing evidence from mismatch', () => {
    expect(compareFcaOutcome(expectation, observed(2), false)).toEqual({ status: 'observed', actual: 2, mismatch: false });
    expect(compareFcaOutcome(expectation, observed(3), false)).toEqual({ status: 'mismatch', actual: 3, mismatch: true });
    for (const result of [null, { ok: false, text: '{"count":2}' }, { ok: true, text: 'not-json' }, { ok: true, text: '{}' }]) {
      expect(compareFcaOutcome(expectation, result, false)).toEqual({ status: 'pending', actual: null, mismatch: null });
      expect(compareFcaOutcome(expectation, result, true)).toEqual({ status: 'unobserved', actual: null, mismatch: null });
    }
    expect(validFcaExpectation({ ...expectation, observable: { kind: 'json_pointer', path: '/ok' } })).toBe(false);
    expect(validFcaExpectation({ ...expectation, observable: { kind: 'json_pointer', path: '/count', extra: 'hidden' } })).toBe(false);
    // One definition of validity, with the closed reason the decoder returns to the model (operator run 5, 2026-10-14).
    expect(fcaExpectationProblem(expectation)).toBeNull();
    expect(([
      [{ ...expectation, observable: { kind: 'text_contains', text: '到着' }, expected: '到着' }, 'text_contains_expected'],
      [{ ...expectation, observable: { kind: 'text_contains', text: '' }, expected: true }, 'text_contains_text'],
      [{ ...expectation, observable: { kind: 'json_pointer', path: 'count' } }, 'json_pointer_path'],
      [{ ...expectation, observable: { kind: 'json_pointer', path: '/success' } }, 'transport_success'],
      [{ ...expectation, observable: { kind: 'regex', path: '/count' } }, 'observable'],
      [{ ...expectation, source: 'model' }, 'source'], [{ ...expectation, callId: '' }, 'call_id'],
      [{ ...expectation, expected: 'x'.repeat(241) }, 'expected'], [{ ...expectation, probability: 1.5 }, 'probability'],
      [{ ...expectation, expectedValue: -2 }, 'expected_value'], [{ ...expectation, withinMs: 86_400_001 }, 'within_ms'], [[], 'not_object'],
    ] as const).map(([value]) => [fcaExpectationProblem(value), validFcaExpectation(value)]))
      .toEqual(['text_contains_expected', 'text_contains_text', 'json_pointer_path', 'transport_success', 'observable', 'source', 'call_id',
        'expected', 'probability', 'expected_value', 'within_ms', 'not_object'].map(reason => [reason, false]));
    expect(fcaExpectationProblem({ ...expectation, observable: { kind: 'text_contains', text: '到着' }, expected: true })).toBeNull();
    expect(compareFcaOutcome({ ...expectation, observable: { kind: 'json_pointer', path: '/a~1b/~0value' } },
      { ok: true, text: '{"a/b":{"~value":2}}' }, false).status).toBe('observed');
  });
  it('makes prediction optional, records it before dispatch, and does not fabricate a result after an unknown dispatch', async () => {
    const f = fixture(), step = await f.begin();
    expect(f.evidence.beforeActions(step, output())).toBe(true);
    expect(f.row(step)).toMatchObject({ observation: 'pending', result_json: null, expectation_json: JSON.stringify(expectation) });
    expect(() => f.evidence.beforeActions(step, { ...output(), decision: { kind: 'tools', calls: [{ ...call, input: { query: 'different' } }] } })).toThrow('FCA_EVIDENCE_CONFLICT');
    f.evidence.unknown(step, call); f.restart(); f.evidence.flush();
    expect(f.row(step)).toMatchObject({ observation: 'unknown', result_json: null });
    expect(JSON.parse(String(f.row(step).comparison_json))).toMatchObject({ status: 'pending', mismatch: null });
    f.advance(1001); f.evidence.flush();
    expect(JSON.parse(String(f.row(step).comparison_json))).toEqual({ status: 'unobserved', actual: null, mismatch: null });
    expect(f.deliveries).toEqual([]);
    const other = f.runtime.createChild('owner', f.root.id, { title: 'Optional', goal: 'No forecast needed' }, 'optional'), noPrediction = await f.begin(other.id);
    f.evidence.beforeActions(noPrediction, output(false)); f.evidence.observed(noPrediction, call, observed());
    expect(f.row(noPrediction)).toMatchObject({ expectation_json: null, comparison_json: null });
  });
  it('fences writes under the exact lease and prevents source revocation from exposing stored outcomes', async () => {
    const f = fixture(), step = await f.begin();
    expect(f.evidence.beforeActions({ ...step, lease: { ...step.lease, generation: step.lease.generation + 1 } }, output())).toBe(false);
    f.evidence.beforeActions(step, output()); f.evidence.observed(step, call, observed());
    expect(f.evidence.prepare(step).recentOutcomes).toHaveLength(1);
    f.visible(false); expect(() => f.evidence.prepare(step)).toThrow('FCA_EVIDENCE_HELD');
    expect(() => f.evidence.observed(step, call, observed())).toThrow('FCA_EVIDENCE_HELD');
    f.visible(true); f.allow(false); expect(f.evidence.beforeActions(step, output())).toBe(false);
    f.evidence.unknown(step, call); expect(f.row(step).observation).toBe('observed');
  });
});

describe('durable FCA observation and appraisal outboxes', () => {
  it('flushes all original appraisal rows while observing only the active scope and the actual task/step', async () => {
    const f = fixture();
    const foreignRoot = f.runtime.ensureRoot('foreign');
    const foreign = f.runtime.createChild('foreign', foreignRoot.id, { title: 'Foreign private task', goal: 'Foreign private goal' }, 'foreign');
    const pending = async (scope: string, taskId: string) => {
      const action = await f.begin(taskId, scope); f.evidence.beforeActions(action, output());
      f.evidence.observed(action, call, observed()); await f.commit(action);
      const appraisal = await f.begin(taskId, scope);
      f.evidence.beforeActions(appraisal, { decision: { kind: 'complete', summary: 'PRIVATE_FINAL' }, history: [],
        appraisals: [{ eventId: `${action.id}:${call.id}`, revision: 1, value: 0.7, cause: 'PRIVATE_CAUSE', target: 'PRIVATE_TARGET' }] });
      await f.commit(appraisal, 'complete'); return appraisal;
    };
    const ownerStep = await pending('owner', f.task.id), foreignStep = await pending('foreign', foreign.id);
    const events: ObserverDraft[] = [], restore = installObserverSink(event => events.push(event));
    try { withObserverRunSync({ scopeKey: 'owner', surface: 'fixture', taskId: 'unrelated-task', stepId: 'unrelated-step', actionId: 'unrelated-action' }, () => f.evidence.flush()); }
    finally { restore(); }
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM fca_affect_outbox WHERE done=1').get()?.n).toBe(2);
    const affect = events.filter(event => event.node === 'emotion');
    expect(affect).toHaveLength(2);
    expect(affect.every(event => event.taskId === f.task.id && event.stepId === ownerStep.id && event.actionId === undefined)).toBe(true);
    expect(JSON.stringify(events)).not.toContain(foreignStep.id);
    expect(JSON.stringify(events)).not.toContain(foreign.id);
    expect(JSON.stringify(events)).not.toContain('PRIVATE_');
  });
  it('delivers only canonically committed results, replays after restart, and never repeats an action', async () => {
    const f = fixture(), step = await f.begin();
    f.evidence.beforeActions(step, output()); f.evidence.observed(step, call, observed());
    f.evidence.flush(); expect(f.deliveries).toEqual([]);
    await f.commit(step); f.restart().flush();
    expect(f.deliveries).toHaveLength(1);
    expect(f.deliveries[0]).toMatchObject({ outcomeId: `${step.id}:${call.id}`, goal: f.task.goal, action: call,
      comparison: { status: 'mismatch', actual: 3, mismatch: true }, observation: 'observed', result: { ok: true, text: observed().text } });
    f.evidence.flush(); expect(f.deliveries).toHaveLength(1);
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM fca_action_evidence').get()?.count).toBe(1);
  });
  it('applies an appraisal only after its decision commits and retries a lost acknowledgement without another mood increment', async () => {
    const f = fixture(), actionStep = await f.begin(); f.evidence.beforeActions(actionStep, output());
    f.evidence.observed(actionStep, call, observed()); await f.commit(actionStep);
    const step = await f.begin(), eventId = `${actionStep.id}:${call.id}`, before = f.options.state.snapshot('owner');
    const final: FcaModelOutput = { decision: { kind: 'complete', summary: 'Measurements compared' }, history: [],
      appraisals: [{ eventId, revision: 1, value: 0.7, cause: 'Observed more measurements than expected', target: 'research' }] };
    f.evidence.beforeActions(step, final); f.evidence.flush(); expect(f.options.state.snapshot('owner')).toEqual(before);
    await f.commit(step, 'complete');
    f.db.exec("CREATE TRIGGER fail_affect_ack BEFORE UPDATE ON fca_affect_outbox BEGIN SELECT RAISE(ABORT,'ack crash'); END");
    expect(() => f.evidence.flush()).toThrow('ack crash'); const applied = f.options.state.snapshot('owner');
    expect(applied.emotion.valence).toBeGreaterThan(before.emotion.valence);
    f.db.exec('DROP TRIGGER fail_affect_ack'); f.restart().flush();
    expect(f.options.state.snapshot('owner')).toEqual(applied);
    expect(f.options.state.fcaAffectReceipts('owner')).toMatchObject([{ eventId, revision: 1, expectedValue: 0.2, unexpected: 0.8 }]);
  });
  it('deduplicates concurrent parent/child reports of one event and does not let an abandoned report block a committed one', async () => {
    const f = fixture(), childStep = await f.begin(); f.evidence.beforeActions(childStep, output());
    f.evidence.observed(childStep, call, observed()); await f.commit(childStep);
    f.runtime.send('owner', f.task.id, f.root.id, 'The child observed evidence', 'parent-wake');
    const childReport = await f.begin(), parentReport = await f.begin(f.root.id), eventId = `${childStep.id}:${call.id}`;
    const appraisal = { eventId, revision: 1, value: 0.5, cause: 'The child found evidence', target: 'research' };
    const report: FcaModelOutput = { decision: { kind: 'wait', summary: 'Observation received' }, history: [], appraisals: [appraisal] };
    const unsafe = new SQLiteFcaEvidenceStore({ ...f.options, observeContext: undefined });
    expect(() => unsafe.prepare(parentReport)).toThrow('FCA_CONTEXT_SOURCE_UNPINNED');
    expect(f.evidence.prepare(parentReport).recentOutcomes.some(item => item.eventId === eventId)).toBe(true);
    f.evidence.beforeActions(childReport, report); f.evidence.beforeActions(parentReport, report);
    await f.commit(parentReport, 'wait'); f.evidence.flush();
    expect(f.options.state.fcaAffectReceipts('owner')).toHaveLength(1); const applied = f.options.state.snapshot('owner');
    await f.commit(childReport, 'wait'); f.evidence.flush(); expect(f.options.state.snapshot('owner')).toEqual(applied);
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM fca_affect_outbox WHERE done=1').get()?.count).toBe(2);
  });
  it('rejects an appraisal for an unknown event without persisting a partial action registration', async () => {
    const f = fixture(), step = await f.begin();
    f.evidence.beforeActions(step, output()); f.evidence.unknown(step, call);
    expect(() => f.evidence.beforeActions(step, { decision: { kind: 'wait', summary: 'Uncertain' }, history: [],
      appraisals: [{ eventId: `${step.id}:${call.id}`, revision: 1, value: -1, cause: 'Cannot assert failure', target: 'research' }] })).toThrow('FCA_APPRAISAL_UNOBSERVED');
    expect(f.db.prepare("SELECT COUNT(*) AS count FROM fca_action_evidence WHERE call_id='lifecycle'").get()?.count).toBe(0);
  });
  it('does not poison a newly admitted step when a prior committed outbox acknowledgement fails', async () => {
    const f = fixture(), first = await f.begin(); f.evidence.beforeActions(first, output()); f.evidence.observed(first, call, observed()); await f.commit(first);
    f.db.exec("CREATE TRIGGER fail_outcome_ack BEFORE UPDATE OF outcome_delivered ON fca_action_evidence BEGIN SELECT RAISE(ABORT,'delivery ack crash'); END");
    const next = await f.begin(); expect(f.evidence.prepare(next).recentOutcomes).toHaveLength(1);
    expect(f.deliveries).toHaveLength(1); expect(f.row(first).outcome_delivered).toBe(0);
    f.db.exec('DROP TRIGGER fail_outcome_ack'); f.restart().flush();
    expect(f.deliveries).toHaveLength(2); expect(f.deliveries[0]!.outcomeId).toBe(f.deliveries[1]!.outcomeId);
    f.evidence.flush(); expect(f.deliveries).toHaveLength(2);
  });
  it('keeps appraisal-context sources and author lineage attached to a cause originating in another task', async () => {
    const f = fixture(), original = await f.begin(); f.evidence.beforeActions(original, output()); f.evidence.observed(original, call, observed()); await f.commit(original);
    const author = f.runtime.createChild('owner', f.root.id, { title: 'Interpretation', goal: 'Interpret the evidence privately' }, 'author');
    const reporting = await f.begin(author.id);
    expect(f.runtime.observeSources(reporting, { observationId: 'private-input', recalledMemoryIds: ['private-memory'] })).toBe(true);
    reporting.snapshot.sources = f.runtime.taskSources('owner', author.id, reporting.messageIds);
    const source = reporting.snapshot.sources[0]!;
    const eventId = `${original.id}:${call.id}`;
    f.evidence.beforeActions(reporting, { decision: { kind: 'complete', summary: 'Interpreted' }, history: [],
      appraisals: [{ eventId, revision: 1, value: 0.5, cause: 'Meaning derived from private author context', target: 'research' }] });
    await f.commit(reporting, 'complete'); f.evidence.flush();
    expect(f.options.state.fcaAffectReceipts('owner', [eventId])).toMatchObject([{ taskId: f.task.id, appraisalTaskId: author.id, sources: [source] }]);
    const observer = f.runtime.createChild('owner', f.root.id, { title: 'Observe', goal: 'Read shared affect' }, 'observer'), next = await f.begin(observer.id);
    let inherited: readonly string[] = [];
    f.options.observeContext = (step, ids) => {
      inherited = ids; if (!f.runtime.inheritTaskSources(step, ids)) return false;
      step.snapshot.sources = f.runtime.taskSources('owner', step.taskId, step.messageIds); return true;
    };
    expect(f.evidence.prepare(next).affect.causes).toHaveLength(1); expect(inherited).toEqual(expect.arrayContaining([author.id, f.task.id]));
    expect(next.snapshot.sources.some(item => item.recalledMemoryIds.includes('private-memory'))).toBe(true);
    // The source gate checks receipt provenance on every use, before it can enter downstream native history.
    f.options.sourcesVisible = (_scope, _task, sources) => !sources.some(item => item.recalledMemoryIds.includes('private-memory'));
    f.restart(); inherited = []; expect(() => f.evidence.prepare(next)).toThrow('FCA_EVIDENCE_HELD');
    const fresh = f.runtime.createChild('owner', f.task.id, { title: 'Fresh', goal: 'Read only current affect' }, 'fresh'), freshStep = await f.begin(fresh.id);
    expect(f.evidence.prepare(freshStep).affect.causes).toEqual([]); expect(inherited).toEqual([]);
  });
  it('delivers meaningful completion summaries with actual canonical status and suppresses rote waits and lookup outcomes', async () => {
    const f = fixture(), step = await f.begin();
    f.evidence.beforeActions(step, output()); f.evidence.observed(step, call, observed()); await f.commit(step); f.evidence.flush();
    const wait = await f.begin(); f.evidence.beforeActions(wait, { decision: { kind: 'wait', summary: 'Three measurements are available' }, history: [] });
    await f.commit(wait, 'wait'); f.evidence.flush();
    expect(f.deliveries.at(-1)).toMatchObject({ action: { name: 'fca.wait' }, actualTaskStatus: 'running' });
    f.runtime.send('owner', f.root.id, f.task.id, 'continue', 'wake');
    const routine = await f.begin(); f.evidence.beforeActions(routine, { decision: { kind: 'wait', summary: 'Still waiting' }, history: [] });
    await f.commit(routine, 'wait'); f.evidence.flush(); expect(f.deliveries).toHaveLength(2);
    f.runtime.send('owner', f.root.id, f.task.id, 'continue', 'wake-again');
    const final = await f.begin(); f.evidence.beforeActions(final, { decision: { kind: 'complete', summary: 'Main finding: three measurements disagree' }, history: [] });
    f.runtime.send('owner', f.root.id, f.task.id, 'new information during decision', 'late');
    await f.commit(final, 'complete'); f.restart().flush();
    expect(f.deliveries.at(-1)).toMatchObject({ action: { name: 'fca.complete' }, actualTaskStatus: 'queued' });
    expect(JSON.parse(f.deliveries.at(-1)!.result!.text)).toEqual({ requestedDecision: 'complete', actualStatus: 'queued', summary: 'Main finding: three measurements disagree' });
  });
});
