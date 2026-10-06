import { randomUUID } from 'node:crypto';
import { CALL_ANSWER_OUTCOME, STORY_REACTION_OUTCOME } from '@shannon/learning';
import { PREDICTION_SYMBOL, dayBand, type TouchLedger } from '../contracts/cognitionLedgerContract.js';
import type { AutonomyPredictionTap, ReachOutFacts } from '../mind/action/ownTime/store/autonomyLoopObservations.js';
import type { ChoiceLedger } from '../mind/learning/choiceLedger.js';
import type { PredictionLedger } from '../mind/learning/predictionLedger.js';

export type { TouchLedger } from '../contracts/cognitionLedgerContract.js';

/**
 * Where predictions are opened and settled, and choices recorded (Syzygy ADR-0008 stage 1; `docs/cognition-ledger-contract.md`).
 * Each part is handed one function, never a ledger, and is told nothing back. Every value is a closed symbol or an id.
 *
 * Her own time (the activity loop's process): a step the gate allowed is a choice (`chose`, with its `step_success` prediction),
 * and its report ends it (`reported`); a message (`reply`), a call (`call_answer`), a story shown (`story_reacted`,
 * `story_reaction`) and a page read (`reading_used`) open predictions linked to the choice of their step, and what followed
 * settles them. The API's processes: the owner's reaction to a story (its enum only, never the comment), a touch
 * (`body_stance`), and her tool calls in a conversation (choices, data only).
 */
type LedgerPort = Pick<PredictionLedger, 'open' | 'settle' | 'settleSource'>;
type ChoicePort = Pick<ChoiceLedger, 'choose' | 'report' | 'void' | 'settleLater' | 'recordSettled'>;

export type Presence = 'alone' | 'others' | 'away' | 'unknown';

/** Steps that are not choices: planning and resting. */
const NOT_CHOICES = new Set(['think', 'rest']);

/** The closed name of a step's choice: `reach_out.wonder`, `call.share`, `follow_up`, `tool.study.search`, `draft`, … */
export function stepChoice(step: { kind: string; reason?: string; call?: boolean; tool?: string }): string | null {
  if (NOT_CHOICES.has(step.kind)) return null;
  if (step.kind === 'reach_out') return step.reason === 'follow_up' ? 'follow_up' : `${step.call ? 'call' : 'reach_out'}.${step.reason ?? 'unknown'}`;
  if (step.kind === 'tool') return step.tool && PREDICTION_SYMBOL.test(`tool.${step.tool}`) ? `tool.${step.tool}` : 'tool.unknown';
  return PREDICTION_SYMBOL.test(step.kind) ? step.kind : null;
}

/** Who was around when she chose, from what the server knows of her body: others present, the owner away, him alone, or unknown. */
export function presenceOf(body: Pick<ReachOutFacts, 'windowVisible' | 'owner' | 'others'>): Presence {
  if (body.others) return 'others';
  if (body.owner === 'away') return 'away';
  return body.owner === 'returned' || body.windowVisible ? 'alone' : 'unknown';
}

/** The piece a step made or showed, from its record link (`shannon-study://<id>`). */
export function studyPieceOf(link: string | undefined): string | undefined {
  const match = /^shannon-study:\/\/([A-Za-z0-9][A-Za-z0-9_:-]{0,119})$/u.exec(link ?? '');
  return match?.[1];
}

/**
 * The loop's tap with the ledgers' taps beside the shadow's: what followed a message goes to both. Without `choices` no choice
 * is recorded (`SHANNON_CHOICE_LEDGER=off`), and predictions are opened without a choice.
 */
export function ledgerPredictionTap(
  ledger: LedgerPort, shadow: AutonomyPredictionTap,
  choices: { ledger: ChoicePort; presence?: (scopeKey: string, at: string) => Presence } | null = null,
): Required<AutonomyPredictionTap> {
  const quietly = (operation: () => void) => { try { operation(); } catch { /* the ledger never stops a step */ } };
  // The choice of the step now running, per scope: one runner takes one step at a time.
  const current = new Map<string, { stepId: string; choiceId: string }>();
  const choiceOf = (scopeKey: string) => current.get(scopeKey)?.choiceId;
  const linked = (scopeKey: string) => { const choiceId = choiceOf(scopeKey); return choiceId ? { choiceId } : {}; };
  return {
    reachOut: (scopeKey, facts, at) => {
      shadow.reachOut(scopeKey, facts, at);
      quietly(() => settleReachOut(ledger, scopeKey, facts, at));
    },
    sent: (scopeKey, message, at) => quietly(() => {
      ledger.open(scopeKey, { domain: 'reply', key: `${message.reason}.${dayBand(at)}`, context: message.others ? 'others' : 'alone', sourceKind: 'reach_out', sourceId: message.id, ...linked(scopeKey) }, at);
    }),
    called: (scopeKey, call, at) => quietly(() => {
      ledger.open(scopeKey, { domain: 'call_answer', key: `${call.reason}.${dayBand(at)}`, context: call.others ? 'others' : 'alone', sourceKind: 'call', sourceId: call.id, ...linked(scopeKey) }, at);
    }),
    shown: (scopeKey, piece, at) => quietly(() => {
      const key = piece.revised ? 'revised' : 'first';
      for (const domain of ['story_reacted', 'story_reaction'] as const) ledger.open(scopeKey, { domain, key, context: '', sourceKind: 'study_piece', sourceId: piece.id, ...linked(scopeKey) }, at);
    }),
    read: (scopeKey, reading, at) => quietly(() => {
      ledger.open(scopeKey, { domain: 'reading_used', key: reading.source, context: '', sourceKind: 'reading', sourceId: reading.id, ...linked(scopeKey) }, at);
    }),
    noted: (scopeKey, readingId, at) => quietly(() => {
      ledger.settleSource(scopeKey, { sourceKind: 'reading', sourceId: readingId, domain: 'reading_used' }, 1, at);
    }),
    chose: (scopeKey, step, at) => quietly(() => {
      current.delete(scopeKey);
      const choice = choices ? stepChoice(step) : null;
      if (!choices || !choice) return;
      let presence: Presence = 'unknown';
      try { presence = choices.presence?.(scopeKey, at) ?? 'unknown'; } catch { presence = 'unknown'; }
      const choiceId = choices.ledger.choose(scopeKey, { surface: 'autonomy', choice, context: `${dayBand(at)}.${presence}`, sourceKind: 'step', sourceId: step.stepId }, at);
      current.set(scopeKey, { stepId: step.stepId, choiceId });
      ledger.open(scopeKey, { domain: 'step_success', key: choice, context: '', sourceKind: 'choice', sourceId: choiceId, choiceId }, at);
    }),
    reported: (scopeKey, report, at) => quietly(() => {
      const running = current.get(scopeKey);
      if (!choices || !running || running.stepId !== report.stepId) return;
      current.delete(scopeKey);
      if (report.outcome === 'void') {
        ledger.settleSource(scopeKey, { sourceKind: 'choice', sourceId: running.choiceId, domain: 'step_success' }, null, at);
        choices.ledger.void(scopeKey, running.choiceId, at);
        return;
      }
      const success = report.outcome === 'done' ? 1 : 0;
      ledger.settleSource(scopeKey, { sourceKind: 'choice', sourceId: running.choiceId, domain: 'step_success' }, success, at);
      choices.ledger.report(scopeKey, running.choiceId, { success, costYen: report.costYen, ...(report.pieceId ? { subject: { kind: 'study_piece', id: report.pieceId } } : {}) }, at);
    }),
  };
}

/**
 * What followed a message or a call of hers. A message he could not have seen (away, hidden) or whose wait was cut off
 * (unwatched) is void, not a failure of the message (ADR-0006 §1); a call that could not connect, or that she did not see to
 * its end, is void.
 */
export function settleReachOut(ledger: LedgerPort, scopeKey: string, facts: ReachOutFacts, at: string): void {
  const call = facts.unwatched || !facts.call ? null : CALL_ANSWER_OUTCOME[facts.call];
  ledger.settleSource(scopeKey, { sourceKind: 'call', sourceId: facts.id, domain: 'call_answer' }, call, at);
  const unseen = facts.unwatched || facts.delivery === 'away' || facts.delivery === 'hidden';
  ledger.settleSource(scopeKey, { sourceKind: 'reach_out', sourceId: facts.id, domain: 'reply' }, unseen ? null : facts.replied ? 1 : 0, at);
}

/** The owner reacted to a story she showed: it was reacted to, and how (the enum only); the showing's choice may settle now. */
export function storyReacted(
  ledger: LedgerPort, scopeKey: string, pieceId: string, reaction: keyof typeof STORY_REACTION_OUTCOME, at: string, choices: ChoicePort | null = null,
): void {
  try {
    ledger.settleSource(scopeKey, { sourceKind: 'study_piece', sourceId: pieceId, domain: 'story_reacted' }, 1, at);
    ledger.settleSource(scopeKey, { sourceKind: 'study_piece', sourceId: pieceId, domain: 'story_reaction' }, STORY_REACTION_OUTCOME[reaction], at);
    choices?.settleLater(scopeKey, at);
  } catch { /* the ledger never fails a reaction */ }
}

/**
 * A tool call of hers in a conversation (text or voice) that ran: a choice made and ended at once, recorded as data for stage 2
 * (no effect). A call the gate or the turn refused is not a choice.
 */
export function toolCallChoice(choices: ChoicePort): (scopeKey: string, call: { tool: string; surface: 'text' | 'voice'; audience: 'owner_alone' | 'others'; ok: boolean }, at: string) => void {
  return (scopeKey, call, at) => {
    try {
      const choice = PREDICTION_SYMBOL.test(`tool.${call.tool}`) ? `tool.${call.tool}` : 'tool.unknown';
      choices.recordSettled(scopeKey, {
        surface: call.surface, choice, context: `${dayBand(at)}.${call.audience === 'owner_alone' ? 'alone' : 'others'}`, sourceKind: 'tool_call', sourceId: randomUUID(),
      }, call.ok ? 1 : 0, at);
    } catch { /* never fails a turn */ }
  };
}

export function touchLedger(ledger: LedgerPort): TouchLedger {
  return {
    open: (scopeKey, touch, at) => {
      try { return ledger.open(scopeKey, { domain: 'body_stance', key: touch.key, context: touch.context, sourceKind: 'touch', sourceId: touch.burstId }, at); } catch { return null; }
    },
    settle: (scopeKey, predictionId, stance, at) => { try { ledger.settle(scopeKey, predictionId, stance, at); } catch { /* never fails a touch */ } },
  };
}
