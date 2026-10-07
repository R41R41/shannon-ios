import { createHash } from 'node:crypto';
import {
  describeAudience,
  disclosureFor,
  memoryControlFor,
  peopleAudience,
  visibleMemoryText,
  type CompanionStateSnapshot,
  type CompanionStateStore,
  type MemoryAudience,
  type MemoryControl,
} from '@shannon/cognition';
import { DisclosureGate } from '../inhibition/disclosurePorts.js';
import type { PeopleMemoryStore, PersonCall, PersonMemoryItem, RememberedPerson } from './store/peopleMemoryStore.js';
import { extractPromiseCaptures } from './prospectiveMemory.js';
import { extractExplicitMemoryProposals } from '../sleep/sleepConsolidation.js';
import type { LabelledRecallCandidate } from '../action/respond/respondPorts.js';
import type { GuestCallTurn } from '../../surfaces/voice/voiceGuestCall.js';
import { establishedGuestName, personNameKey } from '../../surfaces/voice/voiceGuestNames.js';
import { ownerPeoplePrompt, type VisiblePersonItem } from './peopleMemoryPrompts.js';
import type { MemoryCommands, MemoryProposals } from './memoryWriter.js';

/** Recall and memory-control identifier of a person memory item. */
export const personMemoryId = (itemId: string) => `person:${itemId}`;
/** The item id of a platform conversation period's summary. */
export const platformSummaryId = (callId: string) => `ps-${createHash('sha256').update(callId).digest('hex').slice(0, 32)}`;

/**
 * The summary of one conversation period as code writes it (the deterministic one, or the written `text`): its item id, its
 * text as stored (one line) and as labelled. Null when the period is not known.
 */
export function periodSummaryText(store: Pick<PeopleMemoryStore, 'call' | 'person' | 'items'>, scopeKey: string, callId: string, label: string, text?: string):
  { id: string; text: string; labelled: string } | null {
  const call = store.call(scopeKey, callId);
  if (!call) return null;
  const names = call.personIds.flatMap(id => store.person(scopeKey, id)?.displayName ?? []).map(name => `${name}さん`);
  const turns = store.items(scopeKey).filter(item => item.callId === callId && item.kind === 'turn');
  const opening = Array.from((turns.at(-1)?.evidence ?? '').replace(/\s+/gu, ' ').trim()).slice(0, 40).join('');
  const summary = text ?? `相手: ${names.join('・') || '名前を聞いていない方'}\n話したこと: ${label}で${turns.length}件のやり取り。「${opening}」から始まった。`;
  return { id: platformSummaryId(callId), text: summary.replace(/\s+/gu, ' ').trim(), labelled: summary };
}
const personCause = (personId: string) => `person-record:${personId}`;
const HOW_KNOWN = '「友人も一緒」の通話で名前を聞いた';
const FORGET_REASON = 'ユーザーが忘れるよう指定';

/**
 * Syzygy ADR-0008 stage 3: the memory outbox's proposals and the owner's commands (F5), and (F6) the readers of people facts with
 * time (`closedIds`: items recall leaves out now), the identity suggestions, and whether a newly met name is proposed to the tiers.
 */
export interface PeopleMemoryParts {
  proposals: MemoryProposals;
  commands: Pick<MemoryCommands, 'run'> | null;
  facts?: { closedIds(scopeKey: string): ReadonlySet<string>; candidates(scopeKey: string): readonly { personId: string; candidatePersonId: string; tier: 3 | 4 }[] } | null;
  identity?: boolean;
}

/** Who is in a 「友人も一緒」 call right now, as far as the words said have established. */
export interface GuestCallPresence {
  present: MemoryAudience;
  people: readonly RememberedPerson[];
  /** People Shannon has talked with in an earlier call. */
  returning: readonly RememberedPerson[];
  /** Named by this very utterance: greet them by name now. */
  newlyNamed?: RememberedPerson;
  /** A name that matches several remembered people: ask, do not guess. */
  ambiguousName?: string;
  /** False for an old client or a call the owner chose not to keep: nothing of it is stored. */
  recorded: boolean;
}

export interface RememberedCall {
  status: 'remembered' | 'discarded' | 'empty';
  callId: string;
  people: readonly { id: string; displayName: string }[];
  summary: string;
  itemCount: number;
}

export type CallSummarizer = (turns: readonly GuestCallTurn[], names: readonly string[]) => Promise<string | null>;

const namesOf = (person: RememberedPerson) => [person.displayName, ...person.aliases].map(personNameKey).filter(Boolean);

/**
 * People Shannon has met with the owner, and what was talked about with them. A friend's
 * words are kept here and never in the owner's profile, promises, goals, or sleep batch.
 * Forgetting is the owner's memory control (`person:<item>`), so the forgetting boundary
 * applies to these items exactly as it does to the owner's own.
 */
export class PeopleMemory {
  constructor(
    private readonly store: PeopleMemoryStore,
    private readonly stateStore: CompanionStateStore,
    /**
     * Syzygy ADR-0008 stage 3 (F5): the memory outbox. What a call leaves is proposed; the owner's rename and merge run as
     * synchronous commands through the same write path. Absent (switched off): everything is written here, as it was.
     */
    private readonly memory: PeopleMemoryParts | null = null,
  ) {}

  /** F6: the open identity suggestions of tiers 3 and 4 (empty while `SHANNON_IDENTITY_TIERS` is off). */
  identityCandidates(scopeKey: string): readonly { personId: string; candidatePersonId: string; tier: 3 | 4 }[] {
    return this.memory?.facts?.candidates(scopeKey) ?? [];
  }

  listPeople(scopeKey: string): readonly RememberedPerson[] { return this.store.listPeople(scopeKey); }

  /**
   * Establishes who is present from the words of the current utterance. A name that matches
   * one remembered person is that person; none creates a person; several are left unresolved.
   */
  resolveCall(scopeKey: string, input: {
    callId?: string; threadId?: string; transcript: string; turns: readonly GuestCallTurn[];
  }, at: string): GuestCallPresence {
    const unknown: GuestCallPresence = { present: peopleAudience([], true), people: [], returning: [], recorded: false };
    if (!input.callId) return unknown;
    const stored = this.store.call(scopeKey, input.callId);
    if (stored?.status === 'discarded') return unknown;
    let call: PersonCall = stored ?? { callId: input.callId, status: 'open', personIds: [], createdPersonIds: [], startedAt: at, updatedAt: at,
      ...(input.threadId ? { threadId: input.threadId } : {}) };
    const previousShannon = [...input.turns].reverse().find(turn => turn.role === 'shannon')?.text ?? '';
    const name = establishedGuestName(input.transcript, previousShannon);
    let newlyNamed: RememberedPerson | undefined;
    if (name) {
      const key = personNameKey(name);
      const inCall = call.personIds.flatMap(id => this.store.person(scopeKey, id) ?? []);
      if (!inCall.some(person => namesOf(person).includes(key))) {
        const matches = this.store.listPeople(scopeKey).filter(person => !person.forgottenAt && namesOf(person).includes(key));
        const { pendingName: _resolved, ...settled } = call;
        if (matches.length === 0) {
          newlyNamed = this.store.createPerson(scopeKey, { displayName: name, howKnown: HOW_KNOWN }, at);
          call = { ...settled, personIds: [...call.personIds, newlyNamed.id], createdPersonIds: [...call.createdPersonIds, newlyNamed.id] };
          // F6: a new name goes to identity tiers 3 and 4 in the background; they only suggest, the owner merges.
          if (this.memory?.identity) this.memory.proposals.propose({ opId: `identity:${scopeKey}:${newlyNamed.id}`, scopeKey, kind: 'person.link', origin: 'people',
            subjectKey: `identity:${newlyNamed.id}`, payload: { action: 'suggest', personId: newlyNamed.id, name } });
        } else if (matches.length === 1) {
          newlyNamed = matches[0]!;
          call = { ...settled, personIds: [...call.personIds, newlyNamed.id] };
        } else {
          // Two remembered people share this name. Never pick one.
          call = { ...call, pendingName: name };
        }
      }
    }
    if (!stored || name) call = this.store.saveCall(scopeKey, { ...call, updatedAt: at });
    const people = call.personIds.flatMap(id => this.store.person(scopeKey, id) ?? []).filter(person => !person.forgottenAt);
    const earlier = this.store.items(scopeKey).filter(item => item.callId !== call.callId);
    const returning = people.filter(person => !call.createdPersonIds.includes(person.id)
      && earlier.some(item => audiencePeople(item).includes(person.id)));
    return {
      // Someone named earlier who has since been forgotten or merged away is an unknown guest again, not absent.
      present: peopleAudience(people.map(person => person.id),
        people.length === 0 || people.length !== call.personIds.length || Boolean(call.pendingName)),
      people, returning, recorded: true,
      ...(newlyNamed ? { newlyNamed } : {}),
      ...(call.pendingName ? { ambiguousName: call.pendingName } : {}),
    };
  }

  /**
   * Stores one ended 「友人も一緒」 period: each exchange as text, a short summary, the friend's
   * own statements as facts about that person, and promises and next-time topics.
   */
  async rememberCall(scopeKey: string, input: {
    callId: string; threadId?: string; turns: readonly GuestCallTurn[]; timeZone?: string;
  }, at: string, summarize?: CallSummarizer): Promise<RememberedCall> {
    if (this.store.call(scopeKey, input.callId)?.status === 'discarded') {
      return { status: 'discarded', callId: input.callId, people: [], summary: '', itemCount: 0 };
    }
    // Names are established turn by turn during the call; replaying is idempotent and covers a missed turn.
    const heard: GuestCallTurn[] = [];
    for (const turn of input.turns) {
      if (turn.role === 'participant') this.resolveCall(scopeKey, { callId: input.callId, threadId: input.threadId, transcript: turn.text, turns: heard }, at);
      heard.push(turn);
    }
    const call = this.store.call(scopeKey, input.callId);
    if (!call || !input.turns.some(turn => turn.role === 'participant')) {
      return { status: 'empty', callId: input.callId, people: [], summary: '', itemCount: 0 };
    }
    const people = call.personIds.flatMap(id => this.store.person(scopeKey, id) ?? []).filter(person => !person.forgottenAt);
    const audience = peopleAudience(people.map(person => person.id),
      people.length === 0 || people.length !== call.personIds.length || Boolean(call.pendingName));
    const single = people.length === 1 && !call.pendingName ? people[0]! : undefined;
    const subject = single ? `${single.displayName}さん` : people.length ? people.map(person => `${person.displayName}さん`).join('・') : '同席していた方';
    const items: Omit<PersonMemoryItem, 'callId'>[] = [];
    // The same period saved again yields the same item IDs, so an earlier forget still applies to it.
    const itemId = (kind: string, text: string) => createHash('sha256')
      .update(`${input.callId}\u0000${kind}\u0000${items.filter(item => item.kind === kind).length}\u0000${text}`).digest('hex').slice(0, 32);
    const add = (kind: PersonMemoryItem['kind'], text: string, extra: Partial<PersonMemoryItem> = {}, force?: 'third_party') => items.push({
      id: itemId(kind, kind === 'summary' ? '' : text), kind, text: text.replace(/\s+/gu, ' ').trim().slice(0, 600), observedAt: at,
      disclosure: disclosureFor(text, audience, force ? { force } : {}), ...extra,
    });
    const names = people.map(person => person.displayName);
    const summary = (await summarize?.(input.turns, names).catch(() => null)) ?? fallbackCallSummary(input.turns, subject);
    // 「今回は残さない」 may have arrived while the summary was being written. It wins.
    if (this.store.call(scopeKey, input.callId)?.status === 'discarded') {
      return { status: 'discarded', callId: input.callId, people: [], summary: '', itemCount: 0 };
    }
    add('summary', summary);
    let pending: string[] = [];
    // An exchange in which someone states a fact about themselves is as protected as the fact drawn from it.
    const personal = (texts: readonly string[]) => texts.some(text => extractExplicitMemoryProposals(text).length > 0) ? 'third_party' as const : undefined;
    for (const turn of input.turns) {
      if (turn.role === 'participant') { pending.push(turn.text); continue; }
      if (pending.length) add('turn', `話し手: ${pending.join(' ').slice(0, 300)} / シャノン: ${turn.text.slice(0, 200)}`, { evidence: pending.join(' ') }, personal(pending));
      pending = [];
      const topic = turn.text.match(/[^。！？!?\n]*(?:次は|次に|次回|今度|また)[^。！？!?\n]{0,40}(?:話|聞かせ|見せ|教え)[^。！？!?\n]*/u)?.[0];
      if (topic) add('topic', `シャノンが次に話したいと言ったこと: ${topic.trim()}`);
    }
    if (pending.length) add('turn', `話し手: ${pending.join(' ').slice(0, 300)}`, { evidence: pending.join(' ') }, personal(pending));
    for (const turn of input.turns.filter(candidate => candidate.role === 'participant')) {
      // Unknown speaker is the friend, never the owner: a first-person statement is a fact about that person.
      for (const proposal of extractExplicitMemoryProposals(turn.text).filter(candidate => candidate.kind !== 'interest')) {
        add('fact', proposal.statement.replace(/^ユーザー/u, subject), { evidence: proposal.evidence, ...(single ? { personId: single.id } : {}) }, 'third_party');
      }
      for (const promise of extractPromiseCaptures(turn.text, at, undefined, input.timeZone)) {
        add('promise', `${subject}と話した時の約束: ${promise.memory.summary}`, { evidence: promise.memory.evidence ?? turn.text, ...(single ? { personId: single.id } : {}) });
      }
    }
    if (this.memory) {
      // The period (its summary and exchanges, replacing what an earlier save left), then its topics, facts and promises.
      const remembered: PersonCall = { ...call, status: 'remembered', updatedAt: at, ...(input.threadId ? { threadId: input.threadId } : {}) };
      const of = (...kinds: PersonMemoryItem['kind'][]) => items.filter(item => kinds.includes(item.kind));
      const opId = (part: string) => `call:${scopeKey}:${input.callId}:${at}:${part}`.slice(0, 200);
      const propose = (kind: 'person.summary' | 'person.topic' | 'person.fact' | 'person.promise', part: string, subjectKey: string, payload: Record<string, unknown>) =>
        this.memory!.proposals.propose({ opId: opId(part), scopeKey, kind, origin: 'people', subjectKey, payload });
      propose('person.summary', 'period', `call:${input.callId}`, { callId: input.callId, mode: 'replace', call: remembered, items: of('summary', 'turn') });
      if (of('topic').length) propose('person.topic', 'topics', `call:${input.callId}`, { callId: input.callId, mode: 'upsert', items: of('topic') });
      if (of('fact').length) propose('person.fact', 'facts', single ? `person:${single.id}` : `call:${input.callId}`,
        { callId: input.callId, mode: 'upsert', items: of('fact').map(item => ({ ...item, validAt: at, episodeIds: [`call:${input.callId}`] })) });
      if (of('promise').length) propose('person.promise', 'promises', single ? `person:${single.id}` : `call:${input.callId}`,
        { callId: input.callId, mode: 'upsert', items: of('promise') });
    } else {
      this.store.saveCall(scopeKey, { ...call, status: 'remembered', updatedAt: at, ...(input.threadId ? { threadId: input.threadId } : {}) });
      this.store.replaceCallItems(scopeKey, input.callId, items);
    }
    return { status: 'remembered', callId: input.callId, summary, itemCount: items.length,
      people: people.map(person => ({ id: person.id, displayName: person.displayName })) };
  }

  /** 「今回は残さない」: nothing of the call remains, and a late save of the same call stores nothing. */
  discardCall(scopeKey: string, callId: string, at: string): boolean {
    return this.store.discardCall(scopeKey, callId, at);
  }

  /** Items that may be used at all: their people still exist and are not forgotten, and the item itself is not forgotten. */
  visibleItems(scopeKey: string, snapshot: CompanionStateSnapshot): readonly VisiblePersonItem[] {
    const people = new Map(this.store.listPeople(scopeKey).map(person => [person.id, person]));
    // F6: a fact closed by a contradiction (or not yet true) is kept, never recalled.
    const closed = this.memory?.facts?.closedIds(scopeKey);
    const usable = (id: string) => { const person = people.get(id); return Boolean(person && !person.forgottenAt); };
    const calls = new Map<string, PersonCall | null>();
    const callOf = (id: string) => { if (!calls.has(id)) calls.set(id, this.store.call(scopeKey, id)); return calls.get(id) ?? null; };
    return this.store.items(scopeKey).flatMap(item => {
      if (closed?.has(item.id)) return [];
      const ids = [...audiencePeople(item), ...(item.personId ? [item.personId] : [])];
      if (!ids.every(usable) || visibleMemoryText(snapshot, personMemoryId(item.id), item.text) === null) return [];
      const nameOf = (id: string) => people.get(id)?.displayName;
      const call = callOf(item.callId);
      // A period's summary names everyone who spoke in it, so it goes when any of them is forgotten.
      if (call?.source && !item.personId && !call.personIds.every(usable)) return [];
      // A platform conversation is named by where it took place; its people are those who spoke in it that day.
      const members = call?.source ? (item.personId ? [item.personId] : call.personIds.filter(usable)) : audiencePeople(item);
      return [{ ...item, recallId: personMemoryId(item.id),
        audienceLabel: placeLabel(call) ?? describeAudience(item.disclosure.audience, nameOf),
        people: members.flatMap(id => people.get(id) ?? []) }];
    });
  }

  /**
   * Person memories for one turn. Every candidate passes the disclosure gate for `present`;
   * with the owner alone a 「誰と何を話した？」 or a remembered name adds a provenance block.
   */
  recall(scopeKey: string, snapshot: CompanionStateSnapshot, message: string, present: MemoryAudience): {
    candidates: readonly LabelledRecallCandidate[]; prompt: string; ids: readonly string[]; items: readonly VisiblePersonItem[];
  } {
    const gate = new DisclosureGate(present, snapshot, null, scopeKey);
    const items = this.visibleItems(scopeKey, snapshot).filter(item => gate.allows(item.recallId, item.disclosure));
    const candidates = items.map(item => ({ id: item.recallId, observedAt: item.observedAt, disclosure: item.disclosure,
      summary: `[${item.audienceLabel}] ${item.text}` }));
    const inquiry = gate.ownerOnly ? ownerPeoplePrompt(message, this.store.listPeople(scopeKey).filter(person => !person.forgottenAt), items) : { prompt: '', ids: [] };
    return { candidates, prompt: inquiry.prompt, ids: inquiry.ids, items };
  }

  // --- the owner's own controls -------------------------------------------------------

  rename(scopeKey: string, personId: string, displayName: string, at: string): boolean {
    const person = this.store.person(scopeKey, personId);
    if (!person) return false;
    const commands = this.memory?.commands;
    if (commands) return commands.run({ opId: `owner:rename:${personId}:${at}:${createHash('sha256').update(displayName).digest('hex').slice(0, 16)}`, scopeKey, kind: 'person.link', subjectKey: `person:${personId}`,
      payload: { action: 'rename', personId, displayName } }).applied;
    return Boolean(this.store.updatePerson(scopeKey, personId, { displayName, aliases: [...person.aliases, person.displayName] }, at));
  }

  merge(scopeKey: string, intoId: string, fromId: string, at: string): boolean {
    const commands = this.memory?.commands;
    if (commands) return commands.run({ opId: `owner:merge:${fromId}:${intoId}:${at}`, scopeKey, kind: 'person.link', subjectKey: `person:${intoId}`,
      payload: { action: 'merge', personId: fromId, intoPersonId: intoId } }).applied;
    return Boolean(this.store.mergePeople(scopeKey, intoId, fromId, at));
  }

  forgetItem(scopeKey: string, itemId: string, at: string): boolean {
    const item = this.store.items(scopeKey).find(candidate => candidate.id === itemId);
    if (!item) return false;
    this.stateStore.apply(scopeKey, { type: 'memory-control-upserted', control: this.forgetControl(item, at) });
    return true;
  }

  restoreItem(scopeKey: string, itemId: string, at: string): boolean {
    const previous = memoryControlFor(this.stateStore.snapshot(scopeKey), personMemoryId(itemId));
    if (!previous) return false;
    const { causedBy: _cause, ...kept } = previous;
    this.stateStore.apply(scopeKey, { type: 'memory-control-upserted',
      control: { ...kept, status: 'active', updatedAt: at, changeReason: 'ユーザーが記憶を復元' } });
    return true;
  }

  /** Withholds everything about one person. Items the owner had already forgotten one by one keep their own control. */
  forgetPerson(scopeKey: string, personId: string, at: string): boolean {
    if (!this.store.updatePerson(scopeKey, personId, { forgottenAt: at }, at)) return false;
    const snapshot = this.stateStore.snapshot(scopeKey);
    const events = this.store.items(scopeKey)
      .filter(item => (audiencePeople(item).includes(personId) || item.personId === personId)
        && (memoryControlFor(snapshot, personMemoryId(item.id))?.status ?? 'active') === 'active')
      .map(item => ({ type: 'memory-control-upserted' as const, control: { ...this.forgetControl(item, at), causedBy: personCause(personId) } }));
    if (events.length) this.stateStore.apply(scopeKey, { type: 'memory-transaction', events });
    return true;
  }

  restorePerson(scopeKey: string, personId: string, at: string): boolean {
    if (!this.store.updatePerson(scopeKey, personId, { forgottenAt: null }, at)) return false;
    const events = this.stateStore.snapshot(scopeKey).memoryControls
      .filter(control => control.causedBy === personCause(personId) && control.status !== 'active')
      .map(control => {
        const { causedBy: _cause, ...kept } = control;
        return { type: 'memory-control-upserted' as const, control: { ...kept, status: 'active' as const, updatedAt: at, changeReason: 'ユーザーが記憶を復元' } };
      });
    if (events.length) this.stateStore.apply(scopeKey, { type: 'memory-transaction', events });
    return true;
  }

  setSensitivity(scopeKey: string, itemId: string, sensitivity: 'sensitive' | 'ordinary'): boolean {
    const item = this.store.items(scopeKey).find(candidate => candidate.id === itemId);
    if (!item) return false;
    const { category: _category, ...kept } = item.disclosure;
    return this.store.setItemDisclosure(scopeKey, itemId, { ...kept, sensitivity, decidedBy: 'owner', reason: 'ライ氏が選んだ扱い' });
  }

  allItems(scopeKey: string): readonly PersonMemoryItem[] { return this.store.items(scopeKey); }

  call(scopeKey: string, callId: string): PersonCall | null { return this.store.call(scopeKey, callId); }

  private forgetControl(item: PersonMemoryItem, at: string): MemoryControl {
    return {
      memoryId: personMemoryId(item.id), kind: 'experience', status: 'forgotten', pinned: false, updatedAt: at,
      changeReason: FORGET_REASON, sourceEvidence: item.evidence ?? item.text, withheldText: item.text, contextInvalidatedAt: at,
    };
  }
}

/** 「友人グループ（Discord）で話した時」 for a platform conversation; nothing for a voice call. */
export function placeLabel(call: Pick<PersonCall, 'source' | 'label'> | null | undefined): string | undefined {
  return call?.source ? `${call.label ?? call.source}で話した時` : undefined;
}

export function audiencePeople(item: Pick<PersonMemoryItem, 'disclosure'>): readonly string[] {
  return item.disclosure.audience?.kind === 'people' ? item.disclosure.audience.personIds : [];
}

/** Used when no model summary is available: who, how long, and how it began. */
export function fallbackCallSummary(turns: readonly GuestCallTurn[], subject: string): string {
  const first = turns.find(turn => turn.role === 'participant')?.text.replace(/\s+/gu, ' ').trim() ?? '';
  const exchanges = turns.filter(turn => turn.role === 'shannon').length;
  const opening = Array.from(first).slice(0, 40).join('');
  return `相手: ${subject}\n話したこと: 「${opening}${first.length > opening.length ? '…' : ''}」から始まる、シャノンが${exchanges}回返事をした会話。\n次に話したいこと: 特になし`;
}
