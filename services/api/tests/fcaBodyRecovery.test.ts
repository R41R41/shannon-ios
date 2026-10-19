import { afterEach, describe, expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import type { ActionLease } from '../src/contracts/actionThreadContract.js';
import type { MinecraftControlCommand, MinecraftControlReceipt } from '../src/contracts/minecraftControlContract.js';
import {
  AWAITING_PROOF_SUMMARY, BODY_ABSENT_SUMMARY, BODY_HELD_HINT, FCA_BODY_RECOVERY_CODE, FCA_BODY_RELEASE_ATTEMPTS, FCA_BODY_RELEASE_UNPROVEN,
  FCA_PAUSED_RELEASE_ATTEMPTS, heldBackoffMs, RECOVERY_LIMIT_SUMMARY, RELEASE_UNPROVEN_SUMMARY, releaseBackoffMs, STALE_SUMMARY,
} from '../src/wiring/fcaBodyRecovery.js';
import { fcaBudget } from '../src/wiring/fcaBudgetWiring.js';
import { TaskBudgetStore } from '../src/mind/action/taskRuntime/store/taskBudgetStore.js';
import { TaskBodyRecoveryStore } from '../src/mind/action/taskRuntime/store/taskBodyRecoveryStore.js';
import { MinecraftControlStore } from '../src/surfaces/minecraft/store/minecraftControlStore.js';
import { ActionLeaseReader } from '../src/mind/action/threads/store/actionLeaseReader.js';
import { bodyOperations, operationUnresolved, reconcileOperations } from '../src/surfaces/minecraft/store/minecraftOperationReconcile.js';
import { minecraftWorld } from './support/fcaBodyRecoveryWorld.js';

/**
 * Minebot parity audit C-21 and C-20 (2026-10-19): an API restart, a Spot VM stop or a lost body operation closed a Minecraft
 * request as `outcome_unknown_closed`. It now waits for its body, has the body prove its inputs released (or sees that the step sent
 * nothing), closes the lost step and goes on from a fresh observation, and never sends a body operation twice.
 */
const worlds: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const world of worlds.splice(0).reverse()) await world.close(); });
const MINUTE = 60_000;
function world(options: Parameters<typeof minecraftWorld>[0] = {}) {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const w = minecraftWorld(options);
  worlds.push(w);
  return w;
}
type World = ReturnType<typeof world>;
const skillCommands = <T extends { kind: string }>(body: { commands: T[] }) => body.commands.filter(command => command.kind === 'skill');
interface RecoveryNotice { kind?: string; lostOperations?: unknown[]; instruction?: string; gapSeconds?: number;
  existingChildren?: Array<{ id: string; title: string; status: string }>; sentNotes?: Array<{ to: string; id: string; preview: string }> }
const noticeOf = (input: { messages: ReadonlyArray<{ text: string }> } | undefined) => input?.messages
  .flatMap(message => { try { return [JSON.parse(message.text) as RecoveryNotice]; } catch { return []; } }) // other messages are plain text
  .find(value => value.kind === 'body.recovery');
const releaseCommands = (body: { commands: Array<{ kind: string }> }) => body.commands.filter(command => command.kind === 'release');
const taskActions = (w: World, taskId: string) => w.db.prepare("SELECT state,result FROM mind_actions WHERE kind='agentTask' AND source_id LIKE ? ORDER BY created_at")
  .all(`fca:${taskId}:%`) as Array<{ state: string; result: string | null }>;
async function ticks(w: World, api: ReturnType<World['startApi']>, count: number) {
  for (let i = 0; i < count; i++) {
    await api.driver.tick();
    await delay(2);
  }
  void w;
}
/** A request whose first step sent the body one skill, which it holds without ever answering, when the API dies; and the API started again. */
async function strandedSkill(w: World) {
  const first = w.startApi();
  const task = w.createTask(first);
  const body = w.connectBody(first, 'c1', 'hold');
  w.script.push(() => w.moves());
  await w.until(first, () => skillCommands(body).length === 1, 'the skill is sent to the body');
  await w.crash(first, body);
  return { task, skill: skillCommands(body)[0]!, api: w.startApi() };
}

describe('a restart while the model was deciding (no body operation was sent)', () => {
  it('waits for the body without being retired, then goes on from a fresh observation with a notice, deciding once more', async () => {
    const w = world();
    const first = w.startApi();
    const task = w.createTask(first);
    const body = w.connectBody(first, 'c1', 'complete');
    w.script.push(w.hangs);
    await w.until(first, () => w.modelInputs.length === 1, 'the first decision is asked');
    await w.crash(first, body);

    // The API starts again; the body has not come back. The step's outcome is lost, but it is waited for, not retired.
    const api = w.startApi();
    await w.until(api, () => w.phase(api) === 'unknown', 'the lost step is unknown');
    w.advance(11 * MINUTE); // past both unknown exits (3 and 10 minutes)
    await ticks(w, api, 15);
    expect(w.phase(api)).toBe('unknown');
    expect(w.events()).not.toContain('fca_unknown_retired');
    expect(w.inputsOf(task.id)).toHaveLength(1);

    // The body connects again under a connection of its own: the lost step is closed and the task goes on.
    const again = w.connectBody(api, 'c2', 'complete');
    await w.until(api, () => w.phase(api) === 'completed', 'the task goes on and completes');
    expect(w.inputsOf(task.id)).toHaveLength(2); // the lost decision and one new one
    const notice = noticeOf(w.inputsOf(task.id)[1]);
    expect(notice).toMatchObject({ kind: 'body.recovery', lostOperations: [], existingChildren: [], sentNotes: [] });
    expect(notice?.instruction).toContain('none of them was sent again');
    // The note says how long ago the step was lost (M-3): the eleven minutes the body was away, not "just now".
    expect(notice?.gapSeconds).toBeGreaterThanOrEqual(11 * 60);
    expect(notice?.gapSeconds).toBeLessThan(12 * 60);
    expect(skillCommands(again)).toEqual([]);
    // Nothing is kept for a step that was closed and a task that goes on (L-8).
    await ticks(w, api, 3);
    expect(api.recovery.retained()).toEqual({ releasing: 0, told: 0, awaiting: 0, exhausted: 0 });
    expect(w.events()).toContain('fca_body_recovered');
    expect(w.events()).not.toContain('fca_unknown_retired');
    expect(taskActions(w, task.id)[0]).toMatchObject({ state: 'failed', result: FCA_BODY_RECOVERY_CODE });
    expect(w.logs.some(line => line.includes(`task=${task.id} code=resumed`))).toBe(true);
    expect(w.logs.some(line => line.includes('code=waiting for=body'))).toBe(true);
    expect(w.logs.join('\n')).not.toContain('goal'); // content-free
  });

  it('goes on after a lost model answer that nobody can classify (unknown at once), instead of being retired as unknown_retired', async () => {
    const w = world();
    const api = w.startApi();
    const task = w.createTask(api);
    w.connectBody(api, 'c1', 'complete');
    w.script.push(() => { throw new Error('FCA_MODEL_RESPONSE_UNKNOWN'); });
    await w.until(api, () => w.phase(api) === 'completed', 'the task goes on and completes');
    expect(w.inputsOf(task.id)).toHaveLength(2); // the lost decision, and one new decision from a fresh observation
    expect(w.events()).toEqual(expect.arrayContaining(['fca_recovery_unknown', 'fca_body_recovered']));
    expect(w.events()).not.toContain('fca_unknown_retired');
    expect(noticeOf(w.inputsOf(task.id)[1])).toMatchObject({ kind: 'body.recovery', lostOperations: [] });
  });

  it('is ready to run only when its fresh step is admitted like any other: a task at its cap meets the cap, no decision is asked', async () => {
    let spend!: TaskBudgetStore;
    const w = world({ budget: ({ db, actions, now }) => {
      spend = new TaskBudgetStore(db);
      return fcaBudget({ actions, store: spend, now, minecraftRequest: () => true, taskCapYen: () => 1 });
    } });
    const first = w.startApi();
    const task = w.createTask(first);
    const body = w.connectBody(first, 'c1', 'complete');
    w.script.push(w.hangs);
    await w.until(first, () => w.modelInputs.length === 1, 'the first decision is asked');
    await w.crash(first, body);
    spend.add(task.id, 'owner', 'owner_request', 5, w.now()); // the first step spent more than the one yen the operator left
    const api = w.startApi();
    w.connectBody(api, 'c2', 'complete');
    await w.until(api, () => w.phase(api) === 'failed', 'the cap stops it');
    expect(w.inputsOf(task.id)).toHaveLength(1);
    expect(api.driver.runtime.get('owner', task.id)?.summary).toContain('上限');
    expect(w.events()).toContain('fca_body_recovered');
  });

  it('respects an owner\'s stop: a stopped unknown request is not taken back, and leaves at its exit as before', async () => {
    const w = world();
    const first = w.startApi();
    const task = w.createTask(first);
    const body = w.connectBody(first, 'c1', 'complete');
    w.script.push(w.hangs);
    await w.until(first, () => w.modelInputs.length === 1, 'the first decision is asked');
    await w.crash(first, body);
    const api = w.startApi();
    await w.until(api, () => w.phase(api) === 'unknown', 'the lost step is unknown');
    await api.driver.stop(task.id, 'owner_stop');
    w.connectBody(api, 'c2', 'complete');
    await ticks(w, api, 15);
    expect(w.phase(api)).toBe('unknown');
    expect(w.inputsOf(task.id)).toHaveLength(1);
    expect(w.events()).not.toContain('fca_body_recovered');
    w.advance(4 * MINUTE); // the work task's exit is three minutes
    await w.until(api, () => w.phase(api) === 'failed', 'retired at its exit');
    expect(w.inputsOf(task.id)).toHaveLength(1);
  });

  it('pauses a request that was interrupted again and again, instead of taking it back without end', async () => {
    const w = world({ limit: { count: 2, withinMs: 60 * MINUTE } });
    let api = w.startApi();
    const task = w.createTask(api);
    let body = w.connectBody(api, 'c1', 'complete');
    for (let round = 1; round <= 3; round++) {
      w.script.push(w.hangs);
      await w.until(api, () => w.modelInputs.length === round, `decision ${round} is asked`);
      await w.crash(api, body);
      api = w.startApi();
      body = w.connectBody(api, `c${round + 1}`, 'complete');
      if (round < 3) await w.until(api, () => w.events().filter(event => event === 'fca_body_recovered').length === round, `recovery ${round}`);
    }
    await w.until(api, () => w.phase(api) === 'stopped', 'paused at the limit');
    expect(api.driver.runtime.get('owner', task.id)).toMatchObject({ status: 'paused', summary: RECOVERY_LIMIT_SUMMARY });
    expect(w.inputsOf(task.id)).toHaveLength(3);
    expect(w.events().filter(event => event === 'fca_body_recovered')).toHaveLength(2);
    expect(w.events()).not.toContain('fca_unknown_retired');
  });
});

describe('a restart while a body skill was running (its outcome is unknown)', () => {
  it('has the body prove its release, closes the lost operation as not answered, never sends it again, and goes on', async () => {
    const w = world();
    const { api, task, skill } = await strandedSkill(w);
    await w.until(api, () => w.phase(api) === 'unknown', 'the lost step is unknown');
    const body = w.connectBody(api, 'c2', 'drop-on-release');
    await w.until(api, () => w.phase(api) === 'completed', 'the task goes on after the release');
    // The body was asked to release (the re-check's own command), and the lost skill was never sent to it.
    expect(body.commands.find(command => command.kind === 'release')?.id).toMatch(/^recheck:/u);
    expect(skillCommands(body)).toEqual([]);
    expect(w.skillRows().map(row => row.id)).toEqual([skill.id]);
    expect(JSON.parse(w.skillRows()[0]!.receipt_json!)).toMatchObject({ outcome: 'cancelled', inputsReleased: true, reconciled: 'release_proof' });
    expect(taskActions(w, task.id)[0]).toMatchObject({ state: 'failed', result: FCA_BODY_RECOVERY_CODE });
    expect(api.control.store.safe(task.id)).toBe(true);
    // The next decision was told what may or may not have happened, by the name of the skill and nothing of its arguments.
    expect(noticeOf(w.inputsOf(task.id).at(-1))?.lostOperations).toEqual([{ tool: 'mc.move', outcome: 'no_receipt' }]);
    expect(w.inputsOf(task.id)).toHaveLength(2);
    expect(w.logs.some(line => line.includes('code=reconciled') && line.includes('unresolved=1'))).toBe(true);
  });

  it('does not close the lost operation while the body has not proven its release, and keeps waiting without failing the task', async () => {
    const w = world();
    const { api, task } = await strandedSkill(w);
    await w.until(api, () => w.phase(api) === 'unknown', 'the lost step is unknown');
    w.advance(11 * MINUTE);
    await ticks(w, api, 20);
    expect(w.phase(api)).toBe('unknown');
    expect(w.skillRows()[0]!.receipt_json).toBeNull(); // still unanswered
    expect(w.inputsOf(task.id)).toHaveLength(1);
  });

  it('asks the body again after a release it could not confirm, no sooner than ten seconds, and never goes on until it has', async () => {
    const w = world();
    const { api, task } = await strandedSkill(w);
    await w.until(api, () => w.phase(api) === 'unknown', 'the lost step is unknown');
    const body = w.connectBody(api, 'c2', 'unknown-release');
    await w.until(api, () => body.commands.filter(command => command.kind === 'release').length === 1, 'the first release is asked');
    await ticks(w, api, 30);
    expect(body.commands.filter(command => command.kind === 'release')).toHaveLength(1); // the cooldown
    expect(w.phase(api)).toBe('unknown');
    expect(w.inputsOf(task.id)).toHaveLength(1);
    body.behaviour = 'drop-on-release';
    w.advance(11_000);
    await w.until(api, () => w.phase(api) === 'completed', 'goes on after a release the body confirms');
    expect(body.commands.filter(command => command.kind === 'release')).toHaveLength(2);
    expect(w.inputsOf(task.id)).toHaveLength(2);
  });

  it('closes an operation whose result stayed unknown in a live step: the body answers its release itself, and nothing is closed by the API', async () => {
    const w = world();
    const api = w.startApi();
    const task = w.createTask(api);
    const body = w.connectBody(api, 'c1', 'ignore-cancel-answer-release');
    w.script.push(() => w.moves());
    await w.until(api, () => skillCommands(body).length === 1, 'the skill is sent to the body');
    await w.elapse(1_200); // the skill's time (a second) runs out; the body ignores the cancel, so its outcome stays unknown
    await w.until(api, () => w.phase(api) === 'completed', 'the request goes on once the body released');
    expect(skillCommands(body)).toHaveLength(1);
    expect(body.commands.map(command => command.kind)).toContain('release');
    const receipt = JSON.parse(w.skillRows()[0]!.receipt_json!) as { outcome: string; reconciled?: string };
    expect(receipt.outcome).toBe('cancelled');
    expect(receipt.reconciled).toBeUndefined(); // the body's own answer
    expect(api.control.store.safe(task.id)).toBe(true);
    expect(noticeOf(w.inputsOf(task.id).at(-1))?.lostOperations).toEqual([{ tool: 'mc.move', outcome: 'cancelled' }]);
    expect(w.inputsOf(task.id)).toHaveLength(2);
    expect(w.logs.join('\n')).toContain('code=reconciled');
  });
});

describe('the body does not come back in time', () => {
  it('pauses the request as stopped (not failed) with a summary, waits for the release when the owner resumes it early, and goes on when the body is back', async () => {
    const w = world();
    const { api, task } = await strandedSkill(w);
    await w.until(api, () => w.phase(api) === 'unknown', 'the lost step is unknown');
    w.advance(31 * MINUTE);
    await w.until(api, () => w.phase(api) === 'stopped', 'paused after the window');
    // The lost step still holds the body, and the summary says so (M-C).
    expect(api.driver.runtime.get('owner', task.id)).toMatchObject({ status: 'paused', pauseReason: 'fca_stopped', summary: `${BODY_ABSENT_SUMMARY}${BODY_HELD_HINT}` });
    expect(w.events()).toContain('fca_body_paused');
    expect(w.events()).not.toContain('fca_unknown_retired');
    // The owner resumes it before the body is back: it waits (the lost operation is not proven released), no decision is asked.
    expect(api.driver.runtime.resume('owner', task.id)).not.toBeNull();
    await ticks(w, api, 15);
    expect(w.inputsOf(task.id)).toHaveLength(1);
    // The owner sees why it does not start (L-7), once, not only a log line.
    expect(api.driver.runtime.get('owner', task.id)?.summary).toBe(AWAITING_PROOF_SUMMARY);
    expect(w.events().filter(event => event === 'fca_note')).toHaveLength(1);
    expect(api.recovery.retained().awaiting).toBe(1);
    // The body returns: its release is proven, the lost operation closed, the request goes on.
    w.connectBody(api, 'c2', 'drop-on-release');
    await w.until(api, () => w.phase(api) === 'completed', 'goes on once the body is back');
    expect(w.inputsOf(task.id)).toHaveLength(2);
    expect(noticeOf(w.inputsOf(task.id)[1])?.lostOperations).toEqual([{ tool: 'mc.move', outcome: 'no_receipt' }]);
  });

  it('uses the window the operator sets: a shorter one pauses at once, and a request is held up to it however long its exit', async () => {
    const w = world({ windowMs: 2 * MINUTE });
    const first = w.startApi();
    const task = w.createTask(first);
    const body = w.connectBody(first, 'c1', 'complete');
    w.script.push(w.hangs);
    await w.until(first, () => w.modelInputs.length === 1, 'the first decision is asked');
    await w.crash(first, body);
    const api = w.startApi();
    await w.until(api, () => w.phase(api) === 'unknown', 'the lost step is unknown');
    w.advance(MINUTE);
    await ticks(w, api, 5);
    expect(w.phase(api)).toBe('unknown');
    w.advance(MINUTE + 1);
    await w.until(api, () => w.phase(api) === 'stopped', 'paused when its window ran out');
    expect(task.id).toBeTruthy();
  });
});

describe('the lost operations of a step, read and closed', () => {
  const lease: ActionLease = { id: 'action-1', holder: 'runner', generation: 3 };
  function inserted(w: World, ids: string[]) {
    const store = new MinecraftControlStore(w.db);
    const command = (id: string): MinecraftControlCommand => ({ schemaVersion: 1, id, serverId: 'world', connectionId: 'c1', kind: 'skill', skill: 'move',
      context: { scopeKey: 'owner', taskId: 'task-1', taskRevision: 1, bodyId: 'minecraft:world', sessionId: 's1', generation: 3, goal: 'g', completionCondition: 'c' },
      lease, deadlineAt: '2026-10-19T09:10:00.000Z' });
    for (const id of ids) {
      store.insert(command(id), '2026-10-19T09:00:00.000Z');
      store.deliver(id);
    }
    return { store, command };
  }
  const receipt = (id: string, patch: Partial<MinecraftControlReceipt> = {}): MinecraftControlReceipt => ({ id, connectionId: 'c1', outcome: 'completed', inputsReleased: true,
    observedAt: '2026-10-19T09:00:05.000Z', ...patch });

  it('reads an operation as unresolved when no receipt came, or it was unknown, or its inputs are not confirmed released', () => {
    const w = world();
    const { store } = inserted(w, ['a', 'b', 'c', 'd']);
    store.settle(receipt('a'));
    store.settle(receipt('b', { outcome: 'unknown', inputsReleased: false }));
    store.settle(receipt('c', { outcome: 'failed', inputsReleased: false }));
    const states = Object.fromEntries(bodyOperations(w.db, lease, 'owner').map(operation => [operation.id, operationUnresolved(operation)]));
    expect(states).toEqual({ a: false, b: true, c: true, d: true });
    expect(bodyOperations(w.db, { ...lease, generation: 4 }, 'owner')).toEqual([]);
    expect(bodyOperations(w.db, lease, 'another-owner')).toEqual([]);
  });

  it('closes only the unresolved ones, as cancelled with the inputs released and the body\'s proof named, and never touches a settled one', () => {
    const w = world();
    const { store } = inserted(w, ['a', 'b']);
    store.settle(receipt('a'));
    const closed = reconcileOperations(w.db, lease, 'owner', 'recheck:proof', '2026-10-19T09:01:00.000Z');
    expect(closed.map(operation => operation.id)).toEqual(['b']);
    expect(store.receipt('a')).toMatchObject({ outcome: 'completed' });
    expect(store.receipt('b')).toMatchObject({ outcome: 'cancelled', inputsReleased: true, reconciled: 'release_proof', evidenceId: 'recheck:proof' });
    expect(store.safe('task-1')).toBe(true);
    expect(reconcileOperations(w.db, lease, 'owner', 'recheck:proof', '2026-10-19T09:02:00.000Z')).toEqual([]);
  });

  it('lets the body\'s own late answer replace the closing when it is known, acknowledges it either way, and keeps the closing against an unknown one', () => {
    const w = world();
    const { store } = inserted(w, ['a', 'b']);
    reconcileOperations(w.db, lease, 'owner', 'recheck:proof', '2026-10-19T09:01:00.000Z');
    expect(store.settle(receipt('a', { outcome: 'failed', result: 'x' }))).toBe(true);
    expect(store.receipt('a')).toMatchObject({ outcome: 'failed', result: 'x' });
    expect(store.receipt('a')).not.toHaveProperty('reconciled');
    expect(store.settle(receipt('b', { outcome: 'unknown', inputsReleased: false }))).toBe(true);
    expect(store.receipt('b')).toMatchObject({ outcome: 'cancelled', reconciled: 'release_proof' });
    // A receipt already settled by the body is still compared with the one that arrives again, as before.
    expect(store.settle(receipt('a', { outcome: 'failed', result: 'x' }))).toBe(true);
    expect(store.settle(receipt('a', { outcome: 'completed' }))).toBe(false);
  });
});

describe('the notice is stored before the task goes on (M-1)', () => {
  it.each([
    ['a send that throws', () => { throw new Error('FCA_INBOX_UNAVAILABLE'); }],
    ['a send that reports success without storing anything', () => ({ accepted: true, duplicate: false })],
  ] as const)('does not resume, nor close the lost step, while the notice is not in the inbox (%s), and goes on when it is', async (_label, failing) => {
    const w = world();
    const { api, task } = await strandedSkill(w);
    await w.until(api, () => w.phase(api) === 'unknown', 'the lost step is unknown');
    const send = vi.spyOn(api.driver.runtime, 'send').mockImplementation(failing as never);
    const body = w.connectBody(api, 'c2', 'drop-on-release');
    await w.until(api, () => w.logs.some(line => line.includes('code=waiting for=notice')), 'the notice cannot be stored');
    await ticks(w, api, 20);
    // The body proved its release, but the model has not been told: the task stays unknown, its action stays open, no decision is asked.
    expect(w.phase(api)).toBe('unknown');
    expect(w.inputsOf(task.id)).toHaveLength(1);
    expect(w.events()).not.toContain('fca_body_recovered');
    expect(taskActions(w, task.id)[0]?.state).not.toBe('failed');
    expect(send.mock.calls.length).toBeGreaterThan(1); // tried again at each pass
    send.mockRestore();
    await w.until(api, () => w.phase(api) === 'completed', 'goes on once the notice is stored');
    // The lost skill was never sent again, and the next decision was told.
    expect(skillCommands(body)).toEqual([]);
    expect(w.inputsOf(task.id)).toHaveLength(2);
    expect(noticeOf(w.inputsOf(task.id)[1])?.lostOperations).toEqual([{ tool: 'mc.move', outcome: 'no_receipt' }]);
    expect(releaseCommands(body)).toHaveLength(1); // the proof of the first pass was kept: the body was not asked again for the notice
    expect(taskActions(w, task.id)[0]).toMatchObject({ state: 'failed', result: FCA_BODY_RECOVERY_CODE });
  });
});

describe('the body is asked to release with a backoff, a bounded number of times (M-2)', () => {
  it('backs off 10 s, 20 s, 40 s ... to 5 min, then pauses the task with the closed reason, without closing the step or asking again', async () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(releaseBackoffMs)).toEqual([10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]);
    expect(releaseBackoffMs(0)).toBe(0);
    const w = world({ windowMs: 600 * MINUTE });
    const { api, task } = await strandedSkill(w);
    await w.until(api, () => w.phase(api) === 'unknown', 'the lost step is unknown');
    const body = w.connectBody(api, 'c2', 'unknown-release'); // the body answers, but never confirms its inputs released
    await w.until(api, () => releaseCommands(body).length === 1, 'the first release is asked');
    await api.recovery.idle(); // the ask has come back (a jump of the clock during an ask is not counted)
    for (let asked = 1; asked < FCA_BODY_RELEASE_ATTEMPTS; asked++) {
      const wait = releaseBackoffMs(asked);
      w.advance(wait - 2_000);
      await ticks(w, api, 8);
      expect(releaseCommands(body)).toHaveLength(asked); // not before its time
      w.advance(3_000);
      await w.until(api, () => releaseCommands(body).length === asked + 1, `release ${asked + 1} is asked after ${wait} ms`);
      await api.recovery.idle();
    }
    // The tenth did not confirm either: the task is paused, nothing is closed, and the body is asked no more.
    await w.until(api, () => w.phase(api) === 'stopped', 'paused when the attempts are used up');
    expect(api.driver.runtime.get('owner', task.id)).toMatchObject({ status: 'paused', pauseReason: 'fca_stopped', summary: `${RELEASE_UNPROVEN_SUMMARY}${BODY_HELD_HINT}` });
    expect(w.logs.some(line => line.includes(`code=paused reason=${FCA_BODY_RELEASE_UNPROVEN}`))).toBe(true);
    expect(releaseCommands(body)).toHaveLength(FCA_BODY_RELEASE_ATTEMPTS);
    expect(taskActions(w, task.id)[0]?.state).not.toBe('failed'); // a lost step is never closed without the proof
    expect(w.skillRows()[0]!.receipt_json).toBeNull();
    expect(w.inputsOf(task.id)).toHaveLength(1);
    const rows = () => (w.db.prepare("SELECT COUNT(*) AS n FROM fca_body_operations WHERE id LIKE 'recheck:%'").get() as { n: number }).n;
    expect(rows()).toBe(FCA_BODY_RELEASE_ATTEMPTS);
    // While paused the body goes on being asked, but slowly (a minute, then two ...): two hours later it was asked once more, not
    // 700 times (a 10 s cooldown without end would have been about 8,640 rows a day per lost step).
    w.advance(2 * 60 * MINUTE);
    await ticks(w, api, 30);
    expect(rows()).toBe(FCA_BODY_RELEASE_ATTEMPTS + 1);
    expect(api.recovery.retained().releasing).toBe(1); // the lost step is still waited for
    expect(api.recovery.retained().exhausted).toBe(0);
  }, 30_000);

  it('stops a task the owner resumed in the same way, and a new resume begins a new count', async () => {
    const w = world({ windowMs: 600 * MINUTE });
    const { api, task } = await strandedSkill(w);
    await w.until(api, () => w.phase(api) === 'unknown', 'the lost step is unknown');
    w.advance(601 * MINUTE);
    await w.until(api, () => w.phase(api) === 'stopped', 'paused after the window');
    const body = w.connectBody(api, 'c2', 'unknown-release');
    expect(api.driver.runtime.resume('owner', task.id)).not.toBeNull();
    for (let round = 0; round < 40 && releaseCommands(body).length < FCA_BODY_RELEASE_ATTEMPTS; round++) {
      w.advance(301_000);
      await ticks(w, api, 6);
    }
    await w.until(api, () => api.driver.runtime.get('owner', task.id)?.summary === `${RELEASE_UNPROVEN_SUMMARY}${BODY_HELD_HINT}`, 'stopped when the attempts are used up');
    expect(w.phase(api)).toBe('stopped');
    expect(releaseCommands(body)).toHaveLength(FCA_BODY_RELEASE_ATTEMPTS);
    expect(taskActions(w, task.id)[0]?.state).not.toBe('failed');
    w.advance(10 * MINUTE);
    await ticks(w, api, 20);
    expect(releaseCommands(body)).toHaveLength(FCA_BODY_RELEASE_ATTEMPTS + 1); // one slow ask while it is paused (M-C), not a new round of ten
    // The body is fine now; the owner resumes, and the release is asked afresh (a new count) and proven.
    body.behaviour = 'drop-on-release';
    expect(api.driver.runtime.resume('owner', task.id)).not.toBeNull();
    await w.until(api, () => w.phase(api) === 'completed', 'goes on after a proven release');
    expect(releaseCommands(body)).toHaveLength(FCA_BODY_RELEASE_ATTEMPTS + 2);
  }, 30_000);
});

describe('a request lost before a long stop is stale, not young (M-3)', () => {
  it('pauses it as stale when the step is older than the window when it is noticed, and tells the model how long ago on resume', async () => {
    const w = world();
    const first = w.startApi();
    const task = w.createTask(first);
    const body = w.connectBody(first, 'c1', 'complete');
    w.script.push(w.hangs);
    await w.until(first, () => w.modelInputs.length === 1, 'the first decision is asked');
    w.kill(body); // a Spot VM stopped: the dying process settles nothing, so only this API's own recovery can notice the loss
    // A Spot VM stopped for eight hours: the API starts again, the body is back at once, yesterday's request is not auto-resumed.
    w.advance(8 * 60 * MINUTE);
    const api = w.startApi();
    w.connectBody(api, 'c2', 'complete');
    await w.until(api, () => w.phase(api) === 'stopped', 'paused as stale');
    expect(api.driver.runtime.get('owner', task.id)).toMatchObject({ status: 'paused', pauseReason: 'fca_stopped', summary: STALE_SUMMARY });
    expect(w.events()).toContain('fca_body_paused');
    expect(w.events()).not.toContain('fca_body_recovered');
    expect(w.events()).not.toContain('fca_unknown_retired');
    expect(w.logs.some(line => line.includes('code=paused reason=stale') && line.includes('gapSeconds='))).toBe(true);
    await ticks(w, api, 15);
    expect(w.inputsOf(task.id)).toHaveLength(1); // no decision was asked on yesterday's request
    // The owner decides to go on: the step is closed and the next decision is told the gap.
    expect(api.driver.runtime.resume('owner', task.id)).not.toBeNull();
    await w.until(api, () => w.phase(api) === 'completed', 'goes on when the owner resumes it');
    const notice = noticeOf(w.inputsOf(task.id)[1]);
    expect(notice?.gapSeconds).toBeGreaterThanOrEqual(8 * 3600);
    expect(notice?.gapSeconds).toBeLessThan(8 * 3600 + 120);
  });

  it('still resumes a request lost a few minutes before a restart, as it did', async () => {
    const w = world();
    const first = w.startApi();
    w.createTask(first);
    const body = w.connectBody(first, 'c1', 'complete');
    w.script.push(w.hangs);
    await w.until(first, () => w.modelInputs.length === 1, 'the first decision is asked');
    await w.crash(first, body);
    w.advance(25 * MINUTE); // inside the 30 minutes
    const api = w.startApi();
    w.connectBody(api, 'c2', 'complete');
    await w.until(api, () => w.phase(api) === 'completed', 'goes on at once');
    expect(w.events()).not.toContain('fca_body_paused');
  });
});

describe('what a lost step may have made or sent is listed, not undone (M-5)', () => {
  it('names the child tasks and the notes of the lost step in the notice, and only those of that step', async () => {
    const w = world();
    const first = w.startApi();
    const task = w.createTask(first);
    const body = w.connectBody(first, 'c1', 'complete');
    // An earlier child and note belong to a step that finished; the lost step makes one child and sends one note, then never answers.
    w.script.push((input, signal) => {
      const runtime = first.driver.runtime;
      const child = runtime.createChild('owner', task.id, { title: '木を集める', goal: '木を八本', context: '調べ方のメモ' }, 'lost-child');
      runtime.send('owner', task.id, child.id, '先に北の林を見て', 'lost-note');
      return w.hangs(input, signal);
    });
    await w.until(first, () => w.modelInputs.length === 1, 'the first decision is asked');
    await w.crash(first, body);
    const api = w.startApi();
    w.connectBody(api, 'c2', 'complete');
    await w.until(api, () => w.phase(api) === 'completed', 'goes on');
    const notice = noticeOf(w.inputsOf(task.id)[1]);
    expect(notice?.existingChildren).toHaveLength(1);
    expect(notice?.existingChildren?.[0]).toMatchObject({ title: '木を集める' });
    expect(notice?.sentNotes).toEqual([{ to: notice?.existingChildren?.[0]?.id, id: 'lost-note', preview: '先に北の林を見て' }]);
    expect(notice?.instruction).toContain('before you make or send the same again');
  });

  it('lists nothing from before the step began, nothing the task sent itself, and no context message', () => {
    const w = world();
    const api = w.startApi();
    const task = w.createTask(api);
    const runtime = api.driver.runtime;
    const store = new TaskBodyRecoveryStore(w.db);
    const older = runtime.createChild('owner', task.id, { title: '前の子', goal: 'g', context: 'c' }, 'older');
    runtime.send('owner', task.id, older.id, '前のメモ', 'older-note');
    w.advance(10_000);
    const since = w.now();
    w.advance(10_000);
    const newer = runtime.createChild('owner', task.id, { title: '新しい子', goal: 'g', context: 'c' }, 'newer');
    runtime.send('owner', task.id, newer.id, '新しいメモ', 'newer-note');
    runtime.send('owner', task.id, task.id, '自分へ', 'to-self');
    const effects = store.effectsSince('owner', task.id, since);
    expect(effects.children.map(child => child.title)).toEqual(['新しい子']);
    expect(effects.notes).toEqual([{ to: newer.id, id: 'newer-note', preview: '新しいメモ' }]);
    expect(store.effectsSince('owner', task.id, null)).toEqual({ children: [], notes: [] });
  });
});

describe('what is kept per step and task is let go (L-8)', () => {
  it('keeps a waiting reason while a step is waited for, and nothing after the request goes on', async () => {
    const w = world();
    const { api, task } = await strandedSkill(w);
    await w.until(api, () => w.phase(api) === 'unknown', 'the lost step is unknown');
    await ticks(w, api, 5);
    expect(api.recovery.retained().told).toBe(1); // "for=body", said once
    const body = w.connectBody(api, 'c2', 'drop-on-release');
    await w.until(api, () => w.phase(api) === 'completed', 'goes on');
    await ticks(w, api, 3);
    expect(api.recovery.retained()).toEqual({ releasing: 0, told: 0, awaiting: 0, exhausted: 0 });
    expect(releaseCommands(body)).toHaveLength(1);
    expect(task.id).toBeTruthy();
  });
});

const attemptRows = (w: World) => w.db.prepare('SELECT action_id,attempts,held FROM fca_body_release_attempts').all() as Array<{ action_id: string; attempts: number; held: number }>;
const recheckRows = (w: World) => (w.db.prepare("SELECT COUNT(*) AS n FROM fca_body_operations WHERE id LIKE 'recheck:%'").get() as { n: number }).n;
const messageIds = (w: World) => (w.db.prepare("SELECT message_id FROM fca_task_messages WHERE message_id LIKE 'recovery:%'").all() as Array<{ message_id: string }>).map(row => row.message_id);
/** A request whose body went away with a skill unanswered, paused after its window with the body still away. */
async function pausedAbsent(w: World) {
  const stranded = await strandedSkill(w);
  await w.until(stranded.api, () => w.phase(stranded.api) === 'unknown', 'the lost step is unknown');
  w.advance(31 * MINUTE);
  await w.until(stranded.api, () => w.phase(stranded.api) === 'stopped', 'paused after the window');
  return stranded;
}

describe('a paused request does not keep the body held (M-C)', () => {
  it('closes the lost step\'s operations and action once the body proves its release, leaves the task paused, and tells the model when the owner resumes it', async () => {
    const w = world();
    const { api, task } = await pausedAbsent(w);
    expect(taskActions(w, task.id)[0]?.state).not.toBe('failed'); // the body is held by the lost step
    const body = w.connectBody(api, 'c2', 'drop-on-release');
    await w.until(api, () => taskActions(w, task.id)[0]?.state === 'failed', 'the body is freed while the task is paused');
    expect(taskActions(w, task.id)[0]).toMatchObject({ state: 'failed', result: FCA_BODY_RECOVERY_CODE });
    expect(JSON.parse(w.skillRows()[0]!.receipt_json!)).toMatchObject({ outcome: 'cancelled', inputsReleased: true, reconciled: 'release_proof' });
    expect(api.control.store.safe(task.id)).toBe(true);
    expect(skillCommands(body)).toEqual([]);
    expect(releaseCommands(body)).toHaveLength(1);
    // Nothing was decided and nothing was resumed: still paused, no model step, no notice yet, and the summary no longer says the body is held.
    await ticks(w, api, 10);
    expect(w.phase(api)).toBe('stopped');
    expect(api.driver.runtime.get('owner', task.id)).toMatchObject({ status: 'paused', summary: BODY_ABSENT_SUMMARY });
    expect(w.inputsOf(task.id)).toHaveLength(1);
    expect(w.events()).not.toContain('fca_body_recovered');
    expect(messageIds(w)).toEqual([]);
    expect(w.logs.some(line => line.includes('code=reconciled') && line.includes('held=paused'))).toBe(true);
    // The owner resumes it much later: the model is told, with the gap as it is then, and the body is not asked again.
    w.advance(20 * MINUTE);
    expect(api.driver.runtime.resume('owner', task.id)).not.toBeNull();
    await w.until(api, () => w.phase(api) === 'completed', 'goes on when the owner resumes it');
    const notice = noticeOf(w.inputsOf(task.id)[1]);
    expect(notice).toMatchObject({ kind: 'body.recovery', lostOperations: [{ tool: 'mc.move', outcome: 'no_receipt' }] });
    expect(notice?.gapSeconds).toBeGreaterThanOrEqual(51 * 60);
    expect(releaseCommands(body)).toHaveLength(1);
    expect(skillCommands(body)).toEqual([]);
    await ticks(w, api, 3);
    expect(api.recovery.retained()).toEqual({ releasing: 0, told: 0, awaiting: 0, exhausted: 0 });
    expect(attemptRows(w)).toEqual([]);
  });

  it('lets go of a lost step that sent the body nothing without any body connected (no proof is needed), and sends the notice on resume', async () => {
    const w = world();
    const first = w.startApi();
    const task = w.createTask(first);
    const body = w.connectBody(first, 'c1', 'complete');
    w.script.push(w.hangs);
    await w.until(first, () => w.modelInputs.length === 1, 'the first decision is asked');
    await w.crash(first, body);
    const api = w.startApi();
    await w.until(api, () => w.phase(api) === 'unknown', 'the lost step is unknown');
    w.advance(31 * MINUTE);
    await w.until(api, () => w.phase(api) === 'stopped', 'paused after the window');
    await w.until(api, () => taskActions(w, task.id)[0]?.state === 'failed', 'the step is let go of while paused');
    expect(w.phase(api)).toBe('stopped');
    w.connectBody(api, 'c2', 'complete');
    expect(api.driver.runtime.resume('owner', task.id)).not.toBeNull();
    await w.until(api, () => w.phase(api) === 'completed', 'goes on');
    const notice = noticeOf(w.inputsOf(task.id)[1]);
    expect(notice).toMatchObject({ kind: 'body.recovery', lostOperations: [] });
    expect(notice?.gapSeconds).toBeGreaterThanOrEqual(31 * 60);
  });

  it('keeps asking when the body never confirms, slowly and a bounded number of times, and says in the summary that the body stays held and how to free it', async () => {
    expect([0, 1, 2, 3, 4, 5, 6, 30].map(heldBackoffMs)).toEqual([60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000, 1_800_000]);
    const w = world();
    const { api, task } = await pausedAbsent(w);
    expect(api.driver.runtime.get('owner', task.id)?.summary).toBe(`${BODY_ABSENT_SUMMARY}${BODY_HELD_HINT}`);
    expect(BODY_HELD_HINT).toContain('minecraft release');
    const body = w.connectBody(api, 'c2', 'unknown-release'); // answers, but never confirms its inputs released
    await w.until(api, () => releaseCommands(body).length === 1, 'asked as soon as the body is back');
    await api.recovery.idle();
    for (let asked = 1; asked < FCA_PAUSED_RELEASE_ATTEMPTS; asked++) {
      const wait = heldBackoffMs(asked);
      w.advance(wait - 2_000);
      await ticks(w, api, 6);
      expect(releaseCommands(body)).toHaveLength(asked); // not before its time
      w.advance(3_000);
      await w.until(api, () => releaseCommands(body).length === asked + 1, `ask ${asked + 1} follows after ${wait} ms`);
      await api.recovery.idle();
    }
    // The bound is reached: no more rows, whatever time passes; the lost step stays open and the task stays paused, with its hint.
    w.advance(3 * 24 * 60 * MINUTE);
    await ticks(w, api, 30);
    expect(releaseCommands(body)).toHaveLength(FCA_PAUSED_RELEASE_ATTEMPTS);
    expect(recheckRows(w)).toBe(FCA_PAUSED_RELEASE_ATTEMPTS);
    expect(taskActions(w, task.id)[0]?.state).not.toBe('failed');
    expect(w.skillRows()[0]!.receipt_json).toBeNull();
    expect(api.driver.runtime.get('owner', task.id)).toMatchObject({ status: 'paused', summary: `${BODY_ABSENT_SUMMARY}${BODY_HELD_HINT}` });
    expect(w.inputsOf(task.id)).toHaveLength(1);
    expect(w.logs.some(line => line.includes('code=waiting for=operator'))).toBe(true);
    expect(attemptRows(w)).toEqual([expect.objectContaining({ attempts: 0, held: FCA_PAUSED_RELEASE_ATTEMPTS })]);
  }, 60_000);
});

describe('a notice the model is owed when the action was closed meanwhile (L-5)', () => {
  it('sends the recovery note with the gap as it is on resume, even though the lost action was closed by someone else while paused', async () => {
    const w = world();
    const { api, task, skill } = await pausedAbsent(w);
    await w.actions.reconcile(skill.lease, 'failed', 'closed_elsewhere');
    expect(taskActions(w, task.id)[0]).toMatchObject({ state: 'failed', result: 'closed_elsewhere' });
    w.advance(5 * MINUTE);
    await ticks(w, api, 5);
    expect(w.inputsOf(task.id)).toHaveLength(1);
    expect(api.driver.runtime.resume('owner', task.id)).not.toBeNull();
    await w.until(api, () => w.phase(api) === 'completed', 'goes on when the owner resumes it');
    const notice = noticeOf(w.inputsOf(task.id)[1]);
    expect(notice).toMatchObject({ kind: 'body.recovery', lostOperations: [{ tool: 'mc.move', outcome: 'no_receipt' }] });
    expect(notice?.gapSeconds).toBeGreaterThanOrEqual(36 * 60);
    expect(messageIds(w)).toEqual([`recovery:${skill.lease.id}`]);
  });
});

describe('a resumed request waits for its body only for the window (L-3)', () => {
  it('stops it again as not returned when the owner resumed it with the body away and the window passes, with the hint', async () => {
    const w = world();
    const { api, task } = await pausedAbsent(w);
    expect(api.driver.runtime.resume('owner', task.id)).not.toBeNull();
    await ticks(w, api, 10);
    expect(api.driver.runtime.get('owner', task.id)?.summary).toBe(AWAITING_PROOF_SUMMARY);
    expect(api.recovery.retained().awaiting).toBe(1);
    w.advance(31 * MINUTE);
    await w.until(api, () => w.phase(api) === 'stopped', 'stopped when the window ran out');
    expect(api.driver.runtime.get('owner', task.id)).toMatchObject({ status: 'paused', pauseReason: 'fca_stopped', summary: `${BODY_ABSENT_SUMMARY}${BODY_HELD_HINT}` });
    expect(w.logs.filter(line => line.includes('code=paused reason=body_not_returned'))).toHaveLength(2);
    expect(api.recovery.retained().awaiting).toBe(0);
    expect(w.inputsOf(task.id)).toHaveLength(1);
    // It is the owner's again: the body comes back, the held mode frees it, and a new resume goes on.
    w.connectBody(api, 'c2', 'drop-on-release');
    await w.until(api, () => taskActions(w, task.id)[0]?.state === 'failed', 'freed while paused again');
    expect(api.driver.runtime.resume('owner', task.id)).not.toBeNull();
    await w.until(api, () => w.phase(api) === 'completed', 'goes on');
  });
});

describe('the words of a resumed request are cleared when it starts (L-4)', () => {
  it('replaces "waiting for the proof" by nothing once the body proved and the first step runs', async () => {
    const w = world();
    const { api, task } = await pausedAbsent(w);
    expect(api.driver.runtime.resume('owner', task.id)).not.toBeNull();
    await ticks(w, api, 10);
    expect(api.driver.runtime.get('owner', task.id)?.summary).toBe(AWAITING_PROOF_SUMMARY);
    w.script.push(w.hangs); // the first step after the proof is held, so that its state can be read while it runs
    w.connectBody(api, 'c2', 'drop-on-release');
    await w.until(api, () => w.inputsOf(task.id).length === 2, 'the first step after the proof is asked');
    expect(api.driver.runtime.get('owner', task.id)?.summary).toBe('');
  });
});

describe('giving up on a resumed request with a stop that fails (L-1)', () => {
  it('does not begin another round of ten asks, tries the stop again, and stops it when the stop works', async () => {
    const w = world({ windowMs: 600 * MINUTE });
    const { api, task } = await strandedSkill(w);
    await w.until(api, () => w.phase(api) === 'unknown', 'the lost step is unknown');
    w.advance(601 * MINUTE);
    await w.until(api, () => w.phase(api) === 'stopped', 'paused after the window');
    const body = w.connectBody(api, 'c2', 'unknown-release');
    await api.recovery.idle();
    const stop = vi.spyOn(api.driver.runtime, 'stop').mockImplementation(() => { throw new Error('FCA_STORE_BUSY'); });
    expect(api.driver.runtime.resume('owner', task.id)).not.toBeNull();
    for (let round = 0; round < 60 && releaseCommands(body).length < FCA_BODY_RELEASE_ATTEMPTS; round++) {
      w.advance(301_000);
      await ticks(w, api, 6);
    }
    expect(releaseCommands(body)).toHaveLength(FCA_BODY_RELEASE_ATTEMPTS);
    for (let round = 0; round < 12; round++) {
      w.advance(301_000);
      await ticks(w, api, 6);
    }
    expect(stop.mock.calls.length).toBeGreaterThan(1); // the stop was tried again at the next passes ...
    expect(releaseCommands(body)).toHaveLength(FCA_BODY_RELEASE_ATTEMPTS); // ... and the body was not asked ten more times
    expect(recheckRows(w)).toBe(FCA_BODY_RELEASE_ATTEMPTS);
    stop.mockRestore();
    await w.until(api, () => api.driver.runtime.get('owner', task.id)?.summary === `${RELEASE_UNPROVEN_SUMMARY}${BODY_HELD_HINT}`, 'stopped once the stop works');
    expect(w.phase(api)).toBe('stopped');
    expect(releaseCommands(body)).toHaveLength(FCA_BODY_RELEASE_ATTEMPTS);
    expect(api.recovery.retained().exhausted).toBe(0);
  }, 60_000);
});

describe('the count of asks survives a restart (L-11)', () => {
  it('counts the asks of both processes toward the ten, and removes the count when the step is closed', async () => {
    const w = world({ windowMs: 600 * MINUTE });
    const { api: first, task, skill } = await strandedSkill(w);
    await w.until(first, () => w.phase(first) === 'unknown', 'the lost step is unknown');
    const oldBody = w.connectBody(first, 'c2', 'unknown-release');
    for (let round = 0; round < 40 && releaseCommands(oldBody).length < 3; round++) {
      w.advance(301_000);
      await ticks(w, first, 6);
    }
    expect(releaseCommands(oldBody)).toHaveLength(3);
    await first.recovery.idle();
    expect(attemptRows(w)).toEqual([expect.objectContaining({ action_id: skill.lease.id, attempts: 3 })]);
    await w.crash(first, oldBody);
    const api = w.startApi();
    const body = w.connectBody(api, 'c3', 'unknown-release');
    for (let round = 0; round < 80 && w.phase(api) !== 'stopped'; round++) {
      w.advance(301_000);
      await ticks(w, api, 6);
    }
    expect(w.phase(api)).toBe('stopped');
    expect(api.driver.runtime.get('owner', task.id)?.summary).toBe(`${RELEASE_UNPROVEN_SUMMARY}${BODY_HELD_HINT}`);
    // Three asks before the restart and seven after it: ten for the step, not ten for each process.
    expect(releaseCommands(oldBody).length + releaseCommands(body).length).toBe(FCA_BODY_RELEASE_ATTEMPTS);
    expect(recheckRows(w)).toBe(FCA_BODY_RELEASE_ATTEMPTS);
    body.behaviour = 'drop-on-release';
    w.advance(40 * MINUTE);
    await w.until(api, () => taskActions(w, task.id)[0]?.state === 'failed', 'freed once the body confirms');
    await ticks(w, api, 3);
    expect(attemptRows(w)).toEqual([]);
  }, 60_000);
});

describe('releases that were never asked are not counted', () => {
  it.each([['recheck_busy'], ['body_unavailable']] as const)('does not count an answer of %s: no row was written, so the task is not paused however often it comes', async code => {
    let answers = 0, last: { rows: number; attempts: unknown[]; phase: string | undefined } | null = null;
    const w: World = world({ release: (step, real) => {
      answers += 1;
      if (answers < 25) return Promise.resolve({ code, actionIds: [], detail: 'not asked' });
      if (answers === 25) {
        last = { rows: recheckRows(w), attempts: attemptRows(w), phase: w.phase(api) };
        return Promise.resolve({ code, actionIds: [], detail: 'not asked' });
      }
      return real(step);
    } });
    const { api, task } = await strandedSkill(w);
    await w.until(api, () => w.phase(api) === 'unknown', 'the lost step is unknown');
    const body = w.connectBody(api, 'c2', 'drop-on-release');
    await w.until(api, () => answers > 25, 'more than twice the bound of unasked answers');
    // Twenty-five answers of this kind (the bound is ten): not paused, not closed, nothing written, nothing counted.
    expect(last).toEqual({ rows: 0, attempts: [], phase: 'unknown' });
    await w.until(api, () => w.phase(api) === 'completed', 'goes on when the body is really asked');
    expect(releaseCommands(body)).toHaveLength(1);
    expect(w.inputsOf(task.id)).toHaveLength(2);
  }, 30_000);
});

describe('what is kept per step is let go when the task leaves (L-8, forget)', () => {
  it('drops the waiting reason, the ask times and the counts of a request that ends while its step was being waited for', async () => {
    const w = world();
    const { api, task } = await strandedSkill(w);
    await w.until(api, () => w.phase(api) === 'unknown', 'the lost step is unknown');
    const body = w.connectBody(api, 'c2', 'unknown-release');
    await w.until(api, () => releaseCommands(body).length === 1, 'the body is asked once');
    await api.recovery.idle();
    expect(api.recovery.retained().releasing).toBe(1);
    expect(api.recovery.retained().told).toBe(1);
    expect(attemptRows(w)).toHaveLength(1);
    await api.driver.stop(task.id, 'owner_stop');
    w.advance(4 * MINUTE); // the work task's exit
    await w.until(api, () => w.phase(api) === 'failed', 'retired at its exit');
    await ticks(w, api, 5);
    expect(api.recovery.retained()).toEqual({ releasing: 0, told: 0, awaiting: 0, exhausted: 0 });
    expect(attemptRows(w)).toEqual([]);
  });
});

describe('a step the checkpoint still names but the action store no longer holds (goOn, unrecorded lease)', () => {
  it('stores the notice first, waits while it cannot be stored, and then goes on with a notice that lists nothing', async () => {
    const w = world();
    const { api, task, skill } = await strandedSkill(w);
    await w.until(api, () => w.phase(api) === 'unknown', 'the lost step is unknown');
    await w.actions.reconcile(skill.lease, 'failed', 'closed_elsewhere'); // closed before the recovery's pass: no lost step is on record
    expect(new ActionLeaseReader(w.db).lostFcaSteps('owner', w.now())).toEqual([]);
    const send = vi.spyOn(api.driver.runtime, 'send').mockImplementation(() => { throw new Error('FCA_INBOX_UNAVAILABLE'); });
    w.connectBody(api, 'c2', 'complete');
    await w.until(api, () => w.logs.some(line => line.includes('code=waiting for=notice')), 'the notice cannot be stored');
    await ticks(w, api, 10);
    expect(w.phase(api)).toBe('unknown');
    expect(w.inputsOf(task.id)).toHaveLength(1);
    send.mockRestore();
    await w.until(api, () => w.phase(api) === 'completed', 'goes on once the notice is stored');
    expect(noticeOf(w.inputsOf(task.id)[1])).toMatchObject({ kind: 'body.recovery', lostOperations: [], existingChildren: [], sentNotes: [] });
    expect(messageIds(w)).toEqual([`recovery:${skill.lease.id}`]);
  });
});

describe('when a lost step was last alive (L-2)', () => {
  async function lostStep() {
    const w = world();
    const first = w.startApi();
    w.createTask(first);
    const body = w.connectBody(first, 'c1', 'complete');
    w.script.push(w.hangs);
    await w.until(first, () => w.modelInputs.length === 1, 'the first decision is asked');
    await w.crash(first, body);
    const api = w.startApi();
    await w.until(api, () => w.phase(api) === 'unknown', 'the lost step is unknown');
    const reader = new ActionLeaseReader(w.db);
    const read = () => reader.lostFcaSteps('owner', w.now())[0]!;
    return { w, reader, read, api };
  }
  const isoPlus = (base: string | null, minutes: number) => new Date(Date.parse(base!) + minutes * MINUTE).toISOString();
  const addProgress = (w: World, taskId: string, at: string, sequence: number) => w.db.prepare(`INSERT INTO agent_task_events(event_id,task_id,sequence,event_type,title,tone,occurred_at,payload_json)
    VALUES(?,?,?,?,?,'neutral',?,'{}')`).run(`e-${sequence}`, taskId, sequence, 'fca_progress_observed', 'fca_progress_observed', at);

  it('is the end of its lease while the action records it', async () => {
    const { w, read } = await lostStep();
    const step = read();
    w.advance(30 * MINUTE);
    const end = isoPlus(step.startedAt, 7);
    w.db.prepare('UPDATE mind_actions SET lease_until=? WHERE id=?').run(end, step.actionId);
    expect(read().lostAt).toBe(end);
  });

  it('is the latest sign of life of a swept step, never its start when it left later ones, and never past the sweep', async () => {
    const { w, read } = await lostStep();
    const step = read();
    w.db.prepare('UPDATE mind_actions SET lease_until=NULL,updated_at=? WHERE id=?').run(isoPlus(step.startedAt, 30), step.actionId);
    w.db.prepare("DELETE FROM agent_task_events WHERE event_type='fca_progress_observed'").run();
    // Nothing but its start is on record: that is the time.
    expect(read().lostAt).toBe(step.startedAt);
    // A long step left a progress observation twelve minutes in: it was alive then.
    addProgress(w, step.taskId, isoPlus(step.startedAt, 12), 90_001);
    expect(read().lostAt).toBe(isoPlus(step.startedAt, 12));
    // A body operation of this lease, made twenty minutes in and answered at 21, is later still.
    const command = { schemaVersion: 1, id: 'op-late', serverId: 'world', connectionId: 'c1', kind: 'skill', skill: 'move',
      context: { scopeKey: 'owner', taskId: step.taskId, taskRevision: 1, bodyId: 'minecraft:world', sessionId: 's1', generation: step.lease.generation, goal: 'g', completionCondition: 'c' },
      lease: step.lease, deadlineAt: isoPlus(step.startedAt, 40) };
    w.db.prepare("INSERT INTO fca_body_operations(id,task_id,body_id,connection_id,command_json,phase,receipt_json,created_at) VALUES(?,?,?,?,?,'settled',?,?)")
      .run('op-late', step.taskId, 'minecraft:world', 'c1', JSON.stringify(command), JSON.stringify({ outcome: 'completed', observedAt: isoPlus(step.startedAt, 21) }), isoPlus(step.startedAt, 20));
    expect(read().lostAt).toBe(isoPlus(step.startedAt, 21));
    // Something recorded after the sweep is not evidence of life before it.
    addProgress(w, step.taskId, isoPlus(step.startedAt, 55), 90_002);
    expect(read().lostAt).toBe(isoPlus(step.startedAt, 21));
    // A step that left such evidence is therefore not made to look older than it was: its gap is from then, not from its start.
    expect(Date.parse(read().lostAt!)).toBeGreaterThan(Date.parse(step.startedAt!));
  });
});

describe('the lookup of a task\'s sent notes is indexed (L-9)', () => {
  it('has an index on the source task of the inbox, and the lookup uses it', () => {
    const w = world();
    w.startApi();
    const indexes = (w.db.prepare("PRAGMA index_list('fca_task_messages')").all() as Array<{ name: string }>).map(row => row.name);
    expect(indexes).toContain('fca_task_messages_source');
    const plan = (w.db.prepare(`EXPLAIN QUERY PLAN SELECT message_id,target_task_id,text FROM fca_task_messages WHERE scope_key=? AND source_task_id=?
      AND target_task_id<>? AND received_at>=? AND message_id NOT LIKE 'context:%' ORDER BY rowid DESC LIMIT 8`).all('owner', 't', 't', '2026-10-19') as Array<{ detail: string }>)
      .map(row => row.detail).join(' | ');
    expect(plan).toContain('fca_task_messages_source');
  });
});
