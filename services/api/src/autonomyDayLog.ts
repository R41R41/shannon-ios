import type { AutonomyLoopHeartbeat } from './autonomyLoopState.js';

/**
 * Owner-facing wording computed from the activity record and the loop's heartbeat,
 * without a model call: a short log of her day, and the state line of the loop.
 */
interface LoggedEntry { kind: string; outcome: string; tool?: string; reasonCode?: string }

/** Activity-loop tools in the order a day usually runs: verb stem for a sentence, plain past for a prompt line. */
const STEP_WORDING: readonly { tool: string; code?: string; stem: (count: number) => string; plain: (count: number) => string }[] = [
  { tool: 'study.think', stem: () => '次にすることを考え', plain: () => '次にすることを考えた' },
  { tool: 'study.read', stem: count => `公開ページを${count}つ読み`, plain: count => `公開ページを${count}つ読んだ` },
  { tool: 'study.notion', stem: count => `Notionのページを${count}つ読み`, plain: count => `Notionのページを${count}つ読んだ` },
  { tool: 'study.note', stem: count => `メモを${count}つ書き`, plain: count => `メモを${count}つ書いた` },
  { tool: 'study.draft', stem: count => `物語の下書きを${count}つ書き`, plain: count => `物語の下書きを${count}つ書いた` },
  { tool: 'study.revise', stem: count => `物語を${count}回直し`, plain: count => `物語を${count}回直した` },
  { tool: 'study.ready', stem: count => `物語を${count}つ「見せてもいい」にし`, plain: count => `物語を${count}つ「見せてもいい」にした` },
  { tool: 'study.show', stem: count => `物語を${count}つ見せ`, plain: count => `物語を${count}つ見せた` },
  { tool: 'study.put_away', stem: count => `下書きを${count}つしまい`, plain: count => `下書きを${count}つしまった` },
  // Counted when the device reports the file is in place, not when she queues it.
  { tool: 'folder.write', stem: count => `自分のフォルダに写しを${count}つ置き`, plain: count => `自分のフォルダに写しを${count}つ置いた` },
  { tool: 'study.look', stem: count => `部屋を${count}回見`, plain: count => `部屋を${count}回見た` },
  { tool: 'owner.reach_out', stem: count => `自分から${count}回話しかけ`, plain: count => `自分から${count}回話しかけた` },
  // What followed a message of hers, while she stays with it for a short while (`code`: the result's reason code).
  { tool: 'owner.reach_out', code: 'replied', stem: count => `返事を${count}回もらい`, plain: count => `話しかけて返事をもらった（${count}回）` },
  { tool: 'owner.reach_out', code: 'no_reply', stem: count => `返事のないまま${count}回待ち`, plain: count => `話しかけて待ったが返事がなかった（${count}回）` },
  { tool: 'owner.reach_out_follow_up', stem: count => `もう一度${count}回声をかけ`, plain: count => `返事がないのでもう一度声をかけた（${count}回）` },
  { tool: 'study.jot', stem: count => `思ったことを${count}つ書き留め`, plain: count => `思ったことを${count}つ書き留めた` },
  // The closing step of a session (`autonomyLoopPacing.ts`); never recorded under the fixed cycles.
  { tool: 'study.rest', stem: count => `${count}回ひと区切りにし`, plain: count => `${count}回ひと区切りにして休んだ` },
];

function stepCounts(entries: readonly LoggedEntry[]): { wording: (typeof STEP_WORDING)[number]; count: number }[] {
  return STEP_WORDING.map(wording => ({
    wording, count: entries.filter(entry => entry.kind === 'action' && entry.outcome === 'done' && entry.tool === wording.tool && (!wording.code || entry.reasonCode === wording.code)).length,
  })).filter(item => item.count > 0);
}

/** 「次にすることを考え、公開ページを2つ読み、メモを2つ書きました。」, or null on a day without a finished step of the loop. */
export function autonomyDayLog(entries: readonly LoggedEntry[]): string | null {
  const steps = stepCounts(entries);
  return steps.length ? `${steps.map(item => item.wording.stem(item.count)).join('、')}ました。` : null;
}

/** The same day as short plain phrases, for the owner prompt's 「今日したこと」. */
export function autonomyDayPhrases(entries: readonly LoggedEntry[]): readonly string[] {
  return stepCounts(entries).map(item => item.wording.plain(item.count));
}

export type AutonomyLoopStateId = 'preparing' | 'running' | 'paused' | 'budget_exhausted';

export const AUTONOMY_LOOP_STATE_LABEL: Readonly<Record<AutonomyLoopStateId, string>> = Object.freeze({
  preparing: '準備中', running: '動いています', paused: '一時停止中', budget_exhausted: '今日は予算を使い切りました',
});

export interface AutonomyLoopStatus {
  state: AutonomyLoopStateId;
  label: string;
  /** When the loop process last reported in. */
  heartbeatAt?: string;
}

/** A loop process that has not reported for this long is not running. */
export const AUTONOMY_LOOP_HEARTBEAT_FRESH_MILLISECONDS = 5 * 60_000;

/**
 * 準備中 while the server switch is off, no loop process is reporting, or it has no dedicated
 * credential; 一時停止中 while the owner's stop switch is on; otherwise 動いています, or
 * 今日は予算を使い切りました once the day's cap has stopped a step.
 */
export function autonomyLoopStatus(input: {
  enabled: boolean; paused: boolean; heartbeat: AutonomyLoopHeartbeat | null; at: string; budgetStopped: boolean;
}): AutonomyLoopStatus {
  const fresh = input.heartbeat !== null
    && Date.parse(input.at) - Date.parse(input.heartbeat.heartbeatAt) <= AUTONOMY_LOOP_HEARTBEAT_FRESH_MILLISECONDS;
  const state: AutonomyLoopStateId = !input.enabled ? 'preparing'
    : input.paused ? 'paused'
    : !fresh || input.heartbeat?.readiness !== 'ready' ? 'preparing'
    : input.budgetStopped ? 'budget_exhausted' : 'running';
  return Object.freeze({ state, label: AUTONOMY_LOOP_STATE_LABEL[state], ...(input.heartbeat ? { heartbeatAt: input.heartbeat.heartbeatAt } : {}) });
}
