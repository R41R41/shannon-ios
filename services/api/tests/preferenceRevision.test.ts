import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryCompanionStateStore } from '@shannon/cognition';
import { TurnRefinementProcessor } from '../src/mind/sleep/backgroundUpdates.js';
import { InMemoryConversationStore } from '../src/mind/memory/store/conversationStore.js';
import { ShannonMemoryService } from '../src/mind/memory/memoryService.js';
import { captureImmediateExplicitMemory, consolidateSleepMemory, LocalRuleSleepMemoryAnalyzer } from '../src/mind/sleep/sleepConsolidation.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

const first = '2026-09-24T01:00:00.000Z';
const later = '2026-09-26T01:00:00.000Z';

function said(messages: readonly [string, string][]) {
  const state = new InMemoryCompanionStateStore(() => later);
  const history = new InMemoryConversationStore();
  const processor = new TurnRefinementProcessor(state, history);
  const turns = messages.map(([text, at]) => {
    const turn = history.appendTurn('owner', 'thread', text, 'わかりました。', at);
    processor.process('owner', text, turn.id, at);
    return turn;
  });
  return { state, history, processor, turns };
}

describe('restating or correcting a preference in conversation (TM-07)', () => {
  it.each([
    [['僕は寿司が好き', '僕は寿司が嫌い'], 'ユーザーは寿司が苦手', 'ユーザーは寿司が好き'],
    [['僕は寿司が好き', 'やっぱり寿司より焼肉が好き'], 'ユーザーは寿司より焼肉が好き', 'ユーザーは寿司が好き'],
    [['僕は辛いものが苦手', '最近辛いものが好きになった'], 'ユーザーは辛いものが好き', 'ユーザーは辛いものが苦手'],
    [['僕の名前は太郎', '僕の名前は次郎'], 'ユーザーの名前は次郎', 'ユーザーの名前は太郎'],
    [['僕は東京に住んでいる', '私は大阪に住んでいる'], 'ユーザーは大阪に住んでいる', 'ユーザーは東京に住んでいる'],
  ] as const)('updates the existing answer in place for %j', ([before, after], statement, previousText) => {
    const { state, history, turns } = said([[before, first], [after, later]]);
    const facts = state.snapshot('owner').userFacts;
    expect(facts.map(fact => fact.statement)).toEqual([statement]);
    expect(facts[0]).toMatchObject({ evidence: after, sourceExperienceId: turns[1]!.id, observedAt: later });
    expect(history.turnCaptures('owner', [turns[1]!.id])).toEqual([
      expect.objectContaining({ kind: 'knowledge', change: 'updated', itemId: facts[0]!.id, previousText }),
    ]);
  });

  it('keeps the revision history and both pieces of evidence in the knowledge store', () => {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-revision-'));
    directories.push(directory);
    const store = new SQLiteShannonStore({ path: join(directory, 'fixture.sqlite'), now: () => later });
    const processor = new TurnRefinementProcessor(store, store);
    for (const [text, at] of [['僕は寿司が好き', first], ['僕は寿司が嫌い', later]] as const) {
      const turn = store.appendTurn('owner', 'thread', text, 'わかりました。', at);
      processor.process('owner', text, turn.id, at);
    }
    const answers = store.knowledgeAnswers('owner');
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ answer: 'ユーザーは寿司が苦手', source: 'conversation' });
    expect(answers[0]!.evidence.map(item => item.quote).sort()).toEqual(['僕は寿司が好き', '僕は寿司が嫌い'].sort());
    expect(store.knowledgeRevisions('owner', answers[0]!.answerId)).toEqual([
      expect.objectContaining({ previousAnswer: 'ユーザーは寿司が好き', nextAnswer: 'ユーザーは寿司が苦手' }),
    ]);
    // The earlier conversation stays as history; the owner knowledge states only the current answer.
    expect(store.promptProjection('owner')).toContain('ユーザーは寿司が苦手');
    expect(store.promptProjection('owner')).not.toContain('ユーザーは寿司が好き');
    store.close();
  });

  it('does not duplicate the revised answer when the nightly batch reads the same day again', async () => {
    const { state, turns } = said([['僕は寿司が好き', first], ['僕は寿司が嫌い', later]]);
    const outcome = await consolidateSleepMemory(new LocalRuleSleepMemoryAnalyzer(), turns.map(turn => ({
      content: turn.userMessage, observedAt: turn.observedAt, sourceExperienceId: turn.id,
    })), state.snapshot('owner'), later);
    for (const fact of outcome.facts) state.apply('owner', { type: 'user-fact-upserted', fact, source: 'sleep' });
    expect(state.snapshot('owner').userFacts.map(fact => fact.statement)).toEqual(['ユーザーは寿司が苦手']);
    // The older opposite sentence is still held for review, never applied.
    expect(outcome.report.contradictions).toEqual([expect.objectContaining({ candidateText: 'ユーザーは寿司が好き' })]);
  });

  it('never lets a late job for an older utterance undo the newer statement', () => {
    const { state, processor, turns } = said([['僕は寿司が嫌い', later]]);
    const stale = { id: 'older-turn', text: '僕は寿司が好き' };
    processor.process('owner', stale.text, undefined, first);
    expect(state.snapshot('owner').userFacts.map(fact => fact.statement)).toEqual(['ユーザーは寿司が苦手']);
    expect(turns).toHaveLength(1);
  });

  it('leaves an owner-corrected answer authoritative and only reports the sleep contradiction', () => {
    const { state, history, processor } = said([['僕は寿司が好き', first]]);
    const fact = state.snapshot('owner').userFacts[0]!;
    new ShannonMemoryService(state, history, () => first).mutate('owner', { memoryId: fact.id, action: 'correct', text: 'ユーザーは寿司の光り物が好き' });
    const turn = history.appendTurn('owner', 'thread', '僕は寿司が嫌い', 'わかりました。', later);
    processor.process('owner', turn.userMessage, turn.id, later);
    expect(state.snapshot('owner').userFacts.map(item => item.statement)).toEqual(['ユーザーは寿司が好き']);
    expect(state.snapshot('owner').memoryControls[0]).toMatchObject({ overrideText: 'ユーザーは寿司の光り物が好き' });
    expect(history.turnCaptures('owner', [turn.id])).toEqual([]);
  });

  it('keeps unrelated and ambiguous restatements as they were', () => {
    const state = new InMemoryCompanionStateStore(() => first);
    state.apply('owner', { type: 'user-fact-upserted', fact: { id: 'a', statement: 'ユーザーは寿司が好き', confidence: 0.7, observedAt: first } });
    const snapshot = state.snapshot('owner');
    // A different topic is a new fact, not a revision.
    expect(captureImmediateExplicitMemory('僕は焼肉が好き', snapshot, later)).toMatchObject({
      facts: [{ statement: 'ユーザーは焼肉が好き' }], revisions: [] });
    // Negated and past-tense sentences stay conversation, as before.
    for (const text of ['実は寿司はそんなに好きじゃない', '僕は寿司が好きだった', '寿司が好きかもしれない', '友人は寿司が嫌い']) {
      expect(captureImmediateExplicitMemory(text, snapshot, later).facts).toEqual([]);
    }
    // Saying the same thing again confirms it; nothing is duplicated.
    expect(captureImmediateExplicitMemory('僕は寿司が好き', snapshot, later)).toMatchObject({ facts: [{ id: 'a' }], revisions: [] });
  });
});
