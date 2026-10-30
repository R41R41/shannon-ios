import { type ActionExecution } from '../infra/context/actionExecution.js';
import { FCA_MODEL_BILLING } from '../mind/action/fca/fcaProviderRetry.js';

/** A closed error code for logs: FCA codes are content-free; anything else is reported only by its class. */
export function fcaErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/^[A-Z][A-Z0-9_]{2,80}$/u.test(message)) return message;
  return error instanceof Error && /^[A-Za-z]{1,40}$/u.test(error.name) ? error.name : 'unknown';
}

/** 3-5 s: one short wait with jitter before a step the provider answered 5xx/529 is run again. */
export const PROVIDER_RETRY_DELAY = () => 3_000 + Math.floor(Math.random() * 2_000);

/** A decision request the provider answered with a server error (5xx, 529), with no tool outcome in doubt. */
export function providerServerErrorCode(code: string, execution: Pick<ActionExecution, 'modelOutcome' | 'stepOutcome'>): boolean {
  return /^FCA_MODEL_HTTP_5\d\d$/u.test(code) && execution.modelOutcome === 'acknowledged' && execution.stepOutcome !== 'unknown';
}

/**
 * Definitive provider answers to the decision request with no tool outcome in doubt: a refusal (4xx, not throttling or timeouts)
 * or a server error (5xx, 529, after its one retry; 2026-10-13: a research step's server error sat unknown for ten minutes
 * holding a slot while the owner waited). No decision came back, so nothing ran; a server error's spend stays booked as
 * unknown (a conservative bound), a refusal's as none. The task fails with its report and he can ask again.
 */
export function rejectedBeforeAnyEffect(code: string, execution: Pick<ActionExecution, 'modelOutcome' | 'stepOutcome'>): boolean {
  const status = /^FCA_MODEL_HTTP_([45]\d\d)$/u.exec(code)?.[1] ?? (code === FCA_MODEL_BILLING ? '402' : undefined);
  return (
    !!status && !['408', '409', '429'].includes(status) && execution.modelOutcome === 'acknowledged' && execution.stepOutcome !== 'unknown'
  );
}

/** The history limits `prepareFcaHistory` throws before the step's model call (`fcaHistory.ts`): deterministic,
 * so a replay holds too. */
export const HISTORY_LIMITS: ReadonlySet<string> = new Set([
  'FCA_HISTORY_RECENT_LIMIT',
  'FCA_HISTORY_ROUND_LIMIT',
  'FCA_HISTORY_COMPACTION_LIMIT',
]);

/**
 * The closed checks of the shared-context call (`anthropicFcaContext.ts`, `fcaEvidenceStore.beforeActions`): a
 * complete, paid answer
 * refused before any of its actions ran. The decoder answers an invalid item as a correction, so these remain
 * only as a guard; one
 * that still reaches here is a known failure, never an unknown step (Minecraft operator run 5, 2026-10-14:
 * FCA_EXPECTATION_INVALID).
 */
export const CONTEXT_REJECTIONS: ReadonlySet<string> = new Set(['FCA_CONTEXT_INVALID', 'FCA_EXPECTATION_INVALID', 'FCA_APPRAISAL_INVALID']);

export function failsBeforeAnyEffect(code: string, execution: Pick<ActionExecution, 'modelOutcome' | 'stepOutcome'>): boolean {
  return (
    rejectedBeforeAnyEffect(code, execution) ||
    (HISTORY_LIMITS.has(code) && execution.stepOutcome !== 'unknown') ||
    (CONTEXT_REJECTIONS.has(code) && execution.modelOutcome === 'acknowledged' && execution.stepOutcome !== 'unknown')
  );
}

/** Holds of a step's execution (`fcaRunner.ts` `checked`, and its history's own check in `prepareFcaHistory`). */
export const HELD_CODES: ReadonlySet<string> = new Set(['FCA_EXECUTION_HELD', 'FCA_HISTORY_HELD']);

export const HELD_RETRIES = 3;

/**
 * A hold before the step asked for its decision, with no bounded executor started in it (a body skill, a reflex or a Minecraft
 * lifecycle operation sets `stepOutcome`), no model call in doubt and no write in flight. Before its decision a step has only run
 * internal work and model calls whose results it keeps (a committed history summary among them), so nothing outside can be done
 * twice by running the next step. Any other hold keeps today's unknown.
 */
export function heldBeforeAnyEffect(
  code: string,
  execution: Pick<ActionExecution, 'decisionRequested' | 'modelOutcome' | 'stepOutcome' | 'writeInFlight'>,
): boolean {
  return (
    HELD_CODES.has(code) &&
    execution.decisionRequested !== true &&
    execution.stepOutcome === undefined &&
    execution.modelOutcome !== 'unknown' &&
    execution.writeInFlight !== true
  );
}

/** Owner 2026-10-19 (item 10): a failure says why, and what comes next. */
export function rejectedTaskReport(title: string): string {
  return `「${title.slice(0, 80)}」は処理中にエラーが起きて、最後まで進められませんでした。もう一度頼んでもらえたら、最初からやり直します。`;
}
