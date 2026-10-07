/**
 * The difficulty policy (Syzygy ADR-0008 stage 2, step 4; `docs/skill-and-routing-contract.md`). Core: **response path** (listed
 * by name in `autonomyCore.ts`, so it is not emotion's although this package is). Pure: no database, network, environment or timer.
 *
 * From Jev's difficulty answers and what the competence table has learned, it decides which tier answers a conversation turn,
 * how many rethinks it may take and whether it is verified. Luna first (owner answer 5, ADR-0008 §2).
 *
 * Jev's probabilities are acted on only inside the confidence band (ADR-0008 §14, after Canny): `yes` at p ≥ 0.9, `no` at
 * p ≤ 0.1, `unsure` in between (`jevBand`). An unsure answer never decides anything by itself; each question has its own rule:
 * - `needs_strong_model`: `yes` → `sonnet`; `unsure` → luna, which may be escalated once at a round boundary when a tool fails
 *   or a round runs out of time (`escalateOnTrouble`: evidence decides, never after her words have started); `no` → on.
 *   Also `sonnet` when luna's learned success for that kind of task is below 0.6 over at least five outcomes (evidence).
 * - `multi_step`: `yes` → `luna_plus` (luna thinking one step longer) and one rethink; otherwise luna's own tool rounds.
 * - `needs_verification`: `yes` → the luna checker and one rethink; otherwise the deterministic verifier alone (which checks
 *   every turn that offered a write, whatever Jev said).
 * - small talk (`jev_only`, served by luna, never verified or escalated) only when all three are `no` and the kind is chat.
 * - `luna` otherwise, and whenever Jev could not answer.
 * Jev never blocks: every confident answer adds care (a stronger tier, a check, a rethink) or, for small talk, leaves the
 * deterministic verifier in place; a hard verdict on her reply comes only from evidence (the verifier, the tool results).
 *
 * `sonnet` is served only while it is available (the Anthropic key **and** `SHANNON_SONNET_ROUTING=on`, owner answer I-1);
 * otherwise it is served as `luna_plus` and nothing leaves for Anthropic. On voice (owner answer I-2 「声も含めて」) an available
 * Sonnet is used only when the voice turn's remaining time can absorb its first-token latency (measured once the client
 * exists, step 5; until then an estimate); otherwise voice falls back to luna.
 */
export const TASK_KINDS = ['chat', 'feelings', 'recall', 'lookup', 'write', 'plan', 'analysis', 'code', 'action'] as const;
export type TaskKind = typeof TASK_KINDS[number];

export const TIERS = ['jev_only', 'luna', 'luna_plus', 'sonnet'] as const;
export type Tier = typeof TIERS[number];
/** What actually answers: `jev_only` is served by luna. */
export type ServedTier = 'luna' | 'luna_plus' | 'sonnet';

export interface DifficultyAnswers {
  taskKind: TaskKind;
  /** Jev's probability that a strong model is needed. */
  needsStrongModel: number;
  needsVerification: number;
  multiStep: number;
}

/** What the competence table holds for a (tier, kind): a Beta posterior from Beta(1, 1). */
export interface Competence { successes: number; failures: number }

/** Jev's confidence band (ADR-0008 §14): answers between `no` and `yes` are `unsure` and fall back to each site's own rule. */
export const JEV_BAND = Object.freeze({ yes: 0.9, no: 0.1 });
export type JevBand = 'yes' | 'no' | 'unsure';

export function jevBand(probability: number): JevBand {
  return probability >= JEV_BAND.yes ? 'yes' : probability <= JEV_BAND.no ? 'no' : 'unsure';
}

export const DIFFICULTY_THRESHOLDS = Object.freeze({
  /** Luna is known to be weak at a kind below this learned success … */
  weakLuna: 0.6,
  /** … over at least this many outcomes. */
  weakLunaN: 5,
  /** Review M5: a turn of a kind luna is learned to be weak at is still hers this often, so her competence can recover. */
  exploreLuna: 0.1,
});

/** First-token latency assumed for Sonnet on voice until it is measured (step 5's hook), and the room voice keeps for the rest. */
export const SONNET_FIRST_TOKEN_ESTIMATE_MS = 2_500;
export const VOICE_SONNET_MARGIN_MS = 6_000;

export interface DifficultyContext {
  surface: 'text' | 'voice';
  /** Jev's answers; null when Jev could not answer (the turn is luna's, as before). */
  answers: DifficultyAnswers | null;
  /** Luna's learned competence for the kind, when known. */
  lunaCompetence: Competence | null;
  /** The key and `SHANNON_SONNET_ROUTING=on`; false in steps 1–4 (no client). */
  sonnetAvailable: boolean;
  /** Voice: the turn's time left, and Sonnet's measured first-token latency (null: the estimate). */
  voice?: { remainingMs: number; sonnetFirstTokenMs: number | null };
  /** Review M5: a draw in [0, 1) for exploring luna on a kind she is learned to be weak at; absent, no exploration. */
  explore?: number;
}

export interface TierDecision {
  /** What the policy asked for. */
  tier: Tier;
  /** What answers the turn. */
  served: ServedTier;
  /** A closed code of why. */
  reason: 'no_answers' | 'strong' | 'luna_weak' | 'explore' | 'middle' | 'multi_step' | 'small_talk' | 'plain';
  /** `sonnet` was served as `luna_plus` (not available) or as luna (voice time). */
  mappedDown: 'none' | 'unavailable' | 'voice_time';
  rethinks: 0 | 1 | 2;
  verify: boolean;
  /** May be escalated once, at a round boundary, before her words have started. */
  escalateOnTrouble: boolean;
}

/** The posterior mean of a competence, and how many outcomes it has. */
export function competenceMean(competence: Competence | null): { mean: number; n: number } {
  const successes = Math.max(0, competence?.successes ?? 0);
  const failures = Math.max(0, competence?.failures ?? 0);
  return { mean: (1 + successes) / (2 + successes + failures), n: successes + failures };
}

export function decideTier(context: DifficultyContext): TierDecision {
  const plain = (tier: Tier, reason: TierDecision['reason'], extra: Partial<TierDecision> = {}): TierDecision => ({
    tier, served: tier === 'jev_only' ? 'luna' : tier as ServedTier, reason, mappedDown: 'none', rethinks: 0, verify: false, escalateOnTrouble: false, ...extra,
  });
  const answers = context.answers;
  if (!answers) return plain('luna', 'no_answers');
  const strongBand = jevBand(answers.needsStrongModel);
  const verifyBand = jevBand(answers.needsVerification);
  const multiBand = jevBand(answers.multiStep);
  const verify = verifyBand === 'yes';
  const rethinks = ((multiBand === 'yes' ? 1 : 0) + (verify ? 1 : 0)) as 0 | 1 | 2;
  const luna = competenceMean(context.lunaCompetence);
  const strong = strongBand === 'yes' ? 'strong' as const
    : luna.n >= DIFFICULTY_THRESHOLDS.weakLunaN && luna.mean < DIFFICULTY_THRESHOLDS.weakLuna ? 'luna_weak' as const : null;
  // Review M5: learned weakness alone (not Jev's confident yes) leaves one turn in ten to luna, so the table can learn she improved.
  if (strong === 'luna_weak' && context.explore !== undefined && context.explore < DIFFICULTY_THRESHOLDS.exploreLuna) return { ...plain('luna', 'explore'), rethinks, verify, escalateOnTrouble: true };
  if (strong) return served({ ...plain('sonnet', strong), rethinks, verify }, context);
  if (strongBand === 'unsure') return { ...plain('luna', 'middle'), rethinks, verify, escalateOnTrouble: true };
  if (multiBand === 'yes') return { ...plain('luna_plus', 'multi_step'), rethinks, verify };
  if (answers.taskKind === 'chat' && multiBand === 'no' && verifyBand === 'no') return plain('jev_only', 'small_talk');
  return { ...plain('luna', 'plain'), rethinks, verify };
}

/** Sonnet as it can be served now: `luna_plus` without the key and the switch; on voice, luna when its first token would be late. */
function served(decision: TierDecision, context: DifficultyContext): TierDecision {
  if (!context.sonnetAvailable) return { ...decision, served: 'luna_plus', mappedDown: 'unavailable' };
  if (context.surface === 'voice') {
    const firstToken = context.voice?.sonnetFirstTokenMs ?? SONNET_FIRST_TOKEN_ESTIMATE_MS;
    if (!context.voice || context.voice.remainingMs < firstToken + VOICE_SONNET_MARGIN_MS) return { ...decision, served: 'luna', mappedDown: 'voice_time' };
  }
  return { ...decision, served: 'sonnet' };
}

/** The one escalation of a turn: luna to `luna_plus` (or to Sonnet once it is available); none from above. */
export function escalatedTier(served: ServedTier, sonnetAvailable: boolean): ServedTier | null {
  if (served === 'luna') return sonnetAvailable ? 'sonnet' : 'luna_plus';
  return null;
}

/**
 * The closed outcome signals of a conversation choice (owner answer I-3 「報酬にも入れる」):
 * - G, how well it went by itself: the mean of the signals that apply (the tool worked, the turn finished inside its deadline,
 *   the verifier found no claim without a write), each 0 or 1;
 * - S, what the owner did next: the next turn's Jev probability that he retried or corrected her, inside the band only: 0 when
 *   `yes` (p ≥ 0.9), 1 when `no` (p ≤ 0.1), and null when `unsure`, which settles the turn as if no next turn had told her
 *   anything (the competence and the skill uses from G alone; the choice ledger at S = ½ as `next_turn_unsure`, never a mood).
 */
export function conversationGrowth(signals: readonly boolean[]): number {
  return signals.length ? signals.filter(Boolean).length / signals.length : 0;
}

export function nextTurnServe(retryProbability: number): 1 | 0 | null {
  const band = jevBand(retryProbability);
  return band === 'no' ? 1 : band === 'yes' ? 0 : null;
}

/** A tier's outcome for the competence table: it went well by itself and he did not retry or correct it. */
export function tierOutcome(growth: number, serve: number | null): 0 | 1 {
  return growth >= 2 / 3 && (serve === null || serve >= 0.5) ? 1 : 0;
}
