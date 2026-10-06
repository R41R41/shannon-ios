import type { UserFactProposal } from '../src/mind/sleep/sleepConsolidation.js';

export interface ExplicitMemoryDialogueCase {
  id: string;
  category: 'preference' | 'profile' | 'activity' | 'relationship' | 'interest' | 'boundary';
  message: string;
  expected: readonly {
    kind: NonNullable<UserFactProposal['kind']>;
    includes: readonly string[];
  }[];
}

/**
 * Natural Japanese dialogue forms that must remain stable as the extractor and
 * the real model change. Boundary cases intentionally look similar to facts but
 * must not be written to memory.
 */
export const EXPLICIT_MEMORY_DIALOGUE_CASES: readonly ExplicitMemoryDialogueCase[] = [
  { id: 'like-first-person-boku', category: 'preference', message: '僕は水色が好き', expected: [{ kind: 'user-fact', includes: ['水色', '好き'] }] },
  { id: 'like-first-person-watashi', category: 'preference', message: '私は猫が好きです', expected: [{ kind: 'user-fact', includes: ['猫', '好き'] }] },
  { id: 'prefer-first-person', category: 'preference', message: '自分は静かな場所を好む', expected: [{ kind: 'user-fact', includes: ['静かな場所', '好き'] }] },
  { id: 'favorite-food-label', category: 'preference', message: '好きな食べ物は寿司', expected: [{ kind: 'user-fact', includes: ['好きな食べ物', '寿司'] }] },
  { id: 'favorite-food-colon', category: 'preference', message: '一番好きな食べ物：カレーです', expected: [{ kind: 'user-fact', includes: ['好きな食べ物', 'カレー'] }] },
  { id: 'favorite-food-koubutsu', category: 'preference', message: '好物はラーメンだ', expected: [{ kind: 'user-fact', includes: ['好きな食べ物', 'ラーメン'] }] },
  { id: 'favorite-food-comparative', category: 'preference', message: '食べ物なら餃子が一番好き', expected: [{ kind: 'user-fact', includes: ['好きな食べ物', '餃子'] }] },
  { id: 'like-subject-omitted', category: 'preference', message: '寿司が好き', expected: [{ kind: 'user-fact', includes: ['寿司', '好き'] }] },
  { id: 'love-subject-omitted', category: 'preference', message: 'コーヒー大好き！', expected: [{ kind: 'user-fact', includes: ['コーヒー', '好き'] }] },
  { id: 'dislike-first-person', category: 'preference', message: '僕はパクチーが苦手', expected: [{ kind: 'user-fact', includes: ['パクチー', '苦手'] }] },
  { id: 'dislike-food-label', category: 'preference', message: '苦手な食べ物は納豆です', expected: [{ kind: 'user-fact', includes: ['苦手な食べ物', '納豆'] }] },
  { id: 'dislike-subject-omitted', category: 'preference', message: '大きな音が嫌い', expected: [{ kind: 'user-fact', includes: ['大きな音', '苦手'] }] },
  { id: 'profile-name', category: 'profile', message: '名前は亮', expected: [{ kind: 'user-fact', includes: ['名前', '亮'] }] },
  { id: 'profile-job', category: 'profile', message: '仕事はソフトウェア開発', expected: [{ kind: 'user-fact', includes: ['仕事', 'ソフトウェア開発'] }] },
  { id: 'profile-location', category: 'profile', message: '僕は東京に住んでいる', expected: [{ kind: 'user-fact', includes: ['東京', '住んでいる'] }] },
  { id: 'profile-birthday', category: 'profile', message: '誕生日は4月12日', expected: [{ kind: 'user-fact', includes: ['誕生日', '4月12日'] }] },
  { id: 'activity-current', category: 'activity', message: '私はiOSアプリ開発をしている', expected: [{ kind: 'user-fact', includes: ['iOSアプリ開発', 'している'] }] },
  { id: 'relationship-positive', category: 'relationship', message: '結論から話してほしい', expected: [{ kind: 'relationship', includes: ['結論から話してほしい'] }] },
  { id: 'relationship-negative', category: 'relationship', message: '急かさないでほしい', expected: [{ kind: 'relationship', includes: ['急かさないでほしい'] }] },
  { id: 'relationship-advice', category: 'relationship', message: '求めていない時のアドバイスはいらない', expected: [{ kind: 'relationship', includes: ['助言', '望まない'] }] },
  { id: 'interest-recent', category: 'interest', message: '最近エージェント設計に興味がある', expected: [{ kind: 'interest', includes: ['エージェント設計'] }] },
  { id: 'boundary-third-party', category: 'boundary', message: '友達は寿司が好き', expected: [] },
  { id: 'boundary-question', category: 'boundary', message: '好きな食べ物は何？', expected: [] },
  { id: 'boundary-past', category: 'boundary', message: '昔は寿司が好きだった', expected: [] },
  { id: 'boundary-uncertain', category: 'boundary', message: 'たぶん寿司が好き', expected: [] },
  { id: 'boundary-hearsay', category: 'boundary', message: '寿司が好きって友達が言ってた', expected: [] },
  { id: 'boundary-event', category: 'boundary', message: '今日は寿司を食べた', expected: [] },
] as const;

