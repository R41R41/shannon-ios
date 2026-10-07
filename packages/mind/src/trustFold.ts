/**
 * The trust fold (Syzygy ADR-0008 stage 3 and §14, `docs/mind-workspace-contract.md`; the shape after Emotion Engine): trust kept
 * apart from mood, moved only by closed kinds of evidence, settled once per conversation, easier to lose than to gain, with a floor
 * that follows its highest value.
 *
 * Structure only. Its parameters are unset (`TRUST_PARAMETERS = null`), so the fold answers null, `trust_after` stays null and
 * nothing reaches a prompt. Setting them is an owner approval, from Shannon's own data (§14: 「数値はシャノンのデータから決める」).
 */
export const TRUST_KINDS = Object.freeze(['promise_kept', 'promise_broken', 'owner_confirmed', 'owner_corrected'] as const);
export type TrustKind = typeof TRUST_KINDS[number];

export interface TrustParameters {
  /** Where trust starts, in [0, 1]. */
  initial: number;
  /** The step each kind gives (gains positive, losses negative). */
  step: Readonly<Record<TrustKind, number>>;
  /** One conversation's settlement is clamped to [maximumLoss, maximumGain] (maximumLoss < 0 < maximumGain). */
  maximumLoss: number;
  maximumGain: number;
  /** Trust never falls below floorRatio × its highest value so far. */
  floorRatio: number;
}

/** Unset: no number is decided until the owner approves one. */
export const TRUST_PARAMETERS: TrustParameters | null = null;

export interface TrustEntry {
  kind: TrustKind;
  /** The conversation it is settled in (one settlement per conversation). */
  conversationId: string;
  at: string;
}

export interface TrustSettlement { conversationId: string; at: string; kinds: readonly TrustKind[] }

/** The entries grouped into one settlement per conversation, in the order each conversation was first seen; unknown kinds dropped. */
export function trustSettlements(entries: readonly TrustEntry[]): readonly TrustSettlement[] {
  const ordered = [...entries].filter(entry => (TRUST_KINDS as readonly string[]).includes(entry.kind))
    .sort((left, right) => left.at.localeCompare(right.at) || left.conversationId.localeCompare(right.conversationId));
  const byConversation = new Map<string, { at: string; kinds: TrustKind[] }>();
  for (const entry of ordered) {
    const settlement = byConversation.get(entry.conversationId);
    if (settlement) { settlement.kinds.push(entry.kind); settlement.at = entry.at; } else byConversation.set(entry.conversationId, { at: entry.at, kinds: [entry.kind] });
  }
  return Object.freeze([...byConversation].map(([conversationId, settlement]) => Object.freeze({ conversationId, at: settlement.at, kinds: Object.freeze(settlement.kinds) }))
    .sort((left, right) => left.at.localeCompare(right.at) || left.conversationId.localeCompare(right.conversationId)));
}

/** Whether a parameter set has the shape the fold needs: finite, gains not larger than losses, a floor in [0, 1). */
export function validTrustParameters(parameters: TrustParameters): boolean {
  const finite = [parameters.initial, parameters.maximumLoss, parameters.maximumGain, parameters.floorRatio, ...Object.values(parameters.step)].every(Number.isFinite);
  return finite && parameters.initial >= 0 && parameters.initial <= 1 && parameters.maximumLoss < 0 && parameters.maximumGain > 0
    && parameters.maximumGain <= -parameters.maximumLoss && parameters.floorRatio >= 0 && parameters.floorRatio < 1
    && TRUST_KINDS.every(kind => kind in parameters.step);
}

/**
 * Trust after the given entries, or null while the parameters are unset (or malformed). Each conversation settles once: the sum of
 * its kinds' steps, clamped to [maximumLoss, maximumGain], then held in [floorRatio × highest, 1].
 */
export function trustFold(entries: readonly TrustEntry[], parameters: TrustParameters | null = TRUST_PARAMETERS): number | null {
  if (!parameters || !validTrustParameters(parameters)) return null;
  let trust = parameters.initial;
  let highest = trust;
  for (const settlement of trustSettlements(entries)) {
    const sum = settlement.kinds.reduce((total, kind) => total + parameters.step[kind], 0);
    const step = Math.min(parameters.maximumGain, Math.max(parameters.maximumLoss, sum));
    trust = Math.min(1, Math.max(parameters.floorRatio * highest, trust + step, 0));
    highest = Math.max(highest, trust);
  }
  return trust;
}
