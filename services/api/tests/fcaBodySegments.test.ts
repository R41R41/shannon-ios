import { afterEach, describe, expect, it, vi } from 'vitest';
import { actionResource, leaseOf } from '../src/contracts/actionThreadContract.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import type { TaskSource, TaskStep } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import { SQLiteFcaEvidenceStore } from '../src/mind/action/fca/store/fcaEvidenceStore.js';
import type { FcaDurableOutcome } from '../src/mind/action/fca/fcaEvidencePorts.js';
import type { FcaToolCall } from '../src/mind/action/fca/fcaPorts.js';
import { fcaOutcomeEpisode } from '../src/mind/action/fca/fcaOutcomeEpisode.js';
import { createFcaSleepTaskEvidence } from '../src/wiring/fcaSleepTaskEvidence.js';
import { verifiedSegmentSources } from '../src/wiring/fcaSleepSegmentEvidence.js';
import { taskExperienceDraft, taskExperienceId, type TaskExperienceRecord } from '../src/mind/memory/taskMemoryPorts.js';
import { taskExperienceSummary } from '../src/mind/memory/taskExperience.js';
import { isProvenanceReference } from '../src/infra/sqlite/fcaProvenanceSets.js';
import { committedEvidenceHistorySources } from '../src/mind/action/fca/store/fcaEvidenceSegments.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { memoryWorld } from './support/memoryWorld.js';

/**
 * Owner decision of 2026-10-14 (form, P2(b)): a Minecraft body's actions are remembered as one episode per segment (a subgoal or
 * the task's boundary), 「木を切ってツルハシを作った」, not one memory candidate per `mc.move-to` or pickup. Minecraft run 7 proposed a
 * task experience for nearly every body action, each walking the task's whole provenance in the memory writer.
 */
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

const ok = (text = '{"done":true}') => ({ ok: true, retryable: false, text });
const failed = (text = '{"error":"path blocked"}') => ({ ok: false, retryable: false, text });
const memorySource = (id: string, ids: readonly string[]): TaskSource => ({ kind: 'memory', stepId: `memory:${id}`, experienceId: null, threadId: null,
  observedAt: '2026-10-07T03:00:00.000Z', recalledMemoryIds: ids });

function fixture(provenanceRefs = false, slowFlushMilliseconds?: number) {
  const world = memoryWorld(); cleanup.push(world.close);
  const h = actionHarness(world.now, world.path); cleanup.push(h.close); migrateAgentTasks(h.db);
  const runtime = new SQLiteTaskRuntimeStore(h.db, { authority: new SQLiteFcaTaskAuthority(h.db), now: world.now,
    leaseValid: (_scope, _task, lease, at) => !!h.store.check(lease, at), ...(provenanceRefs ? { provenanceRefs: true } : {}) });
  const root = runtime.ensureRoot('owner');
  const task = runtime.createChild('owner', root.id, { title: '木のツルハシ', goal: '木を切ってツルハシを作る' }, 'mc-segments');
  const deliveries: FcaDurableOutcome[] = [];
  let visible = true;
  const evidence = new SQLiteFcaEvidenceStore({ db: h.db, state: world.store, now: world.now,
    validStep: (step: TaskStep) => !!h.store.check(step.lease, world.now()), sourcesVisible: () => visible, taskVisible: () => true,
    observeContext: () => true, ...(provenanceRefs ? { provenanceRefs: true } : {}),
    ...(slowFlushMilliseconds === undefined ? {} : { slowFlushMilliseconds }), onOutcome: outcome => { deliveries.push(outcome); } });
  let sourceIndex = 0;
  /** One committed step of the task with these calls and results, under fresh provenance (one more memory row each step). */
  async function step(calls: Array<[string, ReturnType<typeof ok> | null]>, taskId = task.id, recalled?: readonly string[]) {
    const current = runtime.get('owner', taskId)!;
    const action = await h.actions.claim((await h.actions.enqueue({ scopeKey: 'owner', kind: 'agentTask', origin: 'owner_request',
      sourceId: `fca:${taskId}:${current.revision}`, resources: [actionResource('owner', `fca:${taskId}`)] })).id);
    const begun = runtime.beginStep('owner', taskId, leaseOf(action!))!;
    sourceIndex += 1;
    runtime.observeSources(begun, { observationId: `obs-${sourceIndex}`, recalledMemoryIds: recalled ?? [`memory-${sourceIndex}`, 'memory-shared'] });
    begun.snapshot.sources = runtime.taskSources('owner', taskId, begun.messageIds);
    const toolCalls: FcaToolCall[] = calls.map(([name], index) => ({ id: `c${index}`, name, input: {} }));
    expect(evidence.beforeActions(begun, { decision: { kind: 'tools', calls: toolCalls }, history: [] })).toBe(true);
    toolCalls.forEach((call, index) => {
      const result = calls[index]![1];
      if (result) evidence.observed(begun, call, result); else evidence.unknown(begun, call);
    });
    runtime.commitStep(begun, { disposition: 'continue', history: [{ role: 'assistant', content: 'round' }] });
    await h.actions.finish(begun.lease, 'completed', 'fca_segment_committed');
    runtime.acknowledgeReceipt('owner', begun.id);
    evidence.flush();
    return begun;
  }
  const held = () => Number((h.db.prepare('SELECT COUNT(*) AS n FROM fca_action_evidence WHERE outcome_delivered=2').get() as { n: number }).n);
  return { world, h, runtime, root, task, evidence, deliveries, step, held, setVisible: (value: boolean) => { visible = value; } };
}

// Every case runs with the rows storing their sources as copies and by reference (`SHANNON_FCA_PROVENANCE_REFS`).
describe.each([[false], [true]])('Minecraft body actions remembered per segment (owner decision 2026-10-14), by reference %s', byReference => {
  it('holds routine body actions and proposes one episode when a subgoal is verified, its provenance each id once', async () => {
    const f = fixture(byReference);
    // The first success of each action in this scope is notable: it is remembered (and closes its segment) at once.
    await f.step([['mc.dig-block-at', ok()], ['mc.move-to', ok()]]);
    expect(f.deliveries.map(item => item.segment?.actions.map(action => [action.name, action.notable ?? null]))).toEqual([
      [['mc.dig-block-at', 'first_time']], [['mc.move-to', 'first_time']]]);
    f.deliveries.length = 0;
    for (let round = 0; round < 4; round++) await f.step([['mc.dig-block-at', ok()], ['mc.move-to', ok()], ['mc.collect', ok()]]);
    // mc.collect's first success closed its segment (with the held dig and move before it); the rest are held.
    expect(f.deliveries).toHaveLength(1);
    expect(f.deliveries[0]!.segment!.actions.map(action => action.name)).toEqual(['mc.dig-block-at', 'mc.move-to', 'mc.collect']);
    f.deliveries.length = 0;
    expect(f.held()).toBe(9);
    await f.step([['goal.verify', ok('{"verified":true}')]]);
    expect(f.held()).toBe(0);
    expect(f.deliveries).toHaveLength(1);
    const episode = f.deliveries[0]!;
    expect(episode.action.name).toBe('goal.verify');
    expect(episode.segment).toMatchObject({ closedBy: 'goal.verify' });
    expect(episode.segment!.actions).toHaveLength(9);
    const record = fcaOutcomeEpisode(episode)!;
    expect(record.status).toBe('success');
    expect(record.action).toContain('mc.dig-block-at×3');
    expect(record.observedResult).toBe('{"verified":true}');
    expect(new Set(record.sourceIds).size).toBe(record.sourceIds.length);
    expect(record.sourceIds).toEqual(expect.arrayContaining(['memory-shared', 'memory-4', 'memory-5', 'memory-6']));
  });

  it('closes the segment at once on a failure, an unknown outcome, danger or a missed prediction: nothing safety-relevant waits', async () => {
    const f = fixture(byReference);
    await f.step([['mc.move-to', ok()]]);
    f.deliveries.length = 0;
    await f.step([['mc.move-to', ok()], ['mc.move-to', failed()]]);
    expect(f.deliveries.map(item => item.segment!.actions.map(action => action.notable ?? null))).toEqual([[null, 'failure']]);
    expect(fcaOutcomeEpisode(f.deliveries[0]!)!.status).toBe('failure');
    await f.step([['mc.move-to', ok()], ['mc.move-to', null]]);
    expect(f.deliveries.at(-1)!.segment!.actions.map(action => action.notable ?? null)).toEqual([null, 'unknown']);
    await f.step([['mc.move-to', ok('{"facts":{"danger":true,"health":6}}')]]);
    expect(f.deliveries.at(-1)!.segment!.actions.map(action => action.notable ?? null)).toEqual(['danger']);
    await f.step([['minecraft.reflex.action', ok('{"outcome":"completed"}')]]);
    expect(f.deliveries.at(-1)!.segment!.actions.map(action => action.notable ?? null)).toEqual(['danger']);
    expect(f.held()).toBe(0);
  });

  it('closes a segment when the task waits, replans, or is stopped without either', async () => {
    const f = fixture(byReference);
    await f.step([['mc.move-to', ok()]]);
    f.deliveries.length = 0;
    await f.step([['mc.move-to', ok()], ['mc.move-to', ok()]]);
    await f.step([['task.replan', ok('{"replanned":true}')]]);
    expect(f.deliveries.map(item => [item.action.name, item.segment?.actions.length])).toEqual([['task.replan', 2]]);
    await f.step([['mc.move-to', ok()]]);
    expect(f.held()).toBe(1);
    f.runtime.stop('owner', f.task.id, 'owner_stop');
    f.evidence.flush();
    expect(f.held()).toBe(0);
    const stopped = f.deliveries.at(-1)!;
    expect(stopped.segment!.closedBy).toMatch(/^task_/u);
    expect(stopped.outcomeId).toMatch(/:segment$/u);
    expect(fcaOutcomeEpisode(stopped)).not.toBeNull();
  });

  it('remembers other outcomes one by one, as before', async () => {
    const f = fixture(byReference);
    await f.step([['web.search', ok('{"hits":1}')], ['web.search', ok('{"hits":2}')]]);
    expect(f.deliveries.map(item => [item.action.name, item.segment ?? null])).toEqual([['web.search', null], ['web.search', null]]);
    expect(f.held()).toBe(0);
  });

  it('keeps held actions held while the owner is not alone when the task is cancelled, and remembers them once he is (review F1)', async () => {
    const f = fixture(byReference);
    await f.step([['mc.move-to', ok()]]);
    await f.step([['mc.move-to', ok()], ['mc.move-to', ok()]]);
    f.deliveries.length = 0;
    expect(f.held()).toBe(2);
    // The owner cancels the task while others are present: nothing can be shown, so nothing closes and nothing is lost.
    f.setVisible(false);
    f.runtime.stop('owner', f.task.id, 'owner_stop');
    f.evidence.flush();
    expect(f.deliveries).toEqual([]);
    expect(f.held()).toBe(2);
    f.setVisible(true);
    f.evidence.flush();
    expect(f.held()).toBe(0);
    expect(f.deliveries.map(item => [item.segment!.closedBy, item.segment!.actions.length])).toEqual([[expect.stringMatching(/^task_(paused|cancelled)$/u), 2]]);
  });

  it('closes a segment left open longer than the quiet time, of a task still running (review F4)', async () => {
    const f = fixture(byReference);
    await f.step([['mc.move-to', ok()]]);
    await f.step([['mc.move-to', ok()]]);
    f.deliveries.length = 0;
    f.world.advance(29 * 60_000);
    f.evidence.flush();
    expect(f.held()).toBe(1);
    f.world.advance(2 * 60_000);
    f.evidence.flush();
    expect(f.held()).toBe(0);
    expect(f.deliveries.map(item => item.segment!.closedBy)).toEqual(['segment_stale']);
  });

  it('lets the nightly learning use a segment episode matched to its rows, and refuses a forged or mismatched one (review F2)', async () => {
    const f = fixture(byReference);
    const turns = Array.from({ length: 4 }, (_, index) => f.world.store.appendTurn('owner', 'thread-mc', `木を集めて${index}`, `集めます${index}`, f.world.now()).id);
    f.world.advance(60_000);
    await f.step([['mc.dig-block-at', ok()], ['mc.move-to', ok()]], f.task.id, turns.slice(0, 2));
    f.deliveries.length = 0;
    await f.step([['mc.dig-block-at', ok()], ['mc.move-to', ok()]], f.task.id, turns.slice(1, 3));
    await f.step([['goal.verify', ok('{"verified":true}')]], f.task.id, [turns[3]!]);
    expect(f.deliveries).toHaveLength(1);
    const record = fcaOutcomeEpisode(f.deliveries[0]!)!;
    expect(record.segment).toEqual({ eventIds: f.deliveries[0]!.segment!.eventIds, closedBy: 'goal.verify' });
    // Through the memory outbox and its one writer, as production writes it (the segment survives the op's codec).
    f.world.ports.proposals.propose(taskExperienceDraft(record));
    await f.world.writer().drain();
    const id = taskExperienceId('owner', f.task.id, record.outcomeId);
    const stored = JSON.parse(String(f.h.db.prepare('SELECT payload_json FROM experience_events WHERE event_id=?').get(id)!.payload_json)) as { task: TaskExperienceRecord };
    expect(stored.task.segment).toEqual(record.segment);
    const evidence = createFcaSleepTaskEvidence(f.h.db);
    expect(evidence('owner', id)).toBe(true);
    const forged: Array<[string, TaskExperienceRecord]> = [
      ['an action left out', { ...record, segment: { ...record.segment!, eventIds: record.segment!.eventIds.slice(1) } }],
      ['actions reordered', { ...record, segment: { ...record.segment!, eventIds: [...record.segment!.eventIds].reverse() } }],
      ['another closing outcome named', { ...record, segment: { ...record.segment!, closedBy: 'task.replan' } }],
      ['a status not derived', { ...record, status: 'failure' }],
      ['an action of nothing', { ...record, segment: { ...record.segment!, eventIds: [...record.segment!.eventIds, 'step-x:call-y'] } }],
      ['another action line', { ...record, action: record.action.replace('×1', '×5') }],
    ];
    expect(record.action).toContain('×1');
    for (const [label, candidate] of forged) expect(verifiedSegmentSources(f.h.db, 'owner', candidate), label).toBeNull();
    // The stored episode replaced by a forged one, its summary consistent, is refused on the same path.
    const payload = JSON.parse(String(f.h.db.prepare('SELECT payload_json FROM experience_events WHERE event_id=?').get(id)!.payload_json)) as Record<string, unknown>;
    const fake = { ...stored.task, segment: { ...record.segment!, eventIds: record.segment!.eventIds.slice(1) } };
    f.h.db.prepare('UPDATE experience_events SET payload_json=? WHERE event_id=?').run(JSON.stringify({ ...payload, task: fake, summary: taskExperienceSummary(fake) }), id);
    expect(evidence('owner', id)).toBe(false);
  });

  it('stores the held segment\'s rows by reference and closes it with the same provenance as copies', async () => {
    const f = fixture(byReference);
    await f.step([['mc.dig-block-at', ok()], ['mc.move-to', ok()]]); // each action's first success is notable: delivered at once
    f.deliveries.length = 0;
    await f.step([['mc.dig-block-at', ok()], ['mc.move-to', ok()]]);
    expect(f.held()).toBe(2);
    const stored = f.h.db.prepare('SELECT sources_json FROM fca_action_evidence').all() as Array<{ sources_json: string }>;
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.every(row => isProvenanceReference(row.sources_json) === byReference)).toBe(true);
    await f.step([['goal.verify', ok('{"verified":true}')]]);
    expect(f.held()).toBe(0);
    expect(f.deliveries).toHaveLength(1);
    const record = fcaOutcomeEpisode(f.deliveries[0]!)!;
    expect(record.sourceIds).toEqual(expect.arrayContaining(['memory-shared', 'memory-2', 'memory-3']));
    expect(new Set(record.sourceIds).size).toBe(record.sourceIds.length);
    // The segment's committed history rows and the nightly proof's reader see the same list through either form.
    const history = f.h.db.prepare('SELECT step_id,sources_json FROM fca_task_history').all() as Array<{ step_id: string; sources_json: string }>;
    expect(history.every(row => isProvenanceReference(row.sources_json) === byReference)).toBe(true);
    const last = f.deliveries[0]!;
    const committed = committedEvidenceHistorySources(f.h.db, 'owner', last.outcomeId, f.task.id);
    expect(committed).toEqual(f.runtime.history('owner', f.task.id)!.rounds.at(-1)!.sources);
    expect(committed!.flatMap(source => source.recalledMemoryIds)).toEqual(expect.arrayContaining(['memory-shared', 'memory-3']));
  });
});

describe('the slow-flush line (Minebot run 12: where the API\'s event-loop blocks came from)', () => {
  const flushLines = (info: ReturnType<typeof vi.spyOn>) => info.mock.calls.map(args => String(args[0])).filter(line => line.startsWith('Shannon FCA evidence flush slow'));

  it('says nothing for a flush under the threshold, and reports the segments a slow one closed', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const quick = fixture();
      await quick.step([['mc.move-to', ok()]]);
      await quick.step([['mc.move-to', ok()]]);
      quick.world.advance(31 * 60_000);
      quick.evidence.flush();
      expect(quick.held()).toBe(0);
      expect(flushLines(info)).toEqual([]);
      // Threshold 0: every flush is slow enough to report; only the one that closes the stale segment says so.
      const slow = fixture(false, 0);
      await slow.step([['mc.move-to', ok()]]);
      await slow.step([['mc.move-to', ok()]]);
      info.mockClear();
      slow.evidence.flush();
      expect(flushLines(info)).toEqual([expect.stringMatching(/^Shannon FCA evidence flush slow ms=\d+ segmentsClosed=0$/u)]);
      info.mockClear();
      slow.world.advance(31 * 60_000);
      slow.evidence.flush();
      expect(slow.held()).toBe(0);
      expect(flushLines(info)).toEqual([expect.stringMatching(/^Shannon FCA evidence flush slow ms=\d+ segmentsClosed=1$/u)]);
    } finally { info.mockRestore(); }
  });
});
