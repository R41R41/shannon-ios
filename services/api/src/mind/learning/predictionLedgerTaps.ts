import { CALL_ANSWER_OUTCOME, STORY_REACTION_OUTCOME } from '@shannon/learning';
import type { AutonomyPredictionTap, ReachOutFacts } from '../../autonomyLoopObservations.js';
import { dayBand } from '../../predictionShadowReadings.js';
import type { PredictionLedger } from './predictionLedger.js';

/**
 * Where predictions are opened and settled (Syzygy ADR-0008 stage 1; `docs/cognition-ledger-contract.md`, *Domains*). Each
 * part is handed one function, never the ledger, and is told nothing back. Every value is a closed symbol or an id.
 *
 * Her own time (the activity loop's process): a message (`reply`), a call (`call_answer`), a story shown (`story_reacted`,
 * `story_reaction`), a page read (`reading_used`), and what followed them. The API's processes: the owner's reaction to a
 * story (its enum only, never the comment) and a touch (`body_stance`).
 */
type LedgerPort = Pick<PredictionLedger, 'open' | 'settle' | 'settleSource'>;

/** The loop's tap with the ledger's taps beside the shadow's: what followed a message goes to both. */
export function ledgerPredictionTap(ledger: LedgerPort, shadow: AutonomyPredictionTap): Required<AutonomyPredictionTap> {
  const quietly = (operation: () => void) => { try { operation(); } catch { /* the ledger never stops a step */ } };
  return {
    reachOut: (scopeKey, facts, at) => {
      shadow.reachOut(scopeKey, facts, at);
      quietly(() => settleReachOut(ledger, scopeKey, facts, at));
    },
    sent: (scopeKey, message, at) => quietly(() => {
      ledger.open(scopeKey, { domain: 'reply', key: `${message.reason}.${dayBand(at)}`, context: message.others ? 'others' : 'alone', sourceKind: 'reach_out', sourceId: message.id }, at);
    }),
    called: (scopeKey, call, at) => quietly(() => {
      ledger.open(scopeKey, { domain: 'call_answer', key: `${call.reason}.${dayBand(at)}`, context: call.others ? 'others' : 'alone', sourceKind: 'call', sourceId: call.id }, at);
    }),
    shown: (scopeKey, piece, at) => quietly(() => {
      const key = piece.revised ? 'revised' : 'first';
      for (const domain of ['story_reacted', 'story_reaction'] as const) ledger.open(scopeKey, { domain, key, context: '', sourceKind: 'study_piece', sourceId: piece.id }, at);
    }),
    read: (scopeKey, reading, at) => quietly(() => {
      ledger.open(scopeKey, { domain: 'reading_used', key: reading.source, context: '', sourceKind: 'reading', sourceId: reading.id }, at);
    }),
    noted: (scopeKey, readingId, at) => quietly(() => {
      ledger.settleSource(scopeKey, { sourceKind: 'reading', sourceId: readingId, domain: 'reading_used' }, 1, at);
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

/** The owner reacted to a story she showed: it was reacted to, and how (the enum only). */
export function storyReacted(ledger: LedgerPort, scopeKey: string, pieceId: string, reaction: keyof typeof STORY_REACTION_OUTCOME, at: string): void {
  try {
    ledger.settleSource(scopeKey, { sourceKind: 'study_piece', sourceId: pieceId, domain: 'story_reacted' }, 1, at);
    ledger.settleSource(scopeKey, { sourceKind: 'study_piece', sourceId: pieceId, domain: 'story_reaction' }, STORY_REACTION_OUTCOME[reaction], at);
  } catch { /* the ledger never fails a reaction */ }
}

/** What a touch's prediction is handed: open one about a burst, match it with her stance, or void it (a carried stance). */
export interface TouchLedger {
  open(scopeKey: string, touch: { key: string; context: string; burstId: string }, at: string): string | null;
  settle(scopeKey: string, predictionId: string, stance: number | null, at: string): void;
}

export function touchLedger(ledger: LedgerPort): TouchLedger {
  return {
    open: (scopeKey, touch, at) => {
      try { return ledger.open(scopeKey, { domain: 'body_stance', key: touch.key, context: touch.context, sourceKind: 'touch', sourceId: touch.burstId }, at); } catch { return null; }
    },
    settle: (scopeKey, predictionId, stance, at) => { try { ledger.settle(scopeKey, predictionId, stance, at); } catch { /* never fails a touch */ } },
  };
}
