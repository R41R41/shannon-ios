import { afterEach, describe, expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import type { ActionLease } from '../src/contracts/actionThreadContract.js';
import type { MinecraftControlCommand, MinecraftControlReceipt } from '../src/contracts/minecraftControlContract.js';
import { BODY_ABSENT_SUMMARY, FCA_BODY_RECOVERY_CODE, RECOVERY_LIMIT_SUMMARY } from '../src/wiring/fcaBodyRecovery.js';
import { fcaBudget } from '../src/wiring/fcaBudgetWiring.js';
import { TaskBudgetStore } from '../src/mind/action/taskRuntime/store/taskBudgetStore.js';
import { MinecraftControlStore } from '../src/surfaces/minecraft/store/minecraftControlStore.js';
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
const noticeOf = (input: { messages: ReadonlyArray<{ text: string }> } | undefined) => input?.messages
  .map(message => JSON.parse(message.text) as { kind?: string; lostOperations?: unknown[]; instruction?: string }).find(value => value.kind === 'body.recovery');
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
    expect(notice).toMatchObject({ kind: 'body.recovery', lostOperations: [] });
    expect(notice?.instruction).toContain('none of them was sent again');
    expect(skillCommands(again)).toEqual([]);
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
    expect(api.driver.runtime.get('owner', task.id)).toMatchObject({ status: 'paused', pauseReason: 'fca_stopped', summary: BODY_ABSENT_SUMMARY });
    expect(w.events()).toContain('fca_body_paused');
    expect(w.events()).not.toContain('fca_unknown_retired');
    // The owner resumes it before the body is back: it waits (the lost operation is not proven released), no decision is asked.
    expect(api.driver.runtime.resume('owner', task.id)).not.toBeNull();
    await ticks(w, api, 15);
    expect(w.inputsOf(task.id)).toHaveLength(1);
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
