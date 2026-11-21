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
function fixture(provenanceRefs = false) {
  const h = actionHarness(() => at); stops.push(h.close); migrateAgentTasks(h.db);
  const authority = new SQLiteFcaTaskAuthority(h.db), runtime = new SQLiteTaskRuntimeStore(h.db, { authority, now: () => at, leaseValid: () => true, conversationLeaseValid: () => true,
    ...(provenanceRefs ? { provenanceRefs: true } : {}) });
  const root = runtime.ensureRoot('owner'), state = new InMemoryCompanionStateStore(() => at), conversations = new InMemoryConversationStore();
  let owner = true, source = true;
  const visible = createFcaSourceGuard({ runtime, state, conversations, ownerScope: 'owner', ownerAlone: () => owner });
  const conversation = createFcaConversationBridge({ runtime, ownerScope: 'owner', visible });
  const configuration = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'minebot', servers: [{ serverId: 'world', title: 'world', onlineMode: true, ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' }] }) })!;
  const bodyStore = new MinecraftControlStore(h.db), control = new MinecraftControl(bodyStore, configuration, { now: () => Date.parse(at), leaseValid: () => true, ownerAlone: () => owner });
  control.poll({ scopeKey: 'owner', deviceId: 'minebot' }, { schemaVersion: 1, serverId: 'world', connectionId: 'connection',
    observation: { schemaVersion: 1, bodyId: 'minecraft:world', sequence: 1, stateAt: at, receivedAt: at, connected: true, state: {}, facts: {} },
    skills: [], candidates: [], receipts: [], activeOperationIds: [] });
  const api = fcaMinecraftRequests({ db: h.db, runtime, control, conversation, visible, ownerScope: 'owner', ownerAlone: () => owner,
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
  it('refuses a request as a closed unavailable value when the turn has no open task context (2026-10-13: it threw)', async () => {
    const f = fixture();
    expect(await f.execute('minecraft.request', { goal: 'Find stone' })).toMatchObject({ ok: false, failure: 'unavailable', retryable: false });
    const status = await f.execute('minecraft.status', {}), cancel = await f.execute('minecraft.cancel', {});
    expect(status).toMatchObject({ ok: false, failure: 'unavailable' }); expect(status.text).toContain('様子を確かめられません');
    expect(cancel).toMatchObject({ ok: false, failure: 'unavailable' }); expect(cancel.text).toContain('止める操作を確かめられません');
    expect(f.runtime.list('owner').filter(task => f.bodyStore.body(task.id))).toEqual([]);
  });
  it('binds a foreground child before admission, shows it during its originating turn, and keeps descendants pending until the existing writer commits', async () => {
    const f = fixture(); let child = '';
    await f.foreground(async turn => {
      const result = await f.execute('minecraft.request', { goal: 'Find stone' });
      expect(result.ok).toBe(true);
      const tasks = f.runtime.list('owner').filter(task => f.bodyStore.body(task.id)); expect(tasks).toHaveLength(1); child = tasks[0]!.id;
      expect(result.evidence).toEqual({ outcome: 'queued', action: 'request', target: { kind: 'minecraft_request', id: child }, operationId: child });
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
    // The request is on the list; its start fails inside the one write, so nothing of it is left (the entry waits and is tried again, then fails).
    const made = (await f.api.intent({ scopeKey: 'owner', request: f.request, experienceId: 'existing', intent: { kind: 'task', goal: 'private goal' } }))!;
    expect(made.kind).toBe('task');
    expect(f.runtime.list('owner')).toHaveLength(before);
    expect(f.db.prepare('SELECT * FROM fca_task_messages').all()).toEqual([]);
    await f.api.queue.pump();
    await f.api.queue.pump();
    expect(f.api.queue.view().recent[0]).toMatchObject({ state: 'failed', note: expect.stringContaining('BINDING_CONFLICT') });
    expect(f.runtime.list('owner')).toHaveLength(before);
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

  it('names each refusal (run 19: one queue_unavailable for four checks), and gives the words to a task under way as a message', async () => {
    const lines: string[] = [], f = fixture();
    const api = fcaMinecraftRequests({ db: f.db, runtime: f.runtime, control: f.control, conversation: f.conversation, visible: createFcaSourceGuard({ runtime: f.runtime,
      state: f.state, conversations: f.conversations, ownerScope: 'owner', ownerAlone: () => true }), ownerScope: 'owner', ownerAlone: () => alone,
      sourceVisible: () => visibleTurn, stop: async (id, reason) => f.runtime.stop('owner', id, reason), atomic: work => underWriteLock(f.db, null, '', work, 'minecraft_test'),
      log: line => lines.push(line) });
    let alone = true, visibleTurn = true;
    const said = (text: string) => f.conversations.appendTurn('owner', 'platform:minecraft:world', text, 'はい', at).id;
    const input = { scopeKey: 'owner', request: f.request, experienceId: said('羊を探して'), intent: { kind: 'task' as const, goal: '羊を探す' } };
    expect(api.admission({ scopeKey: 'other', request: f.request })).toBe('not_owner_scope');
    alone = false;
    expect(await api.intent(input)).toEqual({ kind: 'none', goal: '', rejected: 'queue_unavailable', reason: 'others_present' });
    alone = true; visibleTurn = false;
    expect(await api.intent(input)).toMatchObject({ reason: 'turn_not_visible' });
    expect(await api.intent({ ...input, experienceId: null })).toMatchObject({ reason: 'no_turn' });
    expect(await api.intent({ ...input, request: { ...f.request, serverId: 'elsewhere' } })).toMatchObject({ reason: 'body_unavailable' });
    expect(lines).toEqual(['Shannon Minecraft intent refused reason=others_present kind=task', 'Shannon Minecraft intent refused reason=turn_not_visible kind=task',
      'Shannon Minecraft intent refused reason=no_turn kind=task', 'Shannon Minecraft intent refused reason=body_unavailable kind=task']);
    visibleTurn = true;
    const first = (await api.intent(input))!;
    // 「続けて」 while it is under way: the same task, its inbox, with the turn as the message's source; no second task.
    const again = (await api.intent({ ...input, experienceId: said('続けて'), request: { ...f.request, requestId: 'game-two' }, intent: { kind: 'message', goal: '続けて羊を探す' } }))!;
    expect(again.request?.id).toBe(first.request?.id);
    expect(f.runtime.list('owner').filter(task => f.bodyStore.body(task.id))).toHaveLength(1);
    const messages = f.runtime.snapshot('owner', first.request!.id)!.messages.filter(message => message.id.startsWith('external:'));
    expect(messages.map(message => message.text)).toEqual(['ゲーム内の本人の依頼: 羊を探す', 'ゲーム内の本人の言葉（いまのタスクへ）: 続けて羊を探す']);
    expect(lines.at(-1)).toBe(`Shannon Minecraft intent delivered task=${first.request!.id} as=message`);
    // A stopping or paused one would drop the words: a new task instead (the review). And a body task that is not his request is no target.
    f.runtime.stop('owner', first.request!.id, 'owner_game_stop');
    const later = (await api.intent({ ...input, experienceId: said('羊を探して'), request: { ...f.request, requestId: 'game-three' } }))!;
    expect(later.request?.id).not.toBe(first.request?.id);
    // Another task that only touched the body (a tool call bound it) is not his request: the words never go there.
    f.runtime.stop('owner', later.request!.id, 'owner_game_stop');
    const other = f.runtime.createChild('owner', f.root.id, { title: 'research', goal: 'research', completionCriteria: 'other' }, 'other-task');
    expect(f.bodyStore.bind(other.id, 'minecraft:world')).toBe(true);
    const fresh = (await api.intent({ ...input, experienceId: said('羊を探して'), request: { ...f.request, requestId: 'game-four' } }))!;
    expect(fresh.request?.id).not.toBe(other.id);
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
      expect(await f.execute('minecraft.cancel', { id: task.id })).toMatchObject({ ok: true, evidence: { outcome: 'applied', action: 'cancel',
        target: { kind: 'minecraft_request', id: task.id }, operationId: task.id } });
      expect(f.runtime.get('owner', task.id)?.phase).toBe('stopped'); turn.abort();
    });
  });

  it('a second request while the body has one joins the list; cancel without an ID cancels the one running and the list goes on', async () => {
    const f = fixture();
    await f.foreground(async turn => {
      await f.execute('minecraft.request', { goal: 'Find stone' });
      const first = f.runtime.list('owner').find(task => f.bodyStore.body(task.id))!;
      const added = await f.execute('minecraft.request', { goal: 'Find wood' });
      expect(added).toMatchObject({ ok: true, evidence: { outcome: 'queued', action: 'request' } });
      expect(f.runtime.list('owner').filter(task => f.bodyStore.body(task.id))).toHaveLength(1);
      expect(f.api.queue.view().entries.map(entry => `${entry.goal}:${entry.state}:${entry.origin}`)).toEqual(['Find stone:running:app', 'Find wood:queued:app']);
      expect((await f.execute('minecraft.status', {})).text).toContain('依頼の列');
      expect((await f.execute('minecraft.cancel', {})).ok).toBe(true);
      expect(f.runtime.get('owner', first.id)?.phase).toBe('stopped');
      expect(f.api.queue.view().recent[0]).toMatchObject({ goal: 'Find stone', state: 'cancelled' });
      // The list goes on with the next request, which has its own task now.
      await f.api.queue.pump();
      expect(f.api.queue.view().entries.map(entry => `${entry.goal}:${entry.state}`)).toEqual(['Find wood:running']);
      turn.abort();
    });
  });

  it('stops the owner\'s unfinished body task from the mod\'s 「やめる」 whatever its turn shows, naming the task or not (dragon26 fix 4)', async () => {
    const lines: string[] = [], f = fixture();
    let visibleTurn = true;
    const api = fcaMinecraftRequests({ db: f.db, runtime: f.runtime, control: f.control, conversation: f.conversation, visible: createFcaSourceGuard({ runtime: f.runtime, state: f.state, conversations: f.conversations,
      ownerScope: 'owner', ownerAlone: () => false }), ownerScope: 'owner',
      ownerAlone: () => false, sourceVisible: () => visibleTurn, stop: async (id, reason) => { lines.push(`stop ${reason}`); return f.runtime.stop('owner', id, reason); },
      atomic: work => underWriteLock(f.db, null, '', work, 'minecraft_test'), log: line => lines.push(line) });
    const made = (await f.api.intent({ scopeKey: 'owner', request: f.request, experienceId: 'asking-turn', intent: { kind: 'task', goal: 'Find stone' } }))!;
    const id = made.request!.id;
    // The same call that the in-game words 「今の作業をやめて」 would make is refused here, as it was on 2026-10-26.
    visibleTurn = false; f.source(false);
    expect(await api.intent({ scopeKey: 'owner', request: f.request, experienceId: 'asking-turn', intent: { kind: 'stop', goal: '' } })).toMatchObject({ reason: 'others_present' });
    // The button needs neither the turn, the source guard nor the owner being alone: only that the task is the owner's and bound to a body.
    expect(await api.ownerStop({ taskId: 'not-this-one' })).toEqual({ stopped: [], open: 1 });
    expect(f.runtime.get('owner', id)?.phase).not.toBe('stopped');
    expect(await api.ownerStop({ taskId: id })).toEqual({ stopped: [id], open: 1 });
    expect(f.runtime.get('owner', id)?.phase).toBe('stopped');
    expect(lines).toEqual(expect.arrayContaining(['stop owner_ui_stop', `Shannon Minecraft owner stop requested task=${id} reason=owner_ui_stop phase=ready`,
      `Shannon Minecraft owner stop found nothing task=not-this-one open=1`]));
    // Nothing unfinished is left: stopping again finds nothing and stops nothing.
    expect(await api.ownerStop({})).toEqual({ stopped: [], open: 0 });
    // A task that only touched the body is stopped too when no id is named (the button stops what the body is doing), never another owner's.
    const other = f.runtime.createChild('owner', f.root.id, { title: 'research', goal: 'research', completionCriteria: 'other' }, 'other-task');
    expect(f.bodyStore.bind(other.id, 'minecraft:world')).toBe(true);
    expect((await api.ownerStop({})).stopped).toEqual([other.id]);
  });

  // The real wiring (`sources: 'asking'`) under the switch as the server wires it (`serverFcaWiring.ts`): on, the in-game request
  // inherits only its own asking turn; off, the root's whole accumulated set as before.
  it.each([[true], [false]])('a game-chat task inherits only its asking turn when the switch is %s, not the root\'s accumulated sources', async on => {
    const f = fixture(on);
    f.db.prepare("INSERT INTO fca_task_sources(step_id,scope_key,thread_id,observed_at,recalled_ids_json,state,source_kind) VALUES('memory:earlier','owner','',?,?,'bound','memory')")
      .run(at, JSON.stringify(['accumulated']));
    f.db.prepare('INSERT INTO fca_task_source_links(task_id,step_id) VALUES(?,?)').run(f.root.id, 'memory:earlier');
    const made = (await f.api.intent({ scopeKey: 'owner', request: f.request, experienceId: 'asking-turn', intent: { kind: 'task', goal: 'Find stone' } }))!;
    const ids = f.runtime.taskSources('owner', made.request!.id).flatMap(source => source.recalledMemoryIds);
    expect(ids).toEqual(on ? ['asking-turn'] : expect.arrayContaining(['accumulated', 'asking-turn']));
  });
});

describe('the owner\'s list of requests, through the game chat and the mod, on the real task tree', () => {
  const said = (f: ReturnType<typeof fixture>, text: string) => f.conversations.appendTurn('owner', 'platform:minecraft:world', text, 'はい', at).id;
  const ask = (f: ReturnType<typeof fixture>, id: string, intent: Parameters<typeof f.api.intent>[0]['intent']) =>
    f.api.intent({ scopeKey: 'owner', request: { ...f.request, requestId: id }, experienceId: said(f, id), intent });
  const listed = (f: ReturnType<typeof fixture>) => f.api.queue.view().entries.map(entry => `${entry.goal}:${entry.state}`);

  it('adds a second request to the list (never as words for the first), starts it when the first ends, and says nothing is running to a message when none is', async () => {
    const f = fixture();
    expect(await ask(f, 'm0', { kind: 'message', goal: '続けて' })).toMatchObject({ rejected: 'queue_unavailable', reason: 'nothing_running' });
    const first = (await ask(f, 'g1', { kind: 'task', goal: 'ケーキを1個作る' }))!;
    const second = (await ask(f, 'g2', { kind: 'task', goal: '木材を64個集める' }))!;
    expect(second.request!.id).not.toBe(first.request!.id);
    expect(listed(f)).toEqual(['ケーキを1個作る:running', '木材を64個集める:queued']);
    expect(f.runtime.list('owner').filter(task => f.bodyStore.body(task.id))).toHaveLength(1);
    // The body has one request: the second has no task until its turn.
    f.authority.event('owner', first.request!.id, 'test_completed', at, { status: 'completed' });
    await f.api.queue.pump();
    expect(listed(f)).toEqual(['木材を64個集める:running']);
    const task = f.runtime.get('owner', f.api.queue.snapshot().entries.find(entry => entry.goal.startsWith('木材'))!.taskId!)!;
    expect(task).toMatchObject({ goal: '木材を64個集める', phase: expect.any(String) });
    expect(f.runtime.snapshot('owner', task.id)!.messages.map(message => message.text)).toContain('ゲーム内の本人の依頼: 木材を64個集める');
    expect(f.api.queue.view().recent[0]).toMatchObject({ goal: 'ケーキを1個作る', state: 'done' });
  });

  it('puts a request first (pausing the one running with a real stop), holds, resumes with the same task, and stops the list', async () => {
    const f = fixture();
    const first = (await ask(f, 'g1', { kind: 'task', goal: 'ケーキを1個作る' }))!;
    await ask(f, 'g2', { kind: 'task', goal: '木材を64個集める', placement: 'now' });
    expect(listed(f)).toEqual(['木材を64個集める:running', 'ケーキを1個作る:paused']);
    expect(f.runtime.get('owner', first.request!.id)?.phase).toBe('stopped');
    expect(await ask(f, 'g3', { kind: 'resume', goal: '', target: '#1' })).toEqual({ kind: 'none', goal: '' });
    await ask(f, 'g4', { kind: 'hold', goal: '' });
    // The one held is stopped and the paused one waits no more: the list goes on with it, by its own task.
    expect(listed(f)).toEqual(['ケーキを1個作る:running', '木材を64個集める:paused']);
    expect(f.api.queue.snapshot().entries.find(entry => entry.goal.startsWith('ケーキ'))!.taskId).toBe(first.request!.id);
    expect(f.runtime.get('owner', first.request!.id)?.phase).not.toBe('stopped');
    expect(await ask(f, 'g5', { kind: 'stop', goal: '' })).toEqual({ kind: 'stop', goal: '' });
    expect(listed(f)).toEqual(['ケーキを1個作る:stopped', '木材を64個集める:paused']);
    expect(f.api.queue.view().autoRun).toBe(false);
    expect(await ask(f, 'g6', { kind: 'cancel', goal: '', target: '#9' })).toMatchObject({ reason: 'no_such_request' });
    expect(await ask(f, 'g7', { kind: 'cancel', goal: '' })).toMatchObject({ reason: 'nothing_running' });
  });

  it('starts a request of the mod\'s screen, which came from no turn, as a task of its own with no source to observe', async () => {
    const f = fixture();
    const added = await f.api.queue.operate({ op: 'add', goal: 'ケーキを作る' }, { origin: 'mod' });
    expect(added).toMatchObject({ ok: true, entry: { state: 'running', taskId: expect.any(String), origin: 'mod' } });
    const task = f.runtime.get('owner', added.entry!.taskId!)!;
    expect(task).toMatchObject({ goal: 'ケーキを作る', origin: 'owner_request' });
    expect(f.bodyStore.body(task.id)).toBe('minecraft:world');
    expect(f.runtime.snapshot('owner', task.id)!.messages.filter(message => message.id.startsWith('external:'))).toEqual([]);
    expect(f.runtime.readyTasks('owner').map(item => item.id)).toContain(task.id);
  });

  it('takes a request that was made from outside as the one running, and the mod\'s stop of a named request cancels it so the list goes on', async () => {
    const f = fixture();
    const own = f.runtime.createChild('owner', f.root.id, { title: 'external', goal: 'エンドラを倒して', completionCriteria: 'x' }, 'external-1');
    expect(f.bodyStore.bind(own.id, 'minecraft:world')).toBe(true);
    await f.api.queue.pump();
    // Not his request by its criteria and parent kind: not adopted, but it holds the body, so nothing else starts beside it.
    expect(listed(f)).toEqual([]);
    await f.api.queue.operate({ op: 'add', goal: 'パンを作る' }, { origin: 'mod' });
    expect(listed(f)).toEqual(['パンを作る:queued']);
    f.runtime.stop('owner', own.id, 'test');
    await f.api.queue.pump();
    expect(listed(f)).toEqual(['パンを作る:running']);
    const taskId = f.api.queue.snapshot().entries[0]!.taskId!;
    expect(await f.api.ownerStop({ taskId })).toEqual({ stopped: [taskId], open: 1 });
    expect(f.runtime.get('owner', taskId)?.phase).toBe('stopped');
    expect(f.api.queue.view().recent[0]).toMatchObject({ goal: 'パンを作る', state: 'cancelled' });
  });
});
