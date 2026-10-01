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
import { DisclosureGate } from './memoryDisclosure.js';
import type { PeopleMemoryStore, PersonCall, PersonMemoryItem, RememberedPerson } from './peopleMemoryStore.js';
import { extractPromiseCaptures } from './prospectiveMemory.js';
import { extractExplicitMemoryProposals } from './sleepConsolidation.js';
import type { LabelledRecallCandidate } from './turnCognitiveContext.js';
import type { GuestCallTurn } from './voiceGuestCall.js';
import { establishedGuestName, personNameKey } from './voiceGuestNames.js';
import { ownerPeoplePrompt, type VisiblePersonItem } from './peopleMemoryPrompts.js';

/** Recall and memory-control identifier of a person memory item. */
export const personMemoryId = (itemId: string) => `person:${itemId}`;
const personCause = (personId: string) => `person-record:${personId}`;
const HOW_KNOWN = '「友人も一緒」の通話で名前を聞いた';
const FORGET_REASON = 'ユーザーが忘れるよう指定';

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
  constructor(private readonly store: PeopleMemoryStore, private readonly stateStore: CompanionStateStore) {}

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
    this.store.saveCall(scopeKey, { ...call, status: 'remembered', updatedAt: at, ...(input.threadId ? { threadId: input.threadId } : {}) });
    this.store.replaceCallItems(scopeKey, input.callId, items);
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
    const usable = (id: string) => { const person = people.get(id); return Boolean(person && !person.forgottenAt); };
    const calls = new Map<string, PersonCall | null>();
    const callOf = (id: string) => { if (!calls.has(id)) calls.set(id, this.store.call(scopeKey, id)); return calls.get(id) ?? null; };
    return this.store.items(scopeKey).flatMap(item => {
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
    return Boolean(this.store.updatePerson(scopeKey, personId, { displayName, aliases: [...person.aliases, person.displayName] }, at));
  }

  merge(scopeKey: string, intoId: string, fromId: string, at: string): boolean {
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
