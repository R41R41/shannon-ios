import { FAILURE_HARD_LIMIT, FAILURE_REVIEW_AT, FAILURE_STALL_MS, FAILURE_STOP_AFTER } from '../../mind/action/fca/fcaFailureLadder.js';

/**
 * The turn that looks back before the task stops (mb-r23, owner 2026-10-21: 「何度も失敗が続く際は原因を調べればいいのに」; Minecraft run 23 was
 * stopped at the fifth failure with the body's next move, "先に use-item-on-block（water_bucket）で横の溶岩を固めてください", written in that
 * last result and never read). From `FAILURE_REVIEW_AT` failed steps in a row the decision's pace carries `failureReview`: how many in a
 * row and what would stop the task, the last failures with the end of each result (where the body writes what to do first), and the
 * order of the review. Closed numbers and the body's own result text, as data; it is not stored and it is shown while the count stands.
 */
const RESULT = 420;
const TAIL = 260;

/** A result cut for the review: the start and, past the bound, the end too (the body's advice stands at the end). */
function cut(text: string): string {
  const one = text.replace(/\s+/gu, ' ').trim();
  return one.length <= RESULT ? one : `${one.slice(0, RESULT - TAIL - 1)}…${one.slice(-TAIL)}`;
}

/** The pace with the review added once three failed steps stand in a row; the pace as it is before. */
export function withFailureReview<T extends { failedStepsInARow: number }>(pace: T, recent: ReadonlyArray<{ name: string; ok: boolean; summary: string }>):
  T | (T & { failureReview: Record<string, unknown> }) {
  const review = failureReview(pace.failedStepsInARow, recent);
  return review ? { ...pace, failureReview: review } : pace;
}

type Recent = ReadonlyArray<{ name: string; ok: boolean; summary: string }>;
/** Looks, not work: a find that finds nothing twice is no sign that the work is going round. */
const LOOK = /find|check|list|recall|observe|read|evidence|inventory/u;
/** The same words of a failure without its numbers and places (a count, a coordinate, a distance change from call to call). */
const stem = (summary: string) => summary.replace(/\s+/gu, ' ').replace(/-?\d+(?:\.\d+)?/gu, '#').slice(0, 90);
/** How many failed calls without progress are alike (the same tool, the same words): the most, with the tool. */
export function repeatedFailure(recent: Recent): { tool: string; times: number } | null {
  const alike = new Map<string, { tool: string; times: number }>();
  for (const result of recent) {
    // A call that made something, or that a fast skill only paused, is not a failure of the work.
    if (result.ok || LOOK.test(result.name) || /進み（失敗には数えない）|失敗ではない/u.test(result.summary)) continue;
    const key = `${result.name}|${stem(result.summary)}`, kept = alike.get(key) ?? { tool: result.name, times: 0 };
    alike.set(key, { ...kept, times: kept.times + 1 });
  }
  return [...alike.values()].filter(item => item.times >= REPEATED_FAILURES).sort((a, b) => b.times - a.times)[0] ?? null;
}
/** The same failure this often among the latest results is a review, though a call that worked came between (run 24: 0 obsidian at one pool twice). */
export const REPEATED_FAILURES = 2;

export function failureReview(failures: number, recent: Recent): Record<string, unknown> | null {
  const repeated = repeatedFailure(recent);
  if (!Number.isSafeInteger(failures) || (failures < FAILURE_REVIEW_AT && !repeated)) return null;
  const shown = Math.min(Math.max(failures, repeated?.times ?? 0), 4);
  const failed = recent.filter(result => !result.ok).slice(-shown).map(result => ({ tool: result.name, result: cut(result.summary) }));
  return {
    failedStepsInARow: failures,
    ...(repeated ? { repeatedFailure: `${repeated.tool} が同じ失敗で進みなしのまま${repeated.times}回（間に成功した手があっても数える）。同じ場所・同じ手をもう一度しない` } : {}),
    stops: `連続失敗が${FAILURE_STOP_AFTER + 1}回以上になり、持ち物・節目・場所が${Math.round(FAILURE_STALL_MS / 1000)}秒動かない時。`
      + `${FAILURE_HARD_LIMIT}回続けば動いていても止まる。進みのある手（持ち物が増えた・節目に着いた）は失敗に数えない`,
    failuresLeft: Math.max(0, FAILURE_HARD_LIMIT - failures),
    recentFailures: failed,
    review: '同じ手をそのまま繰り返さない。(1) 直近の失敗の理由と、体の結果文の終わりにある「先にすること・次の手」を読む。'
      + '(2) minecraft.observe で周り（ブロック・液体・溶岩・持ち物・位置）を確かめ、なぜ失敗したかの原因を1つに決める。'
      + '(3) 原因を直す手か、別の道（別の場所・別の道具・先の節目）を選ぶ。体が示した次の一手があれば、まずそれをする',
  };
}
