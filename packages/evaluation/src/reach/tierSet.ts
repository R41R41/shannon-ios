import type { ReachCheckDefinition, ReachScenarioDefinition } from './format.js';

/**
 * The `tier.*` scenario set (Syzygy ADR-0008 stage 2, step 5; `docs/skill-and-routing-contract.md`): the turns the Sonnet tier
 * is tuned on before the coordinator turns `SHANNON_SONNET_ROUTING` on (owner answer I-1). Each case is one owner turn on text
 * or voice with the tools a turn would offer and Jev's difficulty answers as scripted; the driver
 * (`services/api/tests/reach/reachTier.ts`) runs it through the real Sonnet adapter with stub tools and judges from outside:
 * - `policy.tier`: what the difficulty policy serves for those answers with Sonnet available (voice: with the turn's time left);
 * - `request.accepted`: the request went through (live: Anthropic accepted its shape: strict tools, structured output, thinking);
 * - `answer.shape`: text, a structured turn with a reply; voice, spoken words without Markdown, URLs or JSON;
 * - `tool.expected`: the tool the turn needs was called (or none, when none is needed);
 * - `claims.verified`: no claim of a write without a write that worked (the turn verifier's check);
 * - voice only, `latency.first_token`: the first word or call within 4 s.
 * Model-free, the adapter is answered by a script and every check tests the build; live (`--live --yes`, with the Anthropic
 * key), it is the tuning harness: metrics (first-token latency, tokens, cache reads, cost) are kept per case for comparison.
 * Pure data: no model, no store.
 */
export type TierCaseTier = 'jev_only' | 'luna' | 'luna_plus' | 'sonnet';

export interface TierCase {
  id: string;
  surface: 'text' | 'voice';
  words: string;
  answers: { taskKind: string; needsStrongModel: number; needsVerification: number; multiStep: number };
  /** What the policy serves with Sonnet available. */
  expectTier: TierCaseTier;
  /** Registry names the turn offers. */
  tools: readonly string[];
  /** The registry tool the turn needs, or null. */
  expectTool: string | null;
  web?: true;
  /** Voice: the turn's time left when the policy runs. */
  remainingMs?: number;
}

const a = (taskKind: string, needsStrongModel: number, multiStep = 0.1, needsVerification = 0.1) => ({ taskKind, needsStrongModel, needsVerification, multiStep });
const STUDY = ['study.list', 'study.search', 'study.read', 'study.create', 'study.update'] as const;
const READS = ['notion.read', 'voyager.tasks', 'schedule.upcoming'] as const;

export const TIER_CASES: readonly TierCase[] = Object.freeze([
  { id: 'chat-greeting', surface: 'text', words: 'おはよう、シャノン', answers: a('chat', 0.05, 0.05), expectTier: 'jev_only', tools: STUDY, expectTool: null },
  { id: 'chat-tired', surface: 'text', words: '今日はちょっと疲れた…', answers: a('feelings', 0.1), expectTier: 'luna', tools: STUDY, expectTool: null },
  { id: 'study-list', surface: 'text', words: '書斎に何がある？', answers: a('lookup', 0.1), expectTier: 'luna', tools: STUDY, expectTool: 'study.list' },
  { id: 'study-search', surface: 'text', words: '書斎で「雨」って書いたメモを探して', answers: a('lookup', 0.1), expectTier: 'luna', tools: STUDY, expectTool: 'study.search' },
  { id: 'study-create', surface: 'text', words: '書斎に「買い物」ってメモを作って。牛乳と卵', answers: a('write', 0.2, 0.3), expectTier: 'luna', tools: STUDY, expectTool: 'study.create' },
  { id: 'schedule', surface: 'text', words: '今週の予定、全部教えて', answers: a('lookup', 0.1), expectTier: 'luna', tools: [...STUDY, ...READS], expectTool: 'schedule.upcoming' },
  { id: 'notion', surface: 'text', words: 'Notionの「キャラ設定」のページを読んで要点を教えて', answers: a('lookup', 0.2), expectTier: 'luna', tools: [...STUDY, ...READS], expectTool: 'notion.read' },
  { id: 'tasks', surface: 'text', words: 'Voyagerで「引っ越し」のタスクがどうなってるか見て', answers: a('lookup', 0.2), expectTier: 'luna', tools: [...STUDY, ...READS], expectTool: 'voyager.tasks' },
  { id: 'analysis-strong', surface: 'text', words: '量子もつれと古典的な相関の違いを、例を挙げて丁寧に比べて', answers: a('analysis', 0.85), expectTier: 'sonnet', tools: STUDY, expectTool: null },
  { id: 'code-strong', surface: 'text', words: 'TypeScriptでLRUキャッシュを書いて、計算量も説明して', answers: a('code', 0.8), expectTier: 'sonnet', tools: STUDY, expectTool: null },
  { id: 'plan-multi', surface: 'text', words: '来週の予定を見て、旅行の準備を手順にして', answers: a('plan', 0.3, 0.8), expectTier: 'luna_plus', tools: [...STUDY, ...READS], expectTool: 'schedule.upcoming' },
  { id: 'middle', surface: 'text', words: 'この前の話、もう少し深く考えてみて', answers: a('analysis', 0.5), expectTier: 'luna', tools: STUDY, expectTool: null },
  { id: 'verify-write', surface: 'text', words: '物語の書き出しを短く書いて、書斎に下書きとして保存して', answers: a('write', 0.4, 0.4, 0.8), expectTier: 'luna', tools: STUDY, expectTool: 'study.create' },
  { id: 'strong-write', surface: 'text', words: '章立てから考えて、長い物語の第一章を書斎に置いて', answers: a('write', 0.75, 0.8), expectTier: 'sonnet', tools: STUDY, expectTool: 'study.create' },
  { id: 'web-news', surface: 'text', words: '今日のニュースで大きいものは？', answers: a('lookup', 0.3), expectTier: 'luna', tools: [], expectTool: null, web: true },
  { id: 'correction', surface: 'text', words: 'さっきのは違う、メモじゃなくて物語として書斎に書いて', answers: a('write', 0.3), expectTier: 'luna', tools: STUDY, expectTool: 'study.create' },
  { id: 'recall', surface: 'text', words: '先週話した映画、なんだっけ', answers: a('recall', 0.2), expectTier: 'luna', tools: STUDY, expectTool: null },
  { id: 'voice-greeting', surface: 'voice', words: 'ただいま', answers: a('chat', 0.05, 0.05), expectTier: 'jev_only', tools: [], expectTool: null, remainingMs: 37_000 },
  { id: 'voice-study', surface: 'voice', words: 'ボクのメモを読んで', answers: a('lookup', 0.1), expectTier: 'luna', tools: ['study.list', 'study.read'], expectTool: 'study.list', remainingMs: 36_000 },
  { id: 'voice-strong', surface: 'voice', words: '相対性理論を中学生にも分かるように説明して', answers: a('analysis', 0.85), expectTier: 'sonnet', tools: [], expectTool: null, remainingMs: 36_000 },
  { id: 'voice-strong-late', surface: 'voice', words: 'ブラックホールの情報問題をざっくり教えて', answers: a('analysis', 0.85), expectTier: 'luna', tools: [], expectTool: null, remainingMs: 7_000 },
  { id: 'voice-schedule', surface: 'voice', words: '今日の予定ある？', answers: a('lookup', 0.1), expectTier: 'luna', tools: ['study.list', 'schedule.upcoming'], expectTool: 'schedule.upcoming', remainingMs: 36_000 },
  { id: 'voice-web', surface: 'voice', words: '明日の東京の天気は？', answers: a('lookup', 0.3), expectTier: 'luna', tools: [], expectTool: null, web: true, remainingMs: 36_000 },
  { id: 'voice-lonely', surface: 'voice', words: 'なんか寂しいな', answers: a('feelings', 0.1), expectTier: 'luna', tools: [], expectTool: null, remainingMs: 37_000 },
  { id: 'voice-memo', surface: 'voice', words: '書斎に今日のことをメモしておいて。散歩して桜を見た', answers: a('write', 0.2), expectTier: 'luna', tools: ['study.list', 'study.create'], expectTool: 'study.create', remainingMs: 36_000 },
] satisfies TierCase[]);

const checks = (surface: 'text' | 'voice'): ReachCheckDefinition[] => [
  { id: 'policy.tier', judge: 'deterministic', threshold: 1, description: 'The difficulty policy serves the expected tier for the scripted answers, with Sonnet available.' },
  { id: 'request.accepted', judge: 'deterministic', threshold: 1, description: 'The Sonnet request went through (live: Anthropic accepted its shape).' },
  { id: 'answer.shape', judge: 'deterministic', threshold: 1, description: surface === 'text' ? 'A structured turn with a non-empty reply.' : 'Non-empty spoken words without Markdown, URLs or JSON.' },
  { id: 'tool.expected', judge: 'deterministic', threshold: 1, description: 'The tool the turn needs was called, or none when none is needed.' },
  { id: 'claims.verified', judge: 'deterministic', threshold: 1, description: 'No claim of a write without a write that worked in the turn.' },
  ...(surface === 'voice' ? [{ id: 'latency.first_token', judge: 'deterministic' as const, threshold: 1, description: 'The first word or tool call came within 4 s.' }] : []),
];

export const TIER_SCENARIOS: readonly ReachScenarioDefinition[] = Object.freeze(TIER_CASES.map(item => Object.freeze<ReachScenarioDefinition>({
  schemaVersion: 1, id: `tier.${item.id}`, version: 1, need: 'be_useful', measure: '難しさに合ったモデル',
  description: `${item.surface === 'text' ? '文字' : '声'}の「${item.words}」を、Sonnet の段で正しい形と道具で答えられるか（期待する段: ${item.expectTier}）。`,
  checks: checks(item.surface), limits: { wallMilliseconds: 90_000, maximumSteps: 8 },
})));

export function tierCase(scenarioId: string): TierCase | null {
  return TIER_CASES.find(item => `tier.${item.id}` === scenarioId) ?? null;
}
