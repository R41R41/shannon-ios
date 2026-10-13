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
import { noticeLine } from '../src/mind/workspace/promptLayout.js';
import { offeredTools } from '../src/mind/tools/shannonTools.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { inActionExecution, type ActionExecution } from '../src/infra/context/actionExecution.js';
import { actionResource, leaseOf } from '../src/contracts/actionThreadContract.js';
import { toolSessionMemory } from '../src/mind/tools/shannonToolTypes.js';
import type { MinecraftLifecycleCommand, MinecraftLifecyclePoll, MinecraftLifecycleReceipt, MinecraftLifecycleState } from '../src/contracts/minecraftLifecycleContract.js';

// Syzygy ADR-0009 stage 1 S7 and the 2026-10-13 TI-REQ: a conversation's lifecycle request runs under its own Minecraft action.
const close: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const finish of close.splice(0).reverse()) await finish(); });
const values = { SHANNON_MINECRAFT_LIFECYCLE: 'on', SHANNON_ADR8_STAGE4: 'on', SHANNON_MINECRAFT_LIFECYCLE_SERVERS: '["home"]',
  SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'operator', servers: [{ serverId: 'home', title: 'Home', ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146', onlineMode: true }] }) };
const body = actionResource('operator', 'minecraft-body');
async function until(test: () => boolean) { for (let i = 0; i < 500; i++) { if (test()) return; await delay(2); } expect(test()).toBe(true); }

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-lifecycle-detached-')), path = join(directory, 'store.sqlite');
  close.push(() => rmSync(directory, { recursive: true, force: true }));
  let at = '2026-10-13T07:49:13.000Z', alone = true, sequence = 0;
  const store = new SQLiteAutonomyStore(path); close.push(() => store.close());
  const autonomy = new ShannonAutonomyService({ store, config: configuredAutonomy({ SHANNON_AUTONOMY_ENABLED: 'true' }), now: () => at });
  const h = actionHarness(() => at, path); close.push(h.close);
  const configured = configuredMinecraftLifecycle(values, { path, autonomy, actions: h.actions, ownerAlone: () => alone,
    taskAllowed: () => false, now: () => at })!;
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
  const receipt = (command: MinecraftLifecycleCommand, patch: Partial<MinecraftLifecycleReceipt> = {}): MinecraftLifecycleReceipt => ({ id: command.id,
    connectionId: command.connectionId, serverId: command.serverId, action: command.action, outcome: 'completed', code: 'changed', observedAt: at,
    inputsReleased: true, state: state({ bot: 'joined' }), ...patch });
  const command = async () => { await until(() => configured.service.store.pending().length === 1); return poll().commands[0]!; };
  return { ...h, configured, principal, poll, call, receipt, command, at: () => at,
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
    ['an unknown player count', { otherPlayers: null }, 'ほかの参加者がいる'],
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

