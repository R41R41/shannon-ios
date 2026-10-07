import { normalizeAudience, type MemoryAudience } from '@shannon/cognition';
import type { SalienceInputs } from './salience.js';

/**
 * `mind.event.v1` (Syzygy ADR-0008 stage 3, `docs/mind-workspace-contract.md`): one closed shape for everything a surface perceived.
 * A surface's normalizer (`mind/perception/`) copies the surface's own audience decision into it and never recomputes it; another
 * process writes the same shape into `mind_inbox`, which is read back through `checkedMindEvent`.
 *
 * The text is kept in memory only (`content.text`) or referenced (`content.ref`), and is re-read through the withholding and the
 * disclosure gate when rendered, so what the owner asked to forget is gone also after a restart. Nothing here is a word of the
 * owner's except `content.text`, which never goes into the journal, the inbox or a snapshot.
 */
export const MIND_EVENT_SCHEMA = 'mind.event.v1';

export const MIND_EVENT_KINDS = Object.freeze([
  'utterance', 'touch', 'presence', 'game', 'platform_message', 'task_outcome', 'promise_due', 'own_time_step', 'notice',
] as const);
export type MindEventKind = typeof MIND_EVENT_KINDS[number];

export const MIND_SURFACES = Object.freeze(['text', 'voice', 'body', 'minecraft', 'platform', 'outreach', 'own_time'] as const);
export type MindSurface = typeof MIND_SURFACES[number];

export const MIND_SPEAKER_KINDS = Object.freeze(['owner', 'person', 'unknown', 'shannon', 'system'] as const);
export type MindSpeakerKind = typeof MIND_SPEAKER_KINDS[number];

/** How far the source may be trusted: the owner's own words, a system of hers, or text from outside (framed as data). */
export const MIND_TRUST = Object.freeze(['owner', 'system', 'untrusted'] as const);
export type MindTrust = typeof MIND_TRUST[number];

export const MIND_EVENT_LIMITS = Object.freeze({ id: 80, body: 80, personId: 120, people: 12, source: 60, sourceId: 160, episodeIds: 16, text: 4_000, ref: 200 });

export interface MindSpeaker {
  kind: MindSpeakerKind;
  personId: string | null;
  /** True only when the surface proved who spoke (the owner's paired device, his online-mode uuid, his platform id). */
  verified: boolean;
  /** The identity tier that named the speaker (1–4), or null. Tiers 3 and 4 only suggest, so a speaker named by them is not verified. */
  tier: 1 | 2 | 3 | 4 | null;
}

export interface MindPresence {
  /** Only the owner can see or hear the answer. */
  ownerOnlyHears: boolean;
  /** Someone else may hear or read it. */
  othersMayHear: boolean;
}

export interface MindProvenance {
  source: string;
  sourceId: string;
  trust: MindTrust;
  episodeIds: readonly string[];
}

export type MindContent = { text: string } | { ref: string } | null;

export interface MindEvent {
  schema: typeof MIND_EVENT_SCHEMA;
  id: string;
  kind: MindEventKind;
  surface: MindSurface;
  /** Which body, when one perceived it (a device id or a body name), else null. */
  body: string | null;
  audience: MemoryAudience;
  presence: MindPresence;
  speaker: MindSpeaker;
  people: readonly string[];
  /** ISO 8601. */
  time: string;
  salienceInputs: SalienceInputs;
  provenance: MindProvenance;
  content: MindContent;
}

export type MindEventDraft = Omit<MindEvent, 'schema' | 'body' | 'people' | 'salienceInputs' | 'content' | 'speaker' | 'provenance'> & {
  body?: string | null;
  people?: readonly string[];
  salienceInputs?: SalienceInputs;
  content?: MindContent;
  speaker?: Partial<MindSpeaker> & { kind: MindSpeakerKind };
  provenance: Omit<MindProvenance, 'episodeIds'> & { episodeIds?: readonly string[] };
};

const has = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value);
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]*$/u;
const isId = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit && ID.test(value);

/** A deep, frozen copy of the audience the surface decided: never recomputed, only copied. */
function copiedAudience(audience: MemoryAudience): MemoryAudience {
  if (audience.kind === 'people') {
    return Object.freeze({ kind: 'people' as const, personIds: Object.freeze([...audience.personIds]), ...(audience.unknownGuest ? { unknownGuest: true } : {}) });
  }
  return Object.freeze({ ...audience });
}

/** Builds an event from a surface's draft, or says what is wrong with it. The audience is copied as the surface decided it. */
export function mindEvent(draft: MindEventDraft): MindEvent | string {
  const event: MindEvent = {
    schema: MIND_EVENT_SCHEMA,
    id: draft.id, kind: draft.kind, surface: draft.surface, body: draft.body ?? null,
    audience: draft.audience, presence: { ...draft.presence },
    speaker: { personId: draft.speaker?.personId ?? null, verified: draft.speaker?.verified ?? false, tier: draft.speaker?.tier ?? null, kind: draft.speaker?.kind ?? 'unknown' },
    people: [...(draft.people ?? [])], time: draft.time, salienceInputs: { ...(draft.salienceInputs ?? {}) },
    provenance: { ...draft.provenance, episodeIds: [...(draft.provenance.episodeIds ?? [])] },
    content: draft.content ?? null,
  };
  return checkedMindEvent(event, { copyAudience: true });
}

const KEYS = ['schema', 'id', 'kind', 'surface', 'body', 'audience', 'presence', 'speaker', 'people', 'time', 'salienceInputs', 'provenance', 'content'];
const SALIENCE_KEYS = ['ownerSpeech', 'addressed', 'touch', 'promiseDeltaMinutes', 'predictionError', 'ownTaskOutcome', 'othersSpeech', 'novelty'];

function checkedSalience(value: unknown): SalienceInputs | string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'salienceInputs must be an object';
  const row = value as Record<string, unknown>;
  const unknown = Object.keys(row).find(key => !SALIENCE_KEYS.includes(key));
  if (unknown) return `salienceInputs.${unknown} is not allowed`;
  for (const key of ['ownerSpeech', 'addressed', 'ownTaskOutcome', 'othersSpeech']) {
    if (row[key] !== undefined && typeof row[key] !== 'boolean') return `salienceInputs.${key} must be a boolean`;
  }
  if (row.touch !== undefined && row.touch !== null && row.touch !== 'press' && row.touch !== 'hover') return 'salienceInputs.touch must be press, hover or null';
  const finite = (key: string) => row[key] === undefined || row[key] === null || (typeof row[key] === 'number' && Number.isFinite(row[key]));
  if (!finite('promiseDeltaMinutes')) return 'salienceInputs.promiseDeltaMinutes must be a number';
  if (!finite('novelty') || (typeof row.novelty === 'number' && (row.novelty < 0 || row.novelty > 1))) return 'salienceInputs.novelty must be in [0, 1]';
  const error = row.predictionError as Record<string, unknown> | null | undefined;
  if (error !== undefined && error !== null && (typeof error !== 'object' || Object.keys(error).some(key => key !== 'delta' && key !== 'sigma')
    || typeof error.delta !== 'number' || typeof error.sigma !== 'number' || !Number.isFinite(error.delta) || !Number.isFinite(error.sigma))) {
    return 'salienceInputs.predictionError must be { delta, sigma }';
  }
  return Object.freeze({ ...(row as SalienceInputs), ...(error ? { predictionError: Object.freeze({ delta: error.delta as number, sigma: error.sigma as number }) } : {}) });
}

/**
 * Checks a whole event (a surface's, or a row read back from `mind_inbox`): closed keys, closed vocabularies, bounded ids and text.
 * Answers a frozen copy, or what is wrong. A restored audience goes through `normalizeAudience`; a surface's is copied as it is.
 */
export function checkedMindEvent(value: unknown, options: { copyAudience?: boolean } = {}): MindEvent | string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'event must be an object';
  const row = value as Record<string, unknown>;
  const unknown = Object.keys(row).find(key => !KEYS.includes(key));
  if (unknown) return `${unknown} is not allowed`;
  const L = MIND_EVENT_LIMITS;
  if (row.schema !== MIND_EVENT_SCHEMA) return `schema must be ${MIND_EVENT_SCHEMA}`;
  if (!isId(row.id, L.id)) return 'id is invalid';
  if (!has(MIND_EVENT_KINDS, row.kind)) return 'kind is invalid';
  if (!has(MIND_SURFACES, row.surface)) return 'surface is invalid';
  if (row.body !== null && !isId(row.body, L.body)) return 'body is invalid';
  if (typeof row.time !== 'string' || Number.isNaN(Date.parse(row.time))) return 'time is invalid';
  const audienceRow = row.audience as Record<string, unknown> | null;
  if (!audienceRow || typeof audienceRow !== 'object' || !['owner', 'people', 'group'].includes(String(audienceRow.kind))) return 'audience is invalid';
  const presence = row.presence as Record<string, unknown> | null;
  if (!presence || typeof presence !== 'object' || Object.keys(presence).sort().join() !== 'othersMayHear,ownerOnlyHears'
    || typeof presence.ownerOnlyHears !== 'boolean' || typeof presence.othersMayHear !== 'boolean') return 'presence must be { ownerOnlyHears, othersMayHear }';
  if (presence.ownerOnlyHears && presence.othersMayHear) return 'presence cannot be the owner alone while others may hear';
  const speaker = row.speaker as Record<string, unknown> | null;
  if (!speaker || typeof speaker !== 'object' || Object.keys(speaker).some(key => !['kind', 'personId', 'verified', 'tier'].includes(key))) return 'speaker is invalid';
  if (!has(MIND_SPEAKER_KINDS, speaker.kind)) return 'speaker.kind is invalid';
  if (speaker.personId !== null && !isId(speaker.personId, L.personId)) return 'speaker.personId is invalid';
  if (typeof speaker.verified !== 'boolean') return 'speaker.verified must be a boolean';
  if (speaker.tier !== null && ![1, 2, 3, 4].includes(speaker.tier as number)) return 'speaker.tier must be 1–4 or null';
  // Tiers 3 and 4 only suggest (owner answer 3): what they named is never a verified speaker.
  if (speaker.verified && (speaker.tier === 3 || speaker.tier === 4)) return 'a speaker named by tier 3 or 4 is not verified';
  if (!Array.isArray(row.people) || row.people.length > L.people || !row.people.every(id => isId(id, L.personId))) return 'people is invalid';
  const salienceInputs = checkedSalience(row.salienceInputs);
  if (typeof salienceInputs === 'string') return salienceInputs;
  const provenance = row.provenance as Record<string, unknown> | null;
  if (!provenance || typeof provenance !== 'object' || Object.keys(provenance).some(key => !['source', 'sourceId', 'trust', 'episodeIds'].includes(key))) return 'provenance is invalid';
  if (!isId(provenance.source, L.source) || !isId(provenance.sourceId, L.sourceId)) return 'provenance.source is invalid';
  if (!has(MIND_TRUST, provenance.trust)) return 'provenance.trust is invalid';
  if (!Array.isArray(provenance.episodeIds) || provenance.episodeIds.length > L.episodeIds || !provenance.episodeIds.every(id => isId(id, L.sourceId))) return 'provenance.episodeIds is invalid';
  const content = row.content as Record<string, unknown> | null;
  if (content !== null) {
    if (typeof content !== 'object' || Object.keys(content).length !== 1) return 'content must be { text } or { ref } or null';
    if ('text' in content ? typeof content.text !== 'string' || content.text.length > L.text : !('ref' in content) || !isId(content.ref, L.ref)) return 'content is invalid';
  }
  return Object.freeze({
    schema: MIND_EVENT_SCHEMA, id: row.id, kind: row.kind, surface: row.surface, body: row.body as string | null,
    audience: options.copyAudience ? copiedAudience(row.audience as MemoryAudience) : normalizeAudience(row.audience),
    presence: Object.freeze({ ownerOnlyHears: presence.ownerOnlyHears, othersMayHear: presence.othersMayHear }),
    speaker: Object.freeze({ kind: speaker.kind, personId: speaker.personId as string | null, verified: speaker.verified, tier: speaker.tier as MindSpeaker['tier'] }),
    people: Object.freeze([...row.people as string[]]), time: row.time, salienceInputs,
    provenance: Object.freeze({ source: provenance.source, sourceId: provenance.sourceId, trust: provenance.trust, episodeIds: Object.freeze([...provenance.episodeIds as string[]]) }),
    content: content === null ? null : Object.freeze({ ...content }) as MindContent,
  });
}

/** The event without its text: what may go into the journal, the inbox or a snapshot (content as a reference or nothing). */
export function withoutText(event: MindEvent): MindEvent {
  if (!event.content || !('text' in event.content)) return event;
  return Object.freeze({ ...event, content: null });
}
