import { OWNER_AUDIENCE } from '@shannon/cognition';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCompanionStatePrompt, InMemoryCompanionStateStore, type CompanionStateStore } from '@shannon/cognition';
import { createLocalApiKernel } from '../src/infra/http/apiKernel.js';
import { TurnRefinementProcessor } from '../src/mind/sleep/backgroundUpdates.js';
import type { ShannonChatModel, ShannonChatModelRequest } from '../src/infra/models/chatModel.js';
import { InMemoryConversationStore, type ConversationStore } from '../src/mind/memory/store/conversationStore.js';
import { MemoryEmbeddingWorker } from '../src/mind/memory/memoryEmbeddingWorker.js';
import { DeterministicMemoryModelGateway } from '../src/mind/recall/memoryModels.js';
import { ShannonMemoryService } from '../src/mind/memory/memoryService.js';
import { usableThreadSummary, visibleConversationHistory } from '../src/mind/memory/memoryVisibility.js';
import { SemanticMemoryRecall } from '../src/mind/recall/semanticMemoryRecall.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { prepareTurnCognitiveContext } from '../src/mind/workspace/turnCognitiveContext.js';
import { usableKnowledgeFor } from '../src/mind/recall/turnKnowledgeRecall.js';
import { ShannonTurnMemoryRecall } from '../src/mind/recall/turnMemoryRecall.js';

// Synthetic data only. Times are spaced so "before the forget" is unambiguous.
const minute = (value: number) => new Date(Date.UTC(2026, 8, 20, 0, value)).toISOString();
const forgetAt = minute(500);
const emotion = { valence: 0, arousal: 0.3, openness: 0.35, expression: 'calm' as const };
const turnContext = (extra: Record<string, unknown> = {}) => ({ capturedStateVersion: 0, messageEmotion: emotion, ...extra });
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function sqlite(now: () => string = () => forgetAt): { store: SQLiteShannonStore; path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-withholding-'));
  directories.push(directory);
  const path = join(directory, 'shannon.sqlite');
  return { store: new SQLiteShannonStore({ path, now }), path };
}

const unrelated = [
  ['Xcodeのビルドが通らない', '署名設定を一緒に確認しましょう。'],
  ['アーカイブで止まる', 'プロビジョニングの期限を見てみます。'],
  ['写真アプリの整理をしたい', 'アルバム単位で区切るのが続けやすいです。'],
  ['週末の散歩コースを考えて', '川沿いを北へ歩く案はどうですか。'],
] as const;

/** One long thread: unrelated talk, the source turn, more unrelated talk, and one reply restating the fact. */
function longThread(state: CompanionStateStore, history: ConversationStore, thread: string) {
  let clock = 0;
  const say = (user: string, reply: string, extra?: Record<string, unknown>) =>
    history.appendTurn('owner', thread, user, reply, minute(clock += 1), turnContext(extra));
  for (let round = 0; round < 3; round += 1) for (const [user, reply] of unrelated) say(`${user}（${round}）`, `${reply}（${round}）`);
  const source = say('私は紅茶が好き。', '紅茶が好きなんですね。');
  new TurnRefinementProcessor(state, history).process('owner', source.userMessage, source.id, source.observedAt);
  const fact = state.snapshot('owner').userFacts[0]!;
  for (const [user, reply] of unrelated) say(`${user}（続き）`, `${reply}（続き）`);
  const restated = say('おすすめの飲み物は？', 'ライ氏は紅茶が好きなので、ダージリンはどうですか。');
  const paraphrased = say('午後に何か飲みたい', '温かい一杯を用意しましょうか。', { recalledMemoryIds: [fact.id] });
  const sameWordsNoProvenance = say('夕方に何か飲みたい', '温かい一杯を用意しましょうか。');
  return { source, fact, restated, paraphrased, sameWordsNoProvenance, turns: clock };
}

const assistantReplies = (state: CompanionStateStore, history: ConversationStore, thread: string) =>
  visibleConversationHistory(state.snapshot('owner'), history, 'owner', thread, OWNER_AUDIENCE).filter(item => item.role === 'assistant').map(item => item.content);

describe('forgetting one item withholds only what used it (TM-01)', () => {
  it('keeps unrelated earlier replies, withholds the source turn and the reply that restated the fact, and restores them', () => {
    const state = new InMemoryCompanionStateStore(() => forgetAt);
    const history = new InMemoryConversationStore(400, 1_000, 400);
    const scenario = longThread(state, history, 'thread-a');
    const before = assistantReplies(state, history, 'thread-a');
    expect(before).toHaveLength(scenario.turns);
    const service = new ShannonMemoryService(state, history, () => forgetAt);
    service.mutate('owner', { memoryId: scenario.fact.id, action: 'forget' });

    const visible = visibleConversationHistory(state.snapshot('owner'), history, 'owner', 'thread-a', OWNER_AUDIENCE);
    const replies = visible.filter(item => item.role === 'assistant').map(item => item.content);
    // (a) every unrelated earlier reply is still model history
    for (const [, reply] of unrelated) expect(replies).toContain(`${reply}（0）`);
    expect(replies).toContain('署名設定を一緒に確認しましょう。（続き）');
    // (b) the source turn and the restating reply are withheld; nothing of the fact remains
    expect(JSON.stringify(visible)).not.toContain('紅茶');
    // new turn with provenance: the fact was recalled for it, so a wordless paraphrase is withheld too
    expect(replies.filter(reply => reply === '温かい一杯を用意しましょうか。')).toHaveLength(1);
    expect(replies).toHaveLength(scenario.turns - 3);
    expect(buildCompanionStatePrompt(state.snapshot('owner'))).not.toContain('紅茶');
    expect(history.conversationHistory('owner', 'thread-a')).toHaveLength(scenario.turns * 2);

    // (d) restore lifts exactly what this item withheld
    service.mutate('owner', { memoryId: scenario.fact.id, action: 'restore' });
    expect(assistantReplies(state, history, 'thread-a')).toEqual(before);
    expect(buildCompanionStatePrompt(state.snapshot('owner'))).toContain('紅茶');
  });

  it('treats replies made after the forget as usable, and a second forget moves the boundary', () => {
    const state = new InMemoryCompanionStateStore(() => forgetAt);
    const history = new InMemoryConversationStore(400, 1_000, 400);
    const scenario = longThread(state, history, 'thread-a');
    const service = new ShannonMemoryService(state, history, () => forgetAt);
    service.mutate('owner', { memoryId: scenario.fact.id, action: 'forget' });
    history.appendTurn('owner', 'thread-a', '紅茶の淹れ方を教えて', '紅茶は沸騰直後のお湯で3分蒸らします。', minute(600), turnContext({ recalledMemoryIds: [] }));
    expect(assistantReplies(state, history, 'thread-a')).toContain('紅茶は沸騰直後のお湯で3分蒸らします。');
    service.mutate('owner', { memoryId: scenario.fact.id, action: 'restore' });
    new ShannonMemoryService(state, history, () => minute(700)).mutate('owner', { memoryId: scenario.fact.id, action: 'forget' });
    expect(assistantReplies(state, history, 'thread-a')).not.toContain('紅茶は沸騰直後のお湯で3分蒸らします。');
  });

  it('(f) falls back to the wide boundary only for an item with no decidable key term, and restore lifts it', () => {
    const state = new InMemoryCompanionStateStore(() => forgetAt);
    const history = new InMemoryConversationStore(400, 1_000, 400);
    history.appendTurn('owner', 'thread-a', 'Xcodeのビルドが通らない', '署名設定を一緒に確認しましょう。', minute(1), turnContext({ threadSummary: 'Xcodeの署名設定を確認した' }));
    const vague = history.appendTurn('owner', 'thread-b', 'あれはそれです', 'そうなんですね。', minute(2));
    const service = new ShannonMemoryService(state, history, () => forgetAt);
    service.mutate('owner', { memoryId: vague.id, action: 'forget' });
    expect(assistantReplies(state, history, 'thread-a')).toEqual([]);
    expect(usableThreadSummary(state.snapshot('owner'), history, 'owner', 'thread-a', OWNER_AUDIENCE)).toBeUndefined();
    history.appendTurn('owner', 'thread-a', '続きです', '了解です。', minute(600));
    expect(assistantReplies(state, history, 'thread-a')).toEqual(['了解です。']);
    service.mutate('owner', { memoryId: vague.id, action: 'restore' });
    expect(assistantReplies(state, history, 'thread-a')).toEqual(['署名設定を一緒に確認しましょう。', '了解です。']);
  });

  it('withholds only replies that mention what a correction replaced', () => {
    const state = new InMemoryCompanionStateStore(() => forgetAt);
    const history = new InMemoryConversationStore(400, 1_000, 400);
    const scenario = longThread(state, history, 'thread-a');
    new ShannonMemoryService(state, history, () => forgetAt).mutate('owner', { memoryId: scenario.fact.id, action: 'correct', text: 'ユーザーはコーヒーが好き' });
    const replies = assistantReplies(state, history, 'thread-a');
    expect(replies.join('\n')).not.toContain('紅茶');
    expect(replies).toContain('署名設定を一緒に確認しましょう。（0）');
    expect(buildCompanionStatePrompt(state.snapshot('owner'))).toContain('ユーザーはコーヒーが好き');
  });
});

describe('the same rule from every entrance', () => {
  it('a pencil correction in 覚えていること keeps unrelated earlier replies', async () => {
    const { store } = sqlite(() => forgetAt);
    const thread = store.createThread('owner');
    const scenario = longThread(store, store, thread);
    const kernel = createLocalApiKernel(() => forgetAt, { stateStore: store, conversationStore: store, knowledgeStore: store,
      memoryStore: new ShannonMemoryService(store, store, () => forgetAt, store) });
    const response = await kernel.dispatch({ method: 'POST', path: '/v1/knowledge/correct',
      body: { scopeKey: 'owner', answerId: scenario.fact.id, answer: 'ユーザーはコーヒーが好き' } });
    expect(response.status).toBe(200);
    expect(store.snapshot('owner').memoryControls.find(item => item.memoryId === scenario.fact.id))
      .toMatchObject({ overrideText: 'ユーザーはコーヒーが好き', withheldText: 'ユーザーは紅茶が好き' });
    const replies = assistantReplies(store, store, thread);
    expect(replies.join('\n')).not.toContain('紅茶');
    expect(replies).toContain('署名設定を一緒に確認しましょう。（続き）');
    store.close();
  });

  it('restores what a forget hid even when the controls were written before lineage was recorded', () => {
    const state = new InMemoryCompanionStateStore(() => forgetAt);
    const history = new InMemoryConversationStore();
    const source = history.appendTurn('owner', 'thread-a', '明日プレゼンの練習をしよう', '明日、一緒に練習しましょう。', minute(1));
    new TurnRefinementProcessor(state, history).process('owner', source.userMessage, source.id, source.observedAt);
    const promise = state.snapshot('owner').prospectiveMemories[0]!;
    const service = new ShannonMemoryService(state, history, () => forgetAt);
    service.mutate('owner', { memoryId: promise.id, action: 'forget' });
    // The shape a database holds from before this change: no causedBy, no earlier promise status, no withheld text.
    for (const { causedBy: _cause, commitmentStatusBefore: _before, withheldText: _text, ...legacy } of state.snapshot('owner').memoryControls) {
      state.apply('owner', { type: 'memory-control-upserted', control: legacy });
    }
    expect(state.snapshot('owner').memoryControls.every(item => !item.causedBy && item.status === 'forgotten')).toBe(true);
    expect(visibleConversationHistory(state.snapshot('owner'), history, 'owner', 'thread-a', OWNER_AUDIENCE)).toEqual([]);
    service.mutate('owner', { memoryId: promise.id, action: 'restore' });
    expect(state.snapshot('owner').memoryControls.every(item => item.status === 'active')).toBe(true);
    expect(state.snapshot('owner').prospectiveMemories[0]!.status).toBe('pending');
    expect(visibleConversationHistory(state.snapshot('owner'), history, 'owner', 'thread-a', OWNER_AUDIENCE)).toHaveLength(2);
  });

  it('does not lift a control the owner set separately', () => {
    const state = new InMemoryCompanionStateStore(() => forgetAt);
    const history = new InMemoryConversationStore();
    const source = history.appendTurn('owner', 'thread-a', '明日プレゼンの練習をしよう', '明日、一緒に練習しましょう。', minute(1));
    new TurnRefinementProcessor(state, history).process('owner', source.userMessage, source.id, source.observedAt);
    const promise = state.snapshot('owner').prospectiveMemories[0]!;
    // The turn was forgotten on its own earlier (for example by 「それは忘れて」); the promise is forgotten later.
    state.apply('owner', { type: 'memory-control-upserted', control: { memoryId: source.id, kind: 'experience', status: 'forgotten',
      pinned: false, updatedAt: minute(400), changeReason: 'synthetic', contextInvalidatedAt: minute(400), sourceEvidence: source.userMessage } });
    const service = new ShannonMemoryService(state, history, () => forgetAt);
    service.mutate('owner', { memoryId: promise.id, action: 'forget' });
    service.mutate('owner', { memoryId: promise.id, action: 'restore' });
    expect(state.snapshot('owner').memoryControls.find(item => item.memoryId === source.id)?.status).toBe('forgotten');
    expect(visibleConversationHistory(state.snapshot('owner'), history, 'owner', 'thread-a', OWNER_AUDIENCE)).toEqual([]);
  });

  it('restoring any item of one forget lifts the whole group', () => {
    const state = new InMemoryCompanionStateStore(() => forgetAt);
    const history = new InMemoryConversationStore();
    const source = history.appendTurn('owner', 'thread-a', '明日プレゼンの練習をしよう', '明日、一緒に練習しましょう。', minute(1));
    new TurnRefinementProcessor(state, history).process('owner', source.userMessage, source.id, source.observedAt);
    const promise = state.snapshot('owner').prospectiveMemories[0]!;
    const service = new ShannonMemoryService(state, history, () => forgetAt);
    service.mutate('owner', { memoryId: source.id, action: 'reject' });
    expect(state.snapshot('owner').memoryControls.find(item => item.memoryId === promise.id)).toMatchObject({ status: 'rejected', causedBy: source.id });
    service.mutate('owner', { memoryId: promise.id, action: 'restore' });
    expect(state.snapshot('owner').memoryControls.every(item => item.status === 'active' && !item.causedBy)).toBe(true);
    expect(state.snapshot('owner').prospectiveMemories[0]!.status).toBe('pending');
    expect(visibleConversationHistory(state.snapshot('owner'), history, 'owner', 'thread-a', OWNER_AUDIENCE)).toHaveLength(2);
  });
});

describe('summaries follow the turns they were built from', () => {
  function threads(state: CompanionStateStore, history: ConversationStore) {
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(() => history.createThread('owner'));
    const source = history.appendTurn('owner', a!, '私は紅茶が好き。', '覚えておきます。', minute(1), turnContext({ threadSummary: 'ドリンクの好みを聞いた' }));
    new TurnRefinementProcessor(state, history).process('owner', source.userMessage, source.id, source.observedAt);
    history.appendTurn('owner', b!, 'Xcodeの署名で止まる', '証明書の期限を確認しましょう。', minute(2), turnContext({ threadSummary: 'Xcodeの署名設定を整理した' }));
    history.appendTurn('owner', d!, '銘柄を比べたい', '香りと渋みで分けて考えましょう。', minute(3), turnContext({ threadSummary: '紅茶の銘柄を比較した' }));
    return { a: a!, b: b!, c: c!, d: d!, fact: state.snapshot('owner').userFacts[0]! };
  }
  const recalled = (state: CompanionStateStore, history: ConversationStore, thread: string, message: string) =>
    prepareTurnCognitiveContext(state.snapshot('owner'), history, { present: OWNER_AUDIENCE, scopeKey: 'owner', message, occurredAt: minute(700), channel: 'text', threadId: thread }).frame.recalledMemoryIDs;

  it.each(['memory', 'sqlite'] as const)('(c) keeps an unrelated thread summary and drops the tainted ones (%s store)', kind => {
    const persistent = kind === 'sqlite' ? sqlite().store : null;
    const state: CompanionStateStore = persistent ?? new InMemoryCompanionStateStore(() => forgetAt);
    const history: ConversationStore = persistent ?? new InMemoryConversationStore();
    const { a, b, c, d, fact } = threads(state, history);
    expect(recalled(state, history, c, 'ドリンクの好みは？')).toContain(`thread:${a}`);
    const service = new ShannonMemoryService(state, history, () => forgetAt);
    service.mutate('owner', { memoryId: fact.id, action: 'forget' });
    const snapshot = () => state.snapshot('owner');
    // unrelated: still the prior summary of its own thread and still recalled from another thread
    expect(usableThreadSummary(snapshot(), history, 'owner', b, OWNER_AUDIENCE)).toBe('Xcodeの署名設定を整理した');
    expect(recalled(state, history, c, 'Xcodeの署名設定どうなった？')).toContain(`thread:${b}`);
    // built from the forgotten turn, or restating the forgotten term: dropped
    expect(usableThreadSummary(snapshot(), history, 'owner', a, OWNER_AUDIENCE)).toBeUndefined();
    expect(recalled(state, history, c, 'ドリンクの好みは？')).not.toContain(`thread:${a}`);
    expect(recalled(state, history, c, '紅茶の銘柄はどれがいい？')).not.toContain(`thread:${d}`);
    // (d) restore brings the summaries back
    service.mutate('owner', { memoryId: fact.id, action: 'restore' });
    expect(usableThreadSummary(snapshot(), history, 'owner', a, OWNER_AUDIENCE)).toBe('ドリンクの好みを聞いた');
    expect(recalled(state, history, c, 'ドリンクの好みは？')).toContain(`thread:${a}`);
    service.mutate('owner', { memoryId: fact.id, action: 'forget' });
    // the next turn rebuilds the summary from visible history only; it is usable again without a restore
    history.appendTurn('owner', a, '散歩コースを考えたい', '川沿いを北へ歩く案はどうですか。', minute(800), turnContext({ threadSummary: '散歩コースを相談した' }));
    expect(usableThreadSummary(snapshot(), history, 'owner', a, OWNER_AUDIENCE)).toBe('散歩コースを相談した');
    // a continued chain keeps its start, so a later forget is still judged against the whole chain
    history.appendTurn('owner', a, '距離は？', '約3キロです。', minute(801), turnContext({ threadSummary: '散歩コースと距離を相談した', summaryContinuesChain: true }));
    expect(usableThreadSummary(snapshot(), history, 'owner', a, OWNER_AUDIENCE)).toBe('散歩コースと距離を相談した');
    persistent?.close();
  });

  it('passes history and the prior summary to the model after an unrelated forget, and records provenance', async () => {
    const { store } = sqlite(() => minute(900));
    const { b, fact } = threads(store, store);
    new ShannonMemoryService(store, store, () => forgetAt).mutate('owner', { memoryId: fact.id, action: 'forget' });
    const requests: ShannonChatModelRequest[] = [];
    const model: ShannonChatModel = { mode: 'openai', model: 'test-model',
      async generate(request) { requests.push(request); return { mode: 'openai', model: 'test-model', reply: '続きを確認しましょう。', threadSummary: '署名設定の続きを確認した' }; } };
    const api = createLocalApiKernel(() => minute(900), { chatModel: model, stateStore: store, conversationStore: store });
    const result = await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: b, message: 'さっきボクは何て言った？' } });
    expect(result.status).toBe(200);
    expect(requests[0]!.priorThreadSummary).toBe('Xcodeの署名設定を整理した');
    expect(requests[0]!.history).toEqual([
      { role: 'user', content: 'Xcodeの署名で止まる' }, { role: 'assistant', content: '証明書の期限を確認しましょう。' },
    ]);
    expect(JSON.stringify(requests[0])).not.toContain('紅茶');
    await api.waitForBackground('owner');
    const saved = store.conversationHistory('owner', b).at(-1)!;
    expect(Array.isArray(saved.recalledMemoryIds)).toBe(true);
    const history = await api.dispatch({ method: 'GET', path: '/v1/conversation', query: new URLSearchParams({ scopeKey: 'owner', threadId: b }) });
    expect(history.status).toBe(200);
    expect(JSON.stringify(history.body)).not.toContain('recalledMemoryIds');
    store.close();
  });
});

describe('recall, search, embeddings and private knowledge never surface the forgotten content', () => {
  async function seeded() {
    const { store, path } = sqlite();
    const [a, b, c] = [store.createThread('owner'), store.createThread('owner'), store.createThread('owner')];
    const source = store.appendTurn('owner', a, '私は紅茶が好き。', '覚えておきます。', minute(1), turnContext({ threadSummary: 'ドリンクの好みを聞いた' }));
    new TurnRefinementProcessor(store, store).process('owner', source.userMessage, source.id, source.observedAt);
    const fact = store.snapshot('owner').userFacts[0]!;
    const restated = store.appendTurn('owner', b, '差し入れは何がいい？', 'ライ氏は紅茶が好きなので茶葉にしましょう。', minute(2), turnContext({ threadSummary: '差し入れの相談をした' }));
    const paraphrased = store.appendTurn('owner', c, '午後の休憩どうしよう', '温かい一杯で一息つきましょう。', minute(3),
      turnContext({ threadSummary: '午後の休憩を相談した', recalledMemoryIds: [fact.id] }));
    const tripThread = store.createThread('owner');
    const trip = store.appendTurn('owner', tripThread, '旅行計画は沖縄にする', '了解、沖縄で組みましょう。', minute(4), turnContext({ threadSummary: '沖縄旅行の計画を決めた' }));
    return { store, path, a, b, c, source, fact, restated, paraphrased, trip, tripThread };
  }
  const statuses = (path: string) => {
    const raw = new DatabaseSync(path);
    const rows = raw.prepare('SELECT source_id, status FROM memory_embeddings').all() as Array<{ source_id: string; status: string }>;
    raw.close();
    return Object.fromEntries(rows.map(row => [row.source_id, row.status]));
  };

  it('(e) filters full-text and semantic candidates and never embeds a withheld source', async () => {
    const { store, path, a, b, c, fact, restated, paraphrased, trip, tripThread } = await seeded();
    const embedder = new DeterministicMemoryModelGateway();
    const worker = new MemoryEmbeddingWorker(store, store, embedder, store, { now: () => forgetAt });
    expect(await worker.runOnce()).toBe('worked');
    new ShannonMemoryService(store, store, () => forgetAt).mutate('owner', { memoryId: fact.id, action: 'forget' });
    const snapshot = store.snapshot('owner');

    const lexical = (message: string) => prepareTurnCognitiveContext(snapshot, store, { present: OWNER_AUDIENCE, scopeKey: 'owner', message, occurredAt: minute(700), channel: 'text', threadId: 'elsewhere' });
    expect(lexical('差し入れは何がいい？').frame.recalledMemoryIDs).not.toContain(restated.id);
    expect(lexical('午後の休憩どうしよう').frame.recalledMemoryIDs).not.toContain(paraphrased.id);
    expect(lexical('差し入れの相談と午後の休憩').frame.recalledMemoryIDs).toEqual(expect.not.arrayContaining([`thread:${b}`, `thread:${c}`]));
    expect(lexical('沖縄旅行の計画はどうなった？').frame.recalledMemoryIDs).toEqual(expect.arrayContaining([trip.id]));
    expect(lexical('飲み物の好みと差し入れと休憩').prompt).not.toContain('紅茶');

    const semantic = new SemanticMemoryRecall(new DeterministicMemoryModelGateway(), store, undefined);
    const hits = async (query: string) => (await semantic.recall({ present: OWNER_AUDIENCE, scopeKey: 'owner', query, snapshot, threadId: 'elsewhere' })).hits.map(hit => hit.id);
    expect(await hits('差し入れは何がいい 紅茶 茶葉')).toEqual(expect.not.arrayContaining([restated.id, `thread:${a}`, `thread:${b}`]));
    expect(await hits('午後の休憩 温かい一杯')).toEqual(expect.not.arrayContaining([paraphrased.id, `thread:${c}`]));
    // an unrelated experience and an unrelated thread summary are still candidates after the forget
    expect(await hits('沖縄旅行の計画')).toEqual(expect.arrayContaining([trip.id, `thread:${tripThread}`]));
    const enriched = await new ShannonTurnMemoryRecall(semantic).enrich(lexical('前に話した沖縄旅行の計画を覚えてる？'),
      { scopeKey: 'owner', message: '前に話した沖縄旅行の計画を覚えてる？', snapshot, threadId: 'elsewhere' });
    expect(enriched.prompt).not.toContain('紅茶');

    // A rewritten summary of a tainted thread and a new source are judged again; withheld text is never sent.
    store.appendTurn('owner', b, '包装はどうする？', '紅茶の缶に合わせましょう。', minute(5), turnContext({ threadSummary: '差し入れの包装を決めた', summaryContinuesChain: true }));
    const sent: string[] = [];
    const recording = new DeterministicMemoryModelGateway();
    const embed = recording.embed.bind(recording);
    recording.embed = async (scope, texts, lane, signal) => { sent.push(...texts); return embed(scope, texts, lane, signal); };
    await new MemoryEmbeddingWorker(store, store, recording, store, { now: () => forgetAt }).runOnce();
    expect(sent.join('\n')).not.toContain('紅茶');
    expect(sent.join('\n')).not.toContain('差し入れの包装');
    expect(statuses(path)[b]).toBe('withheld');
    store.close();
  });

  it('(e) stops using private knowledge derived from a withheld turn', async () => {
    const { store, fact, restated, trip } = await seeded();
    const note = (title: string, sources: readonly string[]) => store.createShannonKnowledge('owner', {
      title, applicability: '相談を受けたとき', bodyMarkdown: '## 行動\n相手の状況を先に確かめる。', status: 'hypothesis', sourceExperienceIds: sources,
    }, minute(10), 'synthetic');
    const tainted = note('差し入れの選び方', [restated.id]);
    const clean = note('旅行計画の進め方', [trip.id]);
    const usable = () => usableKnowledgeFor(store, 'owner', store.snapshot('owner')).map(document => document.id);
    expect(usable()).toEqual(expect.arrayContaining([tainted.id, clean.id]));
    const service = new ShannonMemoryService(store, store, () => forgetAt);
    service.mutate('owner', { memoryId: fact.id, action: 'forget' });
    expect(usable()).toEqual([clean.id]);
    service.mutate('owner', { memoryId: fact.id, action: 'restore' });
    expect(usable()).toEqual(expect.arrayContaining([tainted.id, clean.id]));
    store.close();
  });
});

describe('old data and restart safety', () => {
  it('(f) judges turns without provenance by text, keeps provenance across restart, and adds the summary column to an old database', () => {
    const first = sqlite();
    const thread = first.store.createThread('owner');
    const scenario = longThread(first.store, first.store, thread);
    new ShannonMemoryService(first.store, first.store, () => forgetAt).mutate('owner', { memoryId: scenario.fact.id, action: 'forget' });
    first.store.close();
    const raw = new DatabaseSync(first.path);
    raw.exec('ALTER TABLE conversation_threads DROP COLUMN summary_chain_started_at');
    const count = Number(raw.prepare('SELECT COUNT(*) AS n FROM conversation_messages').get()!.n);
    raw.close();
    const reopened = new SQLiteShannonStore({ path: first.path, now: () => forgetAt, maximumModelConversationItems: 100, maximumDisplayedConversationItems: 400 });
    const replies = assistantReplies(reopened, reopened, thread);
    expect(replies.join('\n')).not.toContain('紅茶');
    // provenance survived the restart: one of the two identical paraphrases is withheld, the legacy-shaped one is kept
    expect(replies.filter(reply => reply === '温かい一杯を用意しましょうか。')).toHaveLength(1);
    expect(replies).toHaveLength(scenario.turns - 3);
    expect(usableThreadSummary(reopened.snapshot('owner'), reopened, 'owner', thread, OWNER_AUDIENCE)).toBeUndefined();
    const check = new DatabaseSync(first.path);
    expect(Number(check.prepare('SELECT COUNT(*) AS n FROM conversation_messages').get()!.n)).toBe(count);
    expect((check.prepare("PRAGMA table_info('conversation_threads')").all() as Array<{ name: string }>).map(row => row.name)).toContain('summary_chain_started_at');
    check.close();
    reopened.close();
  });
});

describe('listing and promise restore', () => {
  it('TM-09: a forgotten fact is not listed under 覚えていること and returns on restore', () => {
    const { store } = sqlite();
    const source = store.appendTurn('owner', store.createThread('owner'), '私は紅茶が好き。', '覚えておきます。', minute(1));
    new TurnRefinementProcessor(store, store).process('owner', source.userMessage, source.id, source.observedAt);
    const fact = store.snapshot('owner').userFacts[0]!;
    const service = new ShannonMemoryService(store, store, () => forgetAt, store);
    expect(service.dashboard('owner').knowledge.map(item => item.answerId)).toContain(fact.id);
    expect(service.mutate('owner', { memoryId: fact.id, action: 'forget' }).knowledge.map(item => item.answerId)).not.toContain(fact.id);
    expect(service.mutate('owner', { memoryId: fact.id, action: 'restore' }).knowledge.map(item => item.answerId)).toContain(fact.id);
    store.close();
  });

  it('TM-12: restoring a forgotten promise makes it pending and usable again, with its source turn', () => {
    const state = new InMemoryCompanionStateStore(() => forgetAt);
    const history = new InMemoryConversationStore();
    const source = history.appendTurn('owner', 'thread-a', '明日プレゼンの練習をしよう', '明日、一緒に練習しましょう。', minute(1));
    new TurnRefinementProcessor(state, history).process('owner', source.userMessage, source.id, source.observedAt);
    const promise = state.snapshot('owner').prospectiveMemories[0]!;
    expect(promise.status).toBe('pending');
    const service = new ShannonMemoryService(state, history, () => forgetAt);
    service.mutate('owner', { memoryId: promise.id, action: 'forget' });
    expect(state.snapshot('owner').prospectiveMemories[0]!.status).toBe('dismissed');
    expect(visibleConversationHistory(state.snapshot('owner'), history, 'owner', 'thread-a', OWNER_AUDIENCE)).toEqual([]);
    const restored = service.mutate('owner', { memoryId: promise.id, action: 'restore' });
    expect(restored.items.find(item => item.id === promise.id)).toMatchObject({ status: 'active', commitment: { status: 'pending' } });
    expect(buildCompanionStatePrompt(state.snapshot('owner'))).toContain('プレゼン');
    expect(visibleConversationHistory(state.snapshot('owner'), history, 'owner', 'thread-a', OWNER_AUDIENCE)).toHaveLength(2);
    // a promise that was already completed keeps that state through forget and restore
    service.mutate('owner', { memoryId: promise.id, action: 'complete' });
    service.mutate('owner', { memoryId: promise.id, action: 'forget' });
    expect(service.mutate('owner', { memoryId: promise.id, action: 'restore' }).items.find(item => item.id === promise.id)?.commitment?.status).toBe('completed');
  });
});
