import { ownSummary } from './fcaBodyRecoveryPolicy.js';

/**
 * The words of a PAUSE the FCA runtime makes by itself (a Minecraft request stopped, resumable, not failed): the summary the owner and
 * `task.get` read, and the report the owner's activity and call speak (the same kind of notice a failure leaves, `rejectedTaskReport`).
 * Both are short Japanese reasons that say the task can be resumed, and carry nothing but the owner's own title.
 */
export const PROVIDER_UNAVAILABLE_SUMMARY = 'モデルの応答が続けて得られなかったため一時停止しています。応答が戻れば再開できます。';

/** The report of a task paused only because of unconfirmed charges (`fcaBudgetWiring.ts`): the task title, the cap in yen. */
export const estimatesPausedReport = (title: string, capYen: number) =>
  `「${title.slice(0, 60)}」は、確定していない利用料の見積りを含めると上限（${capYen}円）に近づいたので、いったん止めました。再開できます。`;
const ESTIMATES_PAUSED = /^「.*」は、確定していない利用料の見積りを含めると上限（\d+円）に近づいたので、いったん止めました。再開できます。$/su;

/** The report of a pause whose summary is `summary` (without any hint for the operator): 「title」は、<reason>. */
export const pausedReport = (title: string, summary: string) => `「${title.slice(0, 60)}」は、${summary}`;

/**
 * A summary a pause wrote (this recovery's, the provider's, the estimates'): it says the task is paused, so a task the owner resumed
 * must not keep it. Cleared on `resume` and, failing that, at the next commit (`SQLiteTaskRuntimeStore`).
 */
export const pausedSummary = (summary: string): boolean =>
  summary === PROVIDER_UNAVAILABLE_SUMMARY || ESTIMATES_PAUSED.test(summary) || ownSummary(summary);
