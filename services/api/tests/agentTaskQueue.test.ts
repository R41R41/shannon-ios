import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SQLiteAgentTaskStore } from '../src/mind/action/agentTasks/agentTaskStore.js';
import type { HostAgentEvent } from '../src/mind/action/agentTasks/agentTaskStore.js';

const OWNER = 'owner-a';
const MAC = 'local-mac';
const CLOUD = 'cloud-agent';
const WAITING = 'Macで前の作業が終わるのを待っています。';
const OFFLINE = 'Macがオフラインのため、戻るのを待っています。';

let store: SQLiteAgentTaskStore;
let clock = 0;
let eventNumber = 0;

/** Each call is one second later, so the order of the calls is the order in time. */
function tick(): string {
  clock += 1;
  return at(clock);
}

function at(seconds: number): string {
  return new Date(Date.UTC(2026, 9, 2) + seconds * 1_000).toISOString();
}

function heartbeats(): void {
  const now = tick();
  store.heartbeat({
    hostId: MAC, displayName: 'このMac', kind: 'local', capabilities: [], projects: ['shannon-ios'], models: [],
  }, now);
  store.heartbeat({
    hostId: CLOUD, displayName: 'Cloud', kind: 'cloud', capabilities: [], projects: ['shannon-ios'], models: [],
  }, now);
}

/** Creates a task the way the API route does: resolve the host first, then create. */
function start(key: string, options: { project?: string; preference?: string } = {}) {
  const project = 'project' in options ? options.project : 'shannon-ios';
  const host = store.resolveHost(project, options.preference ?? 'auto', tick(), null);
  return store.create(OWNER, {
    idempotencyKey: key, conversationThreadID: 'thread-a', title: key, goal: `${key}を行う`, summary: `${key}を始める。`,
    ...(host ? { hostHint: host } : {}), ...(project ? { projectHint: project } : {}),
  }, tick()).task;
}

function host(hostId: string, taskId: string, type: HostAgentEvent['type'], payload: Record<string, unknown> = {}): void {
  eventNumber += 1;
  const now = tick();
  store.recordHostEvents(hostId, [{
    eventId: `event-${eventNumber}`, taskId, type, title: type, detail: `${type}。`, occurredAt: now, payload,
  }], now);
}

function task(taskId: string) {
  return store.get(OWNER, taskId)!;
}

beforeEach(() => {
  store = new SQLiteAgentTaskStore(':memory:');
  clock = 0;
  eventNumber = 0;
  heartbeats();
});

afterEach(() => store.close());

describe('one task at a time on a host', () => {
  it('assigns code work to the busy Mac, keeps it queued with a true summary, and begins it when the Mac is free', () => {
    const first = start('first');
    expect(first).toMatchObject({ assignedHostID: MAC, status: 'queued', summary: 'firstを始める。' });
    expect(store.claim(MAC, tick())).toMatchObject({ taskId: first.id, type: 'start' });
    host(MAC, first.id, 'started');

    const second = start('second');
    expect(second).toMatchObject({ assignedHostID: MAC, status: 'queued', summary: WAITING, currentAction: '順番待ち' });
    expect(store.claim(MAC, tick())).toBeNull();
    expect(store.claim(CLOUD, tick())).toBeNull();

    host(MAC, first.id, 'approval_requested', { approval: { externalRequestID: 'request-1', kind: 'command' } });
    expect(store.claim(MAC, tick())).toBeNull();
    expect(task(second.id)).toMatchObject({ status: 'queued', summary: WAITING });

    host(MAC, first.id, 'started');
    host(MAC, first.id, 'completed');
    expect(store.claim(MAC, tick())).toMatchObject({ taskId: second.id, type: 'start' });
    expect(task(second.id)).toMatchObject({
      status: 'starting', summary: '作業を始める準備中。', currentAction: '作業環境へ接続中',
    });
  });

  it.each(['failed', 'paused'] as const)('begins the next task when the working one is %s', (ending) => {
    const first = start('first');
    store.claim(MAC, tick());
    host(MAC, first.id, 'started');
    const second = start('second');
    expect(store.claim(MAC, tick())).toBeNull();

    host(MAC, first.id, ending, ending === 'paused' ? { pauseReason: 'needs_owner', currentAction: '実機で確認' } : {});
    expect(store.claim(MAC, tick())).toMatchObject({ taskId: second.id, type: 'start' });
  });

  it('begins three waiting tasks in the order they were accepted', () => {
    const tasks = ['one', 'two', 'three'].map(key => start(key));
    expect(tasks.map(each => each.summary)).toEqual(['oneを始める。', WAITING, WAITING]);
    for (const each of tasks) {
      expect(store.claim(MAC, tick())).toMatchObject({ taskId: each.id, type: 'start' });
      expect(store.claim(MAC, tick())).toBeNull();
      host(MAC, each.id, 'started');
      expect(store.claim(MAC, tick())).toBeNull();
      host(MAC, each.id, 'completed');
    }
    expect(store.claim(MAC, tick())).toBeNull();
  });

  it('sends work without a project to cloud while the Mac is busy, and code work to cloud while the Mac is offline', () => {
    const working = start('working');
    store.claim(MAC, tick());
    host(MAC, working.id, 'started');

    const research = start('research', { project: undefined });
    expect(research).toMatchObject({ assignedHostID: CLOUD, summary: 'researchを始める。' });
    expect(store.claim(CLOUD, tick())).toMatchObject({ taskId: research.id, type: 'start' });
    host(CLOUD, research.id, 'completed');

    clock += 120;
    store.heartbeat({
      hostId: CLOUD, displayName: 'Cloud', kind: 'cloud', capabilities: [], projects: ['shannon-ios'], models: [],
    }, tick());
    expect(start('while-asleep')).toMatchObject({ assignedHostID: CLOUD });
    expect(store.resolveHost('shannon-ios', 'local', tick(), null)).toBeNull();
  });

  it('keeps delivering commands of the working task while others wait', () => {
    const working = start('working');
    store.claim(MAC, tick());
    host(MAC, working.id, 'started');
    const waiting = start('waiting');

    store.enqueue(OWNER, working.id, { idempotencyKey: 'steer-1', type: 'steer', payload: { instruction: '色も直して' } }, tick());
    expect(store.claim(MAC, tick())).toMatchObject({ taskId: working.id, type: 'steer' });

    host(MAC, working.id, 'approval_requested', { approval: { externalRequestID: 'request-1', kind: 'command', denyContinues: true } });
    store.enqueue(OWNER, working.id, {
      idempotencyKey: 'approve-1', type: 'resolve_approval', payload: { decision: 'allow_once', externalRequestID: 'request-1' },
    }, tick());
    const approval = store.claim(MAC, tick())!;
    expect(approval).toMatchObject({ taskId: working.id, type: 'resolve_approval' });
    host(MAC, working.id, 'progress');
    host(MAC, working.id, 'command_completed', { commandId: approval.id });

    store.enqueue(OWNER, working.id, { idempotencyKey: 'pause-1', type: 'interrupt' }, tick());
    const interrupt = store.claim(MAC, tick())!;
    expect(interrupt).toMatchObject({ taskId: working.id, type: 'interrupt' });
    // The task is paused in the store, but the host has not stopped it yet: the next one still waits.
    expect(task(working.id).status).toBe('paused');
    expect(store.claim(MAC, tick())).toBeNull();
    host(MAC, working.id, 'command_completed', { commandId: interrupt.id });
    expect(store.claim(MAC, tick())).toMatchObject({ taskId: waiting.id, type: 'start' });
  });

  it('cancels a waiting task without the host ever seeing it', () => {
    const working = start('working');
    store.claim(MAC, tick());
    host(MAC, working.id, 'started');
    const cancelled = start('cancelled');
    const next = start('next');

    const result = store.enqueue(OWNER, cancelled.id, {
      idempotencyKey: 'cancel-1', type: 'interrupt', payload: { cancel: true },
    }, tick());
    expect(result.task).toMatchObject({ status: 'cancelled', summary: 'この作業を中止した。' });
    expect(store.claim(MAC, tick())).toBeNull();

    host(MAC, working.id, 'completed');
    expect(store.claim(MAC, tick())).toMatchObject({ taskId: next.id, type: 'start' });
    host(MAC, next.id, 'completed');
    expect(store.claim(MAC, tick())).toBeNull();
    expect(task(cancelled.id).status).toBe('cancelled');
  });

  it('holds a waiting task the owner paused, and puts it back in line when resumed', () => {
    const working = start('working');
    store.claim(MAC, tick());
    host(MAC, working.id, 'started');
    const held = start('held');

    expect(store.enqueue(OWNER, held.id, { idempotencyKey: 'pause-1', type: 'interrupt' }, tick()).task)
      .toMatchObject({ status: 'paused', pauseReason: 'owner' });
    host(MAC, working.id, 'completed');
    expect(store.claim(MAC, tick())).toBeNull();
    expect(() => store.enqueue(OWNER, held.id, {
      idempotencyKey: 'steer-1', type: 'steer', payload: { instruction: '先に進めて' },
    }, tick())).toThrow('AGENT_COMMAND_INVALID_STATE');

    expect(store.enqueue(OWNER, held.id, { idempotencyKey: 'resume-1', type: 'resume' }, tick()).task)
      .toMatchObject({ status: 'queued', summary: '開始を待っています。' });
    // The host begins the task with its original start; the resume itself never reaches it.
    expect(store.claim(MAC, tick())).toMatchObject({ taskId: held.id, type: 'start' });
    expect(store.claim(MAC, tick())).toBeNull();
  });

  it.each(['resume', 'steer'] as const)('makes a paused task wait its turn when the owner sends %s', (type) => {
    const paused = start('paused');
    store.claim(MAC, tick());
    host(MAC, paused.id, 'started');
    host(MAC, paused.id, 'paused', { pauseReason: 'needs_owner', currentAction: '実機で確認' });
    const working = start('working');
    expect(working.summary).toBe('workingを始める。');
    store.claim(MAC, tick());
    host(MAC, working.id, 'started');

    const woken = store.enqueue(OWNER, paused.id, {
      idempotencyKey: 'wake-1', type, ...(type === 'steer' ? { payload: { instruction: '続けて' } } : {}),
    }, tick()).task;
    expect(woken).toMatchObject({ status: 'queued', summary: WAITING, currentAction: '順番待ち' });
    expect(woken).not.toHaveProperty('pauseReason');
    expect(store.claim(MAC, tick())).toBeNull();

    host(MAC, working.id, 'completed');
    expect(store.claim(MAC, tick())).toMatchObject({ taskId: paused.id, type });
    expect(task(paused.id)).toMatchObject({ status: 'starting' });
    expect(task(paused.id).summary).not.toBe(WAITING);
    // While it works again, a later task waits behind it.
    const later = start('later');
    expect(later.summary).toBe(WAITING);
    expect(store.claim(MAC, tick())).toBeNull();
  });

  it('wakes a paused task at once when the host is free, and withdraws the wake-up if the owner stops it first', () => {
    const paused = start('paused');
    store.claim(MAC, tick());
    host(MAC, paused.id, 'started');
    host(MAC, paused.id, 'paused', { pauseReason: 'needs_owner', currentAction: '実機で確認' });
    expect(store.enqueue(OWNER, paused.id, { idempotencyKey: 'resume-1', type: 'resume' }, tick()).task)
      .toMatchObject({ status: 'starting', summary: '作業を再開しています。' });
    expect(store.claim(MAC, tick())).toMatchObject({ taskId: paused.id, type: 'resume' });
    host(MAC, paused.id, 'started');
    host(MAC, paused.id, 'paused', { pauseReason: 'needs_owner', currentAction: '実機で確認' });

    const working = start('working');
    store.claim(MAC, tick());
    host(MAC, working.id, 'started');
    store.enqueue(OWNER, paused.id, { idempotencyKey: 'resume-2', type: 'resume' }, tick());
    store.enqueue(OWNER, paused.id, { idempotencyKey: 'cancel-1', type: 'interrupt', payload: { cancel: true } }, tick());
    // The host holds a session for this task, so it is told to stop; the resume never follows.
    expect(store.claim(MAC, tick())).toMatchObject({ taskId: paused.id, type: 'interrupt' });
    host(MAC, working.id, 'completed');
    expect(store.claim(MAC, tick())).toBeNull();
    expect(task(paused.id).status).toBe('cancelled');
  });

  it('does not let another host take a queued task', () => {
    const working = start('working');
    const waiting = start('waiting');
    expect(store.claim(CLOUD, tick())).toBeNull();
    expect(store.claim('another-mac', tick())).toBeNull();
    expect(store.claim(MAC, tick())).toMatchObject({ taskId: working.id });
    host(MAC, working.id, 'completed');
    expect(store.claim(CLOUD, tick())).toBeNull();
    expect(store.claim(MAC, tick())).toMatchObject({ taskId: waiting.id });

    // Each host has its own line: a task on cloud does not hold the Mac.
    host(MAC, waiting.id, 'completed');
    const onCloud = start('on-cloud', { preference: CLOUD });
    const onMac = start('on-mac');
    expect(onMac.summary).toBe('on-macを始める。');
    expect(store.claim(CLOUD, tick())).toMatchObject({ taskId: onCloud.id });
    expect(store.claim(MAC, tick())).toMatchObject({ taskId: onMac.id });
  });

  it('does not let a second task slip in when the lease of the first start runs out', () => {
    const first = start('first');
    const second = start('second');
    expect(store.claim(MAC, tick(), 10)).toMatchObject({ taskId: first.id, attempts: 1 });
    clock += 60;
    // The start is delivered again to the same task; the second task still waits.
    expect(store.claim(MAC, tick(), 10)).toMatchObject({ taskId: first.id, type: 'start', attempts: 2 });
    expect(store.claim(MAC, tick(), 10)).toBeNull();
    clock += 60;
    host(MAC, first.id, 'started');
    host(MAC, first.id, 'command_completed', { commandId: 'unknown' });
    expect(store.claim(MAC, tick(), 10)).toMatchObject({ taskId: first.id, attempts: 3 });
    expect(task(second.id)).toMatchObject({ status: 'queued', summary: WAITING });
  });

  it('keeps queued code work on a Mac that went offline and says so, instead of moving it to cloud', () => {
    const working = start('working');
    const startCommand = store.claim(MAC, tick())!;
    host(MAC, working.id, 'started');
    host(MAC, working.id, 'command_completed', { commandId: startCommand.id });
    const waiting = start('waiting');
    const sequence = waiting.latestSequence;

    clock += 4 * 60;
    expect(store.claim(CLOUD, tick())).toBeNull();
    expect(task(waiting.id).summary).toBe(WAITING);

    clock += 2 * 60;
    expect(store.claim(CLOUD, tick())).toBeNull();
    expect(task(waiting.id)).toMatchObject({
      status: 'queued', assignedHostID: MAC, summary: OFFLINE, currentAction: 'オフライン待ち',
    });
    // A client that polls by sequence sees the change, and it is recorded only once.
    expect(task(waiting.id).latestSequence).toBe(sequence + 1);
    store.claim(CLOUD, tick());
    expect(task(waiting.id).latestSequence).toBe(sequence + 1);
    // The task that was running is left as it was.
    expect(task(working.id)).toMatchObject({ status: 'running' });

    heartbeats();
    expect(store.claim(MAC, tick())).toBeNull();
    expect(task(waiting.id)).toMatchObject({ status: 'queued', summary: WAITING, currentAction: '順番待ち' });
    host(MAC, working.id, 'completed');
    expect(store.claim(MAC, tick())).toMatchObject({ taskId: waiting.id, type: 'start' });
  });
});
