import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCompanionStatePrompt, InMemoryCompanionStateStore, restoreCompanionState, selectContextualMemories } from '@shannon/cognition';
import { commitmentDeadline } from '../src/commitmentTime.js';
import { extractProspectiveMemories } from '../src/prospectiveMemory.js';
import { TurnRefinementProcessor } from '../src/backgroundUpdates.js';
import { InMemoryConversationStore } from '../src/conversationStore.js';
import { ShannonMemoryService } from '../src/memoryService.js';
import { applyExplicitCommitmentCommand, resolveCommitmentCommand } from '../src/commitmentCommands.js';
import { SQLiteShannonStore } from '../src/sqliteStore.js';
import { SQLiteInitiativeStore } from '../src/initiativeStore.js';
import { SQLiteWorldStore } from '../src/integrations/world/store/worldStore.js';
import { createLocalApiKernel } from '../src/apiKernel.js';
import type { ShannonChatModelRequest } from '../src/chatModel.js';
import { promptOf } from './modelPrompt.js';

const at = '2026-09-24T12:00:00.000Z';
const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));
function fixture() {
  const state = new InMemoryCompanionStateStore(() => at);
  const history = new InMemoryConversationStore();
  const processor = new TurnRefinementProcessor(state, history);
  const source = history.appendTurn('owner', history.threadId('owner'), '明日、旅行の写真を一緒に整理しよう', 'そうしよう', at);
  processor.process('owner', source.userMessage, source.id, '2026-09-27T12:00:00.000Z');
  return { state, history, processor, source, memory: state.snapshot('owner').prospectiveMemories[0]! };
}

describe('cognitive continuity regressions', () => {
  it('resolves tomorrow from the original utterance, not a delayed worker clock', () => {
    const { memory } = fixture();
    expect(memory.createdAt).toBe(at);
    expect(memory.dueDate).toBe('2026-09-25');
    expect(memory.dueAt).toBeUndefined();
    expect(commitmentDeadline('明日の10時に写真整理をリマインドして', at)).toMatchObject({ dueAt: '2026-09-25T01:00:00.000Z', timeZone: 'Asia/Tokyo' });
    expect(commitmentDeadline('今度写真を整理', at)).not.toHaveProperty('dueDate');
    expect(commitmentDeadline('2月30日の10時', at)).not.toHaveProperty('dueAt');
    expect(commitmentDeadline('2026年11月1日の1時', at, 'America/New_York')).not.toHaveProperty('dueAt');
  });

  it('lists promises, cancels them, and does not resurrect them on job retry', () => {
    const { state, history, processor, source, memory } = fixture();
    const service = new ShannonMemoryService(state, history, () => at);
    expect(service.dashboard('owner').items.find(item => item.id === memory.id)?.commitment?.status).toBe('pending');
    const receipt = applyExplicitCommitmentCommand(state, history, 'owner', '旅行の写真整理の約束は取り消して。', at);
    expect(receipt).toContain('action=dismiss');
    processor.process('owner', source.userMessage, source.id, at);
    expect(state.snapshot('owner').prospectiveMemories[0]?.status).toBe('dismissed');
    expect(buildCompanionStatePrompt(state.snapshot('owner'))).not.toContain('明日、旅行');
  });

  it('completes, reschedules, and rejects ambiguous promise commands without guesses', () => {
    const { state, history, memory } = fixture();
    const command = resolveCommitmentCommand(state.snapshot('owner'), '旅行の写真整理の約束を金曜の10時に変更して');
    expect(command).toHaveProperty('mutation.action', 'correct');
    applyExplicitCommitmentCommand(state, history, 'owner', '旅行の写真整理の約束を金曜の10時に変更して', at);
    expect(state.snapshot('owner').prospectiveMemories[0]?.dueAt).toBe('2026-09-25T01:00:00.000Z');
    expect(resolveCommitmentCommand(state.snapshot('owner'), 'その約束を取り消して')).toHaveProperty('clarification');
    expect(resolveCommitmentCommand(state.snapshot('owner'), '写真整理の約束は取り消さないで')).toBeNull();
    new ShannonMemoryService(state, history, () => at).mutate('owner', { memoryId: memory.id, action: 'complete' });
    expect(state.snapshot('owner').prospectiveMemories[0]?.status).toBe('completed');
  });

  it('forget hides the source and all sibling promises from recall and future prompts', () => {
    const { state, history, source, memory } = fixture();
    const service = new ShannonMemoryService(state, history, () => at);
    service.mutate('owner', { memoryId: memory.id, action: 'forget' });
    expect(state.snapshot('owner').memoryControls).toEqual(expect.arrayContaining([
      expect.objectContaining({ memoryId: source.id, status: 'forgotten' }),
    ]));
    expect(buildCompanionStatePrompt(state.snapshot('owner'))).not.toContain('旅行の写真');
  });

  it('never silently drops unresolved promises or forget boundaries on restore', () => {
    const { state, memory } = fixture();
    for (let i = 0; i < 180; i++) {
      state.apply('owner', { type: 'prospective-memory-upserted', memory: { ...memory, id: `promise-${i}` } });
      state.apply('owner', { type: 'memory-control-upserted', control: { memoryId: `hidden-${i}`, kind: 'experience', status: 'forgotten', pinned: false, updatedAt: at, changeReason: 'user' } });
    }
    const restored = restoreCompanionState('owner', JSON.parse(JSON.stringify(state.snapshot('owner'))), at);
    expect(restored.prospectiveMemories).toHaveLength(181);
    expect(restored.memoryControls).toHaveLength(180);
  });

  it('reserves prompt space for commitments despite long facts and dates all recalled evidence', () => {
    const { state } = fixture();
    for (let i = 0; i < 24; i++) state.apply('owner', { type: 'user-fact-upserted', fact: { id: `${i}`, statement: '長い事実'.repeat(80), observedAt: at, confidence: 1 } });
    const prompt = buildCompanionStatePrompt(state.snapshot('owner'));
    expect(prompt.length).toBeLessThanOrEqual(2400);
    expect(prompt).toContain('旅行の写真');
    expect(prompt).toContain('2026-09-25');
  });

  it('ranks equally relevant memories by actual event age rather than array order', () => {
    const rows = [{ id: 'new', summary: '浜松旅行の写真整理', observedAt: at }, { id: 'old', summary: '浜松旅行の写真整理', observedAt: '2020-01-01T00:00:00Z' }];
    expect(selectContextualMemories({ text: '浜松旅行の写真', occurredAt: at }, rows)[0]?.id).toBe('new');
    expect(selectContextualMemories({ text: '浜松旅行の写真', occurredAt: at }, [...rows].reverse())[0]?.id).toBe('new');
  });

  it('uses the same notes/tasks in text and voice, and never reads them for guests', async () => {
    const requests: ShannonChatModelRequest[] = [];
    let noteReads = 0;
    let taskReads = 0;
    const api = createLocalApiKernel(() => at, {
      chatModel: { mode: 'local-stub', model: 'test', generate: async request => { requests.push(request); return { mode: 'local-stub', model: 'test', reply: '確認した' }; } },
      aetherContext: { promptFor: () => { noteReads++; return 'PRIVATE_NOTE_MARKER'; } },
      voyagerCatalog: { listProjects: async () => [], searchTasks: async () => { taskReads++; return [{ id: 'private-task', title: '写真整理', details: 'PRIVATE_TASK_MARKER', status: 'open', projectIds: [], revision: 1, updatedAt: at }]; } },
    });
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', message: 'ノートと「写真整理」のタスクを見て' } });
    await api.dispatch({ method: 'POST', path: '/v1/voice/live/delegations', body: { scopeKey: 'owner', transcript: 'ノートと「写真整理」のタスクを見て' } });
    for (const request of requests) {
      expect(promptOf(request)).toContain('PRIVATE_NOTE_MARKER');
      expect(promptOf(request)).toContain('PRIVATE_TASK_MARKER');
    }
    await api.dispatch({ method: 'POST', path: '/v1/voice/live/delegations', body: { scopeKey: 'owner', participantMode: 'guest', transcript: 'ノートと「写真整理」のタスクを見て' } });
    expect(noteReads).toBe(2);
    expect(taskReads).toBe(2);
    expect(promptOf(requests.at(-1))).not.toContain('PRIVATE_');
  });

  it('survives restart, proposes a due promise once, and never re-notifies a completed promise', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shannon-commitments-'));
    directories.push(dir);
    const path = join(dir, 'state.sqlite');
    let state = new SQLiteShannonStore({ path, now: () => at });
    const memory = extractProspectiveMemories('明日の10時に写真整理をリマインドして', at)[0]!;
    state.apply('owner', { type: 'prospective-memory-upserted', memory });
    state.createThread('owner');
    state.close();
    state = new SQLiteShannonStore({ path, now: () => '2026-09-25T03:00:00.000Z' });
    const world = new SQLiteWorldStore(path);
    const initiatives = new SQLiteInitiativeStore(path);
    expect(state.snapshot('owner').prospectiveMemories[0]?.dueAt).toBe('2026-09-25T01:00:00.000Z');
    expect(initiatives.runOnce('2026-09-25T03:00:00.000Z').sent).toBe(1);
    expect(initiatives.runOnce('2026-09-26T03:00:00.000Z').sent).toBe(0);
    new ShannonMemoryService(state, state, () => '2026-09-26T03:00:00.000Z').mutate('owner', { memoryId: memory.id, action: 'complete' });
    expect(initiatives.runOnce('2026-09-27T03:00:00.000Z').sent).toBe(0);
    expect(initiatives.unreadMessages('owner')).toHaveLength(1);
    initiatives.close(); world.close(); state.close();
  });
});
