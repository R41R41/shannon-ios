/**
 * The policy and the words of the Minecraft body recovery (`fcaBodyRecovery.ts`): its windows, backoffs and bounds, and what the owner and
 * the model read. Split out of it for size only; `fcaBodyRecovery.ts` re-exports all of it.
 */
/**
 * A Minecraft request survives a step whose outcome was lost (Minebot parity audit C-20/C-21, 2026-10-19): an API restart, a Spot VM
 * stop, a body that dropped a command, a decision that never came back. The step is never replayed and no body operation of it is ever
 * sent again. Once the body itself has proven its inputs released (a re-check `release` it answered `stopped`), or when the step sent
 * nothing, the lost step's action is closed, the operations nobody answered are closed with it, and the task goes on from a fresh
 * observation with a notice naming what may or may not have happened; the model decides, as after any failed tool.
 *
 * What is guaranteed is about the BODY's operations only: each is either answered by the body, or closed here after the body proved
 * its release, and none is sent twice. A lost step may also have made a child task (`task.create`) or sent a note (`task.send`); the
 * recovery does not undo or close those. It lists the ones it finds (made or sent at or after the step began) in the notice, so that the
 * model sees them before it acts and does not make or send the same again.
 *
 * Bounds:
 * - the notice is stored and verified (`recovery:<actionId>` is in the inbox) before the step is closed and before the task goes on; if
 *   it cannot be stored the task stays as it was and the next pass tries again;
 * - the body has `windowMs` to be connected again, counted from when the step was LOST (its lease's end, else the latest sign of life
 *   of the step, else its start), not from when this process noticed (a Spot VM stopped for eight hours must not make yesterday's
 *   request young): the task stays `fca_unknown`, never retired as failed, meanwhile, and is paused as stopped, not failed (the owner
 *   may resume it) when the window has run out, either because the body did not return (`body_not_returned`) or because the step was
 *   already older than the window when it was noticed (`stale`). A task the owner resumed while its lost step is still open has the same
 *   window, counted from the resume, and is stopped the same way (L-3);
 * - the release is asked of the body with a backoff (10 s, doubling to 5 min) and at most `FCA_BODY_RELEASE_ATTEMPTS` times, counted
 *   across restarts (L-11); then the task is paused with `fca_body_release_unproven` and the action stays open (a lost step is never
 *   closed without proof);
 * - a task recovered `limit.count` times within `limit.withinMs` is paused the same way.
 * The owner's stop, the task's budget cap and every lease check are untouched: this only moves a task that was left unknown, and the
 * next step is admitted like any other.
 *
 * A PAUSED task keeps its lost step's body held (the step's action stays open, and the body is retained until the release is proven),
 * so new Minecraft requests could not take it. The recovery therefore goes on asking the body for the proof while the task is paused
 * (M-C): no model step and no resume, with a longer backoff (1 min doubling to 30 min) and at most `FCA_PAUSED_RELEASE_ATTEMPTS` times.
 * When the proof comes, the lost step's operations and action are closed, which frees the body; the task stays paused, and the notice
 * the model is owed is sent when the owner resumes it, with the gap as it is then (L-5). If the proof never comes, the body stays held,
 * the pause summary says so and names the operator's way to free it (`minecraft release`).
 */
export const FCA_BODY_RETURN_WINDOW_MS = 30 * 60_000;
export const FCA_BODY_RECOVERY_LIMIT = Object.freeze({ count: 6, withinMs: 60 * 60_000 });
export const FCA_BODY_RECOVERY_CODE = 'fca_body_reconciled';
/** The release asked of the body: the first wait, the longest wait, and the attempts after which the task is paused. */
export const RELEASE_BACKOFF_BASE_MS = 10_000;
export const RELEASE_BACKOFF_CAP_MS = 5 * 60_000;
export const FCA_BODY_RELEASE_ATTEMPTS = 10;
export const FCA_BODY_RELEASE_UNPROVEN = 'fca_body_release_unproven';
/** The same, while the task is paused: slower, and bounded in all (each ask writes one `recheck:` row). */
export const HELD_BACKOFF_BASE_MS = 60_000;
export const HELD_BACKOFF_CAP_MS = 30 * 60_000;
export const FCA_PAUSED_RELEASE_ATTEMPTS = 20;

/** The wait after `attempts` unconfirmed releases: none before the first, then 10 s, 20 s, 40 s ... to 5 min. */
export function releaseBackoffMs(attempts: number): number {
  return attempts <= 0 ? 0 : Math.min(RELEASE_BACKOFF_CAP_MS, RELEASE_BACKOFF_BASE_MS * 2 ** (attempts - 1));
}

/** The wait after `asked` unconfirmed releases of a paused task: 1 min, 2 min, 4 min ... to 30 min. */
export function heldBackoffMs(asked: number): number {
  return Math.min(HELD_BACKOFF_CAP_MS, HELD_BACKOFF_BASE_MS * 2 ** Math.max(0, asked));
}

/** `SHANNON_FCA_BODY_RETURN_MINUTES`: how long a Minecraft request waits for its body (1 to 720 minutes; the default is 30). */
export function fcaBodyReturnWindow(value: string | undefined): number {
  const minutes = Number(value);
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= 720 ? minutes * 60_000 : FCA_BODY_RETURN_WINDOW_MS;
}
/** `retireUnknown` leaves a body task alone this long past the window, so that the pause below always comes first. */
export const HOLD_GRACE_MS = 5 * 60_000;
/** What the owner and `task.get` read of a Minecraft request paused here (its state is `stopped`; resuming it is the owner's). */
export const BODY_ABSENT_SUMMARY = '体が戻らなかったため一時停止しています。体が戻ってから再開できます。';
export const RECOVERY_LIMIT_SUMMARY = '同じ依頼が短い間に何度も中断されたため一時停止しています。確認してから再開できます。';
/** A-17: a request the operator holds (a hold row stands) whose step was lost meanwhile: stopped, waiting for the operator's resume. */
export const HELD_SUMMARY = '保留中のまま一時停止しています。保留を解く resume で再開できます。';
export const STALE_SUMMARY = '前回の操作から時間がたちすぎているため一時停止しています。状況を確かめてから再開できます。';
export const RELEASE_UNPROVEN_SUMMARY = '体が前回の操作の解放を確認できなかったため一時停止しています。体の状態を確かめてから再開できます。';
/** A resumed request that waits for the body's proof about the step it lost (it is not started until then). */
export const AWAITING_PROOF_SUMMARY = '前回の操作の結果を体がまだ確認できていないため、確認できるまで開始を待っています。';
/**
 * Said after a pause summary while the lost step still holds the body: the body cannot be used by a new request until its release is
 * proven; the recovery keeps asking, and the operator can ask the body again by hand (`opsCli.ts minecraft release`).
 */
export const BODY_HELD_HINT = '体は、前回の操作の解放が確認できるまで新しい依頼に使えません。運用者が ops の minecraft release で体に確かめさせることもできます。';
const OWN_SUMMARIES: readonly string[] = [BODY_ABSENT_SUMMARY, HELD_SUMMARY, RECOVERY_LIMIT_SUMMARY, STALE_SUMMARY, RELEASE_UNPROVEN_SUMMARY, AWAITING_PROOF_SUMMARY];
/** A summary this recovery wrote (with or without the hint): one that a task going on must not keep. */
export const ownSummary = (summary: string) => OWN_SUMMARIES.includes(summary.endsWith(BODY_HELD_HINT) ? summary.slice(0, -BODY_HELD_HINT.length) : summary);

export const BODY_RECOVERY_NOTICE = 'The previous step of this task was interrupted before its results were stored (a restart, a lost answer or a '
  + 'dropped command). The listed operations may or may not have taken effect; none of them was sent again. Read the fresh observation, '
  + 'check what is true now, and decide the next step; do not assume any listed operation succeeded or failed. Child tasks that step may '
  + 'have made and notes it may have sent are listed too: look at them before you make or send the same again.';
