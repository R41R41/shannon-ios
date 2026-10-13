import type { GoalPredicate } from './goals.js';

/**
 * The Executive's deliberation material (Syzygy ADR-0009 stage 2, plan §1), pure. The server gathers numbers and closed values;
 * this file bounds them, orders them, and ranks the candidates by their value, so the record of a choice can say where the
 * chosen one stood. Nothing here narrows the choice: the model chooses freely (owner answer), and may choose outside the list.
 */
export const DELIBERATION_LIMITS = Object.freeze({
  candidates: 12,
  goals: 6,
  recent: 3,
  interests: 8,
  reason: 80,
  minimumNextMinutes: 20,
  defaultNextMinutes: 90,
  maximumNextMinutes: 24 * 60,
});

/** A coarse mood (owner answer 5), never the numbers of her feeling. */
export const MOOD_LABELS = ['lively', 'content', 'calm', 'a_bit_low', 'tense', 'tired'] as const;
export type MoodLabel = typeof MOOD_LABELS[number];
export const MOOD_LABEL_WORDS: Readonly<Record<MoodLabel, string>> = Object.freeze({
  lively: '元気', content: '機嫌がいい', calm: '落ち着いている', a_bit_low: '少し沈んでいる', tense: '張りつめている', tired: '疲れている',
});

/** The label of a feeling given as valence and arousal, each −1..1. */
export function coarseMood(feeling: { valence: number; arousal: number }): MoodLabel {
  const valence = Number.isFinite(feeling.valence) ? feeling.valence : 0;
  const arousal = Number.isFinite(feeling.arousal) ? feeling.arousal : 0;
  if (valence >= 0.2) return arousal >= 0.2 ? 'lively' : 'content';
  if (valence <= -0.2) return arousal >= 0.2 ? 'tense' : arousal <= -0.2 ? 'tired' : 'a_bit_low';
  return 'calm';
}

export type RecentOutcome = 'success' | 'failure' | 'unknown';

export interface CandidateValue {
  readonly mean: number;
  readonly sd: number;
  readonly n: number;
}

export interface DeliberationCandidate {
  readonly capability: string;
  /** The goal it would work on; absent for notify, rest and stop. */
  readonly goalId?: string;
  readonly value: CandidateValue | null;
  /** The last outcomes of this capability, newest first. */
  readonly recent: readonly RecentOutcome[];
}

export interface DeliberationGoal {
  readonly id: string;
  readonly progress: number;
  readonly predicate: GoalPredicate | null;
  readonly reviewAt: string | null;
  readonly interestId: string | null;
}

export interface DeliberationMaterial {
  readonly at: string;
  readonly candidates: readonly DeliberationCandidate[];
  readonly goals: readonly DeliberationGoal[];
  readonly interests: readonly { readonly id: string; readonly weight: number }[];
  /** Counts of the owner's reactions in the last seven days, by closed reaction (emoji included as their sign). */
  readonly ownerReactions7d: Readonly<Record<string, number>>;
  readonly dayBand: string;
  readonly presence: string;
  readonly budgetLeftYen: number;
  readonly freeSlots: number;
  readonly mood: MoodLabel;
}

/** What the server gathers; `deliberationMaterial` bounds it. */
export type DeliberationInput = DeliberationMaterial;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, Number.isFinite(value) ? value : low));
const candidateKey = (candidate: Pick<DeliberationCandidate, 'capability' | 'goalId'>) => `${candidate.capability}|${candidate.goalId ?? ''}`;

/**
 * The material, bounded: goals by nearest review then least progress (six), candidates on those goals and the goal-free ones
 * (twelve, each once), the strongest interests (eight), three recent outcomes each, and the numbers clamped.
 */
export function deliberationMaterial(input: DeliberationInput): DeliberationMaterial {
  const goals = [...input.goals]
    .sort((left, right) => (left.reviewAt ?? '9').localeCompare(right.reviewAt ?? '9') || left.progress - right.progress || left.id.localeCompare(right.id))
    .slice(0, DELIBERATION_LIMITS.goals)
    .map(goal => Object.freeze({ ...goal, progress: clamp(goal.progress, 0, 1) }));
  const goalIds = new Set(goals.map(goal => goal.id));
  const seen = new Set<string>();
  const candidates = input.candidates.filter(candidate => {
    const key = candidateKey(candidate);
    if (seen.has(key) || (candidate.goalId !== undefined && !goalIds.has(candidate.goalId))) return false;
    seen.add(key);
    return true;
  }).slice(0, DELIBERATION_LIMITS.candidates)
    .map(candidate => Object.freeze({ ...candidate, recent: candidate.recent.slice(0, DELIBERATION_LIMITS.recent) }));
  const interests = [...input.interests]
    .sort((left, right) => right.weight - left.weight || left.id.localeCompare(right.id)).slice(0, DELIBERATION_LIMITS.interests);
  return Object.freeze({
    ...input, goals, candidates, interests,
    budgetLeftYen: Math.max(0, Math.round(input.budgetLeftYen)), freeSlots: Math.max(0, Math.trunc(input.freeSlots)),
  });
}

export interface RankedCandidate {
  readonly capability: string;
  readonly goalId?: string;
  /** 1 is the highest value; candidates without a value share the rank after the last valued one. */
  readonly rank: number;
}

/** The value rank: by V (mean) high to low, then more evidence, then name; a candidate without V ranks after all valued ones. */
export function valueRank(candidates: readonly DeliberationCandidate[]): RankedCandidate[] {
  const valued = candidates.filter(candidate => candidate.value !== null).sort((left, right) =>
    right.value!.mean - left.value!.mean || right.value!.n - left.value!.n || candidateKey(left).localeCompare(candidateKey(right)));
  const ranked: RankedCandidate[] = valued.map((candidate, index) => rankedOf(candidate, index + 1));
  const last = valued.length + 1;
  for (const candidate of candidates) if (candidate.value === null) ranked.push(rankedOf(candidate, last));
  return ranked;
}

function rankedOf(candidate: DeliberationCandidate, rank: number): RankedCandidate {
  return Object.freeze({ capability: candidate.capability, ...(candidate.goalId !== undefined ? { goalId: candidate.goalId } : {}), rank });
}

/** Where a choice stood: its rank, or null when she chose outside the candidates. */
export function rankOfChoice(ranked: readonly RankedCandidate[], choice: { capability: string; goalId?: string }): number | null {
  return ranked.find(item => candidateKey(item) === candidateKey(choice))?.rank ?? null;
}

export const GOAL_PROPOSALS = ['continue', 'rest', 'drop', 'propose_complete'] as const;
export type GoalProposal = typeof GOAL_PROPOSALS[number];

/** The Executive's answer, as the server keeps it. */
export interface DeliberationAnswer {
  readonly capability: string;
  readonly goalId?: string;
  readonly reason: string;
  readonly goalProposal?: GoalProposal;
  readonly nextThinkMinutes: number;
  /** She chose a capability of the catalog that was not among the candidates. */
  readonly outsideCandidates: boolean;
  /** What the chosen capability is handed: what to do in her words, why she speaks up, which piece. */
  readonly args: DeliberationArgs;
}

export const NOTIFY_ABOUT = ['share', 'wonder', 'upcoming', 'saw'] as const;
export type NotifyAbout = typeof NOTIFY_ABOUT[number];

export interface DeliberationArgs {
  /** What to do, one line of hers (at most 160 characters). */
  readonly intent?: string;
  /** For notify: why she speaks up, from the closed set. */
  readonly about?: NotifyAbout;
  /** For create.story or show.piece: the piece. */
  readonly pieceId?: string;
}

function argsOf(value: unknown): DeliberationArgs {
  const item = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const intent = typeof item.intent === 'string' ? item.intent.replace(/\s+/gu, ' ').trim().slice(0, 160) : '';
  const about = NOTIFY_ABOUT.find(reason => reason === item.about);
  const pieceId = typeof item.pieceId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_:-]{0,99}$/u.test(item.pieceId) ? item.pieceId : '';
  return Object.freeze({ ...(intent ? { intent } : {}), ...(about ? { about } : {}), ...(pieceId ? { pieceId } : {}) });
}

/**
 * A model's answer checked against the catalog (`known`) and the candidates: an unknown capability or goal is no answer; the
 * reason is one line of at most 80 characters; the next thought is 20 minutes to a day away (default 90).
 */
export function checkedDeliberationAnswer(
  raw: unknown, known: ReadonlySet<string>, candidates: readonly DeliberationCandidate[], goalIds: ReadonlySet<string>,
): DeliberationAnswer | null {
  const item = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  const capability = typeof item?.capability === 'string' ? item.capability : '';
  const goalId = typeof item?.goalId === 'string' && item.goalId ? item.goalId : undefined;
  if (!item || !known.has(capability) || (goalId !== undefined && !goalIds.has(goalId))) return null;
  const chosen = { capability, ...(goalId !== undefined ? { goalId } : {}) };
  const proposal = goalId === undefined ? undefined : GOAL_PROPOSALS.find(value => value === item.goalProposal);
  return Object.freeze({
    ...chosen, reason: oneLine(item.reason), ...(proposal ? { goalProposal: proposal } : {}), nextThinkMinutes: nextMinutes(item.nextThinkMinutes),
    outsideCandidates: !candidates.some(candidate => candidateKey(candidate) === candidateKey(chosen)),
    args: argsOf(item.args ?? item),
  });
}

function oneLine(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, DELIBERATION_LIMITS.reason) : '';
}

function nextMinutes(value: unknown): number {
  const minutes = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : DELIBERATION_LIMITS.defaultNextMinutes;
  return clamp(minutes, DELIBERATION_LIMITS.minimumNextMinutes, DELIBERATION_LIMITS.maximumNextMinutes);
}
