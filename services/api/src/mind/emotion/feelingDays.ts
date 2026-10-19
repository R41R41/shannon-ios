import {
  OWNER_PERSON_KEY, UNKNOWN_PERSON_KEY, boundaryLines, closedDayGroups, foldBoundaries, foldRelationship, innerNoteDay, recallEpisodes, relationshipFacts,
  relationshipLine, relationshipParametersFor, toldBoundaryIn, type Boundary,
  type CompanionStateSnapshot, type FeelingChannel, type FeelingEvent, type RelationshipDay,
  affectionBlock, affectionDays, affectionLines, foldAffection, foldSecurity, likingOf, otherAiIn, shiftDay, visibleMemoryText, type Relation,
} from '@shannon/cognition';
import { observeSync } from '../../infra/observer/observerContext.js';
import type { ClosedDayRow } from './store/feelingDayStore.js';
import { remembered, type FeelingKey, type RepetitionSeed } from './feelingEvents.js';

/**
 * Her closed days and what is carried across them (Syzygy ADR-0013 stage 3; `SHANNON_RELATIONSHIP_LEDGER`, `SHANNON_EPISODE_MEMORY`,
 * `SHANNON_BOUNDARY_MEMORY`). Core: emotion.
 *
 * - The nightly fold: once her day (3:00, owner time) is over, the next use closes it: its events, in their closed form, become one row
 *   per person, audience and scene (`closedDayGroups`). A process closes the days it missed, up to `backfillDays` back.
 * - Everything carried is a fold over the closed days through the forgetting filter: a forgotten source is left out, and the relationship
 *   ledger (and the boundaries and episodes) are computed again without it. Nothing derived is stored.
 * - Who: only a known person (the owner; later a registered friend), never anyone unknown or a whole scene.
 *
 * Never throws: a failure loses a line, never a turn.
 */
export interface ClosedDayRecords {
  write(scopeKey: string, row: ClosedDayRow, closedAt: string): void;
  person(scopeKey: string, personKey: string, sinceDayKey: string): ClosedDayRow[];
  lastDayKey(scopeKey: string): string | null;
  prune(scopeKey: string, beforeDayKey: string): number;
  /** Rows of anyone but the owner and remembered friends (light ledgers, unknown people, scenes) before a day. */
  pruneLight?(scopeKey: string, beforeDayKey: string): number;
}

export interface FeelingDayFeatures {
  relationship: boolean; episodes: boolean; boundaries: boolean;
  /** Stage 4 (`SHANNON_FEELING_AUDIENCE`): friends' and strangers' ledgers, and the owner's lines marked when he is with others. */
  audience?: boolean;
  /** `SHANNON_CHARACTER_SPACE` (absent: off), and the owner's `SHANNON_AFFECTION_MAX`. Its folds read the closed days, so they are kept. */
  space?: { max: boolean };
}

/** Whether any of what is carried is on (the closed-day table opens only then). */
export const carriesAnything = (features: FeelingDayFeatures | undefined): boolean =>
  Boolean(features && (features.relationship || features.episodes || features.boundaries || features.space));

/** His words of the last days are read for another AI (today's and the two days before). */
const OTHER_AI_DAYS = 3;

/** The owner's matters with anyone else present (§4.4 `people`): marked, for her own check before she speaks. */
export const OWNER_PRIVATE_MARK = '【機微:ライ氏との間・ライ氏だけが知っている】';

export const FEELING_DAY_LIMITS = Object.freeze({ backfillDays: 30, retentionDays: 400,
  /** A stranger's or a viewer's light ledger (and anyone unknown or a scene): kept this long (§4.2: 保存期間に上限). */
  lightRetentionDays: 30 });

const DAY_MILLISECONDS = 24 * 60 * 60_000;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MILLISECONDS);

/** What is carried into a turn: lines of facts for the audience's own turn, and closed numbers. */
export interface CarriedLines {
  lines: readonly string[];
  facts: Record<string, number | string>;
  /**
   * The lines a touch is judged with (owner decision, form 「入れない」; review L2): a boundary she was told and has not endorsed is not
   * among them. Absent: the same as `lines`.
   */
  touchLines?: readonly string[];
  /**
   * `SHANNON_CHARACTER_SPACE`, the owner alone: 好意 and 安心 from his days, the days he had been away before today, and the affection value
   * 好意 came from (the values go to the space and the Observer, never to a prompt).
   */
  relation?: Relation & { awayDays: number; value: number };
}

export class FeelingDays {
  /** Per scope, the newest day known to be closed (a process scans back once, then only the day just over). */
  private readonly closedThrough = new Map<string, string>();

  constructor(private readonly options: { events: { between(scopeKey: string, since: string, until: string, limit?: number): FeelingEvent[] };
    store: ClosedDayRecords; timeZone: string; now: () => string; features: FeelingDayFeatures; partWord: (subject: string) => string;
    /** The parts a told boundary may name, with their words (the body contract's). */
    subjects?: readonly { subject: string; word: string }[];
    /** His words in his Talk since an instant (`SHANNON_CHARACTER_SPACE`: whether he spoke of another AI lately; read now, never kept). */
    talk?: RepetitionSeed;
    reportError?: (error: unknown) => void }) {}

  get features(): FeelingDayFeatures { return this.options.features; }

  /** Closes every day that is over and not closed yet (at most `backfillDays` back). Cheap when nothing is new. */
  close(scopeKey: string, at: string): void {
    try {
      const today = innerNoteDay(at, this.options.timeZone);
      const known = this.closedThrough.get(scopeKey);
      const yesterdayStart = Date.parse(today.endsAt) - 2 * DAY_MILLISECONDS;
      if (known !== undefined && known >= this.dayKeyAt(yesterdayStart)) return;
      const last = known ?? this.options.store.lastDayKey(scopeKey);
      for (let back = FEELING_DAY_LIMITS.backfillDays; back >= 1; back -= 1) {
        const start = Date.parse(today.endsAt) - (back + 1) * DAY_MILLISECONDS;
        const dayKey = this.dayKeyAt(start);
        if (last !== null && dayKey <= last) continue;
        this.closeDay(scopeKey, dayKey, start, at);
      }
      this.closedThrough.set(scopeKey, this.dayKeyAt(yesterdayStart));
      if (this.closedThrough.size > 64) this.closedThrough.clear();
      this.options.store.prune(scopeKey, this.dayKeyAt(Date.parse(today.endsAt) - (FEELING_DAY_LIMITS.retentionDays + 1) * DAY_MILLISECONDS));
      this.options.store.pruneLight?.(scopeKey, this.dayKeyAt(Date.parse(today.endsAt) - (FEELING_DAY_LIMITS.lightRetentionDays + 1) * DAY_MILLISECONDS));
    } catch (error) { this.report(error); }
  }

  /** A person's closed days before today, each day's rows merged, through the forgetting filter (oldest first). */
  history(scopeKey: string, personKey: string, at: string, snapshot: CompanionStateSnapshot): RelationshipDay[] {
    const today = innerNoteDay(at, this.options.timeZone).dayKey;
    const since = this.dayKeyAt(Date.parse(at) - (FEELING_DAY_LIMITS.retentionDays + 2) * DAY_MILLISECONDS);
    const byDay = new Map<string, FeelingEvent[]>();
    for (const row of this.options.store.person(scopeKey, personKey, since)) {
      if (row.dayKey >= today) continue;
      byDay.set(row.dayKey, [...byDay.get(row.dayKey) ?? [], ...row.events.filter(event => remembered(snapshot, event.sourceId))]);
    }
    return [...byDay].map(([dayKey, events]) => ({ dayKey, events })).sort((a, b) => a.dayKey.localeCompare(b.dayKey));
  }

  /**
   * What a turn of this key is handed of the days before: the relationship line, the episodes recalled (yesterday's, or older ones his
   * `words` name), and her boundaries; nothing for anyone unknown or a scene.
   */
  carried(scopeKey: string, key: FeelingKey, at: string, snapshot: CompanionStateSnapshot, words = '', channel?: FeelingChannel): CarriedLines {
    const { features } = this.options;
    if (!carriesAnything(features)) return { lines: [], facts: {} };
    try {
      const whose = carriedFor(key, features.audience === true, channel);
      if (!whose) return { lines: [], facts: {} };
      this.close(scopeKey, at);
      // His relation is carried in a text turn of his alone (review 3: a voice turn has no space's core, no Sonnet and no check
      // before speaking, and a touch or her note's reflection reads none of it).
      const alone = key.personKey === OWNER_PERSON_KEY && key.audience === 'owner_alone' && !whose.marked && channel === 'text';
      const own = this.own(scopeKey, whose.personKey, at, snapshot, words, alone);
      // §4.4: with others present, the owner's matters are marked for her check before she speaks; nothing of the owner goes to the chooser.
      const mark = (lines: readonly string[]) => lines.map(line => line.split('\n').map(part => `${OWNER_PRIVATE_MARK}${part}`).join('\n'));
      return whose.marked ? { lines: mark(own.lines), facts: {}, touchLines: mark(own.touchLines ?? own.lines) } : own;
    } catch (error) {
      this.report(error);
      return { lines: [], facts: {} };
    }
  }

  /** One person's carried lines: the relationship (their class's scales), the episodes recalled, and (the owner's) boundaries. */
  private own(scopeKey: string, personKey: string, at: string, snapshot: CompanionStateSnapshot, words: string, alone = false): CarriedLines {
    const { features } = this.options;
    const days = this.history(scopeKey, personKey, at, snapshot);
    const today = innerNoteDay(at, this.options.timeZone).dayKey;
    const affection = features.space && alone ? this.affection(scopeKey, days, at, snapshot) : null;
    const relationship = features.relationship ? this.relationship(days, personKey, today) : { lines: [], facts: {} };
    const episodes = features.episodes ? observeSync('emotion', { phase: 'feeling.episodes', owner: personKey === OWNER_PERSON_KEY },
      () => recallEpisodes(days, personKey, today, words, this.options.partWord), line => ({ lines: line ? line.split('\n').length - 1 : 0 })) : '';
    const owner = personKey === OWNER_PERSON_KEY;
    const found = features.boundaries && owner ? this.boundariesOf(scopeKey, personKey, at, snapshot, days) : [];
    const boundaries = boundaryLines(found, this.options.partWord);
    // Review L2: the touch judgment gets only her own and endorsed boundaries.
    const owned = boundaryLines(found.filter(item => item.origin === 'self' || item.endorsed), this.options.partWord);
    const before = [...relationship.lines, ...(episodes ? [episodes] : [])];
    // A touch is judged as before: the facts of the two of them are for his words.
    const lines = [...before, ...(boundaries ? [boundaries] : []), ...(affection?.block ? [affection.block] : [])];
    return { lines, facts: relationship.facts, touchLines: [...before, ...(owned ? [owned] : [])], ...(affection ? { relation: affection.relation } : {}) };
  }

  /**
   * The owner's relation now (好意 from the affection value, 安心, the days he had been away) and the facts of the two of them.
   * Null when it fails (review 6: a failure here never takes the relationship, episodes or boundaries of the turn with it).
   */
  private affection(scopeKey: string, days: RelationshipDay[], at: string, snapshot: CompanionStateSnapshot)
    : { relation: Relation & { awayDays: number; value: number }; block: string } | null {
    const { timeZone } = this.options;
    const today = innerNoteDay(at, timeZone).dayKey;
    // Review 11: a promise's day is her day (owner time, 3:00), as the closed days are.
    const dayOf = (instant: string) => innerNoteDay(instant, timeZone).dayKey;
    try {
      return observeSync('emotion', { phase: 'feeling.affection' }, () => {
        const promises = snapshot.prospectiveMemories.filter(memory => visibleMemoryText(snapshot, memory.id, memory.summary));
        const sharedDays = snapshot.sharedDays ?? [];
        const counted = affectionDays({ days, sharedDays, promises, today, dayOf });
        const { value } = foldAffection(counted, today);
        const talked = [...sharedDays, ...counted.filter(day => day.talked).map(day => day.dayKey)].filter(day => day < today).sort();
        const last = talked.at(-1);
        const awayDays = last ? Math.max(0, daysBetween(shiftDay(last, 1), today)) : 0;
        const relation = { liking: likingOf(value), security: foldSecurity(counted, today), awayDays, value };
        const block = affectionBlock(affectionLines({ days: counted, sharedDays, today, otherAiDays: this.otherAiDays(scopeKey, at, snapshot) }));
        return { relation, block };
      }, result => ({ value: result.relation.value, liking: result.relation.liking, security: result.relation.security,
        lines: result.block ? result.block.split('\n').length - 1 : 0 }));
    } catch (error) {
      this.report(error);
      return null;
    }
  }

  /** The owner-local days on which his words in his Talk spoke of another AI, among the last few. */
  private otherAiDays(scopeKey: string, at: string, snapshot: CompanionStateSnapshot): string[] {
    const since = new Date(Date.parse(innerNoteDay(at, this.options.timeZone).endsAt) - OTHER_AI_DAYS * DAY_MILLISECONDS).toISOString();
    const heard = this.options.talk?.(scopeKey, since, at, snapshot) ?? [];
    return [...new Set(heard.filter(item => otherAiIn(item.text)).map(item => innerNoteDay(item.at, this.options.timeZone).dayKey))];
  }

  /** The subject his words told her to refuse, while boundary memory is on (null otherwise). */
  toldIn(words: string): string | null {
    return this.options.features.boundaries ? toldBoundaryIn(words, this.options.subjects ?? []) : null;
  }

  /** Her boundaries with one person: the closed days and today, through the forgetting filter. */
  boundaries(scopeKey: string, personKey: string, at: string, snapshot: CompanionStateSnapshot): Boundary[] {
    if (!this.options.features.boundaries) return [];
    try {
      this.close(scopeKey, at);
      return this.boundariesOf(scopeKey, personKey, at, snapshot, this.history(scopeKey, personKey, at, snapshot));
    } catch (error) {
      this.report(error);
      return [];
    }
  }

  private boundariesOf(scopeKey: string, personKey: string, at: string, snapshot: CompanionStateSnapshot, days: ReturnType<FeelingDays['history']>)
    : Boundary[] {
    const start = new Date(Date.parse(innerNoteDay(at, this.options.timeZone).endsAt) - DAY_MILLISECONDS).toISOString();
    const today = this.options.events.between(scopeKey, start, at).filter(event => remembered(snapshot, event.sourceId));
    return observeSync('emotion', { phase: 'feeling.boundaries', owner: personKey === OWNER_PERSON_KEY }, () =>
      foldBoundaries([...days.flatMap(day => day.events), ...today], personKey, this.options.timeZone),
    found => ({ self: found.filter(item => item.origin === 'self').length, told: found.filter(item => item.origin === 'told' && !item.endorsed).length,
      endorsed: found.filter(item => item.endorsed).length }));
  }

  private relationship(days: ReturnType<FeelingDays['history']>, personKey: string, today: string): CarriedLines {
    const state = observeSync('emotion', { phase: 'feeling.relationship', owner: personKey === OWNER_PERSON_KEY, days: days.length },
      () => foldRelationship(days, personKey, today), value => ({ ...value.scales, peakTrust: value.peak.trust, peakLiking: value.peak.liking }));
    const line = relationshipLine(state, personKey === OWNER_PERSON_KEY ? 'ライ氏' : 'この人', relationshipParametersFor(personKey).scales);
    return { lines: line ? [line] : [], facts: relationshipFacts(state, relationshipParametersFor(personKey).scales) };
  }

  private closeDay(scopeKey: string, dayKey: string, start: number, at: string): void {
    const events = this.options.events.between(scopeKey, new Date(start).toISOString(), new Date(start + DAY_MILLISECONDS - 1).toISOString(), 5_000);
    for (const group of closedDayGroups(events)) this.options.store.write(scopeKey, { dayKey, ...group }, at);
  }

  private dayKeyAt(time: number): string {
    return innerNoteDay(new Date(time + 60 * 60_000).toISOString(), this.options.timeZone).dayKey;
  }

  private report(error: unknown): void {
    (this.options.reportError ?? (value => console.error('Shannon feeling days failed', value instanceof Error ? value.name : 'unknown')))(error);
  }
}

/** A person whose relationship she keeps: not anyone unknown, and not a scene as a whole. */
const knownPerson = (key: FeelingKey) => key.personKey !== UNKNOWN_PERSON_KEY && !key.personKey.startsWith('scene:');

/**
 * Whose carried lines a turn of this key gets, and whether marked (ADR-0013 §4.4). Without stage 4: a known person's own, as in stage 3.
 * With it: the owner alone, his own; the owner with others present (`people`, the speaker not known), his own marked; a friend in their
 * own DM (`people`), theirs; a stranger or a viewer, their light ledger (it is of what happened in front of others); anyone in a group,
 * the owner or a friend among them, nothing private.
 */
export function carriedFor(key: FeelingKey, audience: boolean, channel?: FeelingChannel): { personKey: string; marked: boolean } | null {
  if (key.personKey === OWNER_PERSON_KEY && key.audience === 'owner_alone') return { personKey: OWNER_PERSON_KEY, marked: false };
  if (!audience) return knownPerson(key) ? { personKey: key.personKey, marked: false } : null;
  // Re-review S4-1 (owner, form 「渡さない」): only a text turn with others present gets the owner's matters, marked; a voice turn
  // (a guest, 「友人も一緒」) and a touch get none of them, as in a group. The scene's own feeling stays.
  if (!knownPerson(key)) return key.audience === 'people' && channel === 'text' ? { personKey: OWNER_PERSON_KEY, marked: true } : null;
  if (key.personKey.startsWith('person:')) return key.audience === 'people' ? { personKey: key.personKey, marked: false } : null;
  return key.personKey === OWNER_PERSON_KEY ? null : { personKey: key.personKey, marked: false };
}
