import { createHash } from 'node:crypto';
import {
  audienceCovers,
  resolveDisclosure,
  disclosureFor,
  groupAudience,
  peopleAudience,
  visibleMemoryText,
  type CompanionStateSnapshot,
  type CompanionStateStore,
  type MemoryAudience,
  type MemoryDisclosure,
} from '@shannon/cognition';
import { DisclosureGate } from '../../mind/inhibition/memoryDisclosure.js';
import { localDayKey } from '../../mind/memory/memoryProjection.js';
import { periodSummaryText, personMemoryId, platformSummaryId } from '../../mind/memory/peopleMemory.js';
import type { MemoryProposals } from '../../mind/memory/memoryPorts.js';

export { platformSummaryId };
import type { PeopleMemoryStore, PersonMemoryItem, RememberedPerson } from '../../mind/memory/memoryPorts.js';
import { extractPromiseCaptures } from '../../mind/memory/prospectiveMemory.js';
import { extractExplicitMemoryProposals } from '../../mind/sleep/sleepConsolidation.js';
import { cleanPersonName } from '../../mind/perception/voiceGuestNames.js';
import { serverEnvironment } from '../../infra/config/serverEnvironment.js';

export type PlatformConversationKind = 'dm' | 'group' | 'channel';
export type PlatformSourceKind = 'person' | 'bot' | 'system';

/** One message written by someone other than the owner in a bound platform conversation. */
export interface PlatformPersonTurn {
  platform: string;
  requestId: string;
  payloadHash: string;
  /** Opaque key of the conversation (the same value as its thread identifier). */
  threadKey: string;
  /** How the conversation is shown to the owner, for example 「友人グループ（Discord）」. */
  label: string;
  conversationKind: PlatformConversationKind;
  sourceUserId: string;
  sourceDisplayName: string;
  sourceKind: PlatformSourceKind;
  message: string;
  shannonReply: string;
  observedAt: string;
}

export type PlatformPersonOutcome = 'stored' | 'bot' | 'system' | 'conversation_cap' | 'daily_cap' | 'forgotten_person';

export interface PlatformPersonResult {
  duplicate: boolean;
  outcome: PlatformPersonOutcome;
  itemId: string;
  personId?: string;
  personCreated?: boolean;
}

export interface PlatformPeopleLimits {
  /** Stored messages of people other than the owner, per conversation and local day. */
  conversationTurnsPerDay: number;
  /** The same, over every conversation. */
  turnsPerDay: number;
  /** Characters kept of one message. */
  messageCharacters: number;
  timeZone: string;
}

export const DEFAULT_PLATFORM_PEOPLE_LIMITS: PlatformPeopleLimits = Object.freeze({
  conversationTurnsPerDay: 200, turnsPerDay: 1_000, messageCharacters: 600, timeZone: 'Asia/Tokyo',
});

const PLATFORM_NAMES: Readonly<Record<string, string>> = { discord: 'Discord', line: 'LINE', minecraft: 'Minecraft', x: 'X', youtube: 'YouTube' };
export const platformDisplayName = (platform: string) => PLATFORM_NAMES[platform] ?? platform;
export const platformHowKnown = (platform: string) => `${platformDisplayName(platform)}で会った人`;

/** 「友人グループ（Discord）」: the configured title with the platform, unless the title already names it. */
export function platformConversationLabel(platform: string, title: string): string {
  const name = platformDisplayName(platform);
  return title.toLowerCase().includes(name.toLowerCase()) ? title : `${title}（${name}）`;
}

/** Stopping non-owner ingestion needs only this variable and a restart, not a deployment. */
export function platformPeopleEnabled(environment: Readonly<Record<string, string | undefined>> = serverEnvironment()): boolean {
  return !['off', 'false', '0', 'disabled'].includes(environment.SHANNON_PLATFORM_PEOPLE_INGEST?.trim().toLowerCase() ?? '');
}

const hash = (...parts: string[]) => createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
const digestOf = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);
const clip = (text: string, limit: number) => Array.from(text.replace(/\s+/gu, ' ').trim()).slice(0, limit).join('');

/**
 * People met on a platform. Identity is the platform user id and nothing else: a person is
 * created on first sight from the display name, renamed when it changes, and never merged
 * with anyone automatically. What they say is kept as person memory with the conversation
 * as its audience, and never as an owner fact, promise, goal or thread message.
 */
export class PlatformPeople {
  constructor(
    private readonly store: PeopleMemoryStore,
    private readonly stateStore: CompanionStateStore,
    private readonly limits: PlatformPeopleLimits = DEFAULT_PLATFORM_PEOPLE_LIMITS,
    /** Syzygy ADR-0008 stage 3 (F5): the memory outbox. Absent (switched off): the items are written here, as they were. */
    private readonly memory: MemoryProposals | null = null,
    /**
     * F6: the readers and recorders of people facts and identity: items recall leaves out now, the speaker of each stored message
     * (tier 1, verified by the platform account), and whether a newly met account goes to identity tiers 3 and 4.
     */
    private readonly facts: { closedIds(scopeKey: string): ReadonlySet<string>; speaker?(scopeKey: string, turnId: string, personId: string, at: string): void; identity?: boolean } | null = null,
  ) {}

  /** The audience of a conversation a friend wrote in: the friend alone in a DM, otherwise the conversation. */
  audience(kind: PlatformConversationKind, threadKey: string, personId: string | undefined): MemoryAudience {
    return kind === 'dm' ? peopleAudience(personId ? [personId] : [], !personId) : groupAudience(threadKey);
  }

  /** The remembered person behind a platform account, or nothing when it has not been seen or was forgotten. */
  person(scopeKey: string, platform: string, userId: string): RememberedPerson | null {
    const link = this.store.platformPerson(scopeKey, platform, userId);
    const person = link ? this.store.person(scopeKey, link.personId) : null;
    return person && !person.forgottenAt ? person : null;
  }

  ingest(scopeKey: string, turn: PlatformPersonTurn): PlatformPersonResult {
    const earlier = this.store.platformReceipt(scopeKey, turn.platform, turn.requestId);
    if (earlier) {
      if (earlier.payloadHash !== turn.payloadHash) throw new Error('PLATFORM_TURN_CONFLICT');
      return { duplicate: true, outcome: earlier.outcome as PlatformPersonOutcome, itemId: earlier.itemId };
    }
    const dayKey = localDayKey(turn.observedAt, this.limits.timeZone);
    const done = (outcome: PlatformPersonOutcome, itemId = '', extra: Partial<PlatformPersonResult> = {}): PlatformPersonResult => {
      this.store.recordPlatformReceipt(scopeKey, { platform: turn.platform, requestId: turn.requestId, payloadHash: turn.payloadHash,
        threadKey: turn.threadKey, dayKey, itemId, outcome, createdAt: turn.observedAt });
      return { duplicate: false, outcome, itemId, ...extra };
    };
    if (turn.sourceKind !== 'person') return done(turn.sourceKind);
    const counts = this.store.platformTurnCounts(scopeKey, dayKey, turn.threadKey);
    if (counts.total >= this.limits.turnsPerDay) return done('daily_cap');
    if (counts.conversation >= this.limits.conversationTurnsPerDay) return done('conversation_cap');

    const resolved = this.resolvePerson(scopeKey, turn);
    if (!resolved) return done('forgotten_person');
    const { person, created } = resolved;
    // F6: who wrote it, by the platform account (tier 1, verified); a new account's name goes to tiers 3 and 4 in the background.
    this.facts?.speaker?.(scopeKey, `pt-${hash(turn.platform, turn.requestId)}`, person.id, turn.observedAt);
    if (created && this.facts?.identity && this.memory) this.memory.propose({ opId: `identity:${scopeKey}:${person.id}`, scopeKey, kind: 'person.link', origin: 'platform',
      subjectKey: `identity:${person.id}`, payload: { action: 'suggest', personId: person.id, name: person.displayName, link: `${turn.platform}:${turn.sourceUserId}`.slice(0, 200) } });
    const name = `${person.displayName}さん`;
    const callId = `platform:${turn.threadKey}:${dayKey}`;
    const call = this.store.call(scopeKey, callId);
    const audience = this.audience(turn.conversationKind, turn.threadKey, person.id);
    this.store.saveCall(scopeKey, {
      callId, status: 'remembered', threadId: turn.threadKey, source: turn.platform, label: turn.label,
      personIds: [...new Set([...(call?.personIds ?? []), person.id])],
      createdPersonIds: [...new Set([...(call?.createdPersonIds ?? []), ...(created ? [person.id] : [])])],
      startedAt: call?.startedAt ?? turn.observedAt, updatedAt: turn.observedAt,
    });
    const message = clip(turn.message, this.limits.messageCharacters);
    const reply = clip(turn.shannonReply, 300);
    const itemId = `pt-${hash(turn.platform, turn.requestId)}`;
    const facts = extractExplicitMemoryProposals(message).filter(proposal => proposal.kind !== 'interest');
    const items: Omit<PersonMemoryItem, 'callId'>[] = [];
    const add = (id: string, kind: PersonMemoryItem['kind'], text: string, evidence: string, force?: 'third_party') => items.push({
      id, kind, text, evidence, personId: person.id, observedAt: turn.observedAt,
      disclosure: disclosureFor(text, audience, force ? { force } : {}),
    });
    // An exchange in which someone states a fact about themselves is as protected as the fact drawn from it.
    add(itemId, 'turn', `${name}: ${message}${reply ? ` / シャノン: ${reply}` : ''}`, message, facts.length ? 'third_party' : undefined);
    facts.forEach((proposal, index) => add(`pf-${hash(turn.platform, turn.requestId, String(index))}`, 'fact',
      proposal.statement.replace(/^ユーザー/u, name), proposal.evidence, 'third_party'));
    extractPromiseCaptures(message, turn.observedAt, undefined, this.limits.timeZone).forEach((promise, index) =>
      add(`pp-${hash(turn.platform, turn.requestId, String(index))}`, 'promise', `${name}と話した時の約束: ${promise.memory.summary}`, promise.memory.evidence ?? message));
    if (this.memory) {
      // The exchange and the period's summary, then what the person said of themselves and promised: one op each, in order.
      const opId = (part: string) => `platform:${scopeKey}:${turn.platform}:${turn.requestId}:${part}`;
      const of = (kind: PersonMemoryItem['kind']) => items.filter(item => item.kind === kind);
      this.memory.propose({ opId: opId('turn'), scopeKey, kind: 'person.summary', origin: 'platform', subjectKey: `call:${callId}`,
        payload: { callId, mode: 'upsert', items: of('turn'), summary: { label: turn.label, audience, at: turn.observedAt } } });
      if (of('fact').length) this.memory.propose({ opId: opId('facts'), scopeKey, kind: 'person.fact', origin: 'platform', subjectKey: `person:${person.id}`,
        payload: { callId, mode: 'upsert', items: of('fact').map(item => ({ ...item, validAt: turn.observedAt, episodeIds: [personMemoryId(itemId)] })) } });
      if (of('promise').length) this.memory.propose({ opId: opId('promises'), scopeKey, kind: 'person.promise', origin: 'platform', subjectKey: `person:${person.id}`,
        payload: { callId, mode: 'upsert', items: of('promise') } });
      return done('stored', itemId, { personId: person.id, personCreated: created });
    }
    this.store.upsertCallItems(scopeKey, callId, items);
    this.writeSummary(scopeKey, callId, turn.label, audience, turn.observedAt);
    return done('stored', itemId, { personId: person.id, personCreated: created });
  }

  /** The deterministic summary of one conversation period. The background worker may replace its text. */
  writeSummary(scopeKey: string, callId: string, label: string, audience: MemoryAudience, at: string, text?: string): void {
    // ADR-0008 stage 3 (F5): with the memory outbox on, the summary is proposed and the one writer writes it.
    if (this.memory) {
      this.memory.propose({ opId: `period-summary:${scopeKey}:${callId}:${at}:${text ? digestOf(text) : 'rule'}`, scopeKey, kind: 'person.summary', origin: 'platform',
        subjectKey: `call:${callId}`, payload: { callId, mode: 'upsert', items: [], summary: { label, audience, at, ...(text ? { text } : {}) } } });
      return;
    }
    const summary = periodSummaryText(this.store, scopeKey, callId, label, text);
    if (!summary) return;
    this.store.upsertCallItems(scopeKey, callId, [{ id: summary.id, kind: 'summary', text: summary.text,
      observedAt: at, disclosure: disclosureFor(summary.labelled, audience) }]);
  }

  /**
   * What Shannon remembers about the people in a conversation, for the legacy runtime's prompt.
   * Every line passed the disclosure gate for `present`, and was heard by everyone there (`heardByEveryoneHere`, review of
   * 2026-10-06): a friend's DM never reaches the owner's or anyone else's shared conversation. With the owner absent only
   * open lines are used.
   */
  contextLines(scopeKey: string, platform: string, userIds: readonly string[], present: MemoryAudience, ownerPresent: boolean, maximum = 12): string[] {
    const snapshot = this.stateStore.snapshot(scopeKey);
    const gate = new DisclosureGate(present, snapshot, null, scopeKey);
    const people = userIds.flatMap(id => this.person(scopeKey, platform, id) ?? []);
    if (!people.length) return [];
    const ids = new Set(people.map(person => person.id));
    const labels = new Map<string, string>();
    const label = (callId: string) => {
      if (!labels.has(callId)) labels.set(callId, this.store.call(scopeKey, callId)?.label ?? '');
      return labels.get(callId)!;
    };
    const closed = this.facts?.closedIds(scopeKey);
    const lines = this.store.items(scopeKey)
      .filter(item => item.kind !== 'turn' && item.personId !== undefined && ids.has(item.personId) && !closed?.has(item.id))
      .filter(item => visibleMemoryText(snapshot, personMemoryId(item.id), item.text) !== null && gate.allows(personMemoryId(item.id), item.disclosure)
        && heardByEveryoneHere(snapshot, personMemoryId(item.id), item.disclosure, present))
      .flatMap(item => {
        const marker = gate.marker(personMemoryId(item.id), item.disclosure);
        // Without the owner there nobody can release a protected line, so it is not given at all.
        if (marker && !ownerPresent) return [];
        return [`- ${marker}(${item.observedAt.slice(0, 10)} ${label(item.callId) || '通話'}) ${item.text}`];
      }).slice(0, maximum);
    return ['[この会話にいる人についての記憶]', `名前はプラットフォームのアカウントで確かめたもの: ${people.map(person => `${person.displayName}さん`).join('、')}`,
      ...(lines.length ? lines : ['- (まだ覚えていることはない)'])];
  }

  private resolvePerson(scopeKey: string, turn: PlatformPersonTurn): { person: RememberedPerson; created: boolean } | null {
    const displayName = cleanPersonName(turn.sourceDisplayName) || `${platformDisplayName(turn.platform)}の人`;
    const link = this.store.platformPerson(scopeKey, turn.platform, turn.sourceUserId);
    if (!link) {
      // An account the owner registered beforehand is that person. Otherwise first sight makes a new person from
      // the display name; a voice-met person of the same name stays separate until the owner merges them.
      const registered = this.store.registryPersonId(scopeKey, turn.platform, turn.sourceUserId);
      const known = registered ? this.store.person(scopeKey, registered) : null;
      if (registered && (!known || known.forgottenAt)) return null;
      const person = known ?? this.store.createPerson(scopeKey, { displayName, howKnown: platformHowKnown(turn.platform) }, turn.observedAt);
      if (!known) this.store.recordRegistryCandidate(scopeKey, turn.platform, turn.sourceUserId, person.id, turn.observedAt);
      this.store.linkPlatformPerson(scopeKey, { platform: turn.platform, userId: turn.sourceUserId, personId: person.id, displayName,
        firstSeenAt: turn.observedAt, lastSeenAt: turn.observedAt });
      return { person, created: !known };
    }
    let person = this.store.person(scopeKey, link.personId);
    // The owner forgot or removed this person: their messages are not stored again under that account.
    if (!person || person.forgottenAt) return null;
    if (link.displayName !== displayName) {
      // The account was renamed on the platform. A name the owner chose in 人 stays; the new one becomes an alias.
      const ownerRenamed = person.displayName !== link.displayName;
      person = this.store.updatePerson(scopeKey, person.id, ownerRenamed
        ? { aliases: [...person.aliases, displayName] }
        : { displayName, aliases: [...person.aliases, person.displayName] }, turn.observedAt) ?? person;
    }
    this.store.linkPlatformPerson(scopeKey, { ...link, displayName, lastSeenAt: turn.observedAt });
    return { person, created: false };
  }
}


/**
 * Whether a person memory may reach a conversation with others: everyone there already heard it (`audienceCovers`), or
 * the owner himself made it ordinary (ふつう). Otherwise it stays where it was said: one person's DM or whisper never reaches
 * another person's turn, nor the owner's turn in a shared conversation (review of 2026-10-06). The owner alone hears all.
 */
export function heardByEveryoneHere(
  snapshot: Pick<CompanionStateSnapshot, 'memoryControls'>, memoryId: string, stored: MemoryDisclosure | undefined, present: MemoryAudience,
): boolean {
  if (audienceCovers(stored?.audience, present)) return true;
  const resolved = resolveDisclosure(snapshot, memoryId, stored);
  return resolved.decidedBy === 'owner' && resolved.sensitivity === 'ordinary';
}
