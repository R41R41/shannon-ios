import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { configuredMinecraftLifecycle } from '../src/wiring/minecraftLifecycleWiring.js';
import { createLifecycleRunner } from '../src/wiring/minecraftLifecycleRunner.js';
import { configuredRetainedResources } from '../src/wiring/configuredActionResourceProof.js';
import { configuredAutonomy } from '../src/mind/inhibition/autonomyBudget.js';
import { ShannonAutonomyService } from '../src/mind/action/ownTime/autonomyService.js';
import { SQLiteAutonomyStore } from '../src/wiring/autonomyStoreWiring.js';
import { ActionLeaseReader } from '../src/mind/action/threads/store/actionLeaseReader.js';
import { lifecycleOutcomeNotices } from '../src/mind/perception/noticeProducers.js';
import { noticeLine, VOICE_ENDED_FIRST_MINUTES } from '../src/mind/workspace/promptLayout.js';
import { offeredTools } from '../src/mind/tools/shannonTools.js';
import { toolTraceCall, toolTracePrompt, traceLabel, supersededFailuresDropped } from '../src/mind/tools/shannonToolTrace.js';
import { InMemoryToolTraces, ToolTurnLog } from '../src/mind/tools/shannonToolTurns.js';
import { inboxPerception, voicePerception } from '../src/mind/perception/perceptionPorts.js';
import { applyOp, emptyScope, initialSalience } from '../src/mind/workspace/workspaceState.js';
import { NOTICE_MARKERS, PROMPT_LAYOUT_LIMITS, workspaceBlocks } from '../src/mind/workspace/workspacePorts.js';
import { OWNER_AUDIENCE } from '@shannon/cognition';
import { actionHarness } from './support/actionThreadHarness.js';
import { inActionExecution, type ActionExecution } from '../src/infra/context/actionExecution.js';
import { actionResource, leaseOf } from '../src/contracts/actionThreadContract.js';
import { toolSessionMemory } from '../src/mind/tools/shannonToolTypes.js';
import type { LifecycleOutcomeReport, LifecycleOutcomeTeller } from '../src/wiring/lifecycleOutcomeTellingWiring.js';
import type { MinecraftLifecycleCommand, MinecraftLifecyclePoll, MinecraftLifecycleReceipt, MinecraftLifecycleState } from '../src/contracts/minecraftLifecycleContract.js';

// Syzygy ADR-0009 stage 1 S7 and the 2026-10-13 TI-REQ: a conversation's lifecycle request runs under its own Minecraft action.
const close: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const finish of close.splice(0).reverse()) await finish(); });
const values = { SHANNON_MINECRAFT_LIFECYCLE: 'on', SHANNON_ADR8_STAGE4: 'on', SHANNON_MINECRAFT_LIFECYCLE_SERVERS: '["home"]',
  SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'operator', servers: [{ serverId: 'home', title: 'Home', ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146', onlineMode: true }] }) };
const body = actionResource('operator', 'minecraft-body');
async function until(test: () => boolean) { for (let i = 0; i < 500; i++) { if (test()) return; await delay(2); } expect(test()).toBe(true); }

function fixture(told?: LifecycleOutcomeTeller) {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-lifecycle-detached-')), path = join(directory, 'store.sqlite');
  close.push(() => rmSync(directory, { recursive: true, force: true }));
  let at = '2026-10-13T07:49:13.000Z', alone = true, sequence = 0;
  const store = new SQLiteAutonomyStore(path); close.push(() => store.close());
  const autonomy = new ShannonAutonomyService({ store, config: configuredAutonomy({ SHANNON_AUTONOMY_ENABLED: 'true' }), now: () => at });
  const h = actionHarness(() => at, path); close.push(h.close);
  const configured = configuredMinecraftLifecycle(values, { path, autonomy, actions: h.actions, ownerAlone: () => alone,
    taskAllowed: () => false, now: () => at, ...(told ? { told } : {}) })!;
  // Closing aborts a running operation; its cancellation drain waits on this clock, so the clock moves while it closes.
  close.push(async () => { const ticking = setInterval(() => { at = new Date(Date.parse(at) + 1000).toISOString(); }, 20);
    try { await configured.close(); } finally { clearInterval(ticking); } });
  const principal = { scopeKey: 'owner', deviceId: 'operator' };
  const state = (patch: Partial<MinecraftLifecycleState> = {}): MinecraftLifecycleState => ({ serverId: 'home', observedAt: at, running: 'running', bot: 'absent', otherPlayers: 0, ...patch });
  const poll = (patch: Partial<MinecraftLifecyclePoll> = {}) => configured.service.poll(principal, { schemaVersion: 1, connectionId: 'connection', sequence: sequence++, states: [state()], receipts: [], ...patch });
  poll();
  const turn = async () => {
    const view = (await h.actions.admitRespond({ scopeKey: 'owner', kind: 'respond', origin: 'owner_request', sourceId: `turn-${sequence++}` }))!;
    const controller = new AbortController();
    const execution: ActionExecution = { lease: leaseOf(view), signal: controller.signal, permit: async resources => h.actions.dispatch(execution.lease, resources) };
    return { view, controller, execution };
  };
  const call = async (name: string, identity: string) => {
    const t = await turn();
    const result = await inActionExecution(t.execution, () => autonomy.tools.call(name, {}, { scopeKey: 'owner', surface: 'text', audience: 'owner_alone',
      threadId: 'thread', memory: { ...toolSessionMemory(), turnKey: identity }, acknowledgementOwner: 'fca' }, t.execution.signal));
    // The turn ends as a turn does (its time limit aborts it); nothing of the operation goes with it.
    const resources = h.store.get(t.view.id)!.resources;
    t.controller.abort(); await h.actions.finish(t.execution.lease, 'completed', 'turn_finished');
    return { ...t, result, resources };
  };
  /** Several calls in one turn, as a model makes them (a first try, then a retry): their inputs and results. */
  const calls = async (name: string, identity: string, inputs: readonly Record<string, unknown>[]) => {
    const t = await turn();
    const results = [];
    for (const input of inputs) {
      results.push(await inActionExecution(t.execution, () => autonomy.tools.call(name, input, { scopeKey: 'owner', surface: 'voice', audience: 'owner_alone',
        threadId: 'thread', memory: { ...toolSessionMemory(), turnKey: identity }, acknowledgementOwner: 'fca' }, t.execution.signal)));
    }
    t.controller.abort(); await h.actions.finish(t.execution.lease, 'completed', 'turn_finished');
    return results;
  };
  const receipt = (command: MinecraftLifecycleCommand, patch: Partial<MinecraftLifecycleReceipt> = {}): MinecraftLifecycleReceipt => ({ id: command.id,
    connectionId: command.connectionId, serverId: command.serverId, action: command.action, outcome: 'completed', code: 'changed', observedAt: at,
    inputsReleased: true, state: state({ bot: 'joined' }), ...patch });
  const command = async () => { await until(() => configured.service.store.pending().length === 1); return poll().commands[0]!; };
  return { ...h, configured, principal, poll, call, calls, receipt, command, at: () => at,
    advance(ms: number) { at = new Date(Date.parse(at) + ms).toISOString(); }, alone(value: boolean) { alone = value; } };
}

describe('a conversation lifecycle request holds its own Minecraft action, not the turn', () => {
  it('answers 「受け付けた」 at once, outlives the turn and its time limit, and reports the late receipt as a notice', async () => {
    const f = fixture(), asked = await f.call('minecraft.login', 'login-1');
    expect(asked.result).toMatchObject({ ok: true, evidence: { outcome: 'queued', action: 'login', target: { kind: 'minecraft_server', id: 'home' } } });
    expect(asked.result.text).toContain('受け付けました');
    // The turn never held the body.
    expect(asked.resources).not.toContain(body);
    expect(f.store.get(asked.view.id)).toMatchObject({ state: 'completed' });
    const command = await f.command();
    const own = f.store.get(command.authority.executionId)!;
    expect(own).toMatchObject({ kind: 'minecraft', origin: 'owner_request', sourceId: command.id, state: 'running', resources: [body] });
    expect(command.authority.sourceIds).toEqual(['conversation:thread', expect.stringMatching(/^turn:[a-f0-9]{64}$/u)]);
    expect(f.configured.service.authorize(f.principal, command.id)).toBe(true);
    // One lease authority: the slot of this operation is the Minecraft class, never the foreground one.
    expect(await f.actions.admitRespond({ scopeKey: 'owner', kind: 'respond', origin: 'owner_request', sourceId: 'next-turn' })).not.toBeNull();
    expect(f.poll({ receipts: [f.receipt(command)] }).acknowledged).toEqual([command.id]);
    await until(() => f.store.get(own.id)!.state === 'completed');
    expect(f.store.get(own.id)!.result).toBe('lifecycle_native_acknowledged');
    const reports = new ActionLeaseReader(f.db).ownLifecycleReceipts('owner');
    expect(reports).toEqual([{ id: command.id, action: 'login', outcome: 'completed', observedAt: f.at() }]);
    expect(lifecycleOutcomeNotices(reports, f.at())).toEqual([{ at: f.at(), draft: { kind: 'task_outcome', code: 'done', audience: 'owner',
      source: 'api', sourceId: expect.stringMatching(/^minecraft-lifecycle:[a-f0-9]{64}@\d+$/u), tool: 'minecraft.login' } }]);
  });

  it('keeps 「終わったら知らせます」 when an accepted operation cannot start: a closed failure notice with its reason', async () => {
    const f = fixture();
    // An unresolved operation that appeared between 「受け付けました」 and the start (a race): the service refuses as busy.
    const service = { execute: async () => { throw new Error('MINECRAFT_LIFECYCLE_BUSY'); }, receipt: () => null, store: { command: () => null } };
    const runner = createLifecycleRunner({ actions: f.actions, service: service as never, deviceId: 'operator' })!;
    const sourceId = `lifecycle:${'b'.repeat(64)}`;
    const own = (await runner.admit({ scopeKey: 'owner', kind: 'minecraft', origin: 'owner_request', sourceId }, true))!;
    expect(await runner.takeBody(own)).toBe(true);
    let settled: unknown = null;
    await runner.detach(own, { id: sourceId, serverId: 'home', action: 'login', authority: {} as never }, value => { settled = value; });
    expect(settled).toEqual({ receipt: null, issued: false });
    const leases = new ActionLeaseReader(f.db);
    const [row] = leases.notStartedLifecycle('owner');
    expect(row).toMatchObject({ id: sourceId, result: 'lifecycle_not_started:login:busy' });
    expect(f.store.get(own.view.id)).toMatchObject({ state: 'failed' });
    const notices = lifecycleOutcomeNotices([{ id: row!.id, action: 'login', outcome: 'failed', observedAt: row!.at, notStarted: 'busy' }], row!.at);
    expect(notices[0]!.draft).toMatchObject({ kind: 'task_outcome', code: 'failed', tool: 'minecraft.login', reason: 'lifecycle_not_started.busy' });
    expect(noticeLine({ kind: 'task_outcome', at: row!.at, detail: notices[0]!.draft } as never, row!.at))
      .toContain('受け付けた〈minecraft.login〉を始められなかった（前の操作の結果がまだ確かめられていない）');
  });

  it('keeps a delivered command while the operator is busy and its frames pause (the Ops login of 16:49)', async () => {
    const f = fixture(), asked = await f.call('minecraft.start', 'start-1'), command = await f.command();
    expect(asked.result.ok).toBe(true);
    f.advance(4000); await delay(80); // No frame for four seconds: the operator is starting the server.
    expect(f.configured.service.store.pending()[0]).toMatchObject({ delivered: true, cancelled: false });
    f.poll({ receipts: [f.receipt(command, { state: { serverId: 'home', observedAt: f.at(), running: 'running', bot: 'absent', otherPlayers: 0 } })] });
    await until(() => f.store.get(command.authority.executionId)!.state === 'completed');
  });

  it('refuses a second operation while one is unresolved, and withdraws a claim the Minecraft slot refused', async () => {
    const f = fixture();
    expect((await f.call('minecraft.start', 'first')).result.ok).toBe(true);
    await f.command();
    expect((await f.call('minecraft.login', 'second')).result).toMatchObject({ ok: false, failure: 'conflict', retryable: false });
    expect(f.configured.service.store.pending()).toHaveLength(1);
    const g = fixture();
    const other = (await g.actions.claim((await g.actions.enqueue({ scopeKey: 'owner', kind: 'minecraft', origin: 'owner_request', sourceId: 'game-request' })).id))!;
    expect(other.state).toBe('running');
    expect((await g.call('minecraft.login', 'blocked')).result).toMatchObject({ ok: false, failure: 'conflict' });
    expect(g.db.prepare("SELECT state FROM mind_actions WHERE kind='minecraft' AND source_id LIKE 'lifecycle:%'").get()?.state).toBe('cancelled');
    expect(g.configured.service.store.pending()).toEqual([]);
  });

  it('gives an unknown operation the one standard exit: the action leaves unknown, and the operator slot and a new request are free', async () => {
    const f = fixture(), asked = await f.call('minecraft.login', 'lost');
    expect(asked.result.ok).toBe(true);
    const command = await f.command();
    f.poll({ receipts: [f.receipt(command, { outcome: 'unknown', code: 'error', inputsReleased: false })] });
    await until(() => f.store.get(command.authority.executionId)!.state === 'unknown');
    expect(f.store.get(command.authority.executionId)).toMatchObject({ result: 'lifecycle_result_unknown', sent: true, resources: [body] });
    expect((await f.call('minecraft.login', 'too-early')).result.failure).toBe('conflict');
    f.advance(600_001); f.store.sweep(f.at()); f.poll();
    expect(f.store.get(command.authority.executionId)).toMatchObject({ state: 'unknown', result: 'outcome_unknown_closed', sent: false });
    expect(f.configured.service.store.unresolved()).toBe(false);
    expect(f.configured.service.store.pending()).toEqual([]);
    expect((await f.call('minecraft.login', 'after-exit')).result.ok).toBe(true);
    const next = await f.command();
    expect(next.id).not.toBe(command.id);
    // A late original receipt still settles the first one; nothing was resent.
    expect(f.configured.service.receipt(command.id)?.outcome).toBe('unknown');
  });

  it('releases the body at the unknown exit only for a lifecycle holder; a body held for play waits for its proof', () => {
    const retained = configuredRetainedResources(values);
    expect(retained(body, [body], { kind: 'minecraft', sourceId: `lifecycle:${'a'.repeat(64)}` })).toBe(false);
    expect(retained(body, [body], { kind: 'minecraft', sourceId: 'ops:11111111-1111-4111-8111-111111111111' })).toBe(false);
    expect(retained(body, [body], { kind: 'respond', sourceId: 'turn-1' })).toBe(false);
    expect(retained(body, [body], { kind: 'agentTask', sourceId: 'fca:task:1' })).toBe(true);
    expect(retained(body, [body], { kind: 'minecraft', sourceId: 'game-request' })).toBe(true);
    expect(retained(body, [body])).toBe(true);
  });
});

/** Owner request through the Minebot lane, 2026-10-14 (body ea1ef4ce): `minecraft.set_day`, the fixed `time set day`. */
describe('minecraft.set_day: the owner alone in a conversation, under its own lifecycle action', () => {
  it('is offered only to the owner alone in text or voice, never in her own time or with others present', () => {
    const named = (surface: 'text' | 'voice' | 'autonomy', audience: 'owner_alone' | 'others') => offeredTools(surface, audience).some(tool => tool.name === 'minecraft.set_day');
    expect(named('text', 'owner_alone')).toBe(true);
    expect(named('voice', 'owner_alone')).toBe(true);
    expect(named('autonomy', 'owner_alone')).toBe(false);
    expect(named('text', 'others')).toBe(false);
    expect(named('voice', 'others')).toBe(false);
  });

  it('answers 「受け付けました」, runs under its own Minecraft action and reports completed/changed as done', async () => {
    const f = fixture(), asked = await f.call('minecraft.set_day', 'day-1');
    expect(asked.result).toMatchObject({ ok: true, evidence: { outcome: 'queued', action: 'set_day', target: { kind: 'minecraft_server', id: 'home' } } });
    expect(asked.result.text).toContain('受け付けました');
    expect(asked.resources).not.toContain(body);
    const command = await f.command();
    expect(command.action).toBe('set_day');
    expect(f.store.get(command.authority.executionId)).toMatchObject({ kind: 'minecraft', origin: 'owner_request', sourceId: command.id, resources: [body] });
    // The body's success: completed/changed, ordinary state only, no stop guard.
    expect(f.poll({ receipts: [f.receipt(command)] }).acknowledged).toEqual([command.id]);
    await until(() => f.store.get(command.authority.executionId)!.state === 'completed');
    const reports = new ActionLeaseReader(f.db).ownLifecycleReceipts('owner');
    expect(lifecycleOutcomeNotices(reports, f.at())[0]!.draft).toMatchObject({ code: 'done', tool: 'minecraft.set_day' });
  });

  it('reports refused/players_present from the body as failed', async () => {
    const f = fixture();
    expect((await f.call('minecraft.set_day', 'day-crowded')).result.ok).toBe(true);
    const command = await f.command();
    const refused = f.receipt(command, { outcome: 'refused', code: 'players_present', state: { serverId: 'home', observedAt: f.at(), running: 'running', bot: 'joined', otherPlayers: 1 } });
    expect(f.poll({ receipts: [refused] }).acknowledged).toEqual([command.id]);
    await until(() => f.store.get(command.authority.executionId)!.state === 'failed');
    const reports = new ActionLeaseReader(f.db).ownLifecycleReceipts('owner');
    expect(lifecycleOutcomeNotices(reports, f.at())[0]!.draft).toMatchObject({ code: 'failed', tool: 'minecraft.set_day' });
  });

  it.each([
    ['a stopped server', { running: 'stopped' as const }, 'サーバーが起動していない'],
    ['another player online', { otherPlayers: 1 }, 'ほかの参加者がいる'],
    // Run 6 (2026-10-14): right after a login the count is not known yet; the reason says so, not that players are present.
    ['an unknown player count', { otherPlayers: null }, 'まだ確かめられない'],
  ])('refuses at once on %s, with nothing admitted or sent', async (_label, patch, text) => {
    const f = fixture();
    f.poll({ states: [{ serverId: 'home', observedAt: f.at(), running: 'running', bot: 'joined', otherPlayers: 0, ...patch }] });
    const asked = await f.call('minecraft.set_day', 'day-refused');
    expect(asked.result).toMatchObject({ ok: false, failure: 'refused', retryable: false });
    expect(asked.result.text).toContain(text);
    expect(f.configured.service.store.pending()).toEqual([]);
    expect(f.db.prepare("SELECT COUNT(*) AS count FROM mind_actions WHERE kind='minecraft'").get()?.count).toBe(0);
  });

  it('a body that never answers set_day (one predating it) ends unknown, and the unknown exit tells her 「受け付けた」 ended without a result', async () => {
    const f = fixture();
    expect((await f.call('minecraft.set_day', 'day-old-body')).result.ok).toBe(true);
    const command = await f.command();
    // The old body drops the action in accept(): no receipt, ever. The deadline cancels it; the outcome is unknown. (The clock moves
    // in steps the action's heartbeat would cover.)
    const id = command.authority.executionId;
    const pass = async (milliseconds: number) => {
      for (let left = milliseconds; left > 0; left -= 10_000) { f.advance(Math.min(10_000, left)); await f.actions.renew(leaseOf(f.store.get(id)!)); await delay(30); }
    };
    await pass(121_000); await until(() => f.configured.service.store.pending()[0]?.cancelled === true);
    await pass(6_000); await until(() => f.store.get(id)!.state === 'unknown');
    expect(f.store.get(command.authority.executionId)).toMatchObject({ result: 'lifecycle_result_unknown' });
    const leases = new ActionLeaseReader(f.db);
    expect(leases.unknownExitedLifecycle('owner')).toEqual([]); // not before the exit: it may still answer
    f.advance(600_001); f.store.sweep(f.at());
    expect(f.store.get(command.authority.executionId)).toMatchObject({ state: 'unknown', result: 'outcome_unknown_closed' });
    const [exited] = leases.unknownExitedLifecycle('owner');
    expect(exited).toMatchObject({ id: command.id, action: 'set_day' });
    const notices = lifecycleOutcomeNotices([{ id: exited!.id, action: exited!.action, outcome: 'unknown', observedAt: exited!.at }], f.at());
    expect(notices[0]!.draft).toMatchObject({ kind: 'task_outcome', code: 'failed', tool: 'minecraft.set_day', reason: 'lifecycle_result_unknown' });
    expect(noticeLine({ kind: 'task_outcome', at: exited!.at, detail: notices[0]!.draft } as never, f.at()))
      .toContain('受け付けた〈minecraft.set_day〉は体から完了の返事がないまま、結果を確かめられずに閉じた');
    // The operator slot is free again for a new request.
    expect(f.configured.service.store.unresolved()).toBe(false);
  });
});

/**
 * Production 2026-10-21 (run 22's clean-up stop, action f67261ba): a stop went on without the body (only lost steps held it) and was
 * interrupted before any receipt. It ended `unknown` with `sent=0` (no dispatch had marked it sent), outside the action store's one
 * unknown exit, so `unresolved()` refused every start, login, logout and stop for good.
 */
describe('an operation that goes on without the body still reaches the one unknown exit (2026-10-21)', () => {
  type Fixture = ReturnType<typeof fixture>;
  /** A live step holding the body, so the operation's own dispatch of it is refused. */
  async function holdBody(f: Fixture) {
    const step = (await f.actions.claim((await f.actions.enqueue({ scopeKey: 'owner', kind: 'agentTask', origin: 'owner_request', sourceId: 'fca:held:1' })).id))!;
    expect(await f.actions.dispatch(leaseOf(step), [body])).toBe(true);
  }
  /** The operator's stop under its own action, taken without the body, carried until its wait is interrupted: the unknown row. */
  async function interruptedStop(f: Fixture, sourceId: string, older: boolean) {
    await holdBody(f);
    const runner = createLifecycleRunner({ actions: f.actions, service: f.configured.service, deviceId: 'operator' })!;
    close.push(() => runner.close());
    const own = (await runner.admit({ scopeKey: 'owner', kind: 'minecraft', origin: 'owner_request', sourceId, ownerInformed: true }, true))!;
    expect(own).not.toBeNull();
    expect(await runner.takeBody(own, () => true)).toBe(true);
    const id = own.execution.lease.id;
    // An older build never marked it sent: its row is the one left behind in production.
    if (older) f.db.prepare('UPDATE mind_actions SET sent=0,effect_sent=0 WHERE id=?').run(id);
    const authority = { scopeKey: 'owner', origin: 'owner_request' as const, executionId: id, lease: own.execution.lease, sourceIds: [sourceId] };
    const job = runner.detach(own, { id: sourceId, serverId: 'home', action: 'stop', authority }, () => {});
    await f.command(); // delivered to the body, so a pause of its frames does not cancel it
    // The command's deadline passes while the action's heartbeat renews its lease; then the cancel wait runs out: no receipt, unknown.
    for (let left = 121_000 + 6_000; left > 0; left -= 10_000) { f.advance(Math.min(10_000, left)); await f.actions.renew(leaseOf(f.store.get(id)!)); await delay(30); }
    await job;
    return id;
  }

  it.each([['dispatches without a resource, so the action is sent', false], ['a row an older build left with sent=0', true]])(
    'an interrupted stop (%s) leaves unknown, and the one exit closes it as outcome_unknown_closed and frees the operator', async (_label, older) => {
      const f = fixture(), id = await interruptedStop(f, `lifecycle:${(older ? 'e' : 'f').repeat(64)}`, older);
      expect(f.store.get(id)).toMatchObject({ kind: 'minecraft', state: 'unknown', result: 'lifecycle_result_unknown', sent: !older, resources: [] });
      expect(f.configured.service.store.unresolved()).toBe(true);
      f.store.sweep(f.at());
      expect(f.store.get(id)).toMatchObject({ state: 'unknown', result: 'lifecycle_result_unknown' }); // not before the exit is due
      expect(f.configured.service.store.unresolved()).toBe(true);
      f.advance(600_001); f.store.sweep(f.at());
      expect(f.store.get(id)).toMatchObject({ state: 'unknown', result: 'outcome_unknown_closed', sent: false, resources: [] });
      expect(f.db.prepare('SELECT effect_sent FROM mind_actions WHERE id=?').get(id)?.effect_sent).toBe(1);
      expect(f.configured.service.store.unresolved()).toBe(false);
      expect(new ActionLeaseReader(f.db).unknownExitedLifecycle('owner')).toMatchObject([{ action: 'stop' }]);
      // Closed once: a second sweep changes nothing.
      const closedAt = f.store.get(id)!.updatedAt;
      f.advance(1000); f.store.sweep(f.at());
      expect(f.store.get(id)!.updatedAt).toBe(closedAt);
    }, 20_000);

  it('closes only a lifecycle operation: other unsent unknown rows are left as they are', async () => {
    const f = fixture();
    const other = async (kind: 'minecraft' | 'agentTask', sourceId: string, code: string) => {
      const view = (await f.actions.claim((await f.actions.enqueue({ scopeKey: 'owner', kind, origin: 'owner_request', sourceId })).id))!;
      await f.actions.finish(leaseOf(view), 'unknown', code);
      return view.id;
    };
    const ids = [await other('minecraft', 'game-request', 'something_else'), await other('agentTask', 'fca:other:1', 'lifecycle_result_unknown')];
    f.advance(600_001); f.store.sweep(f.at());
    for (const id of ids) expect(f.store.get(id)).toMatchObject({ state: 'unknown', sent: false });
    expect(ids.map(id => f.store.get(id)!.result)).toEqual(['something_else', 'lifecycle_result_unknown']);
  });

  it('takes the body as before when it is free, and never asks whether only lost steps hold it', async () => {
    const f = fixture();
    const runner = createLifecycleRunner({ actions: f.actions, service: f.configured.service, deviceId: 'operator' })!;
    close.push(() => runner.close());
    const own = (await runner.admit({ scopeKey: 'owner', kind: 'minecraft', origin: 'owner_request', sourceId: `lifecycle:${'d'.repeat(64)}` }, true))!;
    expect(await runner.takeBody(own, () => { throw new Error('asked'); })).toBe(true);
    expect(f.store.get(own.execution.lease.id)).toMatchObject({ state: 'running', sent: true, resources: [body] });
  });

  it('is refused as before when the body is held and not only by lost steps', async () => {
    const f = fixture();
    await holdBody(f);
    const runner = createLifecycleRunner({ actions: f.actions, service: f.configured.service, deviceId: 'operator' })!;
    close.push(() => runner.close());
    for (const [index, bypass] of [undefined, () => false].entries()) {
      const own = (await runner.admit({ scopeKey: 'owner', kind: 'minecraft', origin: 'owner_request', sourceId: `lifecycle:${String(index).repeat(64)}` }, true))!;
      expect(await runner.takeBody(own, bypass)).toBe(false);
      expect(f.store.get(own.execution.lease.id)).toMatchObject({ state: 'cancelled', result: 'lifecycle_body_unavailable', sent: false });
    }
  });

  it('closes as cancelled when the dispatch without the body is refused too', async () => {
    const calls: Array<readonly string[] | undefined> = [], closed: Array<[string, string]> = [];
    const actions = { dispatch: async (_lease: unknown, keys?: readonly string[]) => { calls.push(keys); return false; } };
    const runner = createLifecycleRunner({ actions: actions as never, service: {} as never, deviceId: 'operator' })!;
    const active = { execution: { lease: { id: 'own', generation: 1, holder: 'h' } }, finish: async (state: string, code: string) => { closed.push([state, code]); } };
    expect(await runner.takeBody(active as never, () => true)).toBe(false);
    expect(calls).toEqual([[body], []]);
    expect(closed).toEqual([['cancelled', 'lifecycle_body_unavailable']]);
  });
});


/**
 * The 2026-10-14 incident (production 75a2364c): 「シャノン、マイクラにログインして」 in a voice turn. The first `minecraft.login`
 * failed its input check (invalid_input), the retry in the same turn was accepted, and the body's receipt (completed/changed)
 * came two seconds later. Her next voice turn read the trace 「minecraft.login → できなかった」 beside 「できた」, no
 * 【知らせ:作業終了】 (it enters at 0.5, the voice line was 0.6), and she said she had not got in. Logout did the same at 20:56.
 */
describe('a lifecycle operation retried after a failed first try reaches her next turn as its latest outcome', () => {
  const ACTIONS = ['login', 'logout', 'start', 'stop', 'set_day'] as const;

  it.each(ACTIONS)('minecraft.%s: an invalid first try, an accepted retry, one completed receipt: one done notice, and success in the next turn', async action => {
    const f = fixture(), name = `minecraft.${action}`;
    const inputs = [{ server: 'home' }, {}];
    const [first, second] = await f.calls(name, `incident-${action}`, inputs);
    expect(first).toMatchObject({ ok: false, failure: 'invalid_input' });
    expect(second).toMatchObject({ ok: true, evidence: { outcome: 'queued', action } });
    // Only the retry made an operation and its own action.
    const command = await f.command();
    expect(f.db.prepare("SELECT COUNT(*) AS count FROM mind_actions WHERE kind='minecraft'").get()?.count).toBe(1);

    // Her trace of that turn, as the next turn of the same Talk replays it, with the outcome read at that moment.
    const leases = new ActionLeaseReader(f.db);
    const log = new ToolTurnLog(new InMemoryToolTraces(), f.at, (scopeKey, ids) => leases.lifecycleOutcomes(scopeKey, ids));
    const opened = log.open('owner', 'thread', 'シャノン、マイクラのことお願い', false, `utterance-${action}`);
    [first, second].forEach((result, index) => opened.called(toolTraceCall(name, JSON.stringify(inputs[index]), result!, undefined)));
    log.turnStored('owner', 'thread', 'turn-1', 'シャノン、マイクラのことお願い', true, `utterance-${action}`);
    const replayed = () => toolTracePrompt(log.traces('owner', 'thread', ['turn-1']).map(record => ({ record, label: traceLabel(1) })));
    expect(replayed()).toContain(`${name} → 受け付けた。まだ結果は届いていない`);
    expect(replayed()).not.toContain('できなかった');

    // The state the body reports with its receipt: after a logout she is gone, after a stop the server is down.
    const after = action === 'logout' ? { bot: 'absent' as const } : action === 'stop' ? { running: 'stopped' as const, bot: 'absent' as const } : { bot: 'joined' as const };
    const done = f.receipt(command, { state: { serverId: 'home', observedAt: f.at(), running: 'running', otherPlayers: 0, ...after },
      ...(action === 'stop' ? { stopGuard: { admissionClosed: true as const, otherPlayers: 0 as const, checkedAt: f.at() } } : {}) });
    expect(f.poll({ receipts: [done] }).acknowledged).toEqual([command.id]);
    await until(() => f.store.get(command.authority.executionId)!.state === 'completed');
    expect(replayed()).toContain(`${name} → 受け付けた。そのあと体から完了の返事が届いた（終わった）`);
    expect(replayed()).not.toContain('できなかった');

    // Exactly one notice, done, from the one receipt (the failed first try made none).
    const reports = [...leases.ownLifecycleReceipts('owner'),
      ...leases.notStartedLifecycle('owner').map(row => ({ id: row.id, action, outcome: 'failed', observedAt: row.at })),
      ...leases.unknownExitedLifecycle('owner').map(row => ({ id: row.id, action: row.action, outcome: 'unknown', observedAt: row.at }))];
    const notices = lifecycleOutcomeNotices(reports, f.at());
    expect(notices).toHaveLength(1);
    expect(notices[0]!.draft).toMatchObject({ kind: 'task_outcome', code: 'done', tool: name });
    expect(notices[0]!.draft).not.toHaveProperty('reason');

    // The next turn is voice (as at 20:46:44): the notice is said there although it entered below the voice line.
    const event = inboxPerception({ draft: notices[0]!.draft, at: notices[0]!.at, seq: 1 })!;
    const scope = emptyScope();
    const initial = initialSalience(event, []);
    expect(initial).toBeLessThan(PROMPT_LAYOUT_LIMITS.voice.minimumSalience);
    applyOp(scope, { op: 'perceive', event, initial, detail: { code: 'done', tool: name, reason: null }, at: event.time });
    const later = new Date(Date.parse(f.at()) + 150_000).toISOString();
    const voice = workspaceBlocks(scope, { surface: 'voice', present: OWNER_AUDIENCE, at: later, currentItemId: null, current: null, dataFrames: false, text: () => null });
    expect(voice).toContain(`${NOTICE_MARKERS.task_outcome}2分前、〈${name}〉が終わった`);
    expect(voice).not.toContain('うまくいかず');
  });

  it.each(ACTIONS)('minecraft.%s: an empty serverId (what a model writes for a value it does not know) is absent, and runs at once', async action => {
    const f = fixture(), name = `minecraft.${action}`;
    const [result] = await f.calls(name, `empty-${action}`, [{ serverId: '' }]);
    expect(result).toMatchObject({ ok: true, evidence: { outcome: 'queued', action, target: { kind: 'minecraft_server', id: 'home' } } });
    // An unknown id is still refused by the executor, and a field that is not in the schema by the input check.
    const g = fixture();
    expect((await g.calls(name, `unknown-${action}`, [{ serverId: 'elsewhere' }]))[0]).toMatchObject({ ok: false, failure: 'invalid_input' });
    expect((await g.calls(name, `field-${action}`, [{ reason: 'ライ氏に頼まれた' }]))[0]).toMatchObject({ ok: false, failure: 'invalid_input' });
  });

  it('tells the other ends of an accepted operation as they are, and keeps a failure that was never followed by a success', async () => {
    const f = fixture(), [accepted] = await f.calls('minecraft.login', 'refused-login', [{}]);
    const command = await f.command();
    f.poll({ receipts: [f.receipt(command, { outcome: 'refused', code: 'players_present' })] });
    await until(() => f.store.get(command.authority.executionId)!.state === 'failed');
    const leases = new ActionLeaseReader(f.db);
    expect(leases.lifecycleOutcomes('owner', [command.id, `lifecycle:${'c'.repeat(64)}`, 'not-an-operation'])).toEqual(new Map([[command.id, 'refused']]));
    const call = toolTraceCall('minecraft.login', '{}', accepted!, undefined);
    expect(call).toMatchObject({ ok: true, operation: command.id });
    const line = toolTracePrompt([{ record: { turnId: 't', threadId: 'thread', recordedAt: f.at(), asked: false, calls: [{ ...call, latest: 'refused' }] }, label: traceLabel(1) }]);
    expect(line).toContain('minecraft.login → 受け付けた。そのあと体が断った（できなかった）');
    // A failure stays when nothing after it in the turn succeeded with the same tool and target.
    const failed = { tool: 'minecraft.login', ok: false, failure: 'invalid_input' };
    expect(supersededFailuresDropped([failed, { tool: 'minecraft.status', ok: true }])).toEqual([failed, { tool: 'minecraft.status', ok: true }]);
    expect(supersededFailuresDropped([{ tool: 'folder.read', target: 'a', ok: false, failure: 'refused' }, { tool: 'folder.read', target: 'b', ok: true }])).toHaveLength(2);
    expect(supersededFailuresDropped([{ tool: 'minecraft.login', ok: true }, failed])).toHaveLength(2);
  });
});

/**
 * The review of 1360e94d (2026-10-14): what a later turn is told of a turn's calls hides only a refusal decided before anything
 * ran, and only when it is known that the same thing then succeeded; an outcome that cannot be read says only 「受け付けた」; the
 * voice turn puts a task's end first once, not for an hour.
 */
describe('what a later turn is told of a failed try, an unreadable outcome and a task\'s end in voice', () => {
  const HIDDEN = '（伏せた）';
  it('keeps every failure it cannot know was superseded (the review\'s repros), and drops only a refusal before execution of the same thing', () => {
    // timer.start(300) failed, timer.start(600) succeeded: no target, so the two are not known to be the same.
    const timer = [{ tool: 'timer.start', ok: false, failure: 'invalid_input' }, { tool: 'timer.start', ok: true }];
    expect(supersededFailuresDropped(timer)).toEqual(timer);
    // aetherFolder.delete(A) conflicted, delete(B) succeeded; also with the same target, a conflict is after execution.
    const deletes = [{ tool: 'aetherFolder.delete', target: 'A', ok: false, failure: 'conflict' }, { tool: 'aetherFolder.delete', target: 'B', ok: true }];
    expect(supersededFailuresDropped(deletes)).toEqual(deletes);
    const same = [{ tool: 'aetherFolder.delete', target: 'A', ok: false, failure: 'conflict' }, { tool: 'aetherFolder.delete', target: 'A', ok: true }];
    expect(supersededFailuresDropped(same)).toEqual(same);
    // folder.read of two secrets: both targets read （伏せた）, which says nothing of whether they are the same.
    const secrets = [{ tool: 'folder.read', target: HIDDEN, ok: false, failure: 'invalid_input' }, { tool: 'folder.read', target: HIDDEN, ok: true }];
    expect(supersededFailuresDropped(secrets)).toEqual(secrets);
    // A timeout may have run: the retry may be a second execution, and both stay.
    const timeout = [{ tool: 'folder.write', target: 'notes/a.md', ok: false, failure: 'timeout' }, { tool: 'folder.write', target: 'notes/a.md', ok: true }];
    expect(supersededFailuresDropped(timeout)).toEqual(timeout);
    // A web read and a research call without a target, and a lifecycle retry that was not accepted as an operation, stay too.
    expect(supersededFailuresDropped([{ tool: 'web.read', ok: false, failure: 'not_offered' }, { tool: 'web.read', ok: true }])).toHaveLength(2);
    expect(supersededFailuresDropped([{ tool: 'minecraft.login', ok: false, failure: 'invalid_input' }, { tool: 'minecraft.login', ok: true }])).toHaveLength(2);

    // Dropped: the same real target refused by the input check, then read; the same lifecycle operation refused, then accepted.
    const read = { tool: 'folder.read', target: 'notes/a.md', ok: true };
    expect(supersededFailuresDropped([{ tool: 'folder.read', target: 'notes/a.md', ok: false, failure: 'invalid_input' }, read])).toEqual([read]);
    const accepted = { tool: 'minecraft.login', ok: true, operation: `lifecycle:${'e'.repeat(64)}` };
    expect(supersededFailuresDropped([{ tool: 'minecraft.login', ok: false, failure: 'invalid_input' }, accepted])).toEqual([accepted]);
    expect(supersededFailuresDropped([{ tool: 'minecraft.login', ok: false, failure: 'unavailable' }, accepted])).toHaveLength(2);
  });

  it('says only 「受け付けた」 when how the operation ended cannot be read, and reads every id however many', async () => {
    const f = fixture(), [first] = await f.calls('minecraft.login', 'unreadable', [{}]);
    const command = await f.command();
    const call = toolTraceCall('minecraft.login', '{}', first!, undefined);
    const replay = (outcomes: ConstructorParameters<typeof ToolTurnLog>[2]) => {
      const log = new ToolTurnLog(new InMemoryToolTraces(), f.at, outcomes);
      log.open('owner', 'thread', 'ログインして', false, 'u').called(call);
      log.turnStored('owner', 'thread', 'turn-1', 'ログインして', true, 'u');
      return toolTracePrompt(log.traces('owner', 'thread', ['turn-1']).map(record => ({ record, label: traceLabel(1) })));
    };
    for (const unreadable of [() => null, () => { throw new Error('SQLITE_BUSY'); }]) {
      const said = replay(unreadable);
      expect(said).toContain('minecraft.login → 受け付けた');
      expect(said).not.toContain('まだ結果は届いていない');
      expect(said).not.toContain('そのあと');
    }
    expect(replay(() => new Map())).toContain('minecraft.login → 受け付けた。まだ結果は届いていない');
    // No limit of 12: the one real operation behind 150 others is read.
    const leases = new ActionLeaseReader(f.db);
    f.poll({ receipts: [f.receipt(command)] });
    await until(() => f.store.get(command.authority.executionId)!.state === 'completed');
    const others = Array.from({ length: 150 }, (_, index) => `lifecycle:${index.toString(16).padStart(64, '0')}`);
    expect(leases.lifecycleOutcomes('owner', [...others, command.id])).toEqual(new Map([[command.id, 'completed']]));
    // Without its tables nothing can be known (null), which is not 「not ended」.
    const empty = new ActionLeaseReader(new (await import('node:sqlite')).DatabaseSync(':memory:'));
    expect(empty.lifecycleOutcomes('owner', [command.id])).toBeNull();
  });

  it('puts only the newest task end first in a voice turn, only in the first voice turn after it, and never for long', () => {
    const START = Date.parse('2026-10-14T05:00:00.000Z');
    const time = (seconds: number) => new Date(START + seconds * 1_000).toISOString();
    const scope = emptyScope();
    const perceive = (event: ReturnType<typeof inboxPerception>, code: string | null = null, tool: string | null = null) => {
      applyOp(scope, { op: 'perceive', event: event!, initial: initialSalience(event!, []), detail: code ? { code, tool, reason: null } : null, at: event!.time });
      return event!;
    };
    const ended = (tool: string, seconds: number, seq: number) => perceive(inboxPerception({ draft: { kind: 'task_outcome', code: 'done', audience: 'owner',
      source: 'api', sourceId: `${tool}@${seconds}`, tool }, at: time(seconds), seq }), 'done', tool);
    ended('minecraft.start', 0, 1);
    ended('minecraft.login', 10, 2);
    // A promise's time, which is strong enough for voice: it is not kept out by the ends.
    const promise = perceive(inboxPerception({ draft: { kind: 'promise_due', code: 'due', audience: 'owner', source: 'api', sourceId: 'promise-p-1@1', deltaMinutes: 0 },
      at: time(20), seq: 3 }), 'due');
    const voice = (seconds: number, currentItemId: string | null = null) => workspaceBlocks(scope, { surface: 'voice', present: OWNER_AUDIENCE, at: time(seconds),
      currentItemId, current: { surface: 'voice', sourceId: 'voice-thread' }, dataFrames: false, text: () => null });
    const now = voice(60);
    expect(now.split('\n')[1]).toContain('〈minecraft.login〉が終わった');
    expect(now).not.toContain('minecraft.start');
    expect(initialSalience(promise, [])).toBeGreaterThanOrEqual(PROMPT_LAYOUT_LIMITS.voice.minimumSalience);
    expect(now).toContain(NOTICE_MARKERS.promise_due);

    // This turn's own utterance (in the same voice Talk) does not count as a turn that had it.
    const utterance = voicePerception({ threadId: 'voice-thread', transcript: 'おはよう', present: OWNER_AUDIENCE, alone: true, guest: false, at: time(70) })!;
    applyOp(scope, { op: 'perceive', event: utterance, initial: initialSalience(utterance, []), detail: null, at: utterance.time });
    expect(voice(70, utterance.id)).toContain('〈minecraft.login〉が終わった');
    // The next voice turn of the same Talk: the turn before had it first, so it is ranked by salience (0.5, below the voice line).
    const next = voicePerception({ threadId: 'voice-thread', transcript: 'ありがとう', present: OWNER_AUDIENCE, alone: true, guest: false, at: time(90) })!;
    applyOp(scope, { op: 'perceive', event: next, initial: initialSalience(next, []), detail: null, at: next.time });
    expect(voice(90, next.id)).not.toContain('minecraft.login');

    // Without a voice turn in between, it is first for at most ten minutes.
    const fresh = emptyScope();
    const event = inboxPerception({ draft: { kind: 'task_outcome', code: 'done', audience: 'owner', source: 'api', sourceId: 'x@1', tool: 'minecraft.stop' }, at: time(0), seq: 1 })!;
    applyOp(fresh, { op: 'perceive', event, initial: initialSalience(event, []), detail: { code: 'done', tool: 'minecraft.stop', reason: null }, at: event.time });
    const layout = (seconds: number) => workspaceBlocks(fresh, { surface: 'voice', present: OWNER_AUDIENCE, at: time(seconds), currentItemId: null, current: null,
      dataFrames: false, text: () => null });
    expect(layout(VOICE_ENDED_FIRST_MINUTES * 60)).toContain('minecraft.stop');
    expect(layout(VOICE_ENDED_FIRST_MINUTES * 60 + 1)).not.toContain('minecraft.stop');
  });
});

/** Owner decision 2026-10-14: the runner's `settled` drives telling him, once, with the Talk it was asked in. */
describe('a conversation\'s lifecycle operation is told to him when it settles', () => {
  it.each([
    ['completed', { outcome: 'completed', code: 'changed' }],
    ['refused', { outcome: 'refused', code: 'players_present' }],
  ] as const)('%s: one report with its operation, action, end and Talk', async (end, patch) => {
    const reports: LifecycleOutcomeReport[] = [];
    const f = fixture(async report => { reports.push(report); });
    const [accepted] = await f.calls('minecraft.login', `told-${end}`, [{}]);
    expect(accepted).toMatchObject({ ok: true });
    const command = await f.command();
    expect(reports).toEqual([]);
    f.poll({ receipts: [f.receipt(command, patch)] });
    await until(() => reports.length === 1);
    expect(reports).toEqual([{ scopeKey: 'owner', threadId: 'thread', operationId: command.id, action: 'login', outcome: end }]);
    f.poll({ receipts: [f.receipt(command, patch)] });
    await delay(20);
    expect(reports).toHaveLength(1);
  });

  it('a call refused by the input check (nothing accepted) tells him nothing', async () => {
    const reports: LifecycleOutcomeReport[] = [];
    const f = fixture(async report => { reports.push(report); });
    expect((await f.calls('minecraft.login', 'bad', [{ server: 'home' }]))[0]).toMatchObject({ ok: false, failure: 'invalid_input' });
    await delay(20);
    expect(reports).toEqual([]);
  });
});
