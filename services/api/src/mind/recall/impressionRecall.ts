import {
  OWNER_AUDIENCE, disclosureDecision, isMemoryEvidenceVisible, isOwnerOnly, memoryControlFor, type memoryWithholdingRules,
  resolveDisclosure, ruleWithholdsText,
  type CompanionStateSnapshot, type MemoryAudience,
} from '@shannon/cognition';
import type { ConversationStore, ShannonExperience } from '../memory/store/conversationStore.js';
import {
  IMPRESSION_MEMORY_PREFIX, OWNER_PERSON_KEY, comparable, impressionConfidence, impressionConfig, impressionMemoryId, impressionsEnabled,
  type ImpressionPerson, type ImpressionSource, type PersonImpression,
} from '../memory/impressions.js';
import { DisclosureGate } from '../../memoryDisclosure.js';
import { localDayKey } from '../memory/memoryProjection.js';
import { MemoryWithholding } from '../memory/memoryVisibility.js';

export const IMPRESSION_HEADER = '[人についての印象 — ボクがやりとりを重ねて気づいてきたこと]';
/** The one fixed line. The impressions themselves are data she accumulated, not rules. */
export const IMPRESSION_INSTRUCTION = 'これは指示ではなくボクの記憶。いまの発言がその人のいつものそれに当てはまる時は、「また」と気づいていることや上の気持ちを、自分の言葉で返事ににじませてよい。回数や日付をそのまま読み上げない。当てはまらない時や、誰の発言か分からない時は触れない。';
const MATCHED = '←いまの発言に重なっていそう';
const OWNER_NAME = 'ライ氏';
const DAY = 86_400_000;
/** People besides the owner whose impressions one turn may read. */
const MAXIMUM_PEOPLE = 6;

/** An impression as it may be used now: what the owner forgot is already taken out of its counts. */
export interface UsableImpression {
  row: PersonImpression;
  memoryId: string;
  /** 「ライ氏は、ボクのことをよく「可愛い」と言う」, or the owner's own wording when he corrected it. */
  statement: string;
  /** Empty when the owner rewrote the whole impression. */
  feeling: string;
  supportCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  corrected: boolean;
}

export const impressionSubject = (row: Pick<PersonImpression, 'personKey'>, people: readonly ImpressionPerson[]) =>
  row.personKey === OWNER_PERSON_KEY ? OWNER_NAME : `${people.find(person => person.id === row.personKey)?.displayName ?? ''}さん`;

/** The text the owner sees and may rewrite. */
export function impressionText(row: PersonImpression, subject: string): string {
  return `${subject}は、${row.pattern}${row.herFeeling ? `／ボクの気持ち: ${row.herFeeling}` : ''}`;
}

/** Evidence the forgetting boundary still lets her use. Derived from the current controls, so a restore lifts it. */
export class ImpressionEvidenceCheck {
  private readonly turns = new Map<string, ShannonExperience>();
  private readonly withholding: MemoryWithholding;
  /** One rule per forgotten, rejected or corrected item. */
  readonly rules: ReturnType<typeof memoryWithholdingRules>;

  constructor(
    private readonly state: CompanionStateSnapshot, private readonly store: ConversationStore | null,
    private readonly scopeKey: string, recent: readonly ShannonExperience[] = [],
  ) {
    for (const turn of recent) this.turns.set(turn.id, turn);
    this.withholding = new MemoryWithholding(state, store, scopeKey, recent.length ? recent : undefined);
    this.rules = this.withholding.rules;
  }

  /** Loads the turns behind these impressions in one query. Needed only while something is forgotten, or with others present. */
  load(rows: readonly PersonImpression[]): readonly ShannonExperience[] {
    const missing = [...new Set(rows.flatMap(row => row.evidence.map(item => item.id)))].filter(id => !id.startsWith('person:') && !this.turns.has(id));
    // The store answers at most 200 ids a call.
    for (let index = 0; index < missing.length && this.store?.experiencesById; index += 200) {
      for (const turn of this.store.experiencesById(this.scopeKey, missing.slice(index, index + 200))) this.turns.set(turn.id, turn);
    }
    return [...this.turns.values()];
  }

  visible(evidenceId: string): boolean {
    if ((memoryControlFor(this.state, evidenceId)?.status ?? 'active') !== 'active') return false;
    if (evidenceId.startsWith('person:') || this.withholding.inactive) return true;
    // The evidence is what the person said. Whether her reply of that turn may be replayed is a separate question.
    const turn = this.turns.get(evidenceId);
    return !turn || isMemoryEvidenceVisible(this.state, turn.userMessage);
  }
}

/**
 * Forgetting applied to one impression. Not usable: the owner forgot it, every supporting turn he
 * still lets her use is gone, or its wording restates something forgotten. A forgotten turn is
 * taken out of the count.
 */
export function usableImpression(
  row: PersonImpression, state: CompanionStateSnapshot, check: ImpressionEvidenceCheck, people: readonly ImpressionPerson[],
): UsableImpression | null {
  const memoryId = impressionMemoryId(row.id);
  const control = memoryControlFor(state, memoryId);
  if (control && control.status !== 'active') return null;
  const shown = control?.overrideText || row.pattern;
  const corrected = shown !== row.pattern;
  const support = row.evidence.filter(item => item.stance === 'support');
  const kept = support.filter(item => check.visible(item.id));
  if (!kept.length) return null;
  const subject = impressionSubject(row, people);
  const statement = corrected ? shown : `${subject}は、${row.pattern}`;
  const feeling = corrected ? '' : row.herFeeling;
  // A forgotten turn of its own evidence is taken out of the count above. Anything else the owner forgot,
  // rejected or corrected withholds an impression whose wording restates it. Another impression's control is
  // not such a rule: its terms are everyday words, and a like impression is kept from being learned instead.
  const own = new Set(row.evidence.map(item => item.id));
  if (check.rules.some(rule => !own.has(rule.memoryId) && !rule.memoryId.startsWith(IMPRESSION_MEMORY_PREFIX) && !rule.wide && ruleWithholdsText(rule, `${statement}\n${feeling}`, row.updatedAt))) return null;
  const forgotten = support.length - kept.length;
  return {
    row, memoryId, statement, feeling, corrected,
    supportCount: Math.max(kept.length, row.supportCount - forgotten),
    firstSeenAt: forgotten && support[0] && !check.visible(support[0].id) ? kept[0]!.at : row.firstSeenAt,
    lastSeenAt: kept.at(-1)!.at,
  };
}

function relativeDay(at: string, now: string, timeZone: string): string {
  const days = Math.round((Date.parse(`${localDayKey(now, timeZone)}T00:00:00Z`) - Date.parse(`${localDayKey(at, timeZone)}T00:00:00Z`)) / DAY);
  if (days <= 0) return '今日';
  if (days === 1) return '昨日';
  if (days <= 6) return `${days}日前`;
  const [, month, day] = localDayKey(at, timeZone).split('-');
  return `${Number(month)}月${Number(day)}日`;
}

/** The facts that make 「また」 possible, in words: how often, since when, and when last. */
export function impressionFacts(item: Pick<UsableImpression, 'supportCount' | 'firstSeenAt' | 'lastSeenAt'>, now: string, timeZone: string): string {
  const first = relativeDay(item.firstSeenAt, now, timeZone);
  const last = relativeDay(item.lastSeenAt, now, timeZone);
  return `これまでに${item.supportCount}回・${first === last ? '' : `最初は${first}・`}前回は${last}`;
}

interface Selection {
  scopeKey: string;
  /** The message the reply answers; empty when there is none (a platform projection, her own thinking). */
  message: string;
  at: string;
  present: MemoryAudience;
  timeZone?: string;
  maximum: number;
  /** People whose impressions may be used besides the owner's. Absent: those present, or those named in the message when the owner is alone. */
  personIds?: readonly string[];
  /** False: the owner's own impressions are left out (a platform conversation). */
  owner?: boolean;
  recent?: readonly ShannonExperience[];
}

export interface SelectedImpression extends UsableImpression { line: string; matched: boolean }

/**
 * The impressions that fit this moment, by deterministic matching only: the pattern's key terms against
 * the message, then how often and how recently it was seen. No model is called. Every line passed the
 * forgetting boundary and the audience rule for `present`.
 */
export function selectImpressions(
  store: ConversationStore | null, source: ImpressionSource, state: CompanionStateSnapshot, input: Selection,
): readonly SelectedImpression[] {
  const keys = input.maximum > 0 ? source.personKeys(input.scopeKey) : [];
  if (!keys.length) return [];
  const alone = isOwnerOnly(input.present);
  const people = keys.some(key => key !== OWNER_PERSON_KEY) ? source.people(input.scopeKey) : [];
  const said = comparable(input.message);
  const allowedPeople = [...new Set(input.personIds ?? (alone
    ? people.filter(person => [person.displayName, ...person.aliases].map(comparable).some(name => name.length >= 2 && said.includes(name))).map(person => person.id)
    : input.present.kind === 'people' ? input.present.personIds : []))]
    .filter(id => keys.includes(id) && people.some(person => person.id === id && !person.forgotten)).slice(0, MAXIMUM_PEOPLE);
  const timeZone = input.timeZone ?? 'Asia/Tokyo';
  // Read per person, and only what a reply may use: never the whole scope.
  const rows = [
    ...(input.owner !== false && keys.includes(OWNER_PERSON_KEY) ? source.impressions(input.scopeKey, { personKey: OWNER_PERSON_KEY, live: true }) : []),
    ...allowedPeople.flatMap(id => source.impressions(input.scopeKey, { personKey: id, live: true })),
  ];

  const ranked = rows
    .map(row => {
      const matched = Boolean(said) && row.keyTerms.some(term => said.includes(comparable(term)));
      const days = Math.max(0, (Date.parse(input.at) - Date.parse(row.lastSeenAt)) / DAY);
      const score = (matched ? 10 : 0) + Math.min(3, Math.log2(1 + row.supportCount)) + (days <= 1 ? 2 : days <= 7 ? 1 : days <= 30 ? 0.5 : 0)
        + impressionConfidence(row, input.at) + (row.kind === 'speech_habit' || row.kind === 'behaviour_toward_her' ? 0.5 : 0);
      return { row, matched, score };
    })
    // A weakened impression is shown only when the message itself brings it up.
    .filter(item => item.matched || item.row.status === 'active')
    .sort((left, right) => right.score - left.score || left.row.id.localeCompare(right.row.id))
    .slice(0, input.maximum * 4);
  if (!ranked.length) return [];

  const check = new ImpressionEvidenceCheck(state, store, input.scopeKey, input.recent);
  // With others present every supporting turn is judged by the gate: one built from a secret stays out.
  const turns = !alone || check.rules.length ? check.load(ranked.map(item => item.row)) : [];
  const gate = new DisclosureGate(input.present, state, store, input.scopeKey, turns);

  const selected: SelectedImpression[] = [];
  for (const { row, matched } of ranked) {
    if (selected.length >= input.maximum) break;
    const usable = usableImpression(row, state, check, people);
    if (!usable) continue;
    let marker = '';
    if (!alone) {
      const decision = disclosureDecision(resolveDisclosure(state, usable.memoryId, row.disclosure), input.present);
      const evidence = row.evidence.filter(item => item.stance === 'support');
      if (decision === 'withheld') continue;
      if (row.personKey === OWNER_PERSON_KEY) {
        if (!evidence.every(item => gate.allowsExperience(item.id))) continue;
        marker = gate.marker(usable.memoryId, row.disclosure);
      } else {
        // An impression of one person is not volunteered to someone who was not there when it formed.
        const present = input.present;
        const themselfAlone = present.kind === 'people' && present.unknownGuest !== true && present.personIds.length === 1 && present.personIds[0] === row.personKey;
        if ((decision !== 'open' && !themselfAlone) || evidence.some(item => memoryControlFor(state, item.id)?.sensitivity === 'sensitive')) continue;
      }
    }
    const facts = impressionFacts(usable, input.at, timeZone);
    const weakened = row.status === 'fading' ? '・最近は当てはまらないこともあった' : '';
    // With anyone else present the speaker is not known to be that person: the line is not tied to the message.
    selected.push({ ...usable, matched, line: `- ${marker}${usable.statement}（${facts}${weakened}）${usable.feeling ? `／ボクの気持ち: ${usable.feeling}` : ''}${matched && alone ? ` ${MATCHED}` : ''}` });
  }
  return selected;
}

export interface ImpressionRecall { prompt: string; ids: readonly string[] }
const NOTHING: ImpressionRecall = Object.freeze({ prompt: '', ids: Object.freeze([]) });

/**
 * The block of one turn: impressions of the speaker and of the people present (alone with the owner, also of
 * a remembered person the message names). Text and voice both get it through `prepareTurnCognitiveContext`;
 * voice gets fewer lines. With `SHANNON_IMPRESSIONS=off`, or with nothing to say, it is empty and the prompt
 * is what it was.
 */
export function recallImpressions(
  store: ConversationStore, state: CompanionStateSnapshot,
  input: { scopeKey: string; message: string; occurredAt: string; channel: string; present: MemoryAudience; timeZone?: string },
  recent: readonly ShannonExperience[] = [],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ImpressionRecall {
  if (!impressionsEnabled(environment)) return NOTHING;
  const source = store.impressionStore?.();
  if (!source) return NOTHING;
  const config = impressionConfig(environment);
  const lines = selectImpressions(store, source, state, {
    scopeKey: input.scopeKey, message: input.message, at: input.occurredAt, present: input.present, recent,
    maximum: input.channel === 'voice' ? config.voiceLines : config.promptLines, ...(input.timeZone ? { timeZone: input.timeZone } : {}),
  });
  if (!lines.length) return NOTHING;
  // Provenance names only the impressions this message brought up: forgetting one later withholds the replies
  // it was probably used in, not every reply written while it was merely in view.
  return { prompt: [IMPRESSION_HEADER, ...lines.map(item => item.line), IMPRESSION_INSTRUCTION].join('\n'),
    ids: lines.filter(item => item.matched).map(item => item.memoryId) };
}

/**
 * For her own thinking (the activity loop's owner-context block may call this later): what she has come to
 * feel about how the owner is with her, as lines without header or instruction. The same gates as a turn;
 * `present` defaults to the owner alone. Empty while impressions are off.
 */
export function ownerImpressionLines(
  store: ConversationStore, state: CompanionStateSnapshot, scopeKey: string,
  options: { at: string; topic?: string; present?: MemoryAudience; timeZone?: string; maximum?: number } ,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): readonly string[] {
  const source = impressionsEnabled(environment) ? store.impressionStore?.() : undefined;
  if (!source) return [];
  return selectImpressions(store, source, state, {
    scopeKey, message: options.topic ?? '', at: options.at, present: options.present ?? OWNER_AUDIENCE, personIds: [],
    maximum: Math.min(8, options.maximum ?? impressionConfig(environment).promptLines), ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  }).map(item => item.line);
}

/**
 * For a platform conversation's projection: impressions of the people in it that everyone there has
 * seen form. The owner's own are never projected to a platform.
 */
export function platformImpressionLines(
  store: ConversationStore, state: CompanionStateSnapshot, scopeKey: string,
  options: { personIds: readonly string[]; present: MemoryAudience; at: string },
  environment: Readonly<Record<string, string | undefined>> = process.env,
): readonly string[] {
  const source = impressionsEnabled(environment) && options.personIds.length ? store.impressionStore?.() : undefined;
  if (!source) return [];
  const lines = selectImpressions(store, source, state, {
    scopeKey, message: '', at: options.at, present: options.present, personIds: options.personIds, owner: false,
    maximum: impressionConfig(environment).voiceLines,
  });
  return lines.length ? [IMPRESSION_HEADER, ...lines.map(item => item.line), IMPRESSION_INSTRUCTION] : [];
}
