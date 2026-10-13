import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { InMemoryCompanionStateStore } from '@shannon/cognition';
import { createFcaConversationBridge, createFcaSourceGuard } from '../src/mind/action/fca/fcaConversationPorts.js';
import { InMemoryConversationStore } from '../src/mind/memory/store/conversationStore.js';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { MinecraftControl } from '../src/surfaces/minecraft/minecraftControl.js';
import { MinecraftControlStore } from '../src/surfaces/minecraft/store/minecraftControlStore.js';
import { configuredMinecraftBody } from '../src/contracts/minecraftBodyContract.js';
import { underWriteLock } from '../src/infra/sqlite/lockWaits.js';
import { admittedMinecraftRequest, fcaMinecraftRequests, MINECRAFT_REQUEST_CRITERIA } from '../src/wiring/fcaMinecraftRequests.js';
import { OPERATOR_LIMITS, OPERATOR_TITLE_PREFIX, parseOperatorEnvelope } from '../src/contracts/operatorContract.js';
import { inspectOperatorAudit, operatorLifecycleAllowed, OperatorAuditStore } from '../src/infra/ops/store/operatorAuditStore.js';
import { operatorSocketPath, requestOperatorSocket, serveOperatorSocket } from '../src/infra/ops/operatorSocket.js';
import { operatorEnvelope, runOperatorCli, type OperatorCliDeps } from '../src/infra/ops/operatorCli.js';
import { createOperatorMinecraft, type OperatorActivity, type OperatorMinecraftParts } from '../src/wiring/operatorMinecraftWiring.js';
import { configuredOperatorAudit } from '../src/wiring/operatorServerWiring.js';
import type { OperatorMinecraftRequests } from '../src/wiring/operatorMinecraftRequests.js';
import type { TaskView } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import { actionHarness } from './support/actionThreadHarness.js';

const at = '2026-10-14T00:00:00.000Z';
const TASK = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), 'operator-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const envelope = (op: string, args: Record<string, unknown> = {}, domain = 'minecraft') => ({ v: 1, operator: 'ops.ryo', domain, op, args });

describe('the operator envelope', () => {
  it('refuses anything outside the Minecraft operations as out of scope', () => {
    expect(parseOperatorEnvelope(envelope('send', { text: 'hi' }, 'chat'))).toMatchObject({ ok: false, code: 'out_of_scope' });
    expect(parseOperatorEnvelope(envelope('memory.write', {}))).toMatchObject({ ok: false, code: 'out_of_scope' });
    expect(parseOperatorEnvelope({ ...envelope('stop'), secret: 'x' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(parseOperatorEnvelope({ ...envelope('stop'), operator: 'bad label' })).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('bounds a request: 30 minutes by default, at most 120, and never above the Minecraft request cap', () => {
    expect(parseOperatorEnvelope(envelope('request', { goal: '石を集めて' }))).toMatchObject({ ok: true,
      input: { command: 'request', goal: '石を集めて', maxMinutes: 30, budgetYen: OPERATOR_LIMITS.maxBudgetYen } });
    expect(parseOperatorEnvelope(envelope('request', { goal: 'x', maxMinutes: 121 }))).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(parseOperatorEnvelope(envelope('request', { goal: 'x', budgetYen: 2001 }))).toMatchObject({ ok: false, code: 'budget_above_cap' });
    expect(parseOperatorEnvelope(envelope('request', { goal: 'x', extra: 1 }))).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(parseOperatorEnvelope(envelope('request', { goal: 'a\u0007b' }))).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('reads a lifecycle operation and a cancel', () => {
    expect(parseOperatorEnvelope(envelope('start', { serverId: 'shannon-home' }))).toMatchObject({ ok: true,
      input: { command: 'lifecycle', action: 'start', serverId: 'shannon-home' } });
    expect(parseOperatorEnvelope(envelope('cancel', { latest: true }))).toMatchObject({ ok: true, input: { command: 'cancel', taskId: null } });
    expect(parseOperatorEnvelope(envelope('cancel', { taskId: 'nope' }))).toMatchObject({ ok: false, code: 'invalid_input' });
  });
});

describe('the operator audit', () => {
  it('is append-only and marks only what the operator started', () => {
    const db = new DatabaseSync(':memory:'), audit = new OperatorAuditStore(db);
    const row = audit.append({ operationId: 'operator:a', scopeKey: 'owner', at, operator: 'ops', command: 'request', event: 'accepted',
      code: 'accepted', argsJson: '{}', taskId: TASK, budgetYen: 500, deadlineAt: at });
    expect(() => db.exec(`UPDATE operator_audit SET code='x' WHERE sequence=${row.sequence}`)).toThrow('OPERATOR_AUDIT_APPEND_ONLY');
    expect(() => db.exec(`DELETE FROM operator_audit WHERE sequence=${row.sequence}`)).toThrow('OPERATOR_AUDIT_APPEND_ONLY');
    expect(() => db.prepare(`INSERT OR REPLACE INTO operator_audit (sequence, event_id, operation_id, scope_key, occurred_at, operator, via,
      command, event, code, args_json) VALUES (?, 'e', 'o', 'owner', ?, 'x', 'operator_cli', 'request', 'invoked', 'x', '{}')`).run(row.sequence, at))
      .toThrow('OPERATOR_AUDIT_APPEND_ONLY');
    expect(() => db.prepare(`INSERT INTO operator_audit (event_id, operation_id, scope_key, occurred_at, operator, via, command, event, code,
      args_json) VALUES ('f', 'o', 'owner', ?, 'x', 'owner', 'request', 'invoked', 'x', '{}')`).run(at)).toThrow();
    expect(audit.requestOf('owner', TASK)?.operationId).toBe('operator:a');
    expect(audit.requestOf('owner', OTHER)).toBeNull();
    expect(audit.budgetYen(TASK)).toBe(500);
    expect(audit.budgetYen(OTHER)).toBeNull();
  });

  it('allows a lifecycle command only for the operation the operator invoked, as invoked, and not after a refusal', () => {
    const db = new DatabaseSync(':memory:'), audit = new OperatorAuditStore(db), id = `operator:${TASK}`;
    audit.append({ operationId: id, scopeKey: 'owner', at, operator: 'ops', command: 'lifecycle', event: 'invoked', code: 'invoked',
      argsJson: '{}', action: 'start', serverId: 'shannon-home' });
    expect(operatorLifecycleAllowed(db, 'owner', id, { action: 'start', serverId: 'shannon-home' })).toBe(true);
    expect(operatorLifecycleAllowed(db, 'owner', id, { action: 'stop', serverId: 'shannon-home' })).toBe(false);
    expect(operatorLifecycleAllowed(db, 'owner', id, { action: 'start', serverId: 'other' })).toBe(false);
    expect(operatorLifecycleAllowed(db, 'other', id, { action: 'start', serverId: 'shannon-home' })).toBe(false);
    audit.append({ operationId: id, scopeKey: 'owner', at, operator: 'ops', command: 'lifecycle', event: 'refused', code: 'refused', argsJson: '{}' });
    expect(operatorLifecycleAllowed(db, 'owner', id, { action: 'start', serverId: 'shannon-home' })).toBe(false);
    expect(operatorLifecycleAllowed(new DatabaseSync(':memory:'), 'owner', id, { action: 'start', serverId: 'shannon-home' })).toBe(false);
  });

  it('is not created while the switch is off, and the CLI reads it without writing', () => {
    const path = join(temporary(), 'shannon.sqlite');
    new DatabaseSync(path).close();
    expect(configuredOperatorAudit({}, path)).toBeNull();
    expect(inspectOperatorAudit(path, at).step).toBe('missing');
    const opened = configuredOperatorAudit({ SHANNON_OPERATOR_MINECRAFT: 'on' }, path)!;
    opened.store.append({ operationId: 'operator:a', scopeKey: 'owner', at, operator: 'ops', command: 'request', event: 'accepted',
      code: 'accepted', argsJson: '{}', taskId: TASK });
    opened.close();
    const before = statSync(path).mtimeMs;
    expect(inspectOperatorAudit(path, at)).toMatchObject({ step: 'applied', open: [{ taskId: TASK }], recent: [{ taskId: TASK }] });
    expect(statSync(path).mtimeMs).toBe(before);
    const again = configuredOperatorAudit({}, path);
    expect(again?.enabled).toBe(false);
    again?.close();
  });
});

function task(id: string, phase: TaskView['phase'], goal = '石を集めて'): TaskView {
  return { id, phase, goal, title: goal, childIds: [] } as unknown as TaskView;
}

function service(options: { enabled?: boolean; alone?: boolean; body?: string | null; busy?: boolean; unresolved?: boolean; liveAction?: boolean } = {}) {
  const audit = new OperatorAuditStore(new DatabaseSync(':memory:'));
  const tasks = new Map<string, TaskView>([[OTHER, task(OTHER, 'executing', 'ライ氏の依頼')]]);
  const activity: OperatorActivity[] = [], notes: Array<{ id: string; text: string }> = [], stopped: string[] = [], admitted: unknown[] = [];
  let clock = at, wakes = 0;
  const requests = {
    body: () => (options.body === undefined ? 'minecraft:world' : options.body),
    open: () => [], get: (id: string) => tasks.get(id) ?? null,
    admit: (input: unknown) => {
      admitted.push(input);
      if (options.busy) return { ok: false as const, code: 'minecraft_busy' as const };
      tasks.set(TASK, task(TASK, 'ready'));
      return { ok: true as const, task: tasks.get(TASK)!, bodyId: 'minecraft:world' };
    },
    stop: async (id: string) => {
      stopped.push(id);
      tasks.set(id, task(id, 'stopping', tasks.get(id)?.goal));
      return [tasks.get(id)!];
    },
    wake: () => { wakes += 1; },
  } as unknown as OperatorMinecraftRequests & { wake(): void };
  const lifecycleCalls: unknown[] = [];
  const parts: OperatorMinecraftParts = {
    scopeKey: 'owner', enabled: () => options.enabled ?? true, ownerAlone: () => options.alone ?? true, now: () => clock, audit,
    lifecycle: {
      servers: ['shannon-home'], server: (requested: string | null) => requested ?? 'shannon-home',
      execute: async (request: { id: string }) => {
        lifecycleCalls.push(request);
        return { ok: true as const, lifecycleId: request.id, actionId: 'action-1' };
      },
    } as unknown as OperatorMinecraftParts['lifecycle'],
    requests,
    actions: { list: async () => (options.liveAction ? [{ kind: 'minecraft', state: 'running' }] : []) } as unknown as OperatorMinecraftParts['actions'],
    lifecycleUnresolved: () => options.unresolved ?? false,
    activity: (_at, entry) => activity.push(entry),
    note: (id, text) => notes.push({ id, text }),
  };
  const operator = createOperatorMinecraft(parts);
  return { operator, audit, activity, notes, stopped, admitted, tasks, lifecycleCalls,
    wakes: () => wakes, advance: (minutes: number) => { clock = new Date(Date.parse(clock) + minutes * 60_000).toISOString(); } };
}

const events = (audit: OperatorAuditStore) => audit.recent('owner', 200).reverse().map(row => `${row.command}/${row.event}/${row.code}`);

describe('the operator service', () => {
  it('audits and refuses an out-of-scope invocation, and records it as refused', async () => {
    const s = service();
    const reply = await s.operator.handle(envelope('send', { text: 'ライ氏として話す' }, 'chat'));
    expect(reply).toMatchObject({ status: 403, body: { outcome: 'refused', code: 'out_of_scope' } });
    expect(events(s.audit)).toEqual(['unknown/invoked/invoked', 'unknown/refused/out_of_scope']);
    expect(s.audit.recent('owner')[0]!.argsJson).toContain('chat');
    expect(s.activity).toMatchObject([{ outcome: 'refused', reasonCode: 'out_of_scope' }]);
    expect(s.notes).toEqual([]);
  });

  it('refuses everything while the switch is off', async () => {
    const s = service({ enabled: false });
    expect((await s.operator.handle(envelope('request', { goal: 'x' }))).body).toMatchObject({ code: 'disabled' });
    expect(s.admitted).toEqual([]);
  });

  it('starts one request as the operator\'s, attributed in the audit, the record and the Talk', async () => {
    const s = service();
    const reply = await s.operator.handle(envelope('request', { goal: '石を集めて', maxMinutes: 10, budgetYen: 300 }));
    expect(reply).toMatchObject({ status: 202, body: { outcome: 'accepted', taskId: TASK, budgetYen: 300, deadlineAt: '2026-10-14T00:10:00.000Z' } });
    expect(s.admitted).toMatchObject([{ goal: '石を集めて', operator: 'ops.ryo' }]);
    expect(events(s.audit)).toEqual(['request/invoked/invoked', 'request/accepted/accepted']);
    expect(s.audit.budgetYen(TASK)).toBe(300);
    expect(s.activity[0]!.summary).toContain('運用者（ops.ryo）');
    expect(s.notes[0]!.text).toBe('運用者がライ氏の代わりに Minecraft の依頼「石を集めて」を始めました。');
    expect(s.wakes()).toBe(1);
  });

  it.each([
    ['owner_not_alone', { alone: false }], ['body_unavailable', { body: null }], ['unresolved_operation', { unresolved: true }],
    ['lease_conflict', { liveAction: true }], ['minecraft_busy', { busy: true }],
  ] as const)('refuses a request with %s', async (code, options) => {
    const s = service(options);
    expect((await s.operator.handle(envelope('request', { goal: 'x' }))).body).toMatchObject({ outcome: 'refused', code });
    expect(events(s.audit)).toEqual(['request/invoked/invoked', `request/refused/${code}`]);
    expect(s.notes).toEqual([]);
  });

  it(`accepts at most ${OPERATOR_LIMITS.requestsPerHour} invocations an hour`, async () => {
    const s = service();
    for (let index = 0; index < OPERATOR_LIMITS.requestsPerHour; index += 1) {
      s.audit.append({ operationId: `operator:${index}`, scopeKey: 'owner', at, operator: 'ops', command: 'lifecycle', event: 'accepted',
        code: 'accepted', argsJson: '{}' });
    }
    expect((await s.operator.handle(envelope('start'))).body).toMatchObject({ code: 'rate_limited' });
    s.advance(61);
    expect((await s.operator.handle(envelope('start'))).body).toMatchObject({ outcome: 'accepted' });
  });

  it('cancels only a request it started; the owner\'s task and an unknown id are refused', async () => {
    const s = service();
    await s.operator.handle(envelope('request', { goal: '石を集めて' }));
    expect((await s.operator.handle(envelope('cancel', { taskId: OTHER }))).body).toMatchObject({ outcome: 'refused', code: 'not_operator_task' });
    const unknown = '00000000-0000-4000-8000-000000000000';
    expect((await s.operator.handle(envelope('cancel', { taskId: unknown }))).body).toMatchObject({ outcome: 'refused', code: 'not_found' });
    expect(s.stopped).toEqual([]);
    expect((await s.operator.handle(envelope('cancel', { taskId: TASK }))).body).toMatchObject({ outcome: 'accepted', code: 'stopped', taskId: TASK });
    expect(s.stopped).toEqual([TASK]);
    expect(s.notes.at(-1)!.text).toBe('運用者が、代わりに始めた Minecraft の依頼「石を集めて」を止めました。');
    expect(s.audit.recent('owner', 1)[0]).toMatchObject({ event: 'stopped', taskId: TASK });
    expect((await s.operator.handle(envelope('cancel', { latest: true }))).body).toMatchObject({ code: 'not_found' });
  });

  it('cancels the latest open request with --latest', async () => {
    const s = service();
    await s.operator.handle(envelope('request', { goal: '石を集めて' }));
    expect((await s.operator.handle(envelope('cancel', { latest: true }))).body).toMatchObject({ code: 'stopped', taskId: TASK });
  });

  it('stops a request at its time limit once, through the same stop, even with the switch turned off', async () => {
    const options: { enabled?: boolean } = {}, s = service(options);
    await s.operator.handle(envelope('request', { goal: '石を集めて', maxMinutes: 5 }));
    s.operator.tick();
    expect(s.stopped).toEqual([]);
    options.enabled = false;
    s.advance(6);
    s.operator.tick();
    s.operator.tick();
    await new Promise(resolve => setImmediate(resolve));
    expect(s.stopped).toEqual([TASK]);
    expect(events(s.audit).at(-1)).toBe('request/time_limit/time_limit');
    expect(s.notes.at(-1)!.text).toContain('決められた時間に達したので止めました');
    s.operator.tick();
    await new Promise(resolve => setImmediate(resolve));
    expect(s.stopped).toEqual([TASK]);
  });

  it('hands a lifecycle operation to the lifecycle under its operation id', async () => {
    const s = service();
    const reply = await s.operator.handle(envelope('start', { serverId: 'shannon-home' }));
    expect(reply.body).toMatchObject({ outcome: 'accepted', actionId: 'action-1' });
    const id = (reply.body as { operationId: string }).operationId;
    expect(s.lifecycleCalls).toEqual([{ id, serverId: 'shannon-home', action: 'start' }]);
    expect(s.audit.operation(id).map(row => row.event)).toEqual(['invoked', 'accepted']);
    expect(s.audit.operation(id)[0]).toMatchObject({ action: 'start', serverId: 'shannon-home' });
    expect(s.notes[0]!.text).toContain('運用者がライ氏の代わりに Minecraft の操作（start・shannon-home）');
  });
});

describe('the operator request in the common task tree', () => {
  function fixture() {
    const h = actionHarness(() => at);
    cleanups.push(h.close);
    migrateAgentTasks(h.db);
    const authority = new SQLiteFcaTaskAuthority(h.db);
    const runtime = new SQLiteTaskRuntimeStore(h.db, { authority, now: () => at, leaseValid: () => true, conversationLeaseValid: () => true });
    const state = new InMemoryCompanionStateStore(() => at), conversations = new InMemoryConversationStore();
    const visible = createFcaSourceGuard({ runtime, state, conversations, ownerScope: 'owner', ownerAlone: () => true });
    const conversation = createFcaConversationBridge({ runtime, ownerScope: 'owner', visible });
    const configuration = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'minebot', servers: [{
      serverId: 'world', title: 'world', onlineMode: true, ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' }] }) })!;
    const bodyStore = new MinecraftControlStore(h.db);
    const control = new MinecraftControl(bodyStore, configuration, { now: () => Date.parse(at), leaseValid: () => true, ownerAlone: () => true });
    control.poll({ scopeKey: 'owner', deviceId: 'minebot' }, { schemaVersion: 1, serverId: 'world', connectionId: 'connection',
      observation: { schemaVersion: 1, bodyId: 'minecraft:world', sequence: 1, stateAt: at, receivedAt: at, connected: true, state: {}, facts: {} },
      skills: [], candidates: [], receipts: [], activeOperationIds: [] });
    const api = fcaMinecraftRequests({ runtime, control, conversation, visible, ownerScope: 'owner', ownerAlone: () => true,
      sourceVisible: () => true, stop: async (id, reason) => runtime.stop('owner', id, reason),
      atomic: work => underWriteLock(h.db, null, '', work, 'operator_test') });
    return { runtime, bodyStore, operator: api.operator };
  }

  it('is the owner\'s kind of Minecraft request, under the root, bound to the body, and marked as handed over by the operator', () => {
    const f = fixture();
    const admitted = f.operator.admit({ operationId: TASK, goal: '石を集めて', operator: 'ops.ryo' });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    const created = admitted.task, root = f.runtime.ensureRoot('owner');
    expect(created).toMatchObject({ origin: 'owner_request', parentId: root.id, completionCriteria: MINECRAFT_REQUEST_CRITERIA, goal: '石を集めて' });
    expect(created.title).toBe(`${OPERATOR_TITLE_PREFIX}石を集めて`);
    expect(f.bodyStore.body(created.id)).toBe('minecraft:world');
    expect(admittedMinecraftRequest(created, root, true)).toBe(true);
    const inbox = f.runtime.snapshot('owner', created.id)!.messages.map(message => message.text).join('\n');
    expect(inbox).toContain('この依頼は運用者（ops.ryo）がライ氏の代わりに渡したものです。ライ氏が直接言った言葉ではありません。');
    expect(f.runtime.readyTasks('owner').map(item => item.id)).toContain(created.id);
    expect(f.operator.admit({ operationId: OTHER, goal: 'もう一つ', operator: 'ops.ryo' })).toEqual({ ok: false, code: 'minecraft_busy' });
  });
});

describe('the operator socket and command line', () => {
  it('serves only its path on a socket only the service user can open', async () => {
    const path = join(temporary(), 'shannon.sqlite'), socket = operatorSocketPath(path);
    const served = await serveOperatorSocket(socket, async body => ({ status: 202, body: { echoed: body } }));
    cleanups.push(() => void served.close());
    expect(statSync(socket).mode & 0o777).toBe(0o600);
    expect(statSync(join(socket, '..')).mode & 0o777).toBe(0o700);
    expect(await requestOperatorSocket(socket, { v: 1 })).toEqual({ status: 202, body: { echoed: { v: 1 } } });
    await expect(serveOperatorSocket(socket, async () => ({ status: 200, body: {} }))).rejects.toThrow('OPERATOR_SOCKET_IN_USE');
  });

  it('builds envelopes and sends out-of-scope words as they are, so the API refuses and audits them', () => {
    expect(operatorEnvelope(['minecraft', 'request', '--operator', 'ops', '--max-minutes', '10', '石を', '集めて'], {}))
      .toEqual({ v: 1, operator: 'ops', domain: 'minecraft', op: 'request', args: { goal: '石を 集めて', maxMinutes: 10 } });
    expect(operatorEnvelope(['minecraft', 'cancel', '--latest'], { SHANNON_OPERATOR: 'ops' })).toMatchObject({ args: { latest: true } });
    expect(operatorEnvelope(['chat', 'send', '--operator', 'ops', 'hello'], {})).toEqual({ v: 1, operator: 'ops', domain: 'chat', op: 'send', args: {} });
    expect(() => operatorEnvelope(['minecraft', 'start'], {})).toThrow('--operator');
    expect(() => operatorEnvelope(['minecraft', 'start', '--operator', 'ops', '--goal', 'x'], {})).toThrow('not an option');
  });

  it('answers 0 when accepted, 1 when refused or the socket is absent, and 2 for a usage error', async () => {
    const path = join(temporary(), 'shannon.sqlite');
    writeFileSync(path, '');
    const sent: unknown[] = [], lines: string[] = [];
    let present = true, outcome = 'accepted';
    const deps: OperatorCliDeps = {
      send: async (_socket, body) => { sent.push(body); return { status: 202, body: { outcome, code: outcome, operationId: 'operator:x' } }; },
      inspect: () => ({ step: 'applied', recent: [], open: [] }), socketPresent: () => present, now: () => at,
    };
    const io = { out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) };
    const env = { SHANNON_DATABASE_PATH: path, SHANNON_OPERATOR: 'ops' };
    expect(await runOperatorCli(['minecraft', 'stop'], env, io, deps)).toBe(0);
    outcome = 'refused';
    expect(await runOperatorCli(['minecraft', 'stop'], env, io, deps)).toBe(1);
    present = false;
    expect(await runOperatorCli(['minecraft', 'stop'], env, io, deps)).toBe(1);
    expect(sent).toHaveLength(2);
    expect(await runOperatorCli(['minecraft', 'status'], env, io, deps)).toBe(0);
    expect(await runOperatorCli(['minecraft', 'stop'], { SHANNON_OPERATOR: 'ops' }, io, deps)).toBe(2);
    expect(await runOperatorCli(['minecraft'], env, io, deps)).toBe(2);
  });
});
