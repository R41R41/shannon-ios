import { SHANNON_CORE_PROMPT, buildCompanionStatePrompt, type CompanionStateSnapshot, type UserFact } from '@shannon/cognition';

export type KnowledgeSource = 'conversation' | 'sleep' | 'user' | 'inference';

export interface KnowledgeAnswer {
  answerId: string;
  questionKey: string;
  category: string;
  question: string;
  answer: string;
  confidence: number;
  source: KnowledgeSource;
  confirmed: boolean;
  updatedAt: string;
  evidence: readonly KnowledgeEvidence[];
}

export interface KnowledgeEvidence {
  quote: string;
  source: KnowledgeSource;
  observedAt: string;
}

export interface KnowledgeRevision {
  revisionId: string;
  answerId: string;
  previousAnswer: string | null;
  nextAnswer: string;
  reason: string;
  observedAt: string;
}

export interface PersonalityProfile {
  version: number;
  analysis: string;
  createdAt: string;
}

/**
 * Her identity block split by how often each part changes (Syzygy ADR-0003 principle 4: fixed instructions first,
 * changing state at the end, so the provider's prompt cache holds the start of every request): `identity` (persona,
 * suite roles, capabilities) is fixed; `profile` (what she knows of the owner, the personality analysis) changes when
 * background work learns something; `state` (the shared state) changes every turn. The model request puts `identity`
 * first and `state` with the turn's context (`chatModelTurn.ts`).
 */
export interface LayeredIdentityPrompt {
  identity: string;
  profile: string;
  state: string;
}

/** The identity block in the order it had before it was split, and still has where one string is shown. */
export function joinedIdentityPrompt(parts: LayeredIdentityPrompt): string {
  return [parts.identity, parts.state, parts.profile].filter(Boolean).join('\n\n');
}

/** An identity without the owner's profile or state (another audience). */
export function identityOnly(identity: string): LayeredIdentityPrompt {
  return { identity, profile: '', state: '' };
}

/** Without a knowledge store: the core identity and the shared state, as `assembleShannonSystemPrompt` joins them. */
export function companionIdentityPrompt(snapshot: CompanionStateSnapshot): LayeredIdentityPrompt {
  return { identity: SHANNON_CORE_PROMPT, profile: '', state: buildCompanionStatePrompt(snapshot) };
}

export interface KnowledgeStore {
  synchronizeFact(scopeKey: string, fact: UserFact, source: KnowledgeSource): void;
  correctKnowledge(scopeKey: string, answerId: string, answer: string, observedAt: string): void;
  knowledgeAnswers(scopeKey: string): readonly KnowledgeAnswer[];
  knowledgeRevisions(scopeKey: string, answerId?: string): readonly KnowledgeRevision[];
  personalityProfile(scopeKey: string): PersonalityProfile | null;
  promptProjection(scopeKey: string): string | null;
  /** `promptProjection` in its parts; `joinedIdentityPrompt` of it is `promptProjection`. */
  promptProjectionParts(scopeKey: string): LayeredIdentityPrompt | null;
}

export const DEFAULT_QUESTION_DEFINITIONS = Object.freeze([
  { key: 'basic.nickname', category: '基本情報', question: '何と呼ばれたい？', order: 10 },
  { key: 'basic.age', category: '基本情報', question: '年齢は？', order: 20 },
  { key: 'basic.gender', category: '基本情報', question: '性別は？', order: 30 },
  { key: 'basic.occupation', category: '基本情報', question: '仕事・職業は？', order: 40 },
  { key: 'basic.location', category: '基本情報', question: 'どこに住んでいる？', order: 50 },
  { key: 'basic.birthday', category: '基本情報', question: '誕生日は？', order: 60 },
  { key: 'basic.family', category: '基本情報', question: '家族構成は？', order: 70 },
  { key: 'preference.food', category: '趣味嗜好', question: '好きな食べ物は？', order: 110 },
  { key: 'preference.anime', category: '趣味嗜好', question: '好きなアニメは？', order: 120 },
  { key: 'preference.movie', category: '趣味嗜好', question: '好きな映画は？', order: 130 },
  { key: 'interest.goals', category: '興味', question: 'いま、やりたいことは？', order: 210 },
  { key: 'interest.places', category: '興味', question: '行きたい場所は？', order: 220 },
  { key: 'interest.works', category: '興味', question: '見たい作品は？', order: 230 },
  { key: 'interest.dream', category: '興味', question: '将来の夢は？', order: 240 },
] as const);

export function classifyQuestion(statement: string, factId: string): {
  key: string; category: string; question: string; order: number;
} {
  const rules: readonly [RegExp, string, string, string, number][] = [
    [/名前|ニックネーム|呼んで/u, 'basic.nickname', '基本情報', '何と呼ばれたい？', 10],
    [/年齢|歳/u, 'basic.age', '基本情報', '年齢は？', 20],
    [/性別/u, 'basic.gender', '基本情報', '性別は？', 30],
    [/仕事|職業|働/u, 'basic.occupation', '基本情報', '仕事・職業は？', 40],
    [/住んで|在住|住所/u, 'basic.location', '基本情報', 'どこに住んでいる？', 50],
    [/誕生日|生年月日/u, 'basic.birthday', '基本情報', '誕生日は？', 60],
    [/家族|兄弟|姉妹|配偶者/u, 'basic.family', '基本情報', '家族構成は？', 70],
    [/好きな食べ物|好物/u, 'preference.food', '趣味嗜好', '好きな食べ物は？', 110],
    [/アニメ/u, 'preference.anime', '趣味嗜好', '好きなアニメは？', 120],
    [/映画/u, 'preference.movie', '趣味嗜好', '好きな映画は？', 130],
    [/行きたい/u, 'interest.places', '興味', '行きたい場所は？', 220],
    [/見たい|読みたい|観たい/u, 'interest.works', '興味', '見たい作品は？', 230],
    [/夢|将来/u, 'interest.dream', '興味', '将来の夢は？', 240],
    [/やりたい|したい/u, 'interest.goals', '興味', 'いま、やりたいことは？', 210],
  ];
  for (const [pattern, key, category, question, order] of rules) {
    if (pattern.test(statement)) return { key, category, question, order };
  }
  return {
    key: `custom.${factId}`,
    category: /好き|苦手|嫌い|好む/u.test(statement) ? '趣味嗜好' : 'その他',
    question: statement.length <= 42 ? statement : `${statement.slice(0, 39)}…`,
    order: 900,
  };
}
