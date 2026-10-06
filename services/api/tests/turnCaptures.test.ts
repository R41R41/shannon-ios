import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalApiKernel, type ShannonApiKernel } from '../src/apiKernel.js';
import { TurnRefinementProcessor } from '../src/mind/sleep/backgroundUpdates.js';
import { SQLiteCognitiveIntentStore } from '../src/cognitiveIntent.js';
import { conversationCapabilityPrompt } from '../src/conversationCapabilities.js';
import { EXACT_TIME_DECLINED, EXACT_TIME_NOTE } from '../src/mind/memory/prospectiveMemory.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import type { TurnCaptureView } from '../src/mind/memory/store/turnCaptures.js';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

// Thursday 2026-09-24 10:00 in Tokyo.
const at = '2026-09-24T01:00:00.000Z';
interface HistoryMessage { id: string; role: string; content: string; sourceExperienceId?: string; captures?: TurnCaptureView[]; reminder?: unknown }

async function say(kernel: ShannonApiKernel, message: string, threadId?: string) {
  const response = await kernel.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', message, ...(threadId ? { threadId } : {}) } });
  expect(response.status).toBe(200);
  await kernel.waitForBackground('owner');
  return response.body as { threadId: string; turnId: string; reply: string };
}

async function history(kernel: ShannonApiKernel, threadId: string): Promise<HistoryMessage[]> {
  const response = await kernel.dispatch({ method: 'GET', path: '/v1/conversation',
    query: new URLSearchParams({ scopeKey: 'owner', threadId }) });
  return (response.body as { messages: HistoryMessage[] }).messages;
}

const captured = (messages: HistoryMessage[]) => messages.flatMap(message => message.captures ?? []);

describe('what Shannon took in is visible per turn', () => {
  it('attaches a promise, a remembered preference and a goal to the reply of the turn that stated them', async () => {
    const kernel = createLocalApiKernel(() => at);
    const first = await say(kernel, '明日の朝、プレゼンの練習しよう');
    await say(kernel, '僕は寿司が好き。特に光り物、覚えておいて', first.threadId);
    await say(kernel, 'Shannon Deskを今月中に配信したい', first.threadId);
    await say(kernel, 'おはよう', first.threadId);

    const messages = await history(kernel, first.threadId);
    const replies = messages.filter(message => message.role === 'assistant');
    expect(messages.filter(message => message.role === 'user').every(message => message.captures === undefined)).toBe(true);
    expect(replies[0]?.captures).toEqual([expect.objectContaining({
      kind: 'commitment', text: 'プレゼンの練習', dueDate: '2026-09-25', dueHint: '明日の朝', status: 'active',
      itemId: expect.stringMatching(/^prospective-/u),
    })]);
    expect(replies[0]?.sourceExperienceId).toBe(first.turnId);
    expect(replies[1]?.captures).toEqual([
      expect.objectContaining({ kind: 'knowledge', text: '寿司が好き', change: 'created' }),
      expect.objectContaining({ kind: 'knowledge', text: '寿司の中でも特に光り物が好き', change: 'created' }),
    ]);
    expect(replies[2]?.captures).toEqual([expect.objectContaining({ kind: 'intent', text: 'Shannon Deskを今月中に配信したい', status: 'active' })]);
    // A turn that captured nothing carries no field at all.
    expect(replies[3]).not.toHaveProperty('captures');
    // The undated "promise" the old rule created for a preference no longer exists.
    const state = (await kernel.dispatch({ method: 'GET', path: '/v1/state', query: new URLSearchParams({ scopeKey: 'owner' }) })).body as
      { prospectiveMemories: unknown[] };
    expect(state.prospectiveMemories).toHaveLength(1);
  });

  it('serves the same records through the small poll endpoint and never makes the reply wait for them', async () => {
    const kernel = createLocalApiKernel(() => at);
    const response = await kernel.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', message: '明日病院に行く' } });
    const body = response.body as { threadId: string; turnId: string };
    const poll = () => kernel.dispatch({ method: 'GET', path: '/v1/conversation/captures',
      query: new URLSearchParams({ scopeKey: 'owner', threadId: body.threadId }) });
    // The reply has already returned; extraction has not run yet.
    expect((await poll()).body).toMatchObject({ turns: [], reminders: [] });
    await kernel.waitForBackground('owner');
    expect((await poll()).body).toMatchObject({ threadId: body.threadId, turns: [{
      turnId: body.turnId, captures: [{ kind: 'commitment', text: '病院に行く', dueDate: '2026-09-25' }],
    }] });
    expect((await kernel.dispatch({ method: 'GET', path: '/v1/conversation/captures',
      query: new URLSearchParams({ scopeKey: 'owner' }) })).status).toBe(400);
  });

  it('hides a capture once the owner cancels, forgets or dismisses the item, using the existing controls', async () => {
    const kernel = createLocalApiKernel(() => at);
    const turn = await say(kernel, '明日病院に行く');
    await say(kernel, '僕は紅茶が好き', turn.threadId);
    await say(kernel, '記憶の同期を実装したいです', turn.threadId);
    const [promise, fact, goal] = captured(await history(kernel, turn.threadId));

    await kernel.dispatch({ method: 'POST', path: '/v1/memories/action', body: { scopeKey: 'owner', memoryId: promise!.itemId, action: 'dismiss' } });
    expect(captured(await history(kernel, turn.threadId)).map(item => item.kind)).toEqual(['knowledge', 'intent']);
    await kernel.dispatch({ method: 'POST', path: '/v1/memories/action', body: { scopeKey: 'owner', memoryId: fact!.itemId, action: 'forget' } });
    expect(captured(await history(kernel, turn.threadId)).map(item => item.kind)).toEqual(['intent']);
    await kernel.dispatch({ method: 'POST', path: '/v1/cognition/intents/status', body: { scopeKey: 'owner', intentId: goal!.itemId, status: 'dismissed' } });
    expect(captured(await history(kernel, turn.threadId))).toEqual([]);
  });

  it('shows a completed promise as completed and a corrected one with the corrected text', async () => {
    const kernel = createLocalApiKernel(() => at);
    const turn = await say(kernel, '明日病院に行く');
    await say(kernel, '月末に家賃を払う', turn.threadId);
    const [hospital, rent] = captured(await history(kernel, turn.threadId));
    await kernel.dispatch({ method: 'POST', path: '/v1/memories/action', body: { scopeKey: 'owner', memoryId: hospital!.itemId, action: 'complete' } });
    await kernel.dispatch({ method: 'POST', path: '/v1/memories/action',
      body: { scopeKey: 'owner', memoryId: rent!.itemId, action: 'correct', text: '10月5日に家賃を払う' } });
    const after = captured(await history(kernel, turn.threadId));
    expect(after.find(item => item.itemId === hospital!.itemId)).toMatchObject({ status: 'completed' });
    expect(after.find(item => item.itemId === rent!.itemId)).toMatchObject({ text: '10月5日に家賃を払う', dueDate: '2026-10-05' });
  });

  it('forgetting the source conversation hides every capture of that turn', async () => {
    const kernel = createLocalApiKernel(() => at);
    const turn = await say(kernel, '30分後に教えて');
    expect(captured(await history(kernel, turn.threadId))).toEqual([expect.objectContaining({ kind: 'notice', text: EXACT_TIME_DECLINED })]);
    await kernel.dispatch({ method: 'POST', path: '/v1/memories/action', body: { scopeKey: 'owner', memoryId: turn.turnId, action: 'forget' } });
    expect(captured(await history(kernel, turn.threadId))).toEqual([]);
  });

  it('never records a capture for a guest voice turn and records owner voice turns like text', async () => {
    const kernel = createLocalApiKernel(() => at);
    const owner = await say(kernel, 'こんにちは');
    const guest = await kernel.dispatch({ method: 'POST', path: '/v1/voice/live/delegations', body: {
      scopeKey: 'owner', threadId: owner.threadId, transcript: '明日病院に行く。僕は寿司が好き', participantMode: 'guest',
    } });
    expect(guest.status).toBe(200);
    await kernel.waitForBackground('owner');
    expect(captured(await history(kernel, owner.threadId))).toEqual([]);
    expect((await history(kernel, owner.threadId))).toHaveLength(2);

    const voice = await kernel.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/turns', body: {
      scopeKey: 'owner', threadId: owner.threadId, userTranscript: '明日病院に行く', shannonTranscript: 'わかりました。',
    } });
    expect(voice).toMatchObject({ status: 201, body: { turnId: expect.any(String) } });
    await kernel.waitForBackground('owner');
    expect(captured(await history(kernel, owner.threadId))).toEqual([expect.objectContaining({ kind: 'commitment', text: '病院に行く' })]);
  });

  it('is durable and idempotent in SQLite and readable from a second process after restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-captures-'));
    directories.push(directory);
    const path = join(directory, 'fixture.sqlite');
    let store = new SQLiteShannonStore({ path, now: () => at });
    const turn = store.appendTurn('owner', 'thread', '明日8時に起こして。僕は紅茶が好き', 'わかりました。', at);
    const processor = new TurnRefinementProcessor(store, store);
    processor.process('owner', turn.userMessage, turn.id, at);
    processor.process('owner', turn.userMessage, turn.id, at); // a retried job
    expect(store.turnCaptures('owner', [turn.id])).toHaveLength(2);
    store.close();

    // An older API binary opens the same file: the schema version is unchanged.
    const raw = new DatabaseSync(path);
    expect((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(17);
    raw.close();

    store = new SQLiteShannonStore({ path, now: () => at });
    const intents = new SQLiteCognitiveIntentStore(path);
    const kernel = createLocalApiKernel(() => at, { stateStore: store, conversationStore: store, cognitiveIntents: intents });
    expect(captured(await history(kernel, 'thread'))).toEqual([
      expect.objectContaining({ kind: 'knowledge', text: '紅茶が好き' }),
      expect.objectContaining({ kind: 'commitment', text: '起こして', dueAt: '2026-09-24T23:00:00.000Z', note: EXACT_TIME_NOTE }),
    ]);
    intents.close();
    store.close();
  });
});

describe('exact-time requests are answered honestly (AB-06)', () => {
  it('tells the reply lane that no alarm exists before the reply is generated', () => {
    const declined = conversationCapabilityPrompt('owner', '30分後に教えて', {}, { aetherNotes: false, voyagerTasks: false });
    expect(declined).toContain('[Reminder capability]');
    expect(declined).toContain('nothing was stored');
    const stored = conversationCapabilityPrompt('owner', '明日8時に起こして', {}, { aetherNotes: false, voyagerTasks: false });
    expect(stored).toContain('once-a-day message slot');
    expect(conversationCapabilityPrompt('owner', '明日プレゼンの練習しよう', {}, { aetherNotes: false, voyagerTasks: false })).toBe('');
  });
});
