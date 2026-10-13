import type { ValueCell } from './valueTable.js';

/**
 * The Executive's reward r2 and the capability names of the value table (Syzygy ADR-0009 stage 2, plan §1 and §2), pure.
 *
 * r2 replaces "success = 1" of her own time: the owner's weights (owner answer 4) are completion 0.35, the owner's reaction
 * 0.35, whether her prediction came true 0.2 and her own assessment 0.1. A part that does not apply to a choice (no owner
 * reaction to a note she kept to herself) is void, and the weights of the parts that apply are scaled to sum to 1; a known 0
 * (no reaction in 14 days to a piece she showed) is a part that applies. With no part known, r2 is unsettled (null).
 */
export const EXECUTIVE_REWARD_WEIGHTS = Object.freeze({ completion: 0.35, owner: 0.35, prediction: 0.2, self: 0.1 });
export type ExecutiveRewardPart = keyof typeof EXECUTIVE_REWARD_WEIGHTS;

export interface ExecutiveRewardParts {
  /** 0..1: the goal's progress this choice made, 1 when it met the completion predicate. */
  readonly completion: number | null;
  /** −1..1: the owner's reaction (like 1, more 0.5, unclear 0, a negative reaction −1). */
  readonly owner: number | null;
  /** −1..1: the skill κ of the predictions linked to the choice. */
  readonly prediction: number | null;
  /** −1..1: her own assessment of the result. */
  readonly self: number | null;
}

const RANGES: Readonly<Record<ExecutiveRewardPart, readonly [number, number]>> = Object.freeze({
  completion: [0, 1], owner: [-1, 1], prediction: [-1, 1], self: [-1, 1],
});

export interface ExecutiveReward {
  readonly reward: number;
  /** The weight each known part had after scaling. */
  readonly weights: Readonly<Partial<Record<ExecutiveRewardPart, number>>>;
}

export function executiveReward(parts: ExecutiveRewardParts, weights = EXECUTIVE_REWARD_WEIGHTS): ExecutiveReward | null {
  const known = (Object.keys(weights) as ExecutiveRewardPart[]).filter(part => typeof parts[part] === 'number' && Number.isFinite(parts[part]));
  const total = known.reduce((sum, part) => sum + weights[part], 0);
  if (!known.length || total <= 0) return null;
  let reward = 0;
  const scaled: Partial<Record<ExecutiveRewardPart, number>> = {};
  for (const part of known) {
    const [low, high] = RANGES[part];
    scaled[part] = weights[part] / total;
    reward += scaled[part] * Math.min(high, Math.max(low, parts[part]!));
  }
  return Object.freeze({ reward: Math.min(1, Math.max(-1, reward)), weights: Object.freeze(scaled) });
}

/** The owner's reaction to a piece as the `owner` part. */
export function ownerReactionPart(reaction: 'like' | 'more' | 'unclear' | 'negative' | 'none_in_14_days'): number {
  return { like: 1, more: 0.5, unclear: 0, negative: -1, none_in_14_days: 0 }[reaction];
}

const REACH_OUT_REASONS = new Set(['share', 'wonder', 'upcoming', 'saw']);
const PLAIN: Readonly<Record<string, string>> = Object.freeze({
  draft: 'create.story', revise: 'create.story', read: 'research.read', notion: 'research.read',
  note: 'create.note', jot: 'create.note', copy: 'create.note', look: 'look.room', show: 'show.piece', follow_up: 'notify.text.follow_up',
});

/**
 * The capability a choice of the old loop folds into (the value table's `cap1` version): draft|revise → create.story,
 * reach_out.x → notify.text.x, call.x → notify.call.x, read|notion → research.read, note|jot|copy → create.note,
 * look → look.room, show → show.piece. A capability name stays itself; anything else (ready, put_away, a tool) is not folded.
 */
export function capabilityOfChoice(choice: string): string | null {
  if (PLAIN[choice]) return PLAIN[choice];
  const [head, reason, ...rest] = choice.split('.');
  if (rest.length === 0 && reason && REACH_OUT_REASONS.has(reason)) {
    if (head === 'reach_out') return `notify.text.${reason}`;
    if (head === 'call') return `notify.call.${reason}`;
  }
  if (/^(?:create|research|aether|notify|show|look|music|minecraft|self|rest)(?:\.[a-z_]+){0,2}$/u.test(choice)) return choice;
  return null;
}

/** The activity a capability key belongs to: `notify.text.share` → `notify.text`. */
export function activityOfCapability(capability: string): string {
  return capability.split('.').slice(0, 2).join('.');
}

/**
 * Cells folded under their capability (at the same level and context): n added, the means weighted by n, the spread and
 * noise weighted by n too, the newest `lastAt`, the largest volatility. A fold of what is known for showing and for a first
 * version, not a re-estimation: the `cap1` version re-learns from the evidence itself. `by` picks the key (default: the
 * folded choice; `activityOfCapability` folds the reasons too).
 */
export function foldedValueCells(cells: readonly ValueCell[], by: (capability: string) => string = capability => capability): ValueCell[] {
  const groups = new Map<string, ValueCell[]>();
  for (const cell of cells) {
    if (cell.level === 'root' || cell.level === 'family') continue;
    const capability = capabilityOfChoice(cell.choice);
    if (!capability) continue;
    const key = `${cell.level}|${by(capability)}|${cell.context}`;
    groups.set(key, [...(groups.get(key) ?? []), { ...cell, choice: by(capability) }]);
  }
  return [...groups.values()].map(foldCells);
}

function foldCells(group: readonly ValueCell[]): ValueCell {
  const n = group.reduce((sum, cell) => sum + cell.n, 0);
  const weight = (cell: ValueCell) => (n > 0 ? cell.n / n : 1 / group.length);
  const mean = (pick: (cell: ValueCell) => number) => group.reduce((sum, cell) => sum + weight(cell) * pick(cell), 0);
  const times = group.map(cell => cell.lastAt).filter((value): value is number => value !== null);
  return {
    level: group[0]!.level, choice: group[0]!.choice, context: group[0]!.context, n,
    mean: mean(cell => cell.mean), uncertainty: mean(cell => cell.uncertainty), noise: mean(cell => cell.noise),
    volatility: Math.max(...group.map(cell => cell.volatility)), lastAt: times.length ? Math.max(...times) : null,
    world: mean(cell => cell.world), serve: mean(cell => cell.serve), growth: mean(cell => cell.growth), costYen: mean(cell => cell.costYen),
  };
}
