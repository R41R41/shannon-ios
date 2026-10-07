import { SHANNON_PREDICTION_DOMAINS } from '@shannon/cognition';
import { LEDGER_DOMAIN_RULES, growthScore, serveRule, serveScore, settle, worldScore, type LinkedPrediction } from '@shannon/learning';
import type { SQLiteChoiceLedger, StoredChoice } from './store/sqliteChoiceLedger.js';
import type { SQLitePredictionLedger, StoredPrediction } from './store/sqlitePredictionLedger.js';

/**
 * Settling her choices (Syzygy ADR-0008 stage 1, 報酬系; `docs/cognition-ledger-contract.md`). Core: emotion.
 *
 * A reported choice is settled as soon as what it is scored by is known: its own predictions (`@shannon/learning`, `reward.ts`),
 * and for a draft or a revision the showing it led to (delayed credit). Each choice is settled once; one that cannot be scored
 * (the owner could not have seen her message, a call that could not connect, a report that never came) is void and moves
 * nothing. Runs under the write lock its caller holds.
 */
const DAY = 24 * 60 * 60_000;
/** A draft or revision never shown in this long is credited 0 (modelling assumption, the window of a showing's own S). */
export const INHERIT_STALE_DAYS = 14;
/** A choice whose step never reported (the process stopped) is void after this long. Technical bound. */
export const LOST_REPORT_DAYS = 1;

const SERVE_CODE = Object.freeze({ message: 'reply', call: 'call', show: 'story', inherit: 'inherited', none: 'reported' });

export function linkedPrediction(row: StoredPrediction): LinkedPrediction {
  const spec = SHANNON_PREDICTION_DOMAINS[row.domain];
  return {
    domain: row.domain, status: row.status, expectation: row.expectation, uncertainty: row.uncertainty, noise: row.noise, prior: row.prior,
    outcome: row.outcome, lower: spec.lower, upper: spec.upper,
  };
}

/** Settles every pending choice of a scope that can be settled now. Returns how many were settled or voided. */
export function settlePending(choices: SQLiteChoiceLedger, predictions: SQLitePredictionLedger | null, scopeKey: string, at: string,
  options: { conversation?: boolean } = {}): number {
  const now = Date.parse(at);
  let settled = 0;
  // Stage 2 (owner answer I-3): a conversation choice waits for the owner's next turn in its Talk; one whose next turn did not
  // come in time is credited S = ½ (`turn_expired`, never a mood). Switched off, they wait and nothing else changes.
  const all = choices.pending(scopeKey);
  for (const choice of all.filter(item => item.subjectKind === 'talk')) {
    if (options.conversation && choice.success !== null && now - Date.parse(choice.chosenAt) >= TALK_NEXT_TURN_MINUTES * 60_000) {
      if (settleOne(choices, scopeKey, choice, 0.5, 'turn_expired', at)) settled += 1;
    }
  }
  const pending = all.filter(item => item.subjectKind !== 'talk');
  // A showing is settled before the drafts that inherit from it.
  const ordered = [...pending.filter(choice => serveRule(choice.choice) !== 'inherit'), ...pending.filter(choice => serveRule(choice.choice) === 'inherit')];
  for (const choice of ordered) {
    if (choice.success === null) {
      if (now - Date.parse(choice.chosenAt) >= LOST_REPORT_DAYS * DAY && choices.settle(scopeKey, choice.choiceId, null, 'lost', at)) settled += 1;
      continue;
    }
    const linked = predictions ? predictions.forChoice(scopeKey, choice.choiceId).map(linkedPrediction) : [];
    // What it is scored by includes a prediction that will settle later (a reading used, a story reacted to): wait for it.
    if (linked.some(item => item.status === 'open' && LEDGER_DOMAIN_RULES[item.domain].expiryOutcome !== null)) continue;
    const rule = serveRule(choice.choice);
    const found = rule === 'inherit' ? inheritedServe(choices, scopeKey, choice, now)
      : { serve: serveScore(rule, linked), code: linked.some(item => item.status === 'expired') ? (rule === 'show' ? 'story_expired' : `${SERVE_CODE[rule]}_expired`) : SERVE_CODE[rule] };
    if (found.serve === 'pending') continue;
    if (found.serve === null) {
      if (choices.settle(scopeKey, choice.choiceId, null, 'void', at)) settled += 1;
      continue;
    }
    const result = settle(
      { world: worldScore(linked), serve: found.serve, growth: growthScore(choice.success >= 0.5 ? 1 : 0, linked) },
      { mean: choice.expected, variance: choice.expectedSd ** 2, noise: choice.expectedNoise },
    );
    if (choices.settle(scopeKey, choice.choiceId, result, found.code, at)) settled += 1;
  }
  return settled;
}

/**
 * Delayed credit: the last draft or revision of a piece before it is shown inherits the showing's S. One followed by another
 * draft or revision before any showing is superseded (0); one never shown within the window is stale (0).
 */
export function inheritedServe(choices: SQLiteChoiceLedger, scopeKey: string, choice: StoredChoice, now: number): { serve: number | 'pending'; code: string } {
  if (choice.subjectKind !== 'study_piece' || !choice.subjectId) return { serve: 0, code: 'reported' };
  const about = choices.forSubject(scopeKey, 'study_piece', choice.subjectId);
  const later = about.slice(about.findIndex(item => item.choiceId === choice.choiceId) + 1);
  const showing = later.findIndex(item => item.choice === 'show' && item.status !== 'void');
  const edit = later.findIndex(item => item.choice === 'draft' || item.choice === 'revise');
  if (edit >= 0 && (showing < 0 || edit < showing)) return { serve: 0, code: 'superseded' };
  if (showing >= 0) {
    const shown = later[showing]!;
    if (shown.status === 'pending' || shown.serve === null) return { serve: 'pending', code: 'inherited' };
    return { serve: shown.serve, code: shown.settleCode === 'story_expired' ? 'inherited_expired' : 'inherited' };
  }
  return now - Date.parse(choice.chosenAt) >= INHERIT_STALE_DAYS * DAY ? { serve: 0, code: 'stale' } : { serve: 'pending', code: 'inherited' };
}

/** How long a conversation choice waits for the owner's next turn in its Talk (stage 2). Modelling assumption. */
export const TALK_NEXT_TURN_MINUTES = 30;

/** Settles a conversation choice: W 0 (no linked prediction), S from the next turn, G as reported. */
function settleOne(choices: SQLiteChoiceLedger, scopeKey: string, choice: StoredChoice, serve: number, code: string, at: string): boolean {
  const result = settle({ world: 0, serve, growth: choice.success ?? 0 }, { mean: choice.expected, variance: choice.expectedSd ** 2, noise: choice.expectedNoise });
  return choices.settle(scopeKey, choice.choiceId, result, code, at);
}

/** The owner's next turn in a Talk settles the conversation choices still waiting there. */
export function settleConversation(choices: SQLiteChoiceLedger, scopeKey: string, talkId: string, serve: number, code: string, at: string): number {
  let settled = 0;
  for (const choice of choices.pendingInTalk(scopeKey, talkId)) {
    // Review (low): the next turn settles only what it can be the next turn of (within the window); older choices expire.
    const age = Date.parse(at) - Date.parse(choice.chosenAt);
    if (choice.success !== null && age >= 0 && age <= TALK_NEXT_TURN_MINUTES * 60_000 && settleOne(choices, scopeKey, choice, serve, code, at)) settled += 1;
  }
  return settled;
}
