import { afterEach, describe, expect, it } from 'vitest';
import { actionResource, leaseOf } from '../src/contracts/actionThreadContract.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import type { TaskSource, TaskStep } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import { SQLiteFcaEvidenceStore } from '../src/mind/action/fca/store/fcaEvidenceStore.js';
import type { FcaDurableOutcome } from '../src/mind/action/fca/fcaEvidencePorts.js';
import type { FcaToolCall } from '../src/mind/action/fca/fcaPorts.js';
import { fcaOutcomeEpisode } from '../src/mind/action/fca/fcaOutcomeEpisode.js';
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

function fixture() {
  const world = memoryWorld(); cleanup.push(world.close);
  const h = actionHarness(world.now, world.path); cleanup.push(h.close); migrateAgentTasks(h.db);
  const runtime = new SQLiteTaskRuntimeStore(h.db, { authority: new SQLiteFcaTaskAuthority(h.db), now: world.now,
    leaseValid: (_scope, _task, lease, at) => !!h.store.check(lease, at) });
  const root = runtime.ensureRoot('owner');
  const task = runtime.createChild('owner', root.id, { title: '木のツルハシ', goal: '木を切ってツルハシを作る' }, 'mc-segments');
  const deliveries: FcaDurableOutcome[] = [];
  const evidence = new SQLiteFcaEvidenceStore({ db: h.db, state: world.store, now: world.now,
    validStep: (step: TaskStep) => !!h.store.check(step.lease, world.now()), sourcesVisible: () => true, taskVisible: () => true,
    observeContext: () => true, onOutcome: outcome => { deliveries.push(outcome); } });
  let sourceIndex = 0;
  /** One committed step of the task with these calls and results, under fresh provenance (one more memory row each step). */
  async function step(calls: Array<[string, ReturnType<typeof ok> | null]>, taskId = task.id) {
    const current = runtime.get('owner', taskId)!;
    const action = await h.actions.claim((await h.actions.enqueue({ scopeKey: 'owner', kind: 'agentTask', origin: 'owner_request',
      sourceId: `fca:${taskId}:${current.revision}`, resources: [actionResource('owner', `fca:${taskId}`)] })).id);
    const begun = runtime.beginStep('owner', taskId, leaseOf(action!))!;
    sourceIndex += 1;
    runtime.observeSources(begun, { observationId: `obs-${sourceIndex}`, recalledMemoryIds: [`memory-${sourceIndex}`, 'memory-shared'] });
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
  return { world, h, runtime, root, task, evidence, deliveries, step, held };
}

describe('Minecraft body actions remembered per segment (owner decision 2026-10-14)', () => {
  it('holds routine body actions and proposes one episode when a subgoal is verified, its provenance each id once', async () => {
    const f = fixture();
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
    const f = fixture();
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
    const f = fixture();
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
    const f = fixture();
    await f.step([['web.search', ok('{"hits":1}')], ['web.search', ok('{"hits":2}')]]);
    expect(f.deliveries.map(item => [item.action.name, item.segment ?? null])).toEqual([['web.search', null], ['web.search', null]]);
    expect(f.held()).toBe(0);
  });
});
