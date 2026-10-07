import { createHash } from 'node:crypto';
import { MEMORY_SENSITIVITY_CATEGORIES, looksSecret, type MemoryDisclosure } from '@shannon/cognition';
import { injectionThreats, neutralizedForFrame } from './injectionGuard.js';

/**
 * The closed-field codec of the memory outbox (Syzygy ADR-0008 stage 3, step F5, `docs/mind-workspace-contract.md`). Every
 * proposal to the one memory writer is one op of a closed kind, and its payload has closed fields: `encode` keeps only the fields
 * a kind names (an unknown field is dropped, never stored), `decode` refuses a stored payload with any field it does not name.
 * Every text is bounded, and is refused when it looks like a credential (`looksSecret`) or carries an injection
 * (`injectionThreats`), the checks the knowledge gate and the skill memory already use. Ids and instants have their own shapes.
 */
export const MEMORY_OP_KINDS = Object.freeze([
  'fact.upsert', 'promise.capture', 'intent.capture', 'turn_capture', 'impression.observe', 'impression.merge',
  'person.fact', 'person.promise', 'person.topic', 'person.summary', 'person.link',
  'knowledge.create', 'knowledge.update', 'knowledge.retire', 'replay_summary.update', 'relationship.upsert', 'interest.change',
] as const);
export type MemoryOpKind = typeof MEMORY_OP_KINDS[number];

/** Who proposed it: a turn's refinement, sleep, her impressions, people memory, a platform, knowledge, the replay summary, the owner. */
export const MEMORY_OP_ORIGINS = Object.freeze([
  'turn', 'sleep', 'impressions', 'people', 'platform', 'knowledge', 'replay_summary', 'owner',
] as const);
export type MemoryOpOrigin = typeof MEMORY_OP_ORIGINS[number];

export const MEMORY_OP_LIMITS = Object.freeze({ payloadCharacters: 64_000, episodes: 32, idCharacters: 200, subjectCharacters: 240 });

/** What the codec refused, as a closed code (the row keeps the code, never the refused text). */
export type MemoryOpRefusal = 'unknown_kind' | 'unknown_origin' | 'malformed' | 'unknown_field' | 'too_long' | 'secret' | 'injection' | 'bad_id' | 'bad_time' | 'owner_only';

/**
 * A key kept in the outbox's header (`opId`, `subjectKey`) with no free text in it (stage 3 review M1): what follows a free-text
 * marker (`interest`, `resonant`: an interest in the owner's words, whatever its script, e.g. `interest:Minecraft`) is always one
 * `h-` and 16 hexadecimal characters of its SHA-256; any other part that is not an id-like token (letters, digits, `_ . @ -`) is
 * hashed the same way. The same text always gives the same key.
 */
const FREE_TEXT_MARKERS: ReadonlySet<string> = new Set(['interest', 'resonant']);
const hashed = (text: string) => `h-${createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
export function closedKey(value: string, maximum: number): string {
  const parts = String(value).split(':');
  const marker = parts.findIndex(part => FREE_TEXT_MARKERS.has(part));
  const closed = [...(marker >= 0 ? parts.slice(0, marker + 1) : parts), ...(marker >= 0 && marker < parts.length - 1 ? [parts.slice(marker + 1).join(':')] : [])]
    .map((part, index) => (marker >= 0 && index === marker + 1 ? hashed(part) : /^[A-Za-z0-9_.@-]{1,120}$/u.test(part) ? part : hashed(part)));
  const key = closed.join(':');
  return key.length <= maximum ? key : `h-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
}

/** The marker on the owner's own words that read like an instruction (review L5): kept, quoted, never refused. */
export const OWNER_WORDS_MARKER = '［ライ氏の言葉］';

/**
 * How a codec call reads its texts (set for the duration of one `encode` or `decode`): the owner's own words (an op of his turn,
 * his sleep batch, his command, or his impression lane) are quoted when they read like an instruction instead of refused; a list of
 * someone else's exchanges drops the one exchange that is refused instead of the whole op.
 */
let reading: { ownerWords: boolean } = { ownerWords: false };

class Refused extends Error {
  constructor(readonly code: MemoryOpRefusal, readonly path: string) { super(code); }
}

type Mode = 'encode' | 'decode';
type Codec = (value: unknown, mode: Mode, path: string) => unknown;

const fail = (code: MemoryOpRefusal, path: string): never => { throw new Refused(code, path); };

/** A bounded text: not secret-shaped, without an injection. */
const text = (maximum: number): Codec => (value, _mode, path) => {
  if (typeof value !== 'string') return fail('malformed', path);
  if ([...value].length > maximum) return fail('too_long', path);
  if (looksSecret(value)) return fail('secret', path);
  if (injectionThreats(value).length) return fail('injection', path);
  return value;
};
/**
 * Words as someone said them (a turn's evidence, a capture, what was said to her). The owner's own (see `reading`) that read like an
 * instruction are kept quoted behind `OWNER_WORDS_MARKER`, their brackets neutralized, instead of refused (review L5); anyone else's
 * are refused as any text is. The secret check holds for everyone.
 */
const said = (maximum: number): Codec => (value, mode, path) => {
  if (typeof value !== 'string') return fail('malformed', path);
  if ([...value].length > maximum) return fail('too_long', path);
  if (looksSecret(value)) return fail('secret', path);
  if (!injectionThreats(value).length) return value;
  if (!reading.ownerWords) return fail('injection', path);
  if (value.startsWith(OWNER_WORDS_MARKER)) return value;
  if (mode === 'decode') return fail('injection', path);
  const quoted = `${OWNER_WORDS_MARKER}${neutralizedForFrame(value)}`;
  return [...quoted].length <= maximum ? quoted : fail('too_long', path);
};
/** A short closed word or key (a day key, a time zone, a tag): no spaces or control characters, nothing secret or like an instruction. */
const word = (maximum: number): Codec => (value, _mode, path) => {
  if (typeof value !== 'string' || !value.length || [...value].length > maximum || /[\s\p{Cc}]/u.test(value)) return fail('malformed', path);
  if (looksSecret(value)) return fail('secret', path);
  if (injectionThreats(value).length) return fail('injection', path);
  return value;
};
const ID_SHAPE = /^[^\s\p{Cc}]{1,200}$/u;
const id: Codec = (value, _mode, path) => (typeof value === 'string' && ID_SHAPE.test(value) && !looksSecret(value) && !injectionThreats(value).length ? value : fail('bad_id', path));
const time: Codec = (value, _mode, path) => (typeof value === 'string' && value.length <= 40 && /^\d{4}-\d{2}-\d{2}T/u.test(value) && Number.isFinite(Date.parse(value))
  ? value : fail('bad_time', path));
const number: Codec = (value, _mode, path) => (typeof value === 'number' && Number.isFinite(value) ? value : fail('malformed', path));
const integer: Codec = (value, _mode, path) => (Number.isSafeInteger(value) ? value : fail('malformed', path));
const boolean: Codec = (value, _mode, path) => (typeof value === 'boolean' ? value : fail('malformed', path));
const oneOf = (values: readonly string[]): Codec => (value, _mode, path) => (typeof value === 'string' && values.includes(value) ? value : fail('malformed', path));
const list = (item: Codec, maximum: number): Codec => (value, mode, path) => {
  if (!Array.isArray(value)) return fail('malformed', path);
  if (value.length > maximum) return fail('too_long', path);
  return value.map((entry, index) => item(entry, mode, `${path}[${index}]`));
};
/** Someone's exchanges: on encode, one refused as secret or like an instruction is dropped and the rest kept (review: codec leaks). */
const exchanges = (item: Codec, maximum: number): Codec => (value, mode, path) => {
  if (!Array.isArray(value)) return fail('malformed', path);
  if (value.length > maximum) return fail('too_long', path);
  return value.flatMap((entry, index) => {
    try { return [item(entry, mode, `${path}[${index}]`)]; } catch (error) {
      if (mode === 'encode' && error instanceof Refused && (error.code === 'injection' || error.code === 'secret')) return [];
      throw error;
    }
  });
};
/** An optional text that, on encode, is left out rather than refusing the op when it is secret or like an instruction. */
const droppable = (codec: Codec): Codec & { optional: true } => Object.assign(((value: unknown, mode: Mode, path: string) => {
  try { return codec(value, mode, path); } catch (error) {
    if (mode === 'encode' && error instanceof Refused && (error.code === 'injection' || error.code === 'secret')) return undefined;
    throw error;
  }
}) as Codec, { optional: true as const });
const optional = (codec: Codec): Codec & { optional: true } => Object.assign(((value: unknown, mode: Mode, path: string) => codec(value, mode, path)) as Codec, { optional: true as const });

/** A closed object: encode keeps only the named fields; decode refuses any other. Absent (undefined) optional fields are left out. */
const record = (fields: Readonly<Record<string, Codec & { optional?: true }>>): Codec => (value, mode, path) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('malformed', path);
  const source = value as Record<string, unknown>;
  if (mode === 'decode') for (const key of Object.keys(source)) if (!(key in fields)) fail('unknown_field', `${path}.${key}`);
  const out: Record<string, unknown> = {};
  for (const [key, codec] of Object.entries(fields)) {
    const entry = source[key];
    if (entry === undefined || (entry === null && codec.optional)) {
      if (!codec.optional) fail('malformed', `${path}.${key}`);
      continue;
    }
    const coded = codec(entry, mode, `${path}.${key}`);
    if (coded !== undefined) out[key] = coded;
  }
  return out;
};
const union = (tag: string, cases: Readonly<Record<string, Codec>>): Codec => (value, mode, path) => {
  const key = value && typeof value === 'object' ? (value as Record<string, unknown>)[tag] : undefined;
  const codec = typeof key === 'string' ? cases[key] : undefined;
  return codec ? codec(value, mode, path) : fail('malformed', path);
};

const audience: Codec = union('kind', {
  owner: record({ kind: oneOf(['owner']) }),
  people: record({ kind: oneOf(['people']), personIds: list(id, 40), unknownGuest: optional(boolean) }),
  group: record({ kind: oneOf(['group']), groupKey: word(240) }),
});
const disclosure: Codec = record({
  audience: optional(audience), sensitivity: optional(oneOf(['sensitive', 'ordinary'])),
  category: optional(oneOf(MEMORY_SENSITIVITY_CATEGORIES)), reason: optional(text(200)),
  decidedBy: optional(oneOf(['rule', 'owner'])), speaker: optional(oneOf(['owner', 'unknown'])),
});
const statementItem = record({
  id, statement: text(400), confidence: number, observedAt: time, evidence: optional(said(600)),
  sourceExperienceId: optional(id), disclosure: optional(disclosure),
});
const prospective = record({
  id, summary: text(400), status: oneOf(['pending', 'completed', 'dismissed']), createdAt: time, updatedAt: time,
  dueHint: optional(text(120)), dueAt: optional(time), dueDate: optional(word(10)), timeZone: optional(word(64)),
  sourceExperienceId: optional(id), evidence: optional(said(600)), remindAfter: optional(time), disclosure: optional(disclosure),
});
const capture = record({
  id, turnId: id, kind: oneOf(['commitment', 'knowledge', 'intent', 'notice']), text: said(160), itemId: optional(text(200)),
  change: optional(oneOf(['created', 'updated', 'confirmed'])), previousText: optional(said(400)), note: optional(text(200)),
  dueDate: optional(word(10)), dueAt: optional(time), dueHint: optional(text(120)), timeZone: optional(word(64)), createdAt: time,
});
const learningSource = oneOf(['conversation', 'sleep']);
const personItem = record({
  id, kind: oneOf(['summary', 'turn', 'fact', 'promise', 'topic']), personId: optional(id), text: text(600),
  evidence: optional(text(600)), disclosure, observedAt: time,
  // People facts (F6): when it became true in the world, and the episodes it came from.
  validAt: optional(time), episodeIds: optional(list(id, MEMORY_OP_LIMITS.episodes)),
});
const personCall = record({
  callId: id, threadId: optional(id), source: optional(word(40)), label: optional(text(200)),
  status: oneOf(['open', 'remembered', 'discarded']), personIds: list(id, 40), createdPersonIds: list(id, 40),
  pendingName: optional(text(80)), startedAt: time, updatedAt: time,
});
const personPayload = record({
  callId: id, mode: oneOf(['replace', 'upsert']), items: exchanges(personItem, 200), call: optional(personCall),
  /** The period's summary: written by code after the items (`text` absent, or left out as unsafe: the deterministic one). */
  summary: optional(record({ label: text(200), audience, at: time, text: droppable(text(800)) })),
});
const knowledgeDraft = record({
  title: text(200), bodyMarkdown: text(12_000), status: oneOf(['hypothesis', 'confirmed']), applicability: text(1_000),
  sourceExperienceIds: list(id, 40),
  aetherReferences: optional(list(record({ documentId: id, version: integer, sectionId: optional(id), decisionId: optional(id) }), 20)),
});
const observation = record({
  id, stance: oneOf(['support', 'contradict']), keyTerms: optional(list(text(80), 8)), feeling: optional(text(200)), feelingTag: optional(text(40)),
});
const candidate = record({ kind: word(40), pattern: text(200), keyTerms: list(text(80), 8), feeling: text(200), feelingTag: text(40) });

const PAYLOADS: Readonly<Record<MemoryOpKind, Codec>> = Object.freeze({
  'fact.upsert': record({ fact: statementItem, source: learningSource }),
  'relationship.upsert': record({ relationship: statementItem, source: learningSource }),
  'interest.change': record({ interest: text(160), source: optional(learningSource) }),
  'promise.capture': record({ memory: prospective }),
  turn_capture: record({ captures: list(capture, 24) }),
  'intent.capture': record({ capture }),
  'impression.observe': record({
    lane: oneOf(['owner', 'platform']), personKey: id, sourceId: id, at: time, said: said(8_000), audience,
    analysis: record({ observations: list(observation, 40), candidates: list(candidate, 8) }),
  }),
  'impression.merge': record({ personKey: id, keepId: id, mergedIds: list(id, 20) }),
  'person.summary': personPayload,
  'person.fact': personPayload,
  'person.promise': personPayload,
  'person.topic': personPayload,
  'person.link': union('action', {
    merge: record({ action: oneOf(['merge']), personId: id, intoPersonId: id }),
    rename: record({ action: oneOf(['rename']), personId: id, displayName: text(80) }),
    // F6: a newly met name, for identity tiers 3 and 4 (they only suggest; the owner merges).
    suggest: record({ action: oneOf(['suggest']), personId: id, name: text(80), link: optional(word(200)) }),
  }),
  'knowledge.create': record({ draft: knowledgeDraft, reason: text(400), at: time }),
  'knowledge.update': record({ knowledgeId: id, expectedVersion: integer, draft: knowledgeDraft, reason: text(400), at: time }),
  'knowledge.retire': record({ knowledgeId: id, reason: text(400), at: time, evidence: list(id, 40) }),
  'replay_summary.update': record({ threadId: id, experienceId: id }),
});

/** One proposal before it is stored. */
export interface MemoryOpDraft {
  /** Unique: a proposal made again (a retried job) is the same op and is stored once. */
  opId: string;
  scopeKey: string;
  kind: MemoryOpKind;
  origin: MemoryOpOrigin;
  /** What the op is about (`fact:<id>`, `person:<id>`, `thread:<id>`); ops on one subject are applied in order. */
  subjectKey: string;
  /** The subject's revision the proposer saw, or null (the writer then takes its own snapshot's). */
  baseRevision?: string | null;
  payload: Record<string, unknown>;
  /** The episodes (turn ids, `person:<item>`) the op came from: a forget of any of them stops it. */
  episodeIds?: readonly string[];
  /** The label of what it writes, as the proposer decided it. */
  disclosure?: MemoryDisclosure | null;
}

export interface EncodedMemoryOp {
  opId: string; scopeKey: string; kind: MemoryOpKind; origin: MemoryOpOrigin; subjectKey: string; baseRevision: string | null;
  payloadJson: string; episodeIdsJson: string; disclosureJson: string | null;
}

export type MemoryOp = Omit<MemoryOpDraft, 'baseRevision' | 'episodeIds' | 'disclosure'> & {
  seq: number; baseRevision: string | null; episodeIds: readonly string[]; disclosure: MemoryDisclosure | null; attempts: number;
};

function checked<T>(operation: () => T, ownerWords = false): { ok: true; value: T } | { ok: false; code: MemoryOpRefusal; path: string } {
  const previous = reading;
  reading = { ownerWords };
  try { return { ok: true, value: operation() }; } catch (error) {
    if (error instanceof Refused) return { ok: false, code: error.code, path: error.path };
    return { ok: false, code: 'malformed', path: '' };
  } finally { reading = previous; }
}

/** Whether an op carries the owner's own words (his turn, his sleep batch, his command, his impression lane). */
function ownerWordsOf(origin: string, payload: unknown): boolean {
  if (origin === 'turn' || origin === 'sleep' || origin === 'owner') return true;
  return origin === 'impressions' && Boolean(payload && typeof payload === 'object' && (payload as { lane?: unknown }).lane === 'owner');
}

/** A rename or a merge is the owner's alone (review, low). */
function ownerOnly(kind: string, origin: string, payload: unknown): void {
  if (kind !== 'person.link' || origin === 'owner') return;
  const action = payload && typeof payload === 'object' ? (payload as { action?: unknown }).action : undefined;
  if (action === 'merge' || action === 'rename') fail('owner_only', 'origin');
}

const header = (draft: Pick<MemoryOpDraft, 'opId' | 'scopeKey' | 'kind' | 'origin' | 'subjectKey'>) => {
  if (!(MEMORY_OP_KINDS as readonly string[]).includes(draft.kind)) fail('unknown_kind', 'kind');
  if (!(MEMORY_OP_ORIGINS as readonly string[]).includes(draft.origin)) fail('unknown_origin', 'origin');
  id(draft.opId, 'encode', 'opId');
  word(120)(draft.scopeKey, 'encode', 'scopeKey');
  if (typeof draft.subjectKey !== 'string' || !draft.subjectKey || [...draft.subjectKey].length > MEMORY_OP_LIMITS.subjectCharacters
    || /[\p{Cc}]/u.test(draft.subjectKey)) fail('malformed', 'subjectKey');
};

export const memoryOpCodec = Object.freeze({
  /** A draft as it is stored, or the refusal. Unknown payload fields are dropped. */
  encode(draft: MemoryOpDraft): { ok: true; value: EncodedMemoryOp } | { ok: false; code: MemoryOpRefusal; path: string } {
    return checked(() => {
      const keys = { opId: closedKey(String(draft.opId), MEMORY_OP_LIMITS.idCharacters), subjectKey: closedKey(String(draft.subjectKey), MEMORY_OP_LIMITS.subjectCharacters) };
      header({ ...draft, ...keys });
      ownerOnly(draft.kind, draft.origin, draft.payload);
      const payload = PAYLOADS[draft.kind](draft.payload, 'encode', 'payload');
      const payloadJson = JSON.stringify(payload);
      if (payloadJson.length > MEMORY_OP_LIMITS.payloadCharacters) fail('too_long', 'payload');
      const episodes = list(id, MEMORY_OP_LIMITS.episodes)([...new Set(draft.episodeIds ?? [])], 'encode', 'episodeIds');
      const label = draft.disclosure ? disclosure(draft.disclosure, 'encode', 'disclosure') : null;
      const base = draft.baseRevision ?? null;
      if (base !== null && (typeof base !== 'string' || base.length > 120)) fail('malformed', 'baseRevision');
      return { opId: keys.opId, scopeKey: draft.scopeKey, kind: draft.kind, origin: draft.origin, subjectKey: keys.subjectKey, baseRevision: base,
        payloadJson, episodeIdsJson: JSON.stringify(episodes), disclosureJson: label ? JSON.stringify(label) : null };
    }, ownerWordsOf(draft.origin, draft.payload));
  },
  /** A stored row read back: every field checked again, an unknown field refused. */
  decode(row: { seq: number; opId: string; scopeKey: string; kind: string; origin: string; subjectKey: string; baseRevision: string | null;
    payloadJson: string; episodeIdsJson: string; disclosureJson: string | null; attempts: number }): { ok: true; value: MemoryOp } | { ok: false; code: MemoryOpRefusal; path: string } {
    return checked(() => {
      header(row as unknown as MemoryOpDraft);
      const parse = (raw: string | null, path: string): unknown => { try { return raw === null ? null : JSON.parse(raw) as unknown; } catch { return fail('malformed', path); } };
      const raw = parse(row.payloadJson, 'payload');
      ownerOnly(row.kind, row.origin, raw);
      reading = { ownerWords: ownerWordsOf(row.origin, raw) };
      const payload = PAYLOADS[row.kind as MemoryOpKind](raw, 'decode', 'payload') as Record<string, unknown>;
      const episodes = list(id, MEMORY_OP_LIMITS.episodes)(parse(row.episodeIdsJson, 'episodeIds'), 'decode', 'episodeIds') as string[];
      const label = row.disclosureJson === null ? null : disclosure(parse(row.disclosureJson, 'disclosure'), 'decode', 'disclosure') as MemoryDisclosure;
      return Object.freeze({ seq: row.seq, opId: row.opId, scopeKey: row.scopeKey, kind: row.kind as MemoryOpKind, origin: row.origin as MemoryOpOrigin,
        subjectKey: row.subjectKey, baseRevision: row.baseRevision, payload, episodeIds: Object.freeze(episodes), disclosure: label, attempts: row.attempts });
    });
  },
});
