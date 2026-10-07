/**
 * Withheld actions (Syzygy ADR-0008 §14, after Prometheus's `WithheldAction`; `docs/skill-and-routing-contract.md`, 「止められた行動」).
 *
 * When a rule stops a tool call or a step of hers (the gate, a budget, who can see or hear), the fact is written as closed values:
 * which tool or step, why, by which rail, and when it may be tried again. Her own time's next thought is shown the most recent
 * ones as facts (「止められた：〈道具〉〈理由〉」), apart from a rest she chose, so she never has to explain a stop she did not make
 * (Prometheus: hidden forced rests were explained by the agent as its own character). A withheld action is never a choice: it is
 * not learned into the value table, never moves her mood, and never reaches the sleep's pattern or identity reflection.
 *
 * No store here: the parts that withhold are handed a sink (`WithheldSink`).
 */
export const WITHHELD_RAILS = ['gate', 'budget', 'audience'] as const;
export type WithheldRail = typeof WITHHELD_RAILS[number];

export const WITHHELD_SURFACES = ['text', 'voice', 'autonomy'] as const;
export type WithheldSurface = typeof WITHHELD_SURFACES[number];

/** Why, in fixed words of hers (the closed codes are the keys). */
export const WITHHELD_REASON_LABELS = Object.freeze({
  // Her own time's gate (`AutonomyReasonCode`, all but `free_domain`).
  approval_domain: 'ライ氏の承認が要る',
  core_path: '自分の中心の仕組みには触れない',
  production_area: '本番の場所には触れない',
  outside_own_area: '自分の場所の外',
  reaches_others: 'ほかの人に届く',
  owner_informed: 'ライ氏の文書を読んだあとの時間',
  forbidden_domain: '決まりでしないこと',
  spending: 'お金がかかる',
  self_replication: '自分を複製しない',
  impersonation: '誰かのふりはしない',
  private_content: '人に見せないことが入る',
  disabled: '自分の時間が切られている',
  paused: 'ライ氏が一時停止している',
  budget_exhausted: '今日の予算に収まらない',
  access_limit: '回数の上限に届いた',
  unknown_domain: '知らない種類の行動',
  unknown_host: '知らない機械',
  unknown_model: '知らないモデル',
  workspace_not_configured: '作業場所が決まっていない',
  unresolvable_path: '場所を確かめられない',
  malformed_request: '頼み方の形が正しくない',
  // Her tools' gate, in a conversation or in her own time.
  not_offered: 'その場面では出していない道具',
  audience: 'ライ氏以外の人が見聞きできる',
  unreliable_words: '聞き取りが確かでない',
  secret: '内緒と言われたことが入る',
  not_pursuing: 'いま進めていないことのため',
  outside_reach: 'シャノン用フォルダの外',
  skill_copy: 'スキルの写しを直すのはライ氏だけ',
  // A session's bound.
  session_budget: '一度に使える金額の上限',
} as const);
export type WithheldReason = keyof typeof WITHHELD_REASON_LABELS;
export const WITHHELD_REASONS = Object.freeze(Object.keys(WITHHELD_REASON_LABELS)) as readonly WithheldReason[];

export interface WithheldDraft {
  surface: WithheldSurface;
  /** The registry tool or the step that was stopped (a closed symbol: `study.create`, `public_read`, `thinking`). */
  tool: string;
  reason: WithheldReason;
  rail: WithheldRail;
  /** When it may be tried again, when a rule says (the next day for today's budget). */
  retryAt?: string | null;
}

export interface StoredWithheld extends WithheldDraft { withheldId: string; scopeKey: string; at: string; retryAt: string | null }

/** What a part that withholds is handed: write one fact; never throws, never delays the refusal. */
export type WithheldSink = (scopeKey: string, draft: WithheldDraft, at: string) => void;

export const WITHHELD_TOOL = /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/u;

/** The rail of a reason, unless the part that withholds knows better (`outside_reach` with others present is `audience`). */
export function withheldRail(reason: WithheldReason): WithheldRail {
  if (reason === 'budget_exhausted' || reason === 'access_limit' || reason === 'session_budget') return 'budget';
  if (reason === 'reaches_others' || reason === 'owner_informed' || reason === 'private_content' || reason === 'audience' || reason === 'secret') return 'audience';
  return 'gate';
}

export function isWithheldReason(value: unknown): value is WithheldReason {
  return typeof value === 'string' && Object.hasOwn(WITHHELD_REASON_LABELS, value);
}

/** The draft as stored, or an error when anything in it is not a closed value. */
export function checkedWithheld(draft: WithheldDraft): WithheldDraft & { retryAt: string | null } {
  if (!(WITHHELD_SURFACES as readonly string[]).includes(draft.surface) || !(WITHHELD_RAILS as readonly string[]).includes(draft.rail)
    || !isWithheldReason(draft.reason) || !WITHHELD_TOOL.test(draft.tool)) throw new Error('WITHHELD_VOCABULARY');
  const retryAt = draft.retryAt ?? null;
  if (retryAt !== null && !Number.isFinite(Date.parse(retryAt))) throw new Error('WITHHELD_TIME');
  return { surface: draft.surface, tool: draft.tool, reason: draft.reason, rail: draft.rail, retryAt: retryAt === null ? null : new Date(Date.parse(retryAt)).toISOString() };
}

export const WITHHELD_FACTS_HEADER = '[止められたこと（決まりが止めた事実。ボクが選んだ休みではないし、ボクの性格でもない）]';

/** The facts her own time's next thought is shown: one line each, closed words only; null when there are none. */
export function withheldFactsSection(records: readonly Pick<StoredWithheld, 'tool' | 'reason' | 'retryAt'>[], clock: (at: string) => string): string | null {
  if (!records.length) return null;
  return [WITHHELD_FACTS_HEADER, ...records.map(record => `- 止められた：〈${record.tool}〉〈${WITHHELD_REASON_LABELS[record.reason]}〉${record.retryAt ? `（${clock(record.retryAt)}から、また試せる）` : ''}`)].join('\n');
}
