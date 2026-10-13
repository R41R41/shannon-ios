/**
 * Her goals' lifecycle (Syzygy ADR-0009 stage 2, E2), pure. A goal is one of her pursuits (`autonomy_pursuits`) with a completion
 * predicate of a closed type: it is done only when the evidence meets the predicate, or when the owner confirms it. The model
 * may propose that a goal is done; it never makes it done. The store keeps the rows and the events; this file decides.
 */
export const GOAL_PREDICATE_TYPES = [
  'piece_shown', 'owner_reaction', 'notes_count', 'research_report', 'task_completed', 'minecraft_report', 'owner_confirm',
] as const;
export type GoalPredicateType = typeof GOAL_PREDICATE_TYPES[number];

export type GoalPredicate =
  | { readonly type: 'piece_shown'; readonly minVersion: number }
  | { readonly type: 'owner_reaction'; readonly positive: boolean }
  | { readonly type: 'notes_count'; readonly n: number }
  | { readonly type: 'research_report' }
  | { readonly type: 'task_completed'; readonly capability: string }
  | { readonly type: 'minecraft_report' }
  | { readonly type: 'owner_confirm' };

/** One fact the server observed for a goal (never words: ids, versions, closed values). */
export type GoalEvidence =
  | { readonly kind: 'piece_shown'; readonly ref: string; readonly version: number; readonly at: string }
  | { readonly kind: 'owner_reaction'; readonly ref: string; readonly reaction: GoalReaction; readonly at: string }
  | { readonly kind: 'note_written'; readonly ref: string; readonly at: string }
  | { readonly kind: 'research_report'; readonly ref: string; readonly at: string }
  | { readonly kind: 'task_completed'; readonly ref: string; readonly capability: string; readonly at: string }
  | { readonly kind: 'minecraft_report'; readonly ref: string; readonly at: string }
  | { readonly kind: 'owner_confirm'; readonly ref: string; readonly at: string };
export type GoalEvidenceKind = GoalEvidence['kind'];

/** The study's reactions (`like`, `more`, `unclear`) and a chat reaction's sign. */
export const GOAL_REACTIONS = ['like', 'more', 'unclear', 'positive', 'negative'] as const;
export type GoalReaction = typeof GOAL_REACTIONS[number];
const POSITIVE: ReadonlySet<GoalReaction> = new Set(['like', 'more', 'positive']);

export const GOAL_LIMITS = Object.freeze({
  /** Non-seed goals in progress at once (plan §3). */
  active: 8,
  /** The first reviews of migrated goals are spread over this many days, oldest first. */
  reviewSpreadDays: 7,
  /** A new goal is first reviewed after this many days. */
  firstReviewDays: 7,
  evidence: 24,
  notes: 50,
  version: 1_000,
});

const REF = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,159}$/u;
const CAPABILITY = /^[a-z][A-Za-z0-9_]*(?:\.[a-z][A-Za-z0-9_]*){1,3}$/u;
const integer = (value: unknown, minimum: number, maximum: number) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;

type Parsed<T> = (item: Record<string, unknown>) => T | null;
const recordOf = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null);
const capabilityOf = (item: Record<string, unknown>) => (typeof item.capability === 'string' && CAPABILITY.test(item.capability) ? item.capability : null);

const PREDICATES: Readonly<Record<GoalPredicateType, Parsed<GoalPredicate>>> = {
  piece_shown: item => (integer(item.minVersion, 1, GOAL_LIMITS.version) ? { type: 'piece_shown', minVersion: item.minVersion as number } : null),
  owner_reaction: item => (typeof item.positive === 'boolean' ? { type: 'owner_reaction', positive: item.positive } : null),
  notes_count: item => (integer(item.n, 1, GOAL_LIMITS.notes) ? { type: 'notes_count', n: item.n as number } : null),
  task_completed: item => (capabilityOf(item) ? { type: 'task_completed', capability: capabilityOf(item)! } : null),
  research_report: () => ({ type: 'research_report' }),
  minecraft_report: () => ({ type: 'minecraft_report' }),
  owner_confirm: () => ({ type: 'owner_confirm' }),
};

/** A predicate from stored JSON or a model's answer, or null when it is not one of the closed types. */
export function checkedGoalPredicate(value: unknown): GoalPredicate | null {
  const item = recordOf(value);
  const parse = item && GOAL_PREDICATE_TYPES.includes(item.type as GoalPredicateType) ? PREDICATES[item.type as GoalPredicateType] : null;
  return item && parse ? parse(item) : null;
}

type Base = { ref: string; at: string };
const EVIDENCE: Readonly<Record<GoalEvidenceKind, (item: Record<string, unknown>, base: Base) => GoalEvidence | null>> = {
  piece_shown: (item, base) => (integer(item.version, 1, GOAL_LIMITS.version) ? { kind: 'piece_shown', ...base, version: item.version as number } : null),
  owner_reaction: (item, base) => (GOAL_REACTIONS.includes(item.reaction as GoalReaction)
    ? { kind: 'owner_reaction', ...base, reaction: item.reaction as GoalReaction } : null),
  task_completed: (item, base) => (capabilityOf(item) ? { kind: 'task_completed', ...base, capability: capabilityOf(item)! } : null),
  note_written: (_item, base) => ({ kind: 'note_written', ...base }),
  research_report: (_item, base) => ({ kind: 'research_report', ...base }),
  minecraft_report: (_item, base) => ({ kind: 'minecraft_report', ...base }),
  owner_confirm: (_item, base) => ({ kind: 'owner_confirm', ...base }),
};

/** One fact from stored JSON, or null. */
export function checkedGoalEvidence(value: unknown): GoalEvidence | null {
  const item = recordOf(value);
  if (!item || typeof item.ref !== 'string' || !REF.test(item.ref) || typeof item.at !== 'string' || Number.isNaN(Date.parse(item.at))) return null;
  const parse = Object.hasOwn(EVIDENCE, item.kind as string) ? EVIDENCE[item.kind as GoalEvidenceKind] : null;
  return parse ? parse(item, { ref: item.ref, at: item.at }) : null;
}

export interface GoalVerdict {
  readonly met: boolean;
  /** 0..1: how far the evidence goes towards the predicate (1 only when met). */
  readonly progress: number;
  /** The refs of the evidence that counted. */
  readonly used: readonly string[];
}

const verdict = (met: boolean, progress: number, used: readonly GoalEvidence[]): GoalVerdict =>
  Object.freeze({ met, progress: met ? 1 : Math.max(0, Math.min(0.95, progress)), used: Object.freeze([...new Set(used.map(item => item.ref))]) });

/**
 * Whether the evidence meets the predicate. An owner's confirmation meets every predicate; nothing else meets `owner_confirm`.
 * Evidence is matched by kind only: which goal it belongs to is the store's to say.
 */
export function evaluateGoalPredicate(predicate: GoalPredicate, evidence: readonly GoalEvidence[]): GoalVerdict {
  const confirmed = evidence.filter(item => item.kind === 'owner_confirm');
  if (confirmed.length) return verdict(true, 1, confirmed);
  switch (predicate.type) {
    case 'piece_shown': {
      const shown = evidence.filter(item => item.kind === 'piece_shown');
      const best = shown.filter(item => item.version >= predicate.minVersion);
      const highest = Math.max(0, ...shown.map(item => item.version));
      return verdict(best.length > 0, highest / predicate.minVersion * 0.9, best.length ? best : shown);
    }
    case 'owner_reaction': {
      const reactions = evidence.filter(item => item.kind === 'owner_reaction');
      const counted = predicate.positive ? reactions.filter(item => POSITIVE.has(item.reaction)) : reactions;
      return verdict(counted.length > 0, reactions.length ? 0.5 : 0, counted);
    }
    case 'notes_count': {
      const notes = evidence.filter(item => item.kind === 'note_written');
      const distinct = new Set(notes.map(item => item.ref)).size;
      return verdict(distinct >= predicate.n, distinct / predicate.n, notes);
    }
    case 'task_completed': {
      const done = evidence.filter(item => item.kind === 'task_completed' && item.capability === predicate.capability);
      return verdict(done.length > 0, 0, done);
    }
    case 'research_report': case 'minecraft_report': {
      const found = evidence.filter(item => item.kind === predicate.type);
      return verdict(found.length > 0, 0, found);
    }
    case 'owner_confirm': return verdict(false, 0, []);
  }
}

/** The evidence kept on a goal: the newest per ref and kind, at most `GOAL_LIMITS.evidence`, oldest first. */
export function mergedGoalEvidence(kept: readonly GoalEvidence[], added: readonly GoalEvidence[]): GoalEvidence[] {
  const byKey = new Map<string, GoalEvidence>();
  for (const item of [...kept, ...added]) byKey.set(`${item.kind}|${item.ref}`, item);
  return [...byKey.values()].sort((left, right) => left.at.localeCompare(right.at)).slice(-GOAL_LIMITS.evidence);
}

/** What the server knows of a migrated goal's work, for a first estimate of its progress. */
export interface GoalWorkFacts {
  readonly stories: number;
  readonly shownStories: number;
  readonly reactedStories: number;
  readonly notes: number;
  readonly readings: number;
}

/** A first estimate of progress (0..0.8): never 1, since only evidence or the owner closes a goal. */
export function estimatedGoalProgress(facts: GoalWorkFacts): number {
  const story = facts.reactedStories > 0 ? 0.6 : facts.shownStories > 0 ? 0.45 : facts.stories > 0 ? 0.25 : 0;
  const research = Math.min(0.3, facts.notes * 0.05 + facts.readings * 0.03);
  return Math.round(Math.min(0.8, story + research) * 100) / 100;
}

/** The first review of each migrated goal, oldest first, spread evenly over `GOAL_LIMITS.reviewSpreadDays` from `at`. */
export function staggeredReviews(oldestFirst: readonly string[], at: string): ReadonlyMap<string, string> {
  const start = Date.parse(at);
  const span = GOAL_LIMITS.reviewSpreadDays * 86_400_000;
  const count = oldestFirst.length;
  return new Map(oldestFirst.map((id, index) => [id, new Date(start + Math.round((index + 1) * span / count)).toISOString()]));
}

export interface ActiveGoalFacts {
  readonly id: string;
  readonly lastWorkedAt: string | null;
  readonly updatedAt: string;
}

/**
 * The active goals over the cap, to be rested: the most recently worked stay active (then the most recently changed), and
 * `keep` (a goal just made or just reactivated) always stays.
 */
export function goalsOverCap(active: readonly ActiveGoalFacts[], keep: string | null = null, cap: number = GOAL_LIMITS.active): string[] {
  const recency = (goal: ActiveGoalFacts) => goal.lastWorkedAt ?? '';
  const ordered = [...active].sort((left, right) => Number(right.id === keep) - Number(left.id === keep)
    || recency(right).localeCompare(recency(left)) || right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
  return ordered.slice(Math.max(0, cap)).map(goal => goal.id);
}

/** The predicate in plain Japanese for the owner's 目標 tab (`docs/executive-ui-contract.md`); `label` names a capability. */
export function goalPredicateSummary(predicate: GoalPredicate, label: (capability: string) => string = capability => capability): string {
  switch (predicate.type) {
    case 'piece_shown': return predicate.minVersion > 1 ? `物語を第${predicate.minVersion}版まで直して、ライ氏に見せる` : '物語を書いて、ライ氏に見せる';
    case 'owner_reaction': return predicate.positive ? '見せたものに、ライ氏がよい反応をくれる' : '見せたものに、ライ氏から反応がある';
    case 'notes_count': return `メモを${predicate.n}件書く`;
    case 'research_report': return '調べたことを報告にまとめる';
    case 'task_completed': return `「${label(predicate.capability)}」を最後までやり遂げる`;
    case 'minecraft_report': return 'マイクラで遊んで、報告を残す';
    case 'owner_confirm': return 'ライ氏が完了を認める';
  }
}

/** Progress in words where it is a count (「3/5」), or null. */
export function goalProgressLabel(predicate: GoalPredicate | null, evidence: readonly GoalEvidence[]): string | null {
  if (predicate?.type !== 'notes_count') return null;
  const notes = new Set(evidence.filter(item => item.kind === 'note_written').map(item => item.ref)).size;
  return `${Math.min(notes, predicate.n)}/${predicate.n}`;
}
