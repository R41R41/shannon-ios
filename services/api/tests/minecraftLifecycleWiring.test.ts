import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { configuredMinecraftLifecycle } from '../src/wiring/minecraftLifecycleWiring.js';
import { configuredAutonomy } from '../src/mind/inhibition/autonomyBudget.js';
import { ShannonAutonomyService } from '../src/mind/action/ownTime/autonomyService.js';
import { SQLiteAutonomyStore } from '../src/wiring/autonomyStoreWiring.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { inActionExecution, type ActionExecution } from '../src/infra/context/actionExecution.js';
import { conversationTools } from '../src/mind/tools/shannonToolSession.js';
import { TurnDeadline, TEXT_TURN_DEADLINE, VOICE_TURN_DEADLINE } from '../src/mind/action/respond/turnDeadline.js';
import { foregroundRunner } from '../src/wiring/actionExecutionWiring.js';
import { leaseOf } from '../src/contracts/actionThreadContract.js';
import { toolSessionMemory } from '../src/mind/tools/shannonToolTypes.js';
import type { MinecraftLifecycleCommand, MinecraftLifecyclePoll, MinecraftLifecycleReceipt, MinecraftLifecycleState } from '../src/contracts/minecraftLifecycleContract.js';
const close: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const finish of close.splice(0).reverse()) await finish(); });
const values = { SHANNON_MINECRAFT_LIFECYCLE: 'on', SHANNON_ADR8_STAGE4: 'on', SHANNON_MINECRAFT_LIFECYCLE_SERVERS: '["home"]',
  SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'operator', servers: [{ serverId: 'home', title: 'Home', ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146', onlineMode: true }] }) };
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-lifecycle-wiring-')), path = join(directory, 'store.sqlite'); close.push(() => rmSync(directory, { recursive: true, force: true }));
  let at = '2026-10-09T00:00:00.000Z', alone = true, taskAllowed = true, sequence = 0, taskSources:readonly string[]|null=[];
  const store = new SQLiteAutonomyStore(path); close.push(() => store.close());
  const autonomy = new ShannonAutonomyService({ store, config: configuredAutonomy({ SHANNON_AUTONOMY_ENABLED: 'true' }), now: () => at });
  const h = actionHarness(() => at, path); close.push(h.close);
  const configured = configuredMinecraftLifecycle(values, { path, autonomy, ownerAlone: () => alone, taskAllowed: () => taskAllowed, taskSources:()=>taskSources, now: () => at })!; close.push(configured.close);
  const principal = { scopeKey: 'owner', deviceId: 'operator' };
  const state = (patch: Partial<MinecraftLifecycleState> = {}): MinecraftLifecycleState => ({ serverId: 'home', observedAt: at, running: 'stopped', bot: 'absent', otherPlayers: 0, ...patch });
  const poll = (patch: Partial<MinecraftLifecyclePoll> = {}) => configured.service.poll(principal, { schemaVersion: 1, connectionId: 'connection', sequence: sequence++, states: [state()], receipts: [], ...patch });
  poll();
  const active = async (kind: 'respond' | 'ownTime' | 'agentTask' = 'respond') => {
    const draft = { scopeKey: 'owner', kind, origin: kind === 'ownTime' ? 'own_time' as const : 'owner_request' as const, sourceId: `request-${kind}-${sequence++}` };
    const view = kind === 'respond' ? await h.actions.admitRespond(draft) : await h.actions.claim((await h.actions.enqueue(draft)).id);
    const controller = new AbortController(), lease = leaseOf(view!);
    const execution: ActionExecution = { lease, signal: controller.signal, permit: async resources => h.actions.dispatch(execution.lease, resources) };
    return { execution, controller, view: view! };
  };
  const context = (surface: 'text' | 'autonomy' = 'text', identity = 'operation-1') => ({ scopeKey: 'owner', surface, audience: 'owner_alone' as const,
    memory: { ...toolSessionMemory(), turnKey: identity }, acknowledgementOwner: 'fca' as const });
  const receipt = (command: MinecraftLifecycleCommand, patch: Partial<MinecraftLifecycleReceipt> = {}): MinecraftLifecycleReceipt => ({ id: command.id, connectionId: command.connectionId,
    serverId: command.serverId, action: command.action, outcome: 'completed', code: 'changed', observedAt: at, inputsReleased: true,
    state: state({ running: 'running', bot: command.action === 'login' ? 'joined' : 'absent' }), ...patch });
  return { ...h, autonomyStore: store, autonomy, configured, principal, state, poll, active, context, receipt,
    alone(value: boolean) { alone = value; }, taskAllowed(value: boolean) { taskAllowed = value; }, taskSources(value:readonly string[]|null) { taskSources=value; }, advance(ms: number) { at = new Date(Date.parse(at) + ms).toISOString(); } };
}
async function until(condition: () => boolean) { for (let index = 0; index < 100; index++) { if (condition()) return; await Promise.resolve(); } expect(condition()).toBe(true); }

describe('configured Minecraft lifecycle through real registry, autonomy gate and original SQLite lease', () => {
  it.each(['owner_request', 'own_time'] as const)('offers offline status and performs start/login under %s original authority', async origin => {
    const f = fixture(), own = origin === 'own_time', a = await f.active(own ? 'ownTime' : 'respond'), surface = own ? 'autonomy' as const : 'text' as const;
    if (own) expect(f.autonomy.inspectAuthorization('owner', { domain: 'minecraft_lifecycle', summary: 'Start the registered server' })).toMatchObject({ decision: 'allow' });
    const names = f.autonomy.tools.offered(surface, 'owner_alone', 'owner').map(tool => tool.name);
    expect(names).toContain('minecraft.start'); expect(names).toContain('minecraft.login');
    expect(f.autonomy.tools.offered(surface, 'others', 'owner').map(tool => tool.name)).not.toContain('minecraft.start');
    const status = await f.autonomy.tools.call('minecraft.lifecycle_status', {}, f.context(surface));
    expect(status.ok).toBe(true); expect(JSON.parse(status.text)[0]).toMatchObject({ running: 'stopped', bot: 'absent' });
    for (const name of ['minecraft.start', 'minecraft.login']) {
      const result = inActionExecution(a.execution, () => f.autonomy.tools.call(name, {}, f.context(surface, name), a.execution.signal));
      await until(() => f.configured.service.store.pending().length === 1);
      const command = f.poll().commands[0]!;
      expect(command.authority).toMatchObject({ origin, executionId: a.execution.lease.id, lease: a.execution.lease });
      expect(f.configured.service.authorize(f.principal, command.id)).toBe(true);
      expect(f.poll({ receipts: [f.receipt(command)] }).acknowledged).toEqual([command.id]);
      expect(await result).toMatchObject({ ok: true, evidence: { outcome: 'applied', action: command.action,
        target: { kind: 'minecraft_server', id: command.serverId }, operationId: command.id, receiptId: command.id } });
      expect(a.execution.stepOutcome).toBe('acknowledged');
    }
    expect(f.configured.service.safe(a.execution.lease.id)).toBe(true);
  });
  it('assigns distinct native lifecycle command identities to start → stop → start in one actual conversation session', async () => {
    const f = fixture(), a = await f.active();
    const session = conversationTools(f.autonomy, 'owner', 'text', true, { audience: { othersKnown: () => false, noteOthers() {} }, secrets: () => ({ carries: () => false }) },
      'thread\nマイクラを起動し、停止し、もう一度起動して', new TurnDeadline(TEXT_TURN_DEADLINE)).tools!;
    const ids: string[] = [];
    await inActionExecution(a.execution, async () => {
      for (const action of ['start', 'stop', 'start'] as const) {
        const result = session.call(`minecraft_${action}`, '{}');
        await until(() => f.configured.service.store.pending().length === 1); const command = f.poll().commands[0]!; ids.push(command.id);
        const stopPatch = action === 'stop' ? { state: f.state({ running: 'stopped' }), stopGuard: { admissionClosed: true as const, otherPlayers: 0 as const, checkedAt: f.state().observedAt } } : {};
        f.poll({ receipts: [f.receipt(command, stopPatch)] });
        expect(JSON.parse(await result)).toMatchObject({ ok: true });
      }
    });
    expect(new Set(ids).size).toBe(3);
  });
  it('offers offline lifecycle login for reliable voice Minecraft intent without an existing game body', async () => {
    const f = fixture();
    const session = conversationTools(f.autonomy, 'owner', 'voice', true, { audience: { othersKnown: () => false, noteOthers() {} }, secrets: () => ({ carries: () => false }) },
      'thread\nマイクラに入ってきて', new TurnDeadline(VOICE_TURN_DEADLINE), { trust: 'reliable' }).tools;
    expect(session?.definitions.map(tool => tool.name)).toContain('minecraft.login');
    const uncertain = conversationTools(f.autonomy, 'owner', 'voice', true, { audience: { othersKnown: () => false, noteOthers() {} } },
      'thread\nマイクラに入ってきて', new TurnDeadline(VOICE_TURN_DEADLINE), { trust: 'uncertain' }).tools;
    expect(uncertain?.definitions.map(tool => tool.name)).not.toContain('minecraft.login');
    expect(uncertain?.definitions.map(tool => tool.name)).toContain('minecraft.lifecycle_status');
  });
  it('denies no original action, stale generation, mismatched owner/own-time origin and unavailable task sources', async () => {
    const f = fixture();
    expect((await f.autonomy.tools.call('minecraft.start', {}, f.context())).failure).toBe('refused');
    const a = await f.active(); a.execution.lease = { ...a.execution.lease, generation: a.execution.lease.generation + 1 };
    await expect(inActionExecution(a.execution, () => f.autonomy.tools.call('minecraft.start', {}, f.context(), a.execution.signal))).rejects.toThrow('ACTION_STOPPED');
    await f.actions.finish(leaseOf(a.view), 'completed', 'test_finished');
    const own = await f.active('ownTime');
    expect((await inActionExecution(own.execution, () => f.autonomy.tools.call('minecraft.start', {}, f.context('text'), own.execution.signal))).failure).toBe('refused');
    await f.actions.finish(own.execution.lease, 'completed', 'test_finished');
    const task = await f.active('agentTask'); f.taskAllowed(false);
    expect((await inActionExecution(task.execution, () => f.autonomy.tools.call('minecraft.start', {}, f.context(), task.execution.signal))).failure).toBe('refused');
    expect(f.configured.service.store.pending()).toEqual([]);
  });
  it('rechecks the real own-time pause gate without appending repeated authorization decisions', async () => {
    const f = fixture(), a = await f.active('ownTime'); f.autonomy.setPaused('owner', true);
    const before = f.autonomy.activityDays('owner', 1).flatMap(day => day.entries).filter(entry => entry.kind === 'decision').length;
    expect((await inActionExecution(a.execution, () => f.autonomy.tools.call('minecraft.start', {}, f.context('autonomy'), a.execution.signal))).failure).toBe('refused');
    expect(f.configured.service.store.pending()).toEqual([]);
    expect(f.autonomy.activityDays('owner', 1).flatMap(day => day.entries).filter(entry => entry.kind === 'decision')).toHaveLength(before);
  });
  it('removes tools when operator snapshots age and gates other scopes, people and unregistered servers', async () => {
    const f = fixture();
    expect(f.autonomy.tools.offered('autonomy', 'owner_alone', 'outsider').map(tool => tool.name)).not.toContain('minecraft.start');
    expect((await f.autonomy.tools.call('minecraft.start', { serverId: 'other' }, f.context())).failure).toBe('invalid_input');
    expect((await f.autonomy.tools.call('minecraft.lifecycle_status', {}, { ...f.context(), audience: 'others' })).failure).toBe('not_offered');
    f.advance(3001);
    expect(f.autonomy.tools.offered('text', 'owner_alone', 'owner').map(tool => tool.name)).not.toContain('minecraft.start');
    expect((await f.autonomy.tools.call('minecraft.lifecycle_status', {}, f.context())).failure).toBe('unavailable');
    f.poll(); expect(f.autonomy.tools.offered('autonomy', 'owner_alone', 'owner').map(tool => tool.name)).toContain('minecraft.start');
  });
  it('requires atomic native empty-player guard for stop and holds the original operation until acknowledgement', async () => {
    const f = fixture(), a = await f.active();
    const result = inActionExecution(a.execution, () => f.autonomy.tools.call('minecraft.stop', {}, f.context(), a.execution.signal));
    await until(() => f.configured.service.store.pending().length === 1); const command = f.poll().commands[0]!;
    const stop = f.receipt(command, { state: f.state({ running: 'stopped' }) });
    expect(f.poll({ receipts: [stop] }).acknowledged).toEqual([]); expect(f.configured.service.safe(a.execution.lease.id)).toBe(false);
    expect(f.poll({ receipts: [{ ...stop, stopGuard: { admissionClosed: true, otherPlayers: 0, checkedAt: stop.observedAt } }] }).acknowledged).toEqual([command.id]);
    expect((await result).ok).toBe(true); expect(f.configured.service.safe(a.execution.lease.id)).toBe(true);
  });
  it('returns a known players-present refusal without reporting a stop or holding an unresolved effect', async () => {
    const f = fixture(), a = await f.active();
    const outcome = inActionExecution(a.execution, () => f.autonomy.tools.call('minecraft.stop', {}, f.context(), a.execution.signal));
    await until(() => f.configured.service.store.pending().length === 1); const command = f.poll().commands[0]!;
    f.poll({ receipts: [f.receipt(command, { outcome: 'refused', code: 'players_present', state: f.state({ running: 'running', otherPlayers: 1 }) })] });
    const result = await outcome; expect(result.ok).toBe(false); expect(result.retryable).toBe(false);
    expect(JSON.parse(result.text)).toMatchObject({ code: 'players_present', state: { running: 'running', otherPlayers: 1 } });
    expect(f.configured.service.safe(a.execution.lease.id)).toBe(true); expect(a.execution.stepOutcome).toBe('acknowledged');
  });
  it('keeps ordinary text unknown work and its body resource held while later conversation stays available', async () => {
    const f = fixture(), run = foregroundRunner(f.actions);
    const { acknowledgementOwner: _fca, ...ordinary } = f.context();
    const response = run('owner', async () => {
      const initial = await f.autonomy.tools.call('minecraft.login', {}, ordinary);
      const status = await f.autonomy.tools.call('minecraft.lifecycle_status', {}, ordinary);
      const refusedRetry = await f.autonomy.tools.call('minecraft.start', {}, { ...ordinary, memory: { ...ordinary.memory, turnKey: 'fresh-retry' } });
      return { initial, status, refusedRetry };
    });
    await until(() => f.configured.service.store.pending().length === 1); const command = f.poll().commands[0]!;
    f.poll({ receipts: [f.receipt(command, { outcome: 'unknown', code: 'error', inputsReleased: false })] });
    expect(await response).toMatchObject({ initial: { ok: false, failure: 'unavailable', retryable: false }, status: { ok: true }, refusedRetry: { ok: false, failure: 'conflict', retryable: false } });
    const original = f.store.get(command.authority.executionId)!;
    // Original resource stays reserved under canonical action unknown, preventing a new physical operation.
    expect(original).toMatchObject({ state: 'unknown', sent: true }); expect(original.resources.length).toBeGreaterThan(0);
    expect(f.configured.service.safe(original.id)).toBe(false);
    expect(await run('owner', async () => 'Ordinary chat still works')).toBe('Ordinary chat still works');
    expect(f.db.prepare("SELECT count(*) AS count FROM mind_actions WHERE state='completed' AND kind='respond'").get()!.count).toBe(1);
  });
  it('revokes original owner action after a canonical stop and requires the native cancellation release', async () => {
    const f = fixture(), a = await f.active('agentTask');
    const outcome = inActionExecution(a.execution, () => f.autonomy.tools.call('minecraft.login', {}, f.context(), a.execution.signal));
    await until(() => f.configured.service.store.pending().length === 1); const command = f.poll().commands[0]!;
    await f.actions.stop('owner', a.view.id, 'owner-stop');
    expect(f.configured.service.authorize(f.principal, command.id)).toBe(false);
    expect(f.poll().cancel).toEqual([command.id]); expect(f.configured.service.safe(a.execution.lease.id)).toBe(false);
    f.poll({ receipts: [f.receipt(command, { outcome: 'cancelled', code: 'authority_revoked', inputsReleased: true })] });
    expect((await outcome).ok).toBe(false); expect(f.configured.service.safe(a.execution.lease.id)).toBe(true);
    expect((await f.actions.get('owner', a.view.id))!.state).toBe('stopping');
  });
  it('stops delivery when canonical owner task source visibility changes and waits for native release', async () => {
    const f = fixture(), a = await f.active('agentTask');
    const outcome = inActionExecution(a.execution, () => f.autonomy.tools.call('minecraft.logout', {}, f.context(), a.execution.signal));
    await until(() => f.configured.service.store.pending().length === 1); const command = f.poll().commands[0]!;
    f.taskAllowed(false); expect(f.configured.service.authorize(f.principal, command.id)).toBe(false);
    expect(f.poll().cancel).toEqual([command.id]); expect(f.configured.service.safe(a.execution.lease.id)).toBe(false);
    f.poll({ receipts: [f.receipt(command, { outcome: 'cancelled', code: 'authority_revoked', inputsReleased: true })] });
    expect((await outcome).ok).toBe(false); expect(f.configured.service.safe(a.execution.lease.id)).toBe(true);
  });
  it('pins actual canonical task source IDs in the native command and revokes any withdrawn original source',async()=>{
    const f=fixture(),a=await f.active('agentTask');
    const sources=['experience:original','memory:original','read:original'];f.taskSources(sources);
    const outcome=inActionExecution(a.execution,()=>f.autonomy.tools.call('minecraft.login',{},f.context(),a.execution.signal));
    await until(()=>f.configured.service.store.pending().length===1);const command=f.poll().commands[0]!;
    expect(command.authority.sourceIds).toEqual(sources);expect(f.configured.service.authorize(f.principal,command.id)).toBe(true);
    f.taskSources([...sources,'read:new-visible']);expect(f.configured.service.authorize(f.principal,command.id)).toBe(true);
    f.taskSources(['experience:original','memory:original']);expect(f.configured.service.authorize(f.principal,command.id)).toBe(false);
    expect(f.poll().cancel).toEqual([command.id]);expect(f.configured.service.safe(a.view.id)).toBe(false);
    f.poll({receipts:[f.receipt(command,{outcome:'cancelled',code:'authority_revoked'})]});
    expect((await outcome).ok).toBe(false);expect(f.configured.service.safe(a.view.id)).toBe(true);
    await f.actions.finish(a.execution.lease,'completed','test_finished');
    const next=await f.active('agentTask');f.taskSources(null);
    expect((await inActionExecution(next.execution,()=>f.autonomy.tools.call('minecraft.login',{},f.context(),next.execution.signal))).failure).toBe('refused');
    expect(f.configured.service.store.pending()).toEqual([]);
  });
  it('revokes a delivered own-time operation after pause and preserves unknown identity without automatic fresh retry', async () => {
    const f = fixture(), a = await f.active('ownTime');
    const outcome = inActionExecution(a.execution, () => f.autonomy.tools.call('minecraft.login', {}, f.context('autonomy'), a.execution.signal)).catch(error => error.message);
    await until(() => f.configured.service.store.pending().length === 1); const command = f.poll().commands[0]!;
    f.autonomy.setPaused('owner', true);
    expect(f.configured.service.authorize(f.principal, command.id)).toBe(false); expect(f.poll().cancel).toEqual([command.id]);
    await delay(30); f.advance(6000);
    expect(await outcome).toContain('OUTCOME_UNKNOWN'); expect(a.execution.stepOutcome).toBe('unknown'); expect(f.configured.service.safe(a.execution.lease.id)).toBe(false);
    f.autonomy.setPaused('owner', false); f.poll();
    const retry = await inActionExecution(a.execution, () => f.autonomy.tools.call('minecraft.login', {}, f.context('autonomy', 'new-operation'), a.execution.signal));
    expect(retry.failure).toBe('conflict'); expect(f.poll().commands).toEqual([]);
  });
});
