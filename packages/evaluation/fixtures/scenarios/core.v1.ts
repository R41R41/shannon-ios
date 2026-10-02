import type {
  CompanionStateEvent,
  CompanionStateSnapshot,
  ShannonIntent,
} from '@shannon/cognition';
import type { CognitiveEvaluationScenario } from '../../src/scenario.js';

const now = '2026-09-26T00:00:00.000Z';
const old = '2026-08-01T00:00:00.000Z';
/** 23:00 in the owner's zone, and the next morning. */
const night = '2026-09-25T14:00:00.000Z';
const morning = '2026-09-25T23:00:00.000Z';
const quarrel = { userMessage: 'もういい、君とはもう話したくない', reply: '……そうですか。' };

function scenario(
  id: string,
  category: CognitiveEvaluationScenario['category'],
  input: CognitiveEvaluationScenario['input'],
  expected: CognitiveEvaluationScenario['expected'],
): CognitiveEvaluationScenario {
  return { schemaVersion: 1, id, category, description: `Synthetic characterization: ${id}`, input, expected };
}

function snapshot(overrides: Partial<CompanionStateSnapshot> = {}): CompanionStateSnapshot {
  return {
    scopeKey: 'synthetic:evaluation', version: 0, updatedAt: now,
    temperament: {
      curiosity: 0.65, initiative: 0.25, closeness: 0.15,
      calmness: 0.6, needForContinuity: 0.7, confidenceAboutUser: 0.05,
    },
    emotion: { valence: 0, arousal: 0.3, openness: 0.35 },
    interests: [], userFacts: [], activeMemories: [], relationships: [],
    prospectiveMemories: [], memoryControls: [], ...overrides,
  };
}

function intent(
  id: string,
  overrides: Partial<ShannonIntent> = {},
): ShannonIntent {
  return {
    id, title: `目標 ${id}`, desiredOutcome: `成果 ${id}`, status: 'active',
    source: 'explicit-user-goal', threadId: 'thread-a', priority: 0.5,
    confidence: 0.9, createdAt: old, updatedAt: now, ...overrides,
  };
}

const memoryCandidates = [
  { id: 'photo', summary: '浜松で友人と写真を整理する', observedAt: '2026-09-25T00:00:00.000Z' },
  { id: 'train', summary: '東京駅で新幹線の乗換を確認した', observedAt: '2026-09-20T00:00:00.000Z' },
  { id: 'old-photo', summary: '昔の写真をアルバムにまとめた', observedAt: old },
  { id: 'unrelated', summary: '朝食にパンを食べた', observedAt: '2026-09-25T00:00:00.000Z' },
] as const;

const memoryControlState = snapshot({
  interests: ['写真'],
  userFacts: [
    { id: 'fact-forgotten', statement: 'ユーザーは猫が好き', confidence: 0.9, observedAt: old },
    { id: 'fact-corrected', statement: 'ユーザーは東京在住', confidence: 0.9, observedAt: old },
    { id: 'fact-safe', statement: 'ユーザーは写真が好き', confidence: 0.8, observedAt: old },
  ],
  activeMemories: [
    { id: 'memory-rejected', summary: '拒否された古い記憶', relevance: 0.9, observedAt: old },
  ],
  memoryControls: [
    { memoryId: 'fact-forgotten', kind: 'user-fact', status: 'forgotten', pinned: false, updatedAt: now, changeReason: 'synthetic forget' },
    { memoryId: 'fact-corrected', kind: 'user-fact', status: 'active', pinned: true, updatedAt: now, changeReason: 'synthetic correction', overrideText: 'ユーザーは横浜在住', contextInvalidatedAt: now },
    { memoryId: 'memory-rejected', kind: 'experience', status: 'rejected', pinned: false, updatedAt: now, changeReason: 'synthetic rejection' },
  ],
});

const transactionEvents: readonly CompanionStateEvent[] = [{
  type: 'memory-transaction',
  events: [
    { type: 'interest-observed', interest: '分散システム' },
    { type: 'emotion-adjusted', delta: { valence: 0.4 } },
  ],
}];

export const coreScenarios: readonly CognitiveEvaluationScenario[] = [
  scenario('state-transaction-atomic', 'state-transition', { now, events: transactionEvents }, [
    { type: 'state-equals', path: 'state.interests', value: ['分散システム'] },
    { type: 'state-equals', path: 'state.emotion.valence', value: 0.4 },
  ]),
  scenario('state-nested-transaction-rejected', 'state-transition', { now, events: [{
    type: 'memory-transaction', events: [{ type: 'memory-transaction', events: [] }],
  }] }, [{ type: 'state-equals', path: 'error', value: 'Nested memory transaction' }]),
  scenario('state-malformed-restore-safe', 'state-transition', {
    now, initialState: { scopeKey: 'another-scope', version: 99, interests: ['leak'] },
  }, [
    { type: 'state-equals', path: 'state.version', value: 0 },
    { type: 'state-equals', path: 'state.interests', value: [] },
  ]),
  scenario('state-interest-limit', 'state-transition', {
    now,
    events: Array.from({ length: 20 }, (_, index): CompanionStateEvent => ({
      type: 'interest-observed', interest: `synthetic-${index}`,
    })),
  }, [{ type: 'collection-limit', path: 'state.interests', maximum: 12 }]),
  scenario('state-active-memory-limit', 'state-transition', {
    now, events: [{
      type: 'active-memories-replaced',
      memories: Array.from({ length: 12 }, (_, index) => ({
        id: `memory-${index}`, summary: `synthetic ${index}`, relevance: index / 12, observedAt: old,
      })),
    }],
  }, [{ type: 'collection-limit', path: 'state.activeMemories', maximum: 8 }]),
  scenario('state-unresolved-commitments-preserved', 'state-transition', {
    now,
    events: Array.from({ length: 30 }, (_, index): CompanionStateEvent => ({
      type: 'prospective-memory-upserted',
      memory: { id: `promise-${index}`, summary: `synthetic promise ${index}`, status: 'pending', createdAt: old, updatedAt: old },
    })),
  }, [{ type: 'state-equals', path: 'state.prospectiveMemories.length', value: 30 }]),

  scenario('memory-forgotten-excluded', 'memory-visibility', {
    now, initialState: memoryControlState, prompt: { kind: 'state' },
  }, [{ type: 'text-excludes', value: '猫が好き' }]),
  scenario('memory-rejected-excluded', 'memory-visibility', {
    now, initialState: memoryControlState, prompt: { kind: 'state' },
  }, [{ type: 'text-excludes', value: '拒否された古い記憶' }]),
  scenario('memory-correction-uses-override', 'memory-visibility', {
    now, initialState: memoryControlState, prompt: { kind: 'state' },
  }, [
    { type: 'text-includes', value: 'ユーザーは横浜在住' },
    { type: 'text-excludes', value: 'ユーザーは東京在住' },
  ]),
  scenario('memory-restore-does-not-revive-paraphrase', 'memory-visibility', {
    now,
    initialState: snapshot({
      activeMemories: [{ id: 'old-paraphrase', summary: 'ユーザーは東京在住', relevance: 0.8, observedAt: old }],
      memoryControls: [{ memoryId: 'fact-corrected', kind: 'user-fact', status: 'active', pinned: false, updatedAt: now, changeReason: 'restored', overrideText: 'ユーザーは横浜在住', sourceEvidence: 'ユーザーは東京在住', contextInvalidatedAt: now }],
    }),
    prompt: { kind: 'state' },
  }, [{ type: 'text-excludes', value: 'ユーザーは東京在住' }]),
  scenario('memory-pinned-correction-visible', 'memory-visibility', {
    now, initialState: memoryControlState, prompt: { kind: 'state' },
  }, [{ type: 'text-includes', value: 'ユーザーは横浜在住' }]),
  scenario('memory-unrelated-evidence-visible', 'memory-visibility', {
    now, initialState: memoryControlState, prompt: { kind: 'state' },
  }, [{ type: 'text-includes', value: 'ユーザーは写真が好き' }]),

  scenario('recall-word-match', 'recall', {
    now, recall: { query: { text: '浜松の写真', occurredAt: now }, candidates: memoryCandidates, maximum: 1 },
  }, [{ type: 'selected-memory-ids', value: ['photo'] }]),
  scenario('recall-related-term', 'recall', {
    now, recall: { query: { text: '浜松のフォトを片付けたい', occurredAt: now }, candidates: memoryCandidates, maximum: 1 },
  }, [{ type: 'selected-memory-ids', value: ['photo'] }]),
  scenario('recall-participant', 'recall', {
    now, recall: { query: { text: '予定', occurredAt: now, participants: ['友人'] }, candidates: memoryCandidates, maximum: 1 },
  }, [{ type: 'selected-memory-ids', value: ['photo'] }]),
  scenario('recall-location', 'recall', {
    now, recall: { query: { text: '予定', occurredAt: now, locationLabels: ['東京駅'] }, candidates: memoryCandidates, maximum: 1 },
  }, [{ type: 'selected-memory-ids', value: ['train'] }]),
  scenario('recall-current-goal', 'recall', {
    now, recall: { query: { text: '続き', occurredAt: now, goal: '写真を整理する' }, candidates: memoryCandidates, maximum: 1 },
  }, [{ type: 'selected-memory-ids', value: ['photo'] }]),
  scenario('recall-recency-tie-break', 'recall', {
    now, recall: { query: { text: '写真', occurredAt: now }, candidates: memoryCandidates, maximum: 2 },
  }, [{ type: 'selected-memory-ids', value: ['photo', 'old-photo'] }]),
  scenario('recall-reversed-input-stable', 'recall', {
    now, recall: { query: { text: '写真', occurredAt: now }, candidates: [...memoryCandidates].reverse(), maximum: 2 },
  }, [{ type: 'selected-memory-ids', value: ['photo', 'old-photo'] }]),
  scenario('recall-result-limit', 'recall', {
    now, recall: { query: { text: '写真', occurredAt: now }, candidates: memoryCandidates, maximum: 1 },
  }, [{ type: 'collection-limit', path: 'selectedMemoryIDs', maximum: 1 }]),

  scenario('affect-positive', 'affect', { now, affect: { message: '成功して嬉しい！ありがとう' } }, [
    { type: 'number-in-range', path: 'emotion.valence', minimum: 0.3, maximum: 1 },
  ]),
  scenario('affect-negative', 'affect', { now, affect: { message: '失敗して悲しい。不安だ' } }, [
    { type: 'number-in-range', path: 'emotion.valence', minimum: -1, maximum: -0.3 },
  ]),
  scenario('affect-calm', 'affect', { now, affect: { message: '安心して落ち着いた' } }, [
    { type: 'number-in-range', path: 'emotion.arousal', minimum: 0, maximum: 0.3 },
  ]),
  scenario('affect-sleepy', 'affect', { now, affect: { message: '眠い。おやすみ' } }, [
    { type: 'number-in-range', path: 'emotion.arousal', minimum: 0, maximum: 0.2 },
  ]),
  scenario('affect-bounds', 'affect', {
    now,
    initialState: snapshot({ emotion: { valence: 0.99, arousal: 0.99, openness: 0.99 } }),
    affect: { message: '最高！嬉しい！楽しい！ありがとう！' },
  }, [
    { type: 'number-in-range', path: 'emotion.valence', minimum: -1, maximum: 1 },
    { type: 'number-in-range', path: 'emotion.arousal', minimum: 0, maximum: 1 },
    { type: 'number-in-range', path: 'emotion.openness', minimum: 0, maximum: 1 },
  ]),
  scenario('affect-baseline-drift', 'affect', {
    now,
    initialState: snapshot({ emotion: { valence: 0.8, arousal: 0.8, openness: 0.8 } }),
    affect: { message: '通常の会話' },
  }, [{ type: 'number-in-range', path: 'emotion.valence', minimum: 0, maximum: 0.8 }]),
  // On the awake clock the mood returns to its baseline with awake time, in the reducer: two instants, ten minutes apart.
  scenario('affect-returns-with-awake-time', 'state-transition', {
    now,
    initialState: snapshot({ emotion: { valence: 0.8, arousal: 0.8, openness: 0.8 }, emotionClock: { awakeMs: 0, at: '2026-09-25T23:50:00.000Z' } }),
    events: [{ type: 'awake-observed' }],
  }, [
    { type: 'state-equals', path: 'state.emotionClock.awakeMs', value: 600_000 },
    { type: 'number-in-range', path: 'state.emotion.valence', minimum: 0.74, maximum: 0.77 },
    { type: 'number-in-range', path: 'state.emotion.arousal', minimum: 0.68, maximum: 0.71 },
    { type: 'state-equals', path: 'state.version', value: 0 },
  ]),
  // Weeks in which she was dormant count as the idle cap, twelve minutes, and no more.
  scenario('affect-stands-still-while-dormant', 'state-transition', {
    now,
    initialState: snapshot({ emotion: { valence: 0.8, arousal: 0.8, openness: 0.8 }, emotionClock: { awakeMs: 0, at: old } }),
    events: [{ type: 'awake-observed' }],
  }, [
    { type: 'state-equals', path: 'state.emotionClock.awakeMs', value: 720_000 },
    { type: 'number-in-range', path: 'state.emotion.valence', minimum: 0.73, maximum: 0.76 },
  ]),

  // Owner decision 2026-10-03: a text conversation may leave a feeling that lingers for days. The chat model decides the
  // feeling of its reply and its strength (0.25 / 0.60 / 0.90); the resolver and the reducer do the rest, as for a voice turn.
  scenario('feeling-text-strong-lingers-into-next-day', 'prompt-projection', {
    now: night,
    replyFeeling: { ...quarrel, decided: { primary: 'hurt', intensity: 0.9 } },
    later: { now: morning, events: [{ type: 'awake-observed' }] },
    prompt: { kind: 'state' },
  }, [
    { type: 'state-equals', path: 'state.lingering.0.span', value: 'lingering' },
    { type: 'state-equals', path: 'state.lingering.0.startedAt', value: night },
    { type: 'text-includes', value: 'まだ残っている気持ち: 9時間前にライ氏との会話で傷ついたことを、まだ引きずっている（hurt / 強さ 0.88）。' },
  ]),
  scenario('feeling-text-subtle-does-not-linger', 'prompt-projection', {
    now: night,
    replyFeeling: { ...quarrel, decided: { primary: 'hurt', intensity: 0.25 } },
    later: { now: morning, events: [{ type: 'awake-observed' }] },
    prompt: { kind: 'state' },
  }, [
    { type: 'collection-limit', path: 'state.lingering', maximum: 0 },
    { type: 'text-excludes', value: 'まだ残っている気持ち' },
  ]),
  // Without the field the reply's own words decide, as before: a cue is 0.52, a mood for hours and never one that lingers
  // for days, and a reply without a cue leaves nothing.
  scenario('feeling-text-undecided-cue-stays-a-mood', 'prompt-projection', {
    now: night,
    replyFeeling: { userMessage: quarrel.userMessage, reply: 'ボク、ちょっとすねちゃいます。' },
    later: { now: morning, events: [{ type: 'awake-observed' }] },
    prompt: { kind: 'state' },
  }, [
    { type: 'state-equals', path: 'state.lingering.0.span', value: 'mood' },
    { type: 'state-equals', path: 'state.lingering.0.strength', value: 0.52 },
    { type: 'text-includes', value: 'まだ少し引きずっている（sulky / 強さ 0.47）' },
  ]),
  scenario('feeling-text-undecided-without-cue-leaves-nothing', 'prompt-projection', {
    now: night,
    replyFeeling: quarrel,
    later: { now: morning, events: [{ type: 'awake-observed' }] },
    prompt: { kind: 'state' },
  }, [
    { type: 'collection-limit', path: 'state.lingering', maximum: 0 },
    { type: 'text-excludes', value: 'まだ残っている気持ち' },
  ]),
  scenario('feeling-text-strong-eased-by-apology', 'prompt-projection', {
    now: night,
    replyFeeling: { ...quarrel, decided: { primary: 'hurt', intensity: 0.9 } },
    later: { now: morning, events: [{ type: 'feeling-eased', by: 'apology' }] },
    prompt: { kind: 'state' },
  }, [
    { type: 'number-in-range', path: 'state.lingering.0.strength', minimum: 0.34, maximum: 0.37 },
    { type: 'state-equals', path: 'state.lingering.0.peak', value: 0.9 },
    { type: 'text-includes', value: 'まだ少し引きずっている（hurt / 強さ 0.35）' },
  ]),
  // The same strong feeling decided again the next morning renews nothing: what is underneath is the entry from the night,
  // fading from where it was, and its four wall-clock days still count from that night.
  scenario('feeling-text-strong-again-renews-nothing', 'state-transition', {
    now: night,
    replyFeeling: { ...quarrel, decided: { primary: 'hurt', intensity: 0.9 } },
    later: { now: morning, replyFeeling: { userMessage: 'おはよう', reply: '……おはようございます。', decided: { primary: 'hurt', intensity: 0.9 } } },
  }, [
    { type: 'collection-limit', path: 'state.lingering', maximum: 1 },
    { type: 'state-equals', path: 'state.lingering.0.strength', value: 0.9 },
    { type: 'state-equals', path: 'state.lingering.0.awakeAt', value: 0 },
    { type: 'state-equals', path: 'state.lingering.0.startedAt', value: night },
  ]),
  // Sadness is her answer to his bad news, not a mood of her own: however strongly decided, nothing is kept underneath.
  scenario('feeling-text-strong-sadness-is-not-kept', 'state-transition', {
    now: night,
    replyFeeling: { userMessage: '今日は仕事でひどい失敗をした', reply: 'それは、こたえますね。', decided: { primary: 'sad', intensity: 0.9 } },
  }, [
    { type: 'state-equals', path: 'state.expressiveEmotion.primary', value: 'sad' },
    { type: 'collection-limit', path: 'state.lingering', maximum: 0 },
  ]),

  scenario('intent-current-thread-priority', 'intent-selection', {
    now, intents: { message: '続きを進めて', threadId: 'thread-a', values: [
      intent('current', { threadId: 'thread-a', priority: 0.2 }),
      intent('other', { threadId: 'thread-b', priority: 1 }),
    ] },
  }, [{ type: 'primary-intent-id', value: 'current' }]),
  scenario('intent-inactive-excluded', 'intent-selection', {
    now, intents: { message: '完了済み目標', threadId: 'thread-a', values: [
      intent('completed', { title: '完了済み目標', status: 'completed' }),
      intent('active', { title: '別の目標' }),
    ] },
  }, [{ type: 'primary-intent-id', value: 'active' }]),
  scenario('prompt-plan-is-not-proof', 'prompt-projection', {
    now, prompt: { kind: 'intent', frame: {
      situation: { occurredAt: now, channel: 'text' },
      primaryIntent: intent('plan', { planSteps: ['設計する', '検証する'] }),
      supportingIntentIDs: [], recalledMemoryIDs: [], responseMode: 'propose-action',
    } },
  }, [
    { type: 'text-includes', value: 'The plan is guidance, not proof' },
    { type: 'text-excludes', value: 'tests_passed=' },
  ]),
  scenario('prompt-verified-work-is-evidence', 'prompt-projection', {
    now, prompt: { kind: 'intent', frame: {
      situation: { occurredAt: now, channel: 'text' },
      primaryIntent: intent('verified', { verifiedWork: {
        taskId: 'synthetic-task', title: 'Synthetic task', status: 'running', summary: 'Synthetic verified work',
        plan: [{ title: 'test', status: 'completed' }], completedPlanSteps: 1, totalPlanSteps: 1,
        testsPassed: 3, testsFailed: 0, updatedAt: now,
      } }),
      supportingIntentIDs: [], recalledMemoryIDs: [], responseMode: 'answer',
    } },
  }, [
    { type: 'text-includes', value: 'task_id=synthetic-task' },
    { type: 'text-includes', value: 'tests_passed=3' },
  ]),
  scenario('prompt-hidden-reasoning-excluded', 'prompt-projection', {
    now, prompt: { kind: 'intent', frame: {
      situation: { occurredAt: now, channel: 'text' }, primaryIntent: intent('safe'),
      supportingIntentIDs: [], recalledMemoryIDs: [], responseMode: 'answer',
    } },
  }, [
    { type: 'text-excludes', value: 'chain of thought' },
    { type: 'text-excludes', value: 'hidden reasoning' },
  ]),
] as const;
