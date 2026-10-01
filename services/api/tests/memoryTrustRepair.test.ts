import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCompanionStatePrompt, InMemoryCompanionStateStore } from '@shannon/cognition';
import { captureImmediateExplicitMemory, consolidateSleepMemory, LocalRuleSleepMemoryAnalyzer } from '../src/sleepConsolidation.js';
import { InMemoryConversationStore } from '../src/conversationStore.js';
import { TurnRefinementProcessor } from '../src/backgroundUpdates.js';
import { ShannonMemoryService } from '../src/memoryService.js';
import { usableThreadSummary, visibleConversationHistory } from '../src/memoryVisibility.js';
import { SQLiteShannonStore } from '../src/sqliteStore.js';

const at = '2026-09-25T01:00:00.000Z';
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
const databasePath = () => { const dir = mkdtempSync(join(tmpdir(), 'shannon-memory-trust-')); dirs.push(dir); return join(dir, 'fixture.sqlite'); };
const unsafe = ['友人の名前は太郎です', '友人の仕事は医師です', '彼の誕生日は5月1日', '山田氏の仕事は医師です',
  '私はコーヒーが好きではない', '私は猫が好きじゃない', '私は寿司が好きだった', '私は寿司が好きだったんだ',
  '「私は東京に住んでいる」という例文を翻訳して', '友人が私は猫が好きと言った',
  '例えば私は東京に住んでいるとする', '私はたぶん東京に住んでいる',
  '好きな食べ物は何', '僕の仕事は何か知ってる', '明日は仕事をしてほしいと友人が言った'];

describe('evidence and privacy trust repair', () => {
  it.each(['私は「葬送のフリーレン」が好き', '私は父の作る料理が好き',
    '私は友人と話している時間が好き', '私はサザエさんが好き'])('preserves ownership when a normal preference object contains titles/people: %s', text => {
    const state = new InMemoryCompanionStateStore(() => at).snapshot('owner');
    expect(captureImmediateExplicitMemory(text, state, at).facts).toHaveLength(1);
  });

  it('invalidates corrected original evidence without hiding the explicit replacement, including late sleep paraphrases', async () => {
    const state = new InMemoryCompanionStateStore(() => at);
    const history = new InMemoryConversationStore();
    const source = history.appendTurn('owner', 'thread', '私は紅茶が好き。', '紅茶が好きなんだね。', at);
    new TurnRefinementProcessor(state, history).process('owner', source.userMessage, source.id, at);
    const fact = state.snapshot('owner').userFacts[0]!;
    new ShannonMemoryService(state, history, () => at).mutate('owner', {memoryId: fact.id, action: 'correct', text: 'ユーザーはコーヒーが好き'});
    expect(visibleConversationHistory(state.snapshot('owner'), history, 'owner', 'thread')).toEqual([]);
    const result = await consolidateSleepMemory({mode: 'openai', analyze: async () => [{statement: 'ユーザーは紅茶を好む', evidence: '私は紅茶が好き'}]},
      [{content: source.userMessage, observedAt: at, sourceExperienceId: source.id}], state.snapshot('owner'), at);
    expect(result.facts).toEqual([]);
    const prompt = buildCompanionStatePrompt(state.snapshot('owner'));
    expect(prompt).toContain('ユーザーはコーヒーが好き');
    expect(prompt).not.toContain('紅茶');
  });

  it('withholds old assistant paraphrases while the fact is forgotten, preserves raw history, and restore brings them back', () => {
    const state = new InMemoryCompanionStateStore(() => at);
    const history = new InMemoryConversationStore();
    const source = history.appendTurn('owner', 'thread', '私は紅茶が好き。', '紅茶が好きなんだね。', at);
    new TurnRefinementProcessor(state, history).process('owner', source.userMessage, source.id, at);
    history.appendTurn('owner', 'thread', '私の好きな飲み物は？', 'あなたの好みは紅茶です。', at);
    const fact = state.snapshot('owner').userFacts[0]!;
    const service = new ShannonMemoryService(state, history, () => '2026-09-25T02:00:00.000Z');
    service.mutate('owner', {memoryId: fact.id, action: 'forget'});
    expect(visibleConversationHistory(state.snapshot('owner'), history, 'owner', 'thread').filter(x => x.role === 'assistant')).toEqual([]);
    expect(history.conversationHistory('owner', 'thread')).toHaveLength(4);
    service.mutate('owner', {memoryId: fact.id, action: 'restore'});
    history.appendTurn('owner', 'thread', 'おはよう', 'おはよう！', '2026-09-25T03:00:00.000Z');
    const visible = visibleConversationHistory(state.snapshot('owner'), history, 'owner', 'thread');
    expect(visible.filter(x => x.role === 'assistant').map(x => x.content)).toEqual(['紅茶が好きなんだね。', 'あなたの好みは紅茶です。', 'おはよう！']);
    expect(usableThreadSummary(state.snapshot('owner'), history, 'owner', 'thread')).toBe('おはよう！');
  });

  it('does not invalidate conversation context for pin/unpin alone', () => {
    const state = new InMemoryCompanionStateStore(() => at);
    const history = new InMemoryConversationStore();
    const source = history.appendTurn('owner', 'thread', '私は紅茶が好き。', '覚えたよ', at);
    const service = new ShannonMemoryService(state, history, () => at);
    service.mutate('owner', {memoryId: source.id, action: 'pin'});
    service.mutate('owner', {memoryId: source.id, action: 'unpin'});
    expect(visibleConversationHistory(state.snapshot('owner'), history, 'owner', 'thread')).toHaveLength(2);
    expect(usableThreadSummary(state.snapshot('owner'), history, 'owner', 'thread')).toBe('覚えたよ');
  });

  it('does not derive an interest or pinned recall from forgotten source experience', () => {
    const state = new InMemoryCompanionStateStore(() => at);
    const history = new InMemoryConversationStore();
    const source = history.appendTurn('owner', 'thread', '私は東京が好き。', 'そうなんだね', at);
    const processor = new TurnRefinementProcessor(state, history);
    processor.process('owner', source.userMessage, source.id, at);
    const service = new ShannonMemoryService(state, history, () => at);
    service.mutate('owner', {memoryId: source.id, action: 'pin'});
    const fact = state.snapshot('owner').userFacts[0]!;
    service.mutate('owner', {memoryId: fact.id, action: 'forget'});
    const next = history.appendTurn('owner', 'thread', '東京', 'うん', at);
    processor.process('owner', next.userMessage, next.id, at);
    expect(state.snapshot('owner').interests).not.toContain('東京');
    expect(state.snapshot('owner').activeMemories).toEqual([]);
  });

  it('does not turn a first-person claim inside a liked title into an owner fact', async () => {
    const state = new InMemoryCompanionStateStore(() => at).snapshot('owner');
    const result = await consolidateSleepMemory({mode: 'openai', analyze: async () => [{statement: 'ユーザーは猫が好き', evidence: '私は猫が好き'}]},
      [{content: '私は「私は猫が好き」という小説が好き', observedAt: at}], state, at);
    expect(result.facts).toEqual([]);
  });

  it.each(unsafe)('does not save ambiguous/quoted/third-party/negative evidence: %s', text => {
    const state = new InMemoryCompanionStateStore(() => at).snapshot('owner');
    const result = captureImmediateExplicitMemory(text, state, at);
    expect([...result.facts, ...result.relationships, ...result.interests]).toEqual([]);
  });

  it('rechecks model proposals against evidence attribution instead of trusting an extraction model', async () => {
    const state = new InMemoryCompanionStateStore(() => at).snapshot('owner');
    const evidence = '友人の仕事は医師です';
    const result = await consolidateSleepMemory({ mode: 'openai', analyze: async () => [{statement: 'ユーザーの仕事は医師', evidence}] },
      [{content: evidence, observedAt: at}], state, at);
    expect(result.facts).toEqual([]);
    expect(result.report.learned).toEqual([]);
  });

  it('forgets the original non-commitment experience and all derived prompt/history/sleep uses', async () => {
    const state = new InMemoryCompanionStateStore(() => at);
    const history = new InMemoryConversationStore();
    const source = history.appendTurn('owner', 'thread', '私は紅茶が好き。', '紅茶が好きなんだね。', at);
    new TurnRefinementProcessor(state, history).process('owner', source.userMessage, source.id, at);
    expect(state.snapshot('owner').userFacts[0]).toMatchObject({sourceExperienceId: source.id});
    new ShannonMemoryService(state, history, () => at).mutate('owner', {memoryId: source.id, action: 'forget'});
    expect(buildCompanionStatePrompt(state.snapshot('owner'))).not.toContain('紅茶');
    expect(visibleConversationHistory(state.snapshot('owner'), history, 'owner', 'thread')).toEqual([]);
    const result = await consolidateSleepMemory(new LocalRuleSleepMemoryAnalyzer(), [{content: source.userMessage, observedAt: at}], state.snapshot('owner'), at);
    expect(result.facts).toEqual([]);
  });

  it('forgets a direct fact also in its source conversation, while unrelated history remains usable', () => {
    const state = new InMemoryCompanionStateStore(() => at);
    const history = new InMemoryConversationStore();
    const source = history.appendTurn('owner', 'thread', '私は紅茶が好き。', '紅茶が好きなんだね。', at);
    new TurnRefinementProcessor(state, history).process('owner', source.userMessage, source.id, at);
    history.appendTurn('owner', 'thread', 'おはよう', 'おはよう！', at);
    const fact = state.snapshot('owner').userFacts[0]!;
    state.apply('owner', {type: 'memory-activated', memory: {id: source.id, summary: source.summary, observedAt: at, relevance: 1}});
    new ShannonMemoryService(state, history, () => at).mutate('owner', {memoryId: fact.id, action: 'forget'});
    const remaining = visibleConversationHistory(state.snapshot('owner'), history, 'owner', 'thread');
    // Only the source turn is withheld; the unrelated reply before the forget stays model history.
    expect(remaining).toEqual([{role: 'user', content: 'おはよう'}, {role: 'assistant', content: 'おはよう！'}]);
    expect(JSON.stringify(remaining)).not.toContain('紅茶');
    expect(buildCompanionStatePrompt(state.snapshot('owner'))).not.toContain('紅茶');
  });

  it('repairs an old forgotten fact leaked through personality, preserves history, and distrusts stale cached prompts at read time', () => {
    const path = databasePath();
    let store = new SQLiteShannonStore({path, now: () => at});
    const source = store.appendTurn('owner', store.createThread('owner'), '私は紅茶が好き。', '覚えたよ', at);
    new TurnRefinementProcessor(store, store).process('owner', source.userMessage, source.id, at);
    const fact = store.snapshot('owner').userFacts[0]!;
    new ShannonMemoryService(store, store, () => at).mutate('owner', {memoryId: fact.id, action: 'forget'});
    store.close();
    const legacy = new DatabaseSync(path);
    legacy.prepare('UPDATE personality_profiles SET analysis = ? WHERE active = 1').run('把握している特徴: ユーザーは紅茶が好き');
    legacy.prepare('UPDATE prompt_projections SET content = ?').run('STALE_PROFILE 紅茶');
    legacy.exec('PRAGMA user_version = 13');
    const count = Number(legacy.prepare('SELECT COUNT(*) AS n FROM conversation_messages').get()!.n);
    legacy.close();
    store = new SQLiteShannonStore({path, now: () => at});
    expect(store.promptProjection('owner')).not.toContain('紅茶');
    expect(store.personalityProfile('owner')?.analysis).not.toContain('紅茶');
    const raw = new DatabaseSync(path);
    expect(Number(raw.prepare('SELECT COUNT(*) AS n FROM conversation_messages').get()!.n)).toBe(count);
    expect(String(raw.prepare('SELECT content FROM prompt_projections').get()!.content)).not.toContain('紅茶');
    // A corrupted/stale derived artifact must not bypass final assembly after startup either.
    raw.prepare('UPDATE personality_profiles SET analysis = ? WHERE active = 1').run('STALE_PROFILE 紅茶');
    raw.prepare('UPDATE prompt_projections SET content = ?').run('STALE_PROFILE 紅茶');
    raw.close();
    expect(store.promptProjection('owner')).not.toContain('紅茶');
    expect(store.personalityProfile('owner')?.analysis).not.toContain('紅茶');
    store.close();
  });

  it('recovers provenance for an old forgotten experience from durable events after restart', async () => {
    const path = databasePath();
    let store = new SQLiteShannonStore({path, now: () => at});
    const source = store.appendTurn('owner', store.createThread('owner'), '私は紅茶が好き。', '覚えたよ', at);
    new TurnRefinementProcessor(store, store).process('owner', source.userMessage, source.id, at);
    new ShannonMemoryService(store, store, () => at).mutate('owner', {memoryId: source.id, action: 'forget'});
    store.close();
    const legacy = new DatabaseSync(path);
    const row = JSON.parse(String(legacy.prepare('SELECT snapshot_json FROM companion_states').get()!.snapshot_json));
    row.memoryControls.forEach((control: Record<string, unknown>) => delete control.sourceEvidence);
    row.userFacts.forEach((fact: Record<string, unknown>) => delete fact.sourceExperienceId);
    legacy.prepare('UPDATE companion_states SET snapshot_json = ?').run(JSON.stringify(row));
    legacy.exec('PRAGMA user_version = 13');
    legacy.close();
    store = new SQLiteShannonStore({path, now: () => at});
    expect(store.promptProjection('owner')).not.toContain('紅茶');
    expect(store.snapshot('owner').memoryControls.find(c => c.memoryId === source.id)).toMatchObject({sourceEvidence: source.userMessage});
    const result = await consolidateSleepMemory(new LocalRuleSleepMemoryAnalyzer(), [{content: source.userMessage, observedAt: at}], store.snapshot('owner'), at);
    expect(result.facts).toEqual([]);
    store.close();
  });

  it('keeps correction and context boundaries after SQLite restart/restore', () => {
    const path = databasePath();
    let store = new SQLiteShannonStore({path, now: () => at});
    const thread = store.createThread('owner');
    const source = store.appendTurn('owner', thread, '私は紅茶が好き。', '覚えたよ', at);
    new TurnRefinementProcessor(store, store).process('owner', source.userMessage, source.id, at);
    const fact = store.snapshot('owner').userFacts[0]!;
    const service = new ShannonMemoryService(store, store, () => at);
    service.mutate('owner', {memoryId: fact.id, action: 'correct', text: 'ユーザーはコーヒーが好き'});
    service.mutate('owner', {memoryId: fact.id, action: 'forget'});
    service.mutate('owner', {memoryId: fact.id, action: 'restore'});
    store.close();
    store = new SQLiteShannonStore({path, now: () => at});
    expect(store.promptProjection('owner')).toContain('ユーザーはコーヒーが好き');
    expect(store.promptProjection('owner')).not.toContain('紅茶');
    expect(store.snapshot('owner').memoryControls.find(c => c.memoryId === fact.id)?.contextInvalidatedAt).toBe(at);
    expect(visibleConversationHistory(store.snapshot('owner'), store, 'owner', thread)).toEqual([]);
    store.close();
  });

  it('rolls back all schema-14 repairs if any derived projection write fails', () => {
    const path = databasePath();
    const store = new SQLiteShannonStore({path, now: () => at});
    store.apply('owner', {type: 'user-fact-upserted', fact: {id: 'fixture-fact', statement: 'ユーザーは紅茶が好き',
      evidence: '私は紅茶が好き', confidence: 0.8, observedAt: at}});
    store.apply('owner', {type: 'memory-control-upserted', control: {memoryId: 'fixture-fact', kind: 'user-fact',
      status: 'forgotten', pinned: false, updatedAt: at, changeReason: 'fixture'}});
    store.close();
    const raw = new DatabaseSync(path);
    const snapshot = JSON.parse(String(raw.prepare('SELECT snapshot_json FROM companion_states').get()!.snapshot_json));
    snapshot.memoryControls.forEach((control: Record<string, unknown>) => {delete control.sourceEvidence; delete control.contextInvalidatedAt;});
    raw.prepare('UPDATE companion_states SET snapshot_json = ?').run(JSON.stringify(snapshot));
    raw.exec("PRAGMA user_version = 13; CREATE TRIGGER fixture_fail_profile BEFORE INSERT ON personality_profiles BEGIN SELECT RAISE(ABORT,'FIXTURE_ONLY'); END");
    const read = () => ({state: raw.prepare('SELECT snapshot_json FROM companion_states').get(),
      profiles: raw.prepare('SELECT * FROM personality_profiles ORDER BY version').all(),
      prompts: raw.prepare('SELECT * FROM prompt_projections').all()});
    const before = read();
    expect(() => new SQLiteShannonStore({path, now: () => at})).toThrow('FIXTURE_ONLY');
    expect(read()).toEqual(before);
    expect(raw.prepare('PRAGMA user_version').get()!.user_version).toBe(13);
    raw.close();
  });
});
