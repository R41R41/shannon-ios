import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { createInitialCompanionState, type CompanionStateSnapshot, type ProspectiveMemory } from '@shannon/cognition';
import { createLocalApiKernel } from '../src/infra/http/apiKernel.js';
import type { ShannonChatModel, ShannonChatModelRequest } from '../src/infra/models/chatModel.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { NOTICE_MARKERS } from '../src/mind/workspace/workspacePorts.js';
import { agentTaskOutcomeNotices, lateFolderOutcomeNotices, promiseDueNotices, type EndedTask } from '../src/mind/perception/noticeProducers.js';
import { configuredMind } from '../src/wiring/mindWiring.js';

/**
 * Syzygy ADR-0008 stage 3: the producers of `【知らせ:約束の時刻】` and `【知らせ:作業終了】` (`noticeProducers.ts`, wired in
 * `mindWiring.ts`). A promise with a due time, an agent task that ended and a late report of her own time's folder operation become
 * inbox rows of closed values, once each; the workspace shows them only while the owner alone can see or hear the reply.
 */
const AT = '2026-10-07T03:00:00.000Z';
const MINUTE = 60_000;
const at = (minutes: number) => new Date(Date.parse(AT) + minutes * MINUTE).toISOString();
const promise = (fields: Partial<ProspectiveMemory> = {}): ProspectiveMemory => ({
  id: 'prospective-dentist', summary: '歯医者に行く', status: 'pending', createdAt: at(-600), updatedAt: at(-600), dueAt: at(20), ...fields,
});
const state = (memories: ProspectiveMemory[], extra: Partial<CompanionStateSnapshot> = {}): CompanionStateSnapshot =>
  ({ ...createInitialCompanionState('owner', at(-600)), prospectiveMemories: memories, ...extra });

describe('the producers, pure', () => {
  it('perceive a pending promise from 30 minutes before its time until 30 after, with its minutes, once per time', () => {
    expect(promiseDueNotices(state([promise()]), AT)).toEqual([{ at: at(20), draft: {
      kind: 'promise_due', code: 'due', audience: 'owner', source: 'api', sourceId: `promise-prospective-dentist@${Math.floor(Date.parse(at(20)) / MINUTE)}`, deltaMinutes: -20,
    } }]);
    expect(promiseDueNotices(state([promise({ dueAt: at(31) })]), AT)).toEqual([]);
    expect(promiseDueNotices(state([promise({ dueAt: at(-30) })]), AT)).toHaveLength(1);
    expect(promiseDueNotices(state([promise({ dueAt: at(-31) })]), AT)).toEqual([]);
    // A moved time is a new notice.
    expect(promiseDueNotices(state([promise({ dueAt: at(25) })]), AT)[0]!.draft.sourceId).not.toBe(promiseDueNotices(state([promise()]), AT)[0]!.draft.sourceId);
  });

  it('leave out what is done, undated, put off by 「あとで」, forgotten, or from a forgotten turn; no words of the promise', () => {
    expect(promiseDueNotices(state([promise({ status: 'completed' }), promise({ dueAt: undefined, dueDate: '2026-10-07' }), promise({ remindAfter: at(10) })]), AT)).toEqual([]);
    const forgotten = state([promise()], { memoryControls: [{ memoryId: 'prospective-dentist', kind: 'user-fact', status: 'forgotten', pinned: false, updatedAt: AT, changeReason: 'user' }] } as never);
    expect(promiseDueNotices(forgotten, AT)).toEqual([]);
    expect(JSON.stringify(promiseDueNotices(state([promise()]), AT))).not.toContain('歯医者');
  });

  it('perceive an agent task that ended within the hour, and a late report of her own folder operation', () => {
    const tasks: EndedTask[] = [
      { id: 'task-1', status: 'completed', updatedAt: at(-5) }, { id: 'task-2', status: 'failed', updatedAt: at(-59) }, { id: 'task-3', status: 'cancelled', updatedAt: at(-1) },
      { id: 'task-4', status: 'running', updatedAt: at(-1) }, { id: 'task-5', status: 'completed', updatedAt: at(-61) },
    ];
    expect(agentTaskOutcomeNotices(tasks, AT).map(notice => [notice.draft.sourceId.split('@')[0], notice.draft.code, notice.draft.tool, notice.draft.audience]))
      .toEqual([['task-task-1', 'done', 'agent.task', 'owner'], ['task-task-2', 'failed', 'agent.task', 'owner'], ['task-task-3', 'cancelled', 'agent.task', 'owner']]);
    expect(lateFolderOutcomeNotices([{ id: 'op-1', tool: 'folder.write', status: 'done', finishedAt: at(-2) }, { id: 'op-2', tool: 'folder.read', status: 'expired', finishedAt: at(-2) },
      { id: 'op-3', tool: 'folder.read', status: 'leased', finishedAt: at(-2) }], AT).map(notice => [notice.draft.code, notice.draft.tool]))
      .toEqual([['done', 'folder.write'], ['failed', 'folder.read']]);
  });
});

describe('the notices in a conversation (scenarios ws.promise_due, ws.task_outcome)', () => {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-notice-producers-'));
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  it('reach the owner alone as 【知らせ:約束の時刻】 and 【知らせ:作業終了】, once each, and nobody with others present', async () => {
    const path = join(directory, 'shannon.sqlite');
    const clock = { at: Date.parse(AT) };
    const now = () => new Date(clock.at).toISOString();
    const store = new SQLiteShannonStore({ path, now });
    store.apply('owner', { type: 'prospective-memory-upserted', memory: promise() });
    const tasks: EndedTask[] = [{ id: 'task-1', status: 'completed', updatedAt: at(-5) }];
    const mind = configuredMind({}, { databasePath: path, now, schedule: task => task(), notices: { ownerScopeKey: 'owner', snapshot: scopeKey => store.snapshot(scopeKey), tasks: () => tasks } })!;
    const requests: ShannonChatModelRequest[] = [];
    const answer = async (request: ShannonChatModelRequest) => { requests.push(request); return { reply: 'はい。', mode: 'openai' as const, model: 'test' }; };
    const chatModel = { mode: 'openai', model: 'test', generate: answer, generateVoice: answer } as unknown as ShannonChatModel;
    const api = createLocalApiKernel(now, { chatModel, stateStore: store, conversationStore: store, knowledgeStore: store, mind: mind.mind });
    expect(mind.produceNotices!()).toBe(2);
    // Once each: a second look writes nothing.
    expect(mind.produceNotices!()).toBe(0);
    mind.host!.tick();
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'thread', message: 'ねえ' } });
    const alone = requests.at(-1)!.turnContext ?? '';
    expect(alone).toContain(`${NOTICE_MARKERS.promise_due}約束の時刻まであと20分`);
    expect(alone).toMatch(/【知らせ:作業終了】5分前、〈agent\.task〉が終わった/u);
    // The notice line itself names no promise (the owner's shared state may, as before).
    expect(alone.split('\n').filter(line => line.startsWith('【知らせ:')).join('\n')).not.toContain('歯医者');
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'thread', message: 'これ見て', audience: 'others' } });
    expect(requests.at(-1)!.turnContext ?? '').not.toContain('【知らせ:');
    // The rows hold closed values only.
    const database = new DatabaseSync(path, { readOnly: true });
    const rows = database.prepare('SELECT kind, code, audience, source, source_id, tool, delta_minutes FROM mind_inbox ORDER BY seq').all() as Array<Record<string, unknown>>;
    database.close();
    expect(rows.map(row => [row.kind, row.code, row.audience, row.tool])).toEqual([['promise_due', 'due', 'owner', null], ['task_outcome', 'done', 'owner', 'agent.task']]);
    expect(JSON.stringify(rows)).not.toContain('歯医者');
    await api.waitForBackground('owner');
    mind.close(); store.close();
  });

  it('is not there with the workspace off', () => {
    expect(configuredMind({ SHANNON_WORKSPACE: 'off' }, { databasePath: join(directory, 'off.sqlite'), now: () => AT, notices: { ownerScopeKey: 'owner', snapshot: () => null, tasks: () => [] } })?.produceNotices).toBeUndefined();
    expect(configuredMind({ SHANNON_ADR8_STAGE3: 'off' }, { databasePath: join(directory, 'off.sqlite'), now: () => AT })).toBeNull();
  });
});
