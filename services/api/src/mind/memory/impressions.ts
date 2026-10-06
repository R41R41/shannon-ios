import { createHash } from 'node:crypto';
import {
  SHANNON_EMOTION_KINDS, classifySensitivity, peopleAudience,
  type MemoryAudience, type MemoryDisclosure, type ShannonEmotionKind,
} from '@shannon/cognition';
import { serverEnvironment } from '../../infra/config/serverEnvironment.js';

/**
 * Impressions: what Shannon has noticed, over separate turns, about how a person talks to her or
 * behaves in conversation, and how she feels about it (Syzygy ADR-0003: conditional lessons with
 * supporting and contradicting evidence counts). They are data she accumulated, never prompt rules.
 * This file holds the pure rules: validation, recurrence, contradiction, merging and bounds.
 */

export const IMPRESSION_KINDS = ['speech_habit', 'behaviour_toward_her', 'preference', 'trait', 'treats_others'] as const;
export type ImpressionKind = typeof IMPRESSION_KINDS[number];
/** `candidate`: seen, not yet a pattern, never used in a reply. `fading`: weakened by contrary evidence or time. */
export type ImpressionStatus = 'candidate' | 'active' | 'fading' | 'retired';
/** The owner is a person too; everyone else is keyed by their `people` row. */
export const OWNER_PERSON_KEY = 'owner';
/** Recall, provenance and memory-control identifier of an impression. */
export const impressionMemoryId = (id: string) => `impression:${id}`;
export const IMPRESSION_MEMORY_PREFIX = 'impression:';

export interface ImpressionEvidence {
  /** A completed turn's experience id, or `person:<item id>` for a platform conversation period. */
  id: string;
  at: string;
  stance: 'support' | 'contra';
}

export interface PersonImpression {
  id: string;
  personKey: string;
  kind: ImpressionKind;
  /** Short, from her point of view, without the person as subject: 「ボクのことをよく「可愛い」と言う」. */
  pattern: string;
  /** Words the person actually used when the pattern showed; the response path matches on them. */
  keyTerms: readonly string[];
  /** How she feels about the pattern now, in her words. A memory, not an emotion source. */
  herFeeling: string;
  feelingTag: ShannonEmotionKind | '';
  /** Earlier feelings with the count at which they were replaced, newest last. */
  feelingHistory: readonly { feeling: string; tag: string; until: string; supportCount: number }[];
  supportCount: number;
  contraCount: number;
  /** Contradictions since the last support. */
  contraStreak: number;
  /** Distinct local days on which it was supported. */
  supportDays: number;
  lastSupportDay: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastContraAt?: string;
  /** The most recent evidence references, newest last. */
  evidence: readonly ImpressionEvidence[];
  status: ImpressionStatus;
  disclosure: MemoryDisclosure;
  createdAt: string;
  updatedAt: string;
}

/** A remembered person as the impression rules need them. */
export interface ImpressionPerson { id: string; displayName: string; aliases: readonly string[]; forgotten: boolean }

/** What a reply path may read. */
export interface ImpressionSource {
  /** One person's rows, or every row of the scope. `live`: only those a reply may use (active or fading). */
  impressions(scopeKey: string, options?: { personKey?: string; live?: boolean }): readonly PersonImpression[];
  impression(scopeKey: string, id: string): PersonImpression | null;
  /** Whom she holds any impression of. */
  personKeys(scopeKey: string): readonly string[];
  people(scopeKey: string): readonly ImpressionPerson[];
}

export interface ImpressionStore extends ImpressionSource {
  /** One transaction: rows written and rows removed. */
  saveImpressions(scopeKey: string, upserts: readonly PersonImpression[], deleteIds: readonly string[]): void;
  /** Whether a turn (or a platform period) was already looked at for this person. */
  turnProcessed(scopeKey: string, sourceId: string, personKey: string): boolean;
  recordTurn(scopeKey: string, sourceId: string, personKey: string, dayKey: string, at: string): void;
  /** Model calls made for impressions on one local day. */
  modelCallsOn(scopeKey: string, dayKey: string): number;
}

export interface ImpressionConfig {
  /** Lines of the block in a text turn and in a voice turn. */
  promptLines: number;
  voiceLines: number;
  /** Active and fading impressions kept per person, and candidates kept per person. */
  maximumPerPerson: number;
  maximumCandidates: number;
  /** New candidates one turn may add. */
  newPerTurn: number;
  /** A candidate becomes active after support on this many separate days, or in this many separate turns. */
  activateDays: number;
  activateTurns: number;
  /** Evidence references kept per impression. */
  evidence: number;
  /** Existing impressions shown to the background model. */
  updateContext: number;
  /** Background model calls a local day. */
  callsPerDay: number;
  /** Impressions stop once this share of the monthly background budget is spent, so sleep keeps its part. */
  budgetFraction: number;
}

const integer = (value: string | undefined, fallback: number, minimum: number, maximum: number) => {
  const parsed = Number(value?.trim());
  return value?.trim() && Number.isInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
};

/** `SHANNON_IMPRESSIONS=off` (also `false`, `0`, `disabled`): nothing is read into a prompt and nothing is updated. */
export function impressionsEnabled(environment: Readonly<Record<string, string | undefined>> = serverEnvironment()): boolean {
  return !['off', 'false', '0', 'disabled'].includes(environment.SHANNON_IMPRESSIONS?.trim().toLowerCase() ?? '');
}

export function impressionConfig(environment: Readonly<Record<string, string | undefined>> = serverEnvironment()): ImpressionConfig {
  const fraction = Number(environment.SHANNON_IMPRESSIONS_BUDGET_FRACTION?.trim());
  return Object.freeze({
    promptLines: integer(environment.SHANNON_IMPRESSIONS_PROMPT_LINES, 4, 1, 8),
    voiceLines: integer(environment.SHANNON_IMPRESSIONS_VOICE_LINES, 2, 1, 4),
    maximumPerPerson: integer(environment.SHANNON_IMPRESSIONS_MAX_PER_PERSON, 24, 1, 60),
    maximumCandidates: integer(environment.SHANNON_IMPRESSIONS_MAX_CANDIDATES, 12, 1, 30),
    newPerTurn: integer(environment.SHANNON_IMPRESSIONS_MAX_NEW_PER_TURN, 2, 0, 2),
    activateDays: integer(environment.SHANNON_IMPRESSIONS_ACTIVATE_DAYS, 2, 1, 7),
    activateTurns: integer(environment.SHANNON_IMPRESSIONS_ACTIVATE_TURNS, 3, 2, 20),
    evidence: integer(environment.SHANNON_IMPRESSIONS_EVIDENCE, 16, 4, 40),
    updateContext: integer(environment.SHANNON_IMPRESSIONS_UPDATE_CONTEXT, 12, 1, 24),
    callsPerDay: integer(environment.SHANNON_IMPRESSIONS_MAX_CALLS_PER_DAY, 20, 0, 500),
    budgetFraction: environment.SHANNON_IMPRESSIONS_BUDGET_FRACTION?.trim() && Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0.8,
  });
}

export const PATTERN_CHARACTERS = 60;
export const FEELING_CHARACTERS = 60;
const MAXIMUM_KEY_TERMS = 6;
const CANDIDATE_DAYS = 30;
const STALE_DAYS = 120;
const FADE_STREAK = 2;
const RETIRE_STREAK = 3;
const KEPT_RETIRED = 20;
const KEPT_PROTECTED = 40;
const DAY = 86_400_000;

/** Text as it is compared: width, case, spaces and punctuation folded away. */
export const comparable = (text: string) => text.normalize('NFKC').toLocaleLowerCase('ja-JP').replace(/[\s\p{P}\p{S}]/gu, '');
const clip = (text: string, limit: number) => Array.from(text.replace(/\s+/gu, ' ').trim()).slice(0, limit).join('');

/** What the background model returned for one turn, already keyed by impression id. */
export interface ImpressionAnalysis {
  observations: readonly { id: string; stance: 'support' | 'contradict'; keyTerms?: readonly string[]; feeling?: string; feelingTag?: string }[];
  candidates: readonly { kind: string; pattern: string; keyTerms: readonly string[]; feeling: string; feelingTag: string }[];
}

export interface ObservationContext {
  personKey: string;
  /** The turn or period the analysis is about. It is counted once per impression. */
  sourceId: string;
  at: string;
  dayKey: string;
  /** The person's own words in that turn: key terms must be found in them. */
  said: string;
  /** Who was there. For another person a later, different audience narrows the impression to that person alone. */
  audience: MemoryAudience;
  /** Impressions the owner asked her to forget: left alone, and nothing like them is learned again. */
  forgottenIds: ReadonlySet<string>;
  /** Impressions the owner corrected, marked or pinned: never merged away, so his decision keeps its row. */
  protectedIds?: ReadonlySet<string>;
  config: ImpressionConfig;
}

/** A diagnosis or a judgment of character is not an impression of behaviour. */
const DIAGNOSIS = /障害|症候群|病気|病んで|うつ病|うつ状態|鬱|メンヘラ|依存症|ADHD|ASD|アスペ|人格|診断|サイコパス|ナルシスト/iu;
/** Whatever else is personal is kept and marked like other owner-private memory; these are never kept. */
const REFUSED_CATEGORIES = new Set(['secret', 'contact']);
/** The sensitivity rule reports one category only; contact details are looked for on their own. */
const CONTACT = /住所|番地|郵便番号|電話番号|メールアドレス|メアド|パスワード|暗証番号|マイナンバー|[\w.+-]+@[\w-]+\.[\w.]+|0\d{1,4}-?\d{1,4}-?\d{3,4}/iu;

function heardTerms(values: readonly string[] | undefined, said: string): string[] {
  const heard = comparable(said);
  return [...new Set((values ?? []).map(value => clip(String(value), 16)).filter(term => {
    const key = comparable(term);
    // A short hiragana word (うん, そう) is in nearly every message and signals nothing.
    return key.length >= 2 && !(key.length < 3 && /^[ぁ-ん]+$/u.test(key)) && heard.includes(key);
  }))].slice(0, 4);
}

const feelingTag = (value: string | undefined): ShannonEmotionKind | '' =>
  (SHANNON_EMOTION_KINDS as readonly string[]).includes(value ?? '') ? value as ShannonEmotionKind : '';

/** An impression may not be a diagnosis, a secret, or contact details. */
export function acceptableImpressionText(pattern: string, feeling: string): boolean {
  const text = `${pattern}\n${feeling}`;
  const decision = classifySensitivity(text);
  return !DIAGNOSIS.test(text) && !CONTACT.test(text.normalize('NFKC')) && !(decision.category && REFUSED_CATEGORIES.has(decision.category));
}

function bigrams(text: string): Set<string> {
  const value = comparable(text);
  const grams = new Set<string>();
  for (let index = 0; index < value.length - 1; index += 1) grams.add(value.slice(index, index + 2));
  return grams;
}

/** Near-duplicates: most of their wording is shared, or they are of one kind and signalled by the same words. */
export function similarImpressions(
  left: Pick<PersonImpression, 'kind' | 'pattern' | 'keyTerms'>, right: Pick<PersonImpression, 'kind' | 'pattern' | 'keyTerms'>,
): boolean {
  const a = bigrams(left.pattern);
  const b = bigrams(right.pattern);
  const shared = [...a].filter(gram => b.has(gram)).length;
  if (a.size && b.size && (2 * shared) / (a.size + b.size) >= 0.6) return true;
  if (left.kind !== right.kind || !left.keyTerms.length || !right.keyTerms.length) return false;
  const other = new Set(right.keyTerms.map(comparable));
  const common = left.keyTerms.map(comparable).filter(term => other.has(term)).length;
  return common / new Set([...left.keyTerms.map(comparable), ...other]).size >= 0.5 && shared >= 2;
}

/** 0..1 from the counts for and against and how long ago it was last seen. */
export function impressionConfidence(row: Pick<PersonImpression, 'supportCount' | 'contraCount' | 'lastSeenAt'>, now: string): number {
  const base = row.supportCount / (row.supportCount + 2 * row.contraCount + 1);
  const days = Math.max(0, (Date.parse(now) - Date.parse(row.lastSeenAt)) / DAY);
  return Math.round(base * (0.5 + 0.5 * 0.5 ** (days / 45)) * 100) / 100;
}

/**
 * Recurrence makes a pattern: support on two separate days, or in three separate turns. One sighting is an
 * event; two days rule out a single conversation's running joke; three turns in one day is already a habit
 * she may notice that same evening. Two contradictions in a row weaken it, three retire it.
 */
function settled(row: PersonImpression, context: Pick<ObservationContext, 'at' | 'config'>): PersonImpression {
  if (row.status === 'retired') return row;
  const stale = Date.parse(context.at) - Date.parse(row.lastSeenAt) > STALE_DAYS * DAY;
  const recurring = (row.supportCount >= 2 && row.supportDays >= context.config.activateDays) || row.supportCount >= context.config.activateTurns;
  const status: ImpressionStatus = row.contraStreak >= RETIRE_STREAK || (row.contraCount >= RETIRE_STREAK && row.contraCount > row.supportCount) ? 'retired'
    : row.status === 'candidate' && !recurring ? 'candidate'
      : row.contraStreak >= FADE_STREAK || stale ? 'fading' : 'active';
  return status === row.status ? row : { ...row, status };
}

function evidenced(row: PersonImpression, context: ObservationContext, stance: ImpressionEvidence['stance']): readonly ImpressionEvidence[] {
  return [...row.evidence, { id: context.sourceId, at: context.at, stance }].slice(-context.config.evidence);
}

function supported(
  row: PersonImpression, context: ObservationContext,
  observed: { keyTerms?: readonly string[]; feeling?: string; feelingTag?: string } = {},
): PersonImpression {
  const feeling = clip(observed.feeling ?? '', FEELING_CHARACTERS);
  const revised = Boolean(feeling) && feeling !== row.herFeeling && acceptableImpressionText(row.pattern, feeling);
  const sameAudience = JSON.stringify(row.disclosure.audience) === JSON.stringify(context.audience);
  return settled({
    ...row,
    supportCount: row.supportCount + 1,
    contraStreak: 0,
    supportDays: row.supportDays + (row.lastSupportDay === context.dayKey ? 0 : 1),
    lastSupportDay: context.dayKey,
    lastSeenAt: context.at,
    evidence: evidenced(row, context, 'support'),
    keyTerms: [...new Set([...row.keyTerms, ...heardTerms(observed.keyTerms, context.said)])].slice(0, MAXIMUM_KEY_TERMS),
    // Her feeling about a pattern may shift as it repeats; the earlier one is kept with the count it held until.
    ...(revised ? {
      herFeeling: feeling, feelingTag: feelingTag(observed.feelingTag) || row.feelingTag,
      feelingHistory: [...row.feelingHistory, ...(row.herFeeling ? [{ feeling: row.herFeeling, tag: row.feelingTag, until: context.at, supportCount: row.supportCount }] : [])].slice(-4),
    } : {}),
    // Seen in a second place: only the person themself has seen all of it.
    ...(row.personKey !== OWNER_PERSON_KEY && !sameAudience
      ? { disclosure: { ...row.disclosure, audience: peopleAudience([row.personKey]) } } : {}),
    updatedAt: context.at,
  }, context);
}

/** Null: a candidate that was contradicted before it recurred is dropped. */
function contradicted(row: PersonImpression, context: ObservationContext): PersonImpression | null {
  const next = { ...row, contraCount: row.contraCount + 1, contraStreak: row.contraStreak + 1, lastContraAt: context.at,
    evidence: evidenced(row, context, 'contra'), updatedAt: context.at };
  if (row.status === 'candidate') return next.contraCount >= next.supportCount ? null : next;
  return settled(next, context);
}

function merged(base: PersonImpression, other: PersonImpression, context: ObservationContext): PersonImpression {
  const own = new Set(base.evidence.map(item => `${item.id}\u0000${item.stance}`));
  const shared = (item: ImpressionEvidence) => own.has(`${item.id}\u0000${item.stance}`);
  const extra = other.evidence.filter(item => !shared(item));
  // A turn both parts counted is counted once.
  const twice = (stance: ImpressionEvidence['stance']) => other.evidence.filter(item => item.stance === stance && shared(item)).length;
  const newer = other.updatedAt > base.updatedAt ? other : base;
  return settled({
    ...base,
    keyTerms: [...new Set([...base.keyTerms, ...other.keyTerms])].slice(0, MAXIMUM_KEY_TERMS),
    herFeeling: newer.herFeeling || base.herFeeling || other.herFeeling,
    feelingTag: newer.feelingTag || base.feelingTag || other.feelingTag,
    supportCount: base.supportCount + Math.max(0, other.supportCount - twice('support')),
    contraCount: base.contraCount + Math.max(0, other.contraCount - twice('contra')),
    contraStreak: Math.min(base.contraStreak, other.contraStreak),
    supportDays: Math.max(base.supportDays, other.supportDays, new Set([...base.evidence, ...extra].filter(item => item.stance === 'support').map(item => item.at.slice(0, 10))).size),
    lastSupportDay: base.lastSeenAt >= other.lastSeenAt ? base.lastSupportDay : other.lastSupportDay,
    firstSeenAt: base.firstSeenAt <= other.firstSeenAt ? base.firstSeenAt : other.firstSeenAt,
    lastSeenAt: base.lastSeenAt >= other.lastSeenAt ? base.lastSeenAt : other.lastSeenAt,
    evidence: [...base.evidence, ...extra].sort((left, right) => left.at.localeCompare(right.at)).slice(-context.config.evidence),
    status: base.status === 'candidate' && other.status !== 'candidate' ? other.status : base.status,
    // The narrower audience wins: a merged impression is never shown more widely than either part.
    disclosure: JSON.stringify(base.disclosure.audience) === JSON.stringify(other.disclosure.audience) || base.personKey === OWNER_PERSON_KEY
      ? base.disclosure : { ...base.disclosure, audience: peopleAudience([base.personKey]) },
    updatedAt: context.at,
  }, context);
}

export interface ImpressionChange { upserts: readonly PersonImpression[]; deleteIds: readonly string[] }

/**
 * Applies one turn's analysis to one person's impressions: counts support and contradiction once per
 * turn, lets her feeling shift, adds candidates that are not near-duplicates, merges duplicates, and
 * keeps the store bounded. Pure: the caller reads and writes.
 */
export function applyImpressionAnalysis(
  existing: readonly PersonImpression[], analysis: ImpressionAnalysis, context: ObservationContext,
  label: (pattern: string, feeling: string) => MemoryDisclosure,
): ImpressionChange {
  const rows = new Map(existing.filter(row => row.personKey === context.personKey).map(row => [row.id, row]));
  const before = new Map(rows);
  const deleted = new Set<string>();
  const counted = new Set<string>();
  const untouchable = (row: PersonImpression) => context.forgottenIds.has(row.id) || row.status === 'retired';
  const seenHere = (row: PersonImpression) => counted.has(row.id) || row.evidence.some(item => item.id === context.sourceId);

  for (const observation of analysis.observations.slice(0, 40)) {
    const row = rows.get(observation.id);
    if (!row || untouchable(row) || seenHere(row)) continue;
    counted.add(row.id);
    const next = observation.stance === 'support' ? supported(row, context, observation) : contradicted(row, context);
    if (next) rows.set(row.id, next); else { rows.delete(row.id); deleted.add(row.id); }
  }

  let created = 0;
  for (const proposal of analysis.candidates) {
    if (created >= context.config.newPerTurn) break;
    const pattern = clip(String(proposal.pattern ?? ''), PATTERN_CHARACTERS);
    const feeling = clip(String(proposal.feeling ?? ''), FEELING_CHARACTERS);
    const kind = (IMPRESSION_KINDS as readonly string[]).includes(proposal.kind) ? proposal.kind as ImpressionKind : null;
    if (!kind || Array.from(pattern).length < 4 || !acceptableImpressionText(pattern, feeling)) continue;
    const candidate = { kind, pattern, keyTerms: heardTerms(proposal.keyTerms, context.said) };
    const like = [...rows.values()].filter(row => similarImpressions(row, candidate));
    // She was asked to forget this view of the person: it is not learned again.
    if (like.some(row => context.forgottenIds.has(row.id))) continue;
    const twin = like.find(row => !untouchable(row));
    if (twin) {
      if (!seenHere(twin)) { counted.add(twin.id); rows.set(twin.id, supported(twin, context, { keyTerms: candidate.keyTerms })); }
      continue;
    }
    const id = `imp-${createHash('sha256').update(`${context.personKey}\u0000${context.sourceId}\u0000${created}\u0000${pattern}`).digest('hex').slice(0, 32)}`;
    if (rows.has(id) || deleted.has(id)) continue;
    rows.set(id, {
      id, personKey: context.personKey, kind, pattern, keyTerms: candidate.keyTerms, herFeeling: feeling, feelingTag: feelingTag(proposal.feelingTag),
      feelingHistory: [], supportCount: 1, contraCount: 0, contraStreak: 0, supportDays: 1, lastSupportDay: context.dayKey,
      firstSeenAt: context.at, lastSeenAt: context.at, evidence: [{ id: context.sourceId, at: context.at, stance: 'support' }],
      status: 'candidate', disclosure: label(pattern, feeling), createdAt: context.at, updatedAt: context.at,
    });
    counted.add(id);
    created += 1;
  }

  // Duplicates that already exist side by side (after a correction, or after two people were merged into one).
  const mergeable = (row: PersonImpression) => !context.protectedIds?.has(row.id);
  const live = () => [...rows.values()].filter(row => !untouchable(row)).sort((left, right) => right.supportCount - left.supportCount || left.id.localeCompare(right.id));
  for (let changed = true; changed;) {
    changed = false;
    const list = live().filter(mergeable);
    outer: for (const base of list) for (const other of list) {
      if (base === other || !similarImpressions(base, other)) continue;
      rows.set(base.id, merged(base, other, context));
      rows.delete(other.id); deleted.add(other.id);
      changed = true;
      break outer;
    }
  }

  // Bounds. A candidate that did not recur within a month goes; the weakest go first beyond each cap.
  const drop = (row: PersonImpression) => { rows.delete(row.id); deleted.add(row.id); };
  const recent = (left: PersonImpression, right: PersonImpression) => right.lastSeenAt.localeCompare(left.lastSeenAt);
  const candidates = live().filter(row => row.status === 'candidate').sort(recent);
  candidates.filter((row, index) => index >= context.config.maximumCandidates
    || Date.parse(context.at) - Date.parse(row.lastSeenAt) > CANDIDATE_DAYS * DAY).forEach(drop);
  for (const row of live()) rows.set(row.id, settled(row, context));
  live().filter(row => row.status !== 'candidate')
    .sort((left, right) => impressionConfidence(right, context.at) - impressionConfidence(left, context.at) || recent(left, right))
    .slice(context.config.maximumPerPerson).forEach(row => rows.set(row.id, { ...row, status: 'retired', updatedAt: context.at }));
  [...rows.values()].filter(row => row.status === 'retired' && !context.forgottenIds.has(row.id))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(KEPT_RETIRED).forEach(drop);
  [...rows.values()].filter(row => context.forgottenIds.has(row.id))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(KEPT_PROTECTED).forEach(drop);

  return {
    upserts: [...rows.values()].filter(row => before.get(row.id) !== row),
    deleteIds: [...deleted].filter(id => before.has(id)),
  };
}
