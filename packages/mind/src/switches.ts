/**
 * The switches of Syzygy ADR-0008 stage 3 (`docs/mind-workspace-contract.md`). Pure: the caller hands the values in (the
 * services read their environment; this package reads none).
 *
 * Every switch is on unless it says `off`, `false`, `0`, `disabled`, `no` or `none`, except `SHANNON_EVIDENCE_DECAY`, which is
 * off unless it says `on`, `true`, `1` or `yes` (owner answer 4 of 2026-10-07: the owner sees the dry-run before it is turned on).
 * `SHANNON_ADR8_STAGE3=off` restores afb38c28 byte for byte. The implications are fixed here, in one place:
 * - `SHANNON_ADR8_STAGE3` off: everything below is off.
 * - `SHANNON_MIND_EVENTS` off: nothing is perceived as an event, so attention and the workspace are off too.
 * - `SHANNON_ATTENTION` off: nothing enters the workspace, so the workspace is off too.
 * - `SHANNON_MEMORY_OUTBOX` off: memory is written where it was, so the temporal facts (resolved by the writer) are off too.
 */
export interface MindSwitches {
  /** `SHANNON_ADR8_STAGE3`: the master switch. */
  stage3: boolean;
  /** `SHANNON_MIND_EVENTS`: every surface hands what it perceived to the mind as one `mind.event.v1`. Core: response path. */
  mindEvents: boolean;
  /** `SHANNON_ATTENTION`: salience orders the events (`SALIENCE_V1`); it never silences. Core: response path. */
  attention: boolean;
  /** `SHANNON_WORKSPACE`: the shared place (`[いまの場]`) and the notices of a turn's prompt. Core: response path. */
  workspace: boolean;
  /** `SHANNON_DATA_FRAMES`: untrusted text reaches a prompt inside `〔データ …〕` frames. Core: response path, guard. */
  dataFrames: boolean;
  /** `SHANNON_PROACTIVE_GATE`: intent repeat, intent expiry and topic reuse beside today's spacing and owner-active hold. Core: guard. */
  proactiveGate: boolean;
  /** `SHANNON_MEMORY_OUTBOX`: memory proposals go to the outbox and one writer applies them. Core: memory. */
  memoryOutbox: boolean;
  /** `SHANNON_TEMPORAL_FACTS`: people facts carry `valid_at`/`invalid_at`/`expired_at`; a contradiction closes the old one. Core: memory. */
  temporalFacts: boolean;
  /** `SHANNON_EVIDENCE_DECAY` (off by default): two-clock decay replaces impressions' fading and retirement. Core: memory. */
  evidenceDecay: boolean;
  /** `SHANNON_IDENTITY_TIERS`: tiers 2–4 of identity suggest a merge; the owner merges. Core: memory. */
  identityTiers: boolean;
  /** `SHANNON_TRUST_LEDGER`: the trust ledger records its closed kinds (inert: no parameters, nothing reaches a prompt). Core: memory. */
  trustLedger: boolean;
  /** `SHANNON_STRUCTURED_COMPACTION`: the replay summary is the JSON template rendered by code. Core: memory, response path. */
  structuredCompaction: boolean;
}

export type SwitchValues = Readonly<Record<string, string | undefined>>;

const OFF = new Set(['off', 'false', '0', 'disabled', 'no', 'none']);
const ON = new Set(['on', 'true', '1', 'yes']);

/** On unless the value names off (the words of every other switch of the server). */
export function switchedOn(value: string | undefined): boolean {
  return !OFF.has(value?.trim().toLowerCase() ?? '');
}

/** Off unless the value names on. */
export function switchedOnExplicitly(value: string | undefined): boolean {
  return ON.has(value?.trim().toLowerCase() ?? '');
}

/** The names of the switches, in the order of the contract's table. */
export const MIND_SWITCH_NAMES = Object.freeze({
  stage3: 'SHANNON_ADR8_STAGE3',
  mindEvents: 'SHANNON_MIND_EVENTS',
  attention: 'SHANNON_ATTENTION',
  workspace: 'SHANNON_WORKSPACE',
  dataFrames: 'SHANNON_DATA_FRAMES',
  proactiveGate: 'SHANNON_PROACTIVE_GATE',
  memoryOutbox: 'SHANNON_MEMORY_OUTBOX',
  temporalFacts: 'SHANNON_TEMPORAL_FACTS',
  evidenceDecay: 'SHANNON_EVIDENCE_DECAY',
  identityTiers: 'SHANNON_IDENTITY_TIERS',
  trustLedger: 'SHANNON_TRUST_LEDGER',
  structuredCompaction: 'SHANNON_STRUCTURED_COMPACTION',
} as const satisfies Record<keyof MindSwitches, string>);

export function mindSwitches(values: SwitchValues): MindSwitches {
  const stage3 = switchedOn(values.SHANNON_ADR8_STAGE3);
  const mindEvents = stage3 && switchedOn(values.SHANNON_MIND_EVENTS);
  const attention = mindEvents && switchedOn(values.SHANNON_ATTENTION);
  const memoryOutbox = stage3 && switchedOn(values.SHANNON_MEMORY_OUTBOX);
  return Object.freeze({
    stage3,
    mindEvents,
    attention,
    workspace: attention && switchedOn(values.SHANNON_WORKSPACE),
    dataFrames: stage3 && switchedOn(values.SHANNON_DATA_FRAMES),
    proactiveGate: stage3 && switchedOn(values.SHANNON_PROACTIVE_GATE),
    memoryOutbox,
    temporalFacts: memoryOutbox && switchedOn(values.SHANNON_TEMPORAL_FACTS),
    evidenceDecay: stage3 && switchedOnExplicitly(values.SHANNON_EVIDENCE_DECAY),
    identityTiers: stage3 && switchedOn(values.SHANNON_IDENTITY_TIERS),
    trustLedger: stage3 && switchedOn(values.SHANNON_TRUST_LEDGER),
    structuredCompaction: stage3 && switchedOn(values.SHANNON_STRUCTURED_COMPACTION),
  });
}
