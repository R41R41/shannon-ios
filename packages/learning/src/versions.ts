/**
 * Versions of the value table (Syzygy ADR-0008 §2 answer 1: 版で持ち、1 つ前の版へ戻せる; §7). Core: emotion. Pure.
 *
 * One version is active per scope. The nightly pass writes a new version from all settled choices (`sleep`) unless nothing
 * new was settled or the active version is frozen. The owner's rollback makes a new version with the cells of an earlier one
 * (`owner_rollback`) and freezes: until he resumes, the evidence after it is not used (no nightly version). Resuming makes a
 * new version from all evidence again (`owner_resume`). Retention: a nightly version 30 days unless it is active; versions the
 * owner made are kept (owner override 5).
 */
export type ValueVersionMaker = 'sleep' | 'owner_rollback' | 'owner_resume';

export interface ValueVersionRecord {
  versionId: string;
  createdAt: string;
  madeBy: ValueVersionMaker;
  /** The reward formula and its weights it was computed with (`REWARD_FORMULA`). */
  formula: string;
  weights: Readonly<Record<string, number>>;
  /** The version it was made from: the one before it, or the one a rollback returned to. */
  baseVersion: string | null;
  /** The places in the order of settling of the choices it learned from (1-based, inclusive); 0 and 0 for none. */
  evidenceFrom: number;
  evidenceTo: number;
  state: 'active' | 'retired';
  frozen: boolean;
  /** Stage5's independent owner reaction cursor and immutable fold policy; absent on legacy versions. */
  feedbackSeq?: number;
  feedbackPolicy?: string;
}

export const NIGHTLY_VERSION_RETENTION_DAYS = 30;

export type NightlyDecision = 'snapshot' | 'frozen' | 'already' | 'unchanged' | 'empty';

/**
 * Whether the nightly pass writes a version: not while frozen, not when it already wrote one this owner day (`sleptToday`: a
 * `sleep` version made at or after today's sleep-hour boundary, so a restart later in the day changes nothing), not without
 * evidence, not when nothing new was settled.
 */
export function nightlyDecision(active: Pick<ValueVersionRecord, 'frozen' | 'evidenceTo' | 'feedbackSeq' | 'feedbackPolicy'> | null, lastSeq: number, sleptToday = false,
  feedback?: { seq: number; policy: string }): NightlyDecision {
  if (active?.frozen) return 'frozen';
  if (sleptToday) return 'already';
  if (lastSeq <= 0) return 'empty';
  if (active && active.evidenceTo >= lastSeq && (!feedback || ((active.feedbackSeq ?? 0) >= feedback.seq && active.feedbackPolicy === feedback.policy))) return 'unchanged';
  return 'snapshot';
}

/**
 * The version a rollback returns to: the one asked for, or the newest version that learned from less than the active one did
 * (so a second rollback goes further back, never forward to the version rolled away from).
 */
export function rollbackTarget(versions: readonly ValueVersionRecord[], active: ValueVersionRecord | null, requested?: string): ValueVersionRecord | 'VALUES_NO_ACTIVE_VERSION' | 'VALUES_VERSION_NOT_FOUND' | 'VALUES_NO_EARLIER_VERSION' {
  if (!active) return 'VALUES_NO_ACTIVE_VERSION';
  if (requested) {
    const found = versions.find(version => version.versionId === requested);
    return found && found.versionId !== active.versionId ? found : 'VALUES_VERSION_NOT_FOUND';
  }
  const earlier = versions.filter(version => version.versionId !== active.versionId && version.evidenceTo <= active.evidenceTo
    && (version.feedbackSeq ?? 0) <= (active.feedbackSeq ?? 0)
    && (version.evidenceTo < active.evidenceTo || (version.feedbackSeq ?? 0) < (active.feedbackSeq ?? 0)
      || (version.feedbackPolicy !== active.feedbackPolicy && version.createdAt <= active.createdAt)))
    .sort((left, right) => right.evidenceTo - left.evidenceTo || (right.feedbackSeq ?? 0) - (left.feedbackSeq ?? 0) || right.createdAt.localeCompare(left.createdAt));
  return earlier[0] ?? 'VALUES_NO_EARLIER_VERSION';
}

/** Nightly versions older than the retention that are not active; the owner's are kept. */
export function versionsToPrune(versions: readonly ValueVersionRecord[], at: string, keepDays = NIGHTLY_VERSION_RETENTION_DAYS): string[] {
  const before = Date.parse(at) - keepDays * 24 * 60 * 60_000;
  return versions.filter(version => version.madeBy === 'sleep' && version.state !== 'active' && Date.parse(version.createdAt) < before).map(version => version.versionId);
}
