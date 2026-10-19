import { pausedReportLine } from '../mind/action/fca/fcaSpokenReport.js';
import { BODY_ABSENT_SUMMARY, ownSummary, RECOVERY_LIMIT_SUMMARY, RELEASE_UNPROVEN_SUMMARY, STALE_SUMMARY } from './fcaBodyRecoveryPolicy.js';

/**
 * The words of a PAUSE the FCA runtime makes by itself (a Minecraft request stopped, resumable, not failed): the summary the owner and
 * `task.get` read, and the report the owner's activity and call speak (the same kind of notice a failure leaves, `rejectedTaskReport`).
 * Both are short Japanese reasons that say the task can be resumed, and carry nothing but the owner's own title.
 */
export const PROVIDER_UNAVAILABLE_SUMMARY = 'モデルの応答が続けて得られなかったため一時停止しています。応答が戻れば再開できます。';

/**
 * The report of a task paused only because of unconfirmed charges (`fcaBudgetWiring.ts`): the task title, the cap in yen. What it is
 * recognised by is its marker and its tail, never the cap's formatting (L-4): the number between them may be written any way.
 */
const ESTIMATES_MARK = '」は、確定していない利用料の見積りを含めると上限';
const ESTIMATES_TAIL = 'に近づいたので、いったん止めました。再開できます。';
export const estimatesPausedReport = (title: string, capYen: number) => `「${title.slice(0, 60)}${ESTIMATES_MARK}（${capYen}円）${ESTIMATES_TAIL}`;
const estimatesPaused = (text: string): boolean => text.startsWith('「') && text.includes(ESTIMATES_MARK) && text.endsWith(ESTIMATES_TAIL);

/** The report of a pause whose summary is `summary` (without any hint for the operator): 「title」は、<reason>. */
export const pausedReport = (title: string, summary: string) => `「${title.slice(0, 60)}」は、${summary}`;

/** The short reason of each pause, as a clause that goes before 「ため」 in the sentence a call says. */
const SPOKEN_REASONS: ReadonlyArray<readonly [string, string]> = [
  [PROVIDER_UNAVAILABLE_SUMMARY, 'モデルの応答が続けて得られなかった'], [BODY_ABSENT_SUMMARY, '体が戻らなかった'],
  [RECOVERY_LIMIT_SUMMARY, '同じ依頼が短い間に何度も中断された'], [STALE_SUMMARY, '前回の操作から時間がたちすぎている'],
  [RELEASE_UNPROVEN_SUMMARY, '体が前回の操作の解放を確認できなかった'],
];

/**
 * What a call says of a pause report: a fixed, accurate sentence (「『題名』は<理由>ため一時停止しています。再開できます。」), made
 * from the title and the reason the report's words carry. No model words it (it could not tell a pause from a failure), and a pause
 * whose reason is not known says only that it is paused and can be resumed.
 */
export function pausedSpoken(title: string, report: string): string {
  const reason = SPOKEN_REASONS.find(([summary]) => report.endsWith(summary))?.[1] ?? (estimatesPaused(report) ? '確定していない利用料の見積りが上限に近づいた' : undefined);
  return pausedReportLine(title, reason);
}

/**
 * A summary a pause wrote (this recovery's, the provider's, the estimates'): it says the task is paused, so a task the owner resumed
 * must not keep it. Cleared on `resume` and, failing that, at the next commit (`SQLiteTaskRuntimeStore`).
 */
export const pausedSummary = (summary: string): boolean =>
  summary === PROVIDER_UNAVAILABLE_SUMMARY || estimatesPaused(summary) || ownSummary(summary);
