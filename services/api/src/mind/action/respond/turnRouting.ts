import { createHash } from 'node:crypto';
import { decideTier, type DifficultyAnswers, type TierDecision } from '@shannon/learning';
import type { TurnRouting } from '../../../contracts/turnRoutingContract.js';

export type { TurnRouting } from '../../../contracts/turnRoutingContract.js';
import type { ShannonModelToolSession, ShannonTierRequest } from '../../../infra/models/chatModelTools.js';
import { TURN_CHECKER_MINIMUM_MILLISECONDS, verifiedReply, verifyWriteClaims, type TurnVerdict } from '../../selectors/selectorsPorts.js';
import { turnOffersWrites, turnToolResults } from '../../tools/toolsPorts.js';

/**
 * The routing of one conversation turn (Syzygy ADR-0008 stage 2, step 4; `docs/skill-and-routing-contract.md`). Core: response path.
 *
 * Before the model: the tier from Jev's difficulty answers (`decideTier`), as the request's `tier` and `escalation`; voice
 * passes the time its turn has left, so an available Sonnet whose first token would be late is luna (owner answer I-2). After
 * the model: the verifier (`turnVerifier.ts`), then her conversation choices (the tier, each tool call that ran) handed to be
 * learned (owner answer I-3), and the owner's next turn settling the last turn's (`nextTurn`). Nothing here without `routing`.
 */
export interface TurnDifficultyAnswer {
  difficulty?: { taskKind: string; needsStrongModel: number; needsVerification: number; multiStep: number } | null;
  retry?: number | null;
}

/** A Talk as the ledgers hold it: a closed identifier (a thread id that is not one is digested). */
export function talkId(threadId: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9_:-]{0,119}$/u.test(threadId) ? threadId : `t_${createHash('sha256').update(threadId).digest('hex').slice(0, 32)}`;
}

/**
 * The tier of the turn, or null when the difficulty was not asked (switched off, or no chooser). Also hands the owner's
 * retry-or-correction probability, when Jev gave one, to settle her last turn in this Talk.
 */
export function routeTurn(routing: TurnRouting | null | undefined, turn: {
  scopeKey: string; surface: 'text' | 'voice'; threadId: string; answer: TurnDifficultyAnswer | null; remainingMs?: number; at: string;
}): RoutedTier | null {
  if (!routing) return null;
  if (typeof turn.answer?.retry === 'number') {
    try { routing.nextTurn(turn.scopeKey, talkId(turn.threadId), turn.answer.retry, turn.at); } catch { /* learning never fails a turn */ }
  }
  if (!routing.switches.difficulty || turn.answer?.difficulty === undefined) return null;
  const answers = turn.answer.difficulty as DifficultyAnswers | null;
  let competence: { successes: number; failures: number } | null = null;
  try { competence = answers ? routing.competence(turn.scopeKey, 'luna', answers.taskKind) : null; } catch { competence = null; }
  return { ...decideTier({
    surface: turn.surface, answers, lunaCompetence: competence, sonnetAvailable: routing.sonnetAvailable,
    ...(turn.surface === 'voice' ? { voice: { remainingMs: turn.remainingMs ?? 0, sonnetFirstTokenMs: safe(() => routing.sonnetFirstTokenMs(), null) } } : {}),
  }), kind: answers?.taskKind ?? 'unknown' };
}

/** A tier decision with Jev's task kind (`unknown` when Jev gave none). */
export type RoutedTier = TierDecision & { kind: string };

/** The request fields of a tier: nothing for plain luna (the request is as it was). `sonnet` is not served before step 5. */
export function tierRequest(decision: TierDecision | null): ShannonTierRequest {
  if (!decision) return {};
  return { ...(decision.served === 'luna_plus' ? { tier: 'luna_plus' as const } : {}), ...(decision.escalateOnTrouble ? { escalation: true as const } : {}) };
}

/**
 * After the model: her reply as verified, and her choices handed to be learned. `reply` is the text the turn will show or say.
 * The luna checker runs only on text, when the policy asked for verification and enough of the turn is left.
 */
export async function finishTurn(routing: TurnRouting | null | undefined, turn: {
  scopeKey: string; surface: 'text' | 'voice'; threadId: string; presence: 'alone' | 'others'; reply: string; outOfTime: boolean; escalated: boolean;
  decision: RoutedTier | null; tools: ShannonModelToolSession | undefined; remainingMs: number; at: string;
}): Promise<{ reply: string; verdict: TurnVerdict | null }> {
  if (!routing) return { reply: turn.reply, verdict: null };
  const results = turnToolResults(turn.tools);
  let verdict: TurnVerdict | null = null;
  if (routing.switches.turnVerify && !turn.outOfTime && turnOffersWrites(turn.tools)) {
    verdict = verifyWriteClaims(turn.reply, results);
    if (verdict === 'ok' && routing.checker && turn.surface === 'text' && turn.decision?.verify && turn.remainingMs >= TURN_CHECKER_MINIMUM_MILLISECONDS) {
      const checked = await safeAsync(() => routing.checker!.check(turn.scopeKey, turn.reply, results), 'unclear' as const);
      if (checked === 'claims_unsupported') verdict = 'checker_flagged';
    }
  }
  const served = turn.decision ? (turn.escalated && turn.decision.served === 'luna' ? 'luna_plus' : turn.decision.served) : null;
  try {
    routing.record(turn.scopeKey, {
      talk: talkId(turn.threadId), surface: turn.surface, presence: turn.presence, tier: turn.decision && served ? { served, kind: turn.decision.kind } : null,
      tools: results.map(result => ({ name: result.name, ok: result.ok })), inDeadline: !turn.outOfTime, verified: verdict === null ? null : verdict === 'ok',
    }, turn.at);
  } catch { /* learning never fails a turn */ }
  // On voice her words were already spoken: the verdict is learned (G), and the reply is not amended after the fact.
  return { reply: verdict && turn.surface === 'text' ? verifiedReply(turn.reply, verdict) : turn.reply, verdict };
}

function safe<T>(read: () => T, fallback: T): T { try { return read(); } catch { return fallback; } }
async function safeAsync<T>(read: () => Promise<T>, fallback: T): Promise<T> { try { return await read(); } catch { return fallback; } }
