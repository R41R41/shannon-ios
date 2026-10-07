/**
 * Two-clock evidence decay (Syzygy ADR-0008 stage 3, owner answer 4 of 2026-10-07, `docs/mind-workspace-contract.md`; after
 * N.E.K.O.): how sure she is of an impression, with support and contradiction fading at different speeds.
 *
 *   net(t) = Σ support·2^(−Δt/30 d) − Σ contra·2^(−Δt/180 d)
 *
 * Weights: the owner confirmed +1 or denied −1; an indirect support in a turn +0.5; ignored −0.2. Net ≥ 1 is usable, ≥ 2 promoted,
 * ≤ −2 a retirement candidate; below 0 for 14 days without a break, it is put away. A fact about the owner is exempt. The rule that
 * something said once is not used stays: one turn's support is 0.5, below the usable line.
 *
 * It replaces the fading and retirement of impressions only when `SHANNON_EVIDENCE_DECAY=on`, which waits for the owner's look at
 * the dry-run (`decayTransitions`). Pure: the caller hands the evidence and the time.
 */
export const EVIDENCE_DECAY_V1 = Object.freeze({
  version: 'evidence.v1',
  supportHalfLifeDays: 30,
  contraHalfLifeDays: 180,
  weights: Object.freeze({ owner_confirmed: 1, turn_support: 0.5, owner_denied: 1, ignored: 0.2 }),
  usableAt: 1,
  promotedAt: 2,
  retireAt: -2,
  putAwayAfterDays: 14,
});

export const EVIDENCE_KINDS = Object.freeze(['owner_confirmed', 'turn_support', 'owner_denied', 'ignored'] as const);
export type EvidenceKind = typeof EVIDENCE_KINDS[number];
const SUPPORT: ReadonlySet<EvidenceKind> = new Set(['owner_confirmed', 'turn_support']);

export interface Evidence { kind: EvidenceKind; at: string }

export type EvidenceStatus = 'exempt' | 'unconfirmed' | 'usable' | 'promoted' | 'retire_candidate' | 'put_away';

export interface EvidenceState {
  status: EvidenceStatus;
  /** The net at `at` (0 when exempt). */
  net: number;
  support: number;
  contra: number;
  /** Since when the net has been below 0 without a break, or null. */
  belowZeroSince: string | null;
}

const DAY = 86_400_000;
const supportRate = 1 / (EVIDENCE_DECAY_V1.supportHalfLifeDays * DAY);
const contraRate = 1 / (EVIDENCE_DECAY_V1.contraHalfLifeDays * DAY);

/** The decayed support and contra sums at `at`, from evidence up to then (later evidence does not count yet). */
export function evidenceSums(evidence: readonly Evidence[], at: string): { support: number; contra: number } {
  const now = Date.parse(at);
  let support = 0;
  let contra = 0;
  for (const item of evidence) {
    const age = now - Date.parse(item.at);
    if (!Number.isFinite(age) || age < 0 || !(item.kind in EVIDENCE_DECAY_V1.weights)) continue;
    const weight = EVIDENCE_DECAY_V1.weights[item.kind];
    if (SUPPORT.has(item.kind)) support += weight * 2 ** (-age * supportRate);
    else contra += weight * 2 ** (-age * contraRate);
  }
  return { support, contra };
}

export function evidenceNet(evidence: readonly Evidence[], at: string): number {
  const { support, contra } = evidenceSums(evidence, at);
  return support - contra;
}

/**
 * Since when the net has been below 0 without a break, up to `at`. Between two pieces of evidence the net is
 * S·2^(−t/30 d) − C·2^(−t/180 d): support fades faster, so it crosses 0 at most once there, from above to below, at
 * t = log2(S/C) / (1/30 d − 1/180 d). Evidence makes it jump. The walk is exact.
 */
export function belowZeroSince(evidence: readonly Evidence[], at: string): string | null {
  const now = Date.parse(at);
  const times = [...new Set(evidence.map(item => Date.parse(item.at)).filter(time => Number.isFinite(time) && time <= now))].sort((a, b) => a - b);
  let since: number | null = null;
  for (let index = 0; index < times.length; index += 1) {
    const start = times[index]!;
    const end = times[index + 1] ?? now;
    const { support, contra } = evidenceSums(evidence, new Date(start).toISOString());
    if (support - contra < 0) {
      since ??= start;
      continue;
    }
    since = null;
    if (contra > 0 && support > 0) {
      const crossing = start + Math.log2(support / contra) / (supportRate - contraRate);
      if (crossing < end) since = Math.ceil(crossing);
    }
  }
  return since === null || since > now ? null : new Date(since).toISOString();
}

/** The state of one item's evidence at `at`. `ownerFact`: a fact about the owner, which decay never touches. */
export function evidenceState(evidence: readonly Evidence[], at: string, options: { ownerFact?: boolean } = {}): EvidenceState {
  if (options.ownerFact) return Object.freeze({ status: 'exempt', net: 0, support: 0, contra: 0, belowZeroSince: null });
  const { support, contra } = evidenceSums(evidence, at);
  const net = support - contra;
  const below = net < 0 ? belowZeroSince(evidence, at) : null;
  const status: EvidenceStatus = below !== null && Date.parse(at) - Date.parse(below) >= EVIDENCE_DECAY_V1.putAwayAfterDays * DAY ? 'put_away'
    : net <= EVIDENCE_DECAY_V1.retireAt ? 'retire_candidate'
      : net >= EVIDENCE_DECAY_V1.promotedAt ? 'promoted'
        : net >= EVIDENCE_DECAY_V1.usableAt ? 'usable' : 'unconfirmed';
  return Object.freeze({ status, net, support, contra, belowZeroSince: below });
}

/** Whether an item may reach a prompt by its evidence alone. */
export function evidenceUsable(state: EvidenceState): boolean {
  return state.status === 'exempt' || state.status === 'usable' || state.status === 'promoted';
}

export interface DecayDryRunItem {
  id: string;
  evidence: readonly Evidence[];
  ownerFact?: boolean;
  /** What today's fading and retirement say of it. */
  current: 'active' | 'faded' | 'retired';
}

export interface DecayTransition { id: string; current: DecayDryRunItem['current']; after: EvidenceStatus; net: number }

/** What today's rule maps to, for comparing: active is usable, faded is unconfirmed, retired is put away. */
function sameOutcome(current: DecayDryRunItem['current'], after: EvidenceStatus): boolean {
  if (after === 'exempt') return true;
  if (current === 'active') return after === 'usable' || after === 'promoted';
  if (current === 'faded') return after === 'unconfirmed' || after === 'retire_candidate';
  return after === 'put_away';
}

/** The dry-run the owner sees before the switch: every item whose handling would change, in id order (owner answer 4). */
export function decayTransitions(items: readonly DecayDryRunItem[], at: string): readonly DecayTransition[] {
  return Object.freeze(items.flatMap(item => {
    const state = evidenceState(item.evidence, at, { ownerFact: item.ownerFact === true });
    return sameOutcome(item.current, state.status) ? [] : [Object.freeze({ id: item.id, current: item.current, after: state.status, net: state.net })];
  }).sort((left, right) => left.id.localeCompare(right.id)));
}
