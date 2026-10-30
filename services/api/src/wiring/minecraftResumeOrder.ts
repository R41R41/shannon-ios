import type { HeldAgain } from './minecraftIncidentHold.js';

/**
 * The order of a resume (continue contract 8, 再開の契約): a step that sends a held act again does not ask the model
 * until that act has
 * ended or been held again, so
 * the first thing the decision reads is the result of the act it was held for (or, with `--skip-replay`, the
 * line that says it was
 * not sent again). Run 45's
 * resume 5: the second try ran beside the first decision and its failure reached the model only at the end of a
 * round, or never (the
 * decision was never asked).
 * Nothing here chooses for the model: it waits for a result and records what the queue lost meanwhile.
 */

/** The longest the first decision waits for the second try beyond the act's own longest run (the body's answer
 * after its deadline, a
 * cleanup's 5 s). */
export const RESUME_WAIT_MARGIN_MS = 15_000;
/** The longest a first decision ever waits (an act's ceiling is 180 s: `queue.add` clamps it). */
export const RESUME_WAIT_CAP_MS = 195_000;

/**
 * Waits (never throws) until the second try has been handed to the queue (`sent`), then until the queue holds
 * nothing open: the try
 * ended, was taken off, or was held
 * again (a hold stops the step and aborts the signal). Gives up after `limitMs`, so a body that never answers
 * cannot keep the model from being asked.
 */
export async function waitForResend(parts: { sent: Promise<unknown> | null; open(): boolean; signal: AbortSignal; limitMs: number; pollMs?:
   number; now?(): number;
  sleep?(ms: number): Promise<void> }): Promise<'ended' | 'aborted' | 'limit'> {
  const now = parts.now ?? Date.now, sleep = parts.sleep ?? ((ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms).unref?.(); }));
  const until = now() + Math.min(parts.limitMs, RESUME_WAIT_CAP_MS);
  try { await parts.sent; } catch { /* a failed send is told by the resend itself */ }
  while (parts.open()) {
    if (parts.signal.aborted) return 'aborted';
    if (now() >= until) return 'limit';
    await sleep(parts.pollMs ?? 50);
  }
  return parts.signal.aborted ? 'aborted' : 'ended';
}

/** How the second try of a held act is limited: its own longest run and the margin, within the cap. */
export const resendLimitMs = (maxMs: number): number => Math.min(RESUME_WAIT_CAP_MS, Math.max(0, maxMs) + RESUME_WAIT_MARGIN_MS);

/** The line of the hand that stopped an act, from the act's result as the body wrote it (its first hand that is
 * neither done nor skipped), or ''. */
export function stopLineOf(result: string | undefined): string {
  if (!result || !result.startsWith('{')) return '';
  try {
    const lines = (JSON.parse(result) as { lines?: Array<{ status?: string; line?: string; code?: string }> }).lines ?? [];
    const found = lines.find(entry => entry.status !== 'done' && entry.status !== 'skipped');
    return found ? `${String(found.line ?? '')}${found.code && !String(found.line ?? '').includes(found.code) ? ` 止まった ${found.code}` : ''}` : '';
  } catch { return ''; }
}

/**
 * The record of a second try that was held again (chapter 8's 再開 9 → 保留 10): the code its stop line names (「止まった
 * search_timeout」),
 * else the hold's own reason; and the
 * items that were in the queue meanwhile and were taken off (the ones the queue dropped since the try began, then the ones still
 * open, which the hold is about to take off).
 * The try itself is not one of them. At most 3, each with its why short and without its own mark repeated.
 */
export function heldAgainRecord(parts: { resultText: string; why: string; replayItem: string | null; dropped: readonly { item: string; why: string }[];
  open: readonly { item: string; why: string }[] }): HeldAgain {
  const code = /止まった (\w+)/u.exec(parts.resultText)?.[1] ?? parts.why.replace(/\s+/gu, ' ').trim().slice(0, 40);
  const seen = new Set<string>(), dropped: HeldAgain['dropped'] = [];
  for (const entry of [...parts.dropped, ...parts.open]) {
    if (entry.item === parts.replayItem || seen.has(entry.item)) continue;
    seen.add(entry.item);
    dropped.push({ item: entry.item, why: entry.why.replace(new RegExp(`^${entry.item}\\s*`, 'u'), '').slice(0, 60) });
    if (dropped.length >= 3) break;
  }
  return { code: code || '(理由なし)', dropped };
}
