import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryCompanionStateStore } from '@shannon/cognition';
import { createFcaConversationBridge, createFcaSourceGuard } from '../src/mind/action/fca/fcaConversationPorts.js';
import { InMemoryConversationStore } from '../src/mind/memory/store/conversationStore.js';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { MinecraftControl } from '../src/surfaces/minecraft/minecraftControl.js';
import { MinecraftControlStore } from '../src/surfaces/minecraft/store/minecraftControlStore.js';
import { configuredMinecraftBody, type MinecraftTurnRequest } from '../src/contracts/minecraftBodyContract.js';
import { underWriteLock } from '../src/infra/sqlite/lockWaits.js';
import { inActionExecution } from '../src/infra/context/actionExecution.js';
import { fcaMinecraftRequests } from '../src/wiring/fcaMinecraftRequests.js';
import { toolSessionMemory } from '../src/mind/tools/shannonToolTypes.js';
import { actionHarness } from './support/actionThreadHarness.js';

const at = '2026-10-09T00:00:00.000Z', stops: Array<() => void> = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); });
function fixture() {
  const h = actionHarness(() => at); stops.push(h.close); migrateAgentTasks(h.db);
  const authority = new SQLiteFcaTaskAuthority(h.db), runtime = new SQLiteTaskRuntimeStore(h.db, { authority, now: () => at, leaseValid: () => true, conversationLeaseValid: () => true });
  const root = runtime.ensureRoot('owner'), state = new InMemoryCompanionStateStore(() => at), conversations = new InMemoryConversationStore();
  let owner = true, source = true;
  const visible = createFcaSourceGuard({ runtime, state, conversations, ownerScope: 'owner', ownerAlone: () => owner });
  const conversation = createFcaConversationBridge({ runtime, ownerScope: 'owner', visible });
  const configuration = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'minebot', servers: [{ serverId: 'world', title: 'world', onlineMode: true, ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' }] }) })!;
  const bodyStore = new MinecraftControlStore(h.db), control = new MinecraftControl(bodyStore, configuration, { now: () => Date.parse(at), leaseValid: () => true, ownerAlone: () => owner });
  control.poll({ scopeKey: 'owner', deviceId: 'minebot' }, { schemaVersion: 1, serverId: 'world', connectionId: 'connection',
    observation: { schemaVersion: 1, bodyId: 'minecraft:world', sequence: 1, stateAt: at, receivedAt: at, connected: true, state: {}, facts: {} },
    skills: [], candidates: [], receipts: [], activeOperationIds: [] });
  const api = fcaMinecraftRequests({ runtime, control, conversation, visible, ownerScope: 'owner', ownerAlone: () => owner,
    sourceVisible: () => source, stop: async (id, reason) => runtime.stop('owner', id, reason),
    atomic: work => underWriteLock(h.db, null, '', work, 'minecraft_test') });
  const context = { scopeKey: 'owner', surface: 'text' as const, audience: 'owner_alone' as const, memory: toolSessionMemory() };
  const execute = (name: string, input: unknown) => api.tools.execute(name, input, context);
  const request = { requestId: 'game-one', serverId: 'world', observedAt: at } as MinecraftTurnRequest;
  return { ...h, root, runtime, authority, state, conversations, conversation, control, bodyStore, api, context, execute, request,
    owner: (value: boolean) => { owner = value; }, source: (value: boolean) => { source = value; },
    async foreground(work: (turn: NonNullable<ReturnType<typeof conversation.begin>>) => Promise<void>) {
      await inActionExecution({ lease: { id: 'respond', holder: 'test', generation: 1 }, signal: new AbortController().signal, permit: async () => true }, async () => {
        const turn = conversation.begin({ scopeKey: 'owner', threadId: conversations.threadId('owner'), observedAt: at, recalledMemoryIds: [], ownerAlone: () => owner })!;
        expect(turn).not.toBeNull(); await work(turn);
      });
    },
  };
}

describe('Minecraft requests enter the canonical common task tree', () => {
  it('binds a foreground child before admission, shows it during its originating turn, and keeps descendants pending until the existing writer commits', async () => {
    const f = fixture(); let child = '';
    await f.foreground(async turn => {
      const result = await f.execute('minecraft.request', { goal: 'Find stone' });
      expect(result.ok).toBe(true);
      const tasks = f.runtime.list('owner').filter(task => f.bodyStore.body(task.id)); expect(tasks).toHaveLength(1); child = tasks[0]!.id;
      expect(f.bodyStore.body(child)).toBe('minecraft:world'); expect(f.runtime.readyTasks('owner')).toEqual([]);
      expect((await f.execute('minecraft.status', {})).text).toContain(child);
      turn.commit(f.conversations.appendTurn('owner', f.conversations.threadId('owner'), 'Find stone', 'Accepted', at).id);
    });
    expect(f.runtime.readyTasks('owner').map(task => task.id)).toEqual([child]);
    expect(f.db.prepare('SELECT * FROM agent_task_commands').all()).toEqual([]);
  });

  it('rolls back every new child, event and source when body binding fails in either ingress', async () => {
    const f = fixture(), before = f.runtime.list('owner').length;
    f.bodyStore.bind = () => false;
    await expect(f.api.intent({ scopeKey: 'owner', request: f.request, experienceId: 'existing', intent: { kind: 'task', goal: 'private goal' } })).rejects.toThrow('BINDING_CONFLICT');
    expect(f.runtime.list('owner')).toHaveLength(before);
    expect(f.db.prepare('SELECT * FROM fca_task_messages').all()).toEqual([]);
    await f.foreground(async turn => {
      const count = f.runtime.list('owner').length;
      await expect(f.execute('minecraft.request', { goal: 'private foreground goal' })).rejects.toThrow('BINDING_CONFLICT');
      expect(f.runtime.list('owner')).toHaveLength(count); expect(f.runtime.readyTasks('owner')).toEqual([]); turn.abort();
    });
  });

  it('deduplicates a game-chat task, persists its original source, and rejects changed or unavailable source input', async () => {
    const f = fixture(), input = { scopeKey: 'owner', request: f.request, experienceId: 'existing', intent: { kind: 'task' as const, goal: 'Find stone' } };
    const result = (await f.api.intent(input))!; expect(result.request?.id).toBeDefined();
    expect(await f.api.intent(input)).toEqual(result);
    expect(f.runtime.snapshot('owner', result.request!.id)?.messages.filter(message => message.id.startsWith('external:'))).toHaveLength(1);
    expect(f.runtime.taskSources('owner', result.request!.id)).toMatchObject([{ kind: 'memory', recalledMemoryIds: ['existing'] }]);
    await expect(f.api.intent({ ...input, experienceId: 'different' })).rejects.toThrow('CONFLICT');
    f.source(false); expect(await f.api.intent({ ...input, request: { ...f.request, requestId: 'second' } })).toMatchObject({ rejected: 'queue_unavailable' });
    f.owner(false); expect(await f.api.intent({ ...input, intent: { kind: 'none', goal: '' }, experienceId: null })).toEqual({ kind: 'none', goal: '' });
  });

  it('pages over canonical tasks for status and cancels a child pending in its exact originating foreground turn', async () => {
    const f = fixture();
    for (let i = 0; i < 105; i++) {
      const task = f.runtime.createChild('owner', f.root.id, { title: 'unrelated', goal: 'unrelated' }, `old-${i}`);
      f.authority.event('owner', task.id, 'test_completed', at, { status: 'completed' });
    }
    await f.foreground(async turn => {
      await f.execute('minecraft.request', { goal: 'Find stone' });
      const task = f.runtime.get('owner', String(f.db.prepare('SELECT task_id FROM fca_body_bindings').get()!.task_id))!;
      expect((await f.execute('minecraft.status', {})).text).toContain(task.id);
      expect((await f.execute('minecraft.cancel', { id: task.id })).ok).toBe(true);
      expect(f.runtime.get('owner', task.id)?.phase).toBe('stopped'); turn.abort();
    });
  });

  it('cancel without an ID stops only the newest open task, preserving other parallel work', async () => {
    const f = fixture();
    await f.foreground(async turn => {
      await f.execute('minecraft.request', { goal: 'Find stone' });
      const first = f.runtime.list('owner').find(task => f.bodyStore.body(task.id))!;
      f.db.prepare('UPDATE agent_tasks SET created_at=? WHERE task_id=?').run('2026-10-08T23:59:00.000Z', first.id);
      await f.execute('minecraft.request', { goal: 'Find wood' });
      const second = f.runtime.list('owner').find(task => task.id !== first.id && f.bodyStore.body(task.id))!;
      expect((await f.execute('minecraft.cancel', {})).ok).toBe(true);
      expect(f.runtime.get('owner', second.id)?.phase).toBe('stopped');
      expect(f.runtime.get('owner', first.id)?.phase).not.toBe('stopped');
      turn.abort();
    });
  });
});
