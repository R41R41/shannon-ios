import { createHash, randomUUID } from 'node:crypto';
import { decideTier, type DifficultyAnswers, type TierDecision } from '@shannon/learning';
import type { TurnDoing, TurnRouting } from '../../../contracts/turnRoutingContract.js';

export type { TurnRouting } from '../../../contracts/turnRoutingContract.js';
import type { ShannonModelToolSession, ShannonTierRequest } from '../../../infra/models/chatModelTools.js';
import { TURN_CHECKER_MINIMUM_MILLISECONDS, verifiedReply, verifyWriteClaims, writeClaims, type TurnVerdict } from '../../selectors/selectorsPorts.js';
import { toolDoing, turnOffersWrites, turnToolResults } from '../../tools/toolsPorts.js';
import type { ToolExecutionEvidence } from '../../../contracts/toolEvidenceContract.js';

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
    surface: turn.surface, answers, lunaCompetence: competence, sonnetAvailable: routing.sonnetAvailable, explore: safe(() => (routing.random ?? Math.random)(), 1),
    ...(turn.surface === 'voice' ? { voice: { remainingMs: turn.remainingMs ?? 0, sonnetFirstTokenMs: safe(() => routing.sonnetFirstTokenMs(), null) } } : {}),
  }), kind: answers?.taskKind ?? 'unknown' };
}

/** Jev's task kinds that ask her to run or change something (ADR-0008 §14). */
export const DOING_KINDS: readonly string[] = Object.freeze(['write', 'action']);

/**
 * Doing or describing (ADR-0008 §14, after Prometheus): the turn was to run or change something when Jev's kind says so and the
 * turn offered her a way to act (a write it could trust its words with), or when her reply claims she did (the verifier's
 * deterministic pattern). Then it is `done` only with an `acts` tool result that worked; else `described_not_done`. A turn that
 * could not act and did not claim to is neither: telling him she cannot is not a failure to do.
 */
export function turnDoing(kind: string | null, reply: string, results: ReadonlyArray<{ name: string; ok: boolean; evidence?: ToolExecutionEvidence }>, offeredActs: boolean, nativeEvidence = true): TurnDoing | null {
  const claimed = writeClaims(reply, nativeEvidence).length > 0;
  const asked = kind !== null && DOING_KINDS.includes(kind) && offeredActs;
  if (!asked && !claimed) return null;
  if (nativeEvidence && claimed && verifyWriteClaims(reply, results.map(result => ({ ...result, effect: toolDoing(result.name) === 'acts' ? 'write' as const : 'read' as const }))) !== 'ok') return 'described_not_done';
  return results.some(result => result.ok && toolDoing(result.name) === 'acts' && (!nativeEvidence || !result.evidence || result.evidence.outcome === 'applied')) ? 'done' : 'described_not_done';
}

/** A tier decision with Jev's task kind (`unknown` when Jev gave none). */
export type RoutedTier = TierDecision & { kind: string };

/** The most a voice turn's Sonnet first word or tool call may take, and the room the rest of the turn keeps (review H3). */
export const VOICE_SONNET_FIRST_TOKEN = Object.freeze({ maximumMs: 4_000, marginMs: 6_000 });

/**
 * The request fields of a tier: nothing for plain luna (the request is as it was); `sonnet` only when the policy served it (routing
 * on). On voice (`voiceRemainingMs`) Sonnet's first-token budget: min(left − 6 s, 4 s), past which luna answers instead.
 */
export function tierRequest(decision: TierDecision | null, voiceRemainingMs?: number): ShannonTierRequest {
  if (!decision) return {};
  const budget = decision.served === 'sonnet' && voiceRemainingMs !== undefined
    ? Math.max(0, Math.min(voiceRemainingMs - VOICE_SONNET_FIRST_TOKEN.marginMs, VOICE_SONNET_FIRST_TOKEN.maximumMs)) : null;
  return { ...(decision.served === 'luna_plus' ? { tier: 'luna_plus' as const } : decision.served === 'sonnet' ? { tier: 'sonnet' as const } : {}),
    ...(decision.escalateOnTrouble ? { escalation: true as const } : {}), ...(budget !== null ? { firstTokenBudgetMs: budget } : {}) };
}

/**
 * After the model: her reply as verified, and her choices handed to be learned. `reply` is the text the turn will show or say.
 * The luna checker runs only on text, when the policy asked for verification and enough of the turn is left.
 */
export async function finishTurn(routing: TurnRouting | null | undefined, turn: {
  scopeKey: string; surface: 'text' | 'voice'; threadId: string; presence: 'alone' | 'others'; reply: string; outOfTime: boolean; escalated: boolean;
  decision: RoutedTier | null; tools: ShannonModelToolSession | undefined; remainingMs: number; at: string;
  /** The answering model's mode (`anthropic` for Sonnet): a `sonnet` turn that luna answered is learned as luna's (review M5). */
  answeredBy?: string;
  /** The actual tier returned by the server adapter; Haiku and Sonnet both use Anthropic. */
  servedTier?: 'luna' | 'luna_plus' | 'sonnet';
  /** Server-owned display additions persisted by the voice client; never changes her spoken reply or adds eligibility. */
  feedbackReplySuffix?: string;
}): Promise<{ reply: string; verdict: TurnVerdict | null; doing: TurnDoing | null; feedbackRecordId?: string }> {
  if (!routing) return { reply: turn.reply, verdict: null, doing: null };
  const results = turnToolResults(turn.tools);
  const doing = turnDoing(turn.decision?.kind ?? null, turn.reply, results, turnOffersWrites(turn.tools), routing.switches.turnVerify);
  let verdict: TurnVerdict | null = null;
  if (routing.switches.turnVerify && !turn.outOfTime && turnOffersWrites(turn.tools)) {
    verdict = verifyWriteClaims(turn.reply, results);
    if (verdict === 'ok' && routing.checker && turn.surface === 'text' && turn.decision?.verify && turn.remainingMs >= TURN_CHECKER_MINIMUM_MILLISECONDS) {
      const checked = await safeAsync(() => routing.checker!.check(turn.scopeKey, turn.reply, results), 'unclear' as const);
      if (checked === 'claims_unsupported') verdict = 'checker_flagged';
    }
  }
  // The tier that actually answered (review M5): a Sonnet turn that fell back to luna is luna's; an escalated luna turn is luna_plus.
  const served = turn.decision ? (turn.servedTier ?? (turn.decision.served === 'sonnet' && turn.answeredBy !== undefined && turn.answeredBy !== 'anthropic' ? 'luna'
    : turn.escalated && turn.decision.served === 'luna' ? 'luna_plus' : turn.decision.served)) : null;
  const reply = verdict && turn.surface === 'text' ? verifiedReply(turn.reply, verdict) : turn.reply;
  const feedbackReply = `${reply.trim()}${turn.surface === 'voice' ? turn.feedbackReplySuffix ?? '' : ''}`;
  const recordId = routing.feedbackEnabled && turn.presence === 'alone' ? randomUUID() : undefined;
  try {
    routing.record(turn.scopeKey, {
      talk: talkId(turn.threadId), surface: turn.surface, presence: turn.presence, tier: turn.decision && served ? { served, kind: turn.decision.kind } : null,
      tools: results.map(result => ({ name: result.name, ok: result.ok, ...(result.subject ? { subject: result.subject } : {}), ...(result.withheld ? { withheld: true } : {}) })), inDeadline: !turn.outOfTime, verified: verdict === null ? null : verdict === 'ok', doing,
      ...(recordId ? { feedback: { recordId, threadId: turn.threadId, replyDigest: createHash('sha256').update(`shannon-feedback-reply\n${feedbackReply.trim()}`).digest('hex') } } : {}),
    }, turn.at);
  } catch { /* learning never fails a turn */ }
  // On voice her words were already spoken: the verdict is learned (G), and the reply is not amended after the fact.
  return { reply, verdict, doing, ...(recordId ? { feedbackRecordId: recordId } : {}) };
}

function safe<T>(read: () => T, fallback: T): T { try { return read(); } catch { return fallback; } }
async function safeAsync<T>(read: () => Promise<T>, fallback: T): Promise<T> { try { return await read(); } catch { return fallback; } }
