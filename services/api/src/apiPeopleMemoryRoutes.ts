import {
  SENSITIVITY_CATEGORY_LABELS, describeAudience, memoryControlFor, type CompanionStateStore,
} from '@shannon/cognition';
import { badRequest, objectBody, validBoundedString, validScopeKey } from './apiValidation.js';
import { acceptedSummary } from './surfaces/voice/apiVoiceCallSummary.js';
import type { ShannonChatModel } from './chatModel.js';
import type { ApiRequest, ApiResponse } from './contracts/contracts.js';
import { audiencePeople, personMemoryId, placeLabel, type CallSummarizer, type PeopleMemory } from './mind/memory/peopleMemory.js';
import type { PersonCall, PersonMemoryItem, RememberedPerson } from './mind/memory/store/peopleMemoryStore.js';
import { platformDisplayName } from './surfaces/platform/platformPeople.js';
import { GUEST_CALL_SUMMARY_TURNS, validatedGuestCallTurns } from './surfaces/voice/voiceGuestCall.js';
import { cleanPersonName, personNameKey } from './surfaces/voice/voiceGuestNames.js';
import { mutatePersonImpression, personImpressionViews } from './mind/memory/impressionViews.js';
import type { ImpressionSource } from './mind/memory/impressions.js';

export const VOICE_CALL_MEMORY_PATH = '/v1/voice/gemini/cascade/calls';
export const VOICE_CALL_DISCARD_PATH = '/v1/voice/gemini/cascade/calls/discard';
export const PEOPLE_MEMORY_PATH = '/v1/people/memory';
export const PEOPLE_MEMORY_ACTION_PATH = '/v1/people/memory/action';

const CALL_ID = /^[A-Za-z0-9-]{8,80}$/u;
const ITEM_KIND_LABELS: Readonly<Record<PersonMemoryItem['kind'], string>> = {
  summary: '話したことの要約', turn: '会話', fact: 'その人のこと', promise: '約束', topic: '次に話したいこと',
};

export interface PersonItemView {
  id: string;
  kind: PersonMemoryItem['kind'];
  kindLabel: string;
  text: string;
  observedAt: string;
  /** 「ミキさんと一緒の時」 */
  audience: string;
  sensitivity: 'sensitive' | 'ordinary';
  decidedBy: 'rule' | 'owner' | 'default';
  reason: string;
  status: 'active' | 'forgotten';
}

export interface PeopleMemoryOverview {
  people: readonly {
    id: string; displayName: string; aliases: readonly string[]; howKnown: string; createdAt: string;
    lastTalkedAt?: string; forgotten: boolean; items: readonly PersonItemView[];
    /** Where Shannon knows the person from: 「音声」「Discord」… */
    sources: readonly string[];
    /** Other remembered people with the same name. Only a suggestion: the owner decides whether they are one person. */
    mergeSuggestions: readonly { personId: string; displayName: string; sources: readonly string[] }[];
  }[];
  /** Calls whose guest never gave a name. Used only when the owner is alone. */
  unnamed: readonly PersonItemView[];
}

interface PeopleRouteDependencies {
  people: PeopleMemory;
  stateStore: CompanionStateStore;
  chatModel?: ShannonChatModel;
  now: () => string;
  /** Her impressions of remembered people, listed with what she knows of each person. */
  impressions?: ImpressionSource;
}

/** What the owner sees under 頭の中 › 人. Forgotten items stay listed so they can be restored. */
export function peopleMemoryOverview(people: PeopleMemory, stateStore: CompanionStateStore, scopeKey: string, impressions?: ImpressionSource): PeopleMemoryOverview {
  const snapshot = stateStore.snapshot(scopeKey);
  const persons = people.listPeople(scopeKey);
  const nameOf = (id: string) => persons.find(person => person.id === id)?.displayName;
  const calls = new Map<string, PersonCall | null>();
  const callOf = (id: string) => { if (!calls.has(id)) calls.set(id, people.call(scopeKey, id)); return calls.get(id) ?? null; };
  // An item belongs to the person it is about, to the people of its audience, and, for a platform period's summary, to those who spoke in it.
  const belongs = (item: PersonMemoryItem, personId: string) => item.personId === personId || audiencePeople(item).includes(personId)
    || (!item.personId && callOf(item.callId)?.source !== undefined && callOf(item.callId)!.personIds.includes(personId));
  const view = (item: PersonMemoryItem): PersonItemView => {
    const { sensitivity, category, reason, decidedBy } = item.disclosure;
    return {
      id: item.id, kind: item.kind, kindLabel: ITEM_KIND_LABELS[item.kind], text: item.text, observedAt: item.observedAt,
      audience: placeLabel(callOf(item.callId)) ?? describeAudience(item.disclosure.audience, nameOf),
      sensitivity: sensitivity ?? 'sensitive',
      decidedBy: decidedBy ?? 'default',
      reason: decidedBy === 'owner' ? 'ライ氏が選んだ扱い' : category ? `${SENSITIVITY_CATEGORY_LABELS[category]}（${reason ?? ''}）` : reason ?? '',
      status: (memoryControlFor(snapshot, personMemoryId(item.id))?.status ?? 'active') === 'active' ? 'active' : 'forgotten',
    };
  };
  const items = people.allItems(scopeKey);
  // Only people with a remembered call: not a bare platform identity, and not a name from a period that was never saved.
  const listed = persons.filter(person => items.some(item => belongs(item, person.id)));
  const sourcesOf = (personId: string) => [...new Set(items.filter(item => belongs(item, personId))
    .map(item => { const source = callOf(item.callId)?.source; return source ? platformDisplayName(source) : '音声'; }))].sort();
  const keysOf = (person: RememberedPerson) => [person.displayName, ...person.aliases].map(personNameKey).filter(Boolean);
  return {
    people: listed.map(person => {
      const own = items.filter(item => belongs(item, person.id));
      const lastTalkedAt = own.map(item => item.observedAt).sort().at(-1);
      const keys = keysOf(person);
      return { id: person.id, displayName: person.displayName, aliases: person.aliases, howKnown: person.howKnown,
        createdAt: person.createdAt, forgotten: Boolean(person.forgottenAt), ...(lastTalkedAt ? { lastTalkedAt } : {}),
        // The exchanges themselves are kept for recall; the list shows what she took from them.
        items: [...own.filter(item => item.kind !== 'turn').map(view), ...personImpressionViews(impressions, snapshot, person.id, nameOf)],
        sources: sourcesOf(person.id),
        // Never merged automatically: the same name on a platform and in a call may be two people.
        mergeSuggestions: person.forgottenAt ? [] : listed.filter(other => other.id !== person.id && !other.forgottenAt
          && keysOf(other).some(key => keys.includes(key))).map(other => ({ personId: other.id, displayName: other.displayName, sources: sourcesOf(other.id) })) };
    }),
    unnamed: items.filter(item => audiencePeople(item).length === 0 && !item.personId && !callOf(item.callId)?.source && item.kind !== 'turn').map(view),
  };
}

export function dispatchPeopleMemoryRequest(request: ApiRequest, dependencies: PeopleRouteDependencies): ApiResponse | Promise<ApiResponse> | null {
  const { people, stateStore } = dependencies;
  if (request.method === 'GET' && request.path === PEOPLE_MEMORY_PATH) {
    const scopeKey = request.query?.get('scopeKey');
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    return { status: 200, body: peopleMemoryOverview(people, stateStore, scopeKey, dependencies.impressions) };
  }
  if (request.method !== 'POST' || ![PEOPLE_MEMORY_ACTION_PATH, VOICE_CALL_MEMORY_PATH, VOICE_CALL_DISCARD_PATH].includes(request.path)) return null;
  if (!objectBody(request.body)) return badRequest('JSON object body is required');
  const { scopeKey } = request.body;
  if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
  const at = dependencies.now();

  if (request.path === PEOPLE_MEMORY_ACTION_PATH) {
    const { action, personId, itemId, displayName, intoPersonId } = request.body;
    const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9-]{1,80}$/u.test(value);
    let done: boolean;
    switch (action) {
      case 'rename': {
        if (!id(personId) || !validBoundedString(displayName, 80) || !cleanPersonName(displayName)) return badRequest('personId and displayName are required');
        done = people.rename(scopeKey, personId, cleanPersonName(displayName), at); break;
      }
      case 'merge':
        if (!id(personId) || !id(intoPersonId) || personId === intoPersonId) return badRequest('personId and intoPersonId are required');
        done = people.merge(scopeKey, intoPersonId, personId, at); break;
      case 'forget-person': if (!id(personId)) return badRequest('personId is required'); done = people.forgetPerson(scopeKey, personId, at); break;
      case 'restore-person': if (!id(personId)) return badRequest('personId is required'); done = people.restorePerson(scopeKey, personId, at); break;
      // An item of 人 is a person memory or one of her impressions of that person; both take the same four actions.
      case 'forget-item': if (!id(itemId)) return badRequest('itemId is required');
        done = mutatePersonImpression(stateStore, dependencies.impressions, scopeKey, itemId, 'forget', at) ?? people.forgetItem(scopeKey, itemId, at); break;
      case 'restore-item': if (!id(itemId)) return badRequest('itemId is required');
        done = mutatePersonImpression(stateStore, dependencies.impressions, scopeKey, itemId, 'restore', at) ?? people.restoreItem(scopeKey, itemId, at); break;
      case 'mark-sensitive': case 'mark-ordinary':
        if (!id(itemId)) return badRequest('itemId is required');
        done = mutatePersonImpression(stateStore, dependencies.impressions, scopeKey, itemId, action, at)
          ?? people.setSensitivity(scopeKey, itemId, action === 'mark-sensitive' ? 'sensitive' : 'ordinary'); break;
      default: return badRequest('action is invalid');
    }
    return done ? { status: 200, body: peopleMemoryOverview(people, stateStore, scopeKey, dependencies.impressions) } : { status: 404, body: { error: 'PERSON_MEMORY_NOT_FOUND' } };
  }

  const { callId } = request.body;
  if (typeof callId !== 'string' || !CALL_ID.test(callId)) return badRequest('callId is invalid');
  if (request.path === VOICE_CALL_DISCARD_PATH) {
    people.discardCall(scopeKey, callId, at);
    return { status: 200, body: { callId, discarded: true } };
  }
  const turns = validatedGuestCallTurns(request.body.turns, GUEST_CALL_SUMMARY_TURNS);
  if (turns === false) return badRequest('turns is invalid');
  if (request.body.threadId !== undefined && typeof request.body.threadId !== 'string') return badRequest('threadId is invalid');
  const timeZone = typeof request.body.timeZone === 'string' && request.body.timeZone.length <= 64 ? request.body.timeZone : undefined;
  return people.rememberCall(scopeKey, { callId, turns, ...(request.body.threadId?.trim() ? { threadId: request.body.threadId.trim() } : {}),
    ...(timeZone ? { timeZone } : {}) }, at, callSummarizer(people, scopeKey, dependencies.chatModel))
    .then(result => ({ status: result.status === 'discarded' ? 409 : 201, body: result }));
}

const SUMMARY_INSTRUCTIONS = [
  'You write Shannon\'s own short memory of a voice call in which ライ氏 introduced her to a friend (「友人も一緒」). The friend agreed that Shannon remembers their name and what was talked about.',
  'The input is that call only. Lines marked 話し手 were spoken by ライ氏 or the friend; speakers were not identified. Lines marked シャノン are Shannon\'s replies.',
  'Write plain Japanese text with exactly these three lines and nothing else:',
  '相手: the names given below with さん; if none, 「名前を聞いていない方」',
  '話したこと: one or two sentences describing faithfully what was talked about, in your own words',
  '次に話したいこと: only what Shannon herself said she would like to talk about or show next time; otherwise 「特になし」',
  'Rules: paraphrase and never quote anyone\'s words. Use nothing that is not in the input. Do not guess who said what. Do not address anyone and do not add advice.',
].join('\n');

const SUMMARIES_PER_WINDOW = 6;
const WINDOW_MILLISECONDS = 10 * 60_000;
const recentSummaries = new WeakMap<PeopleMemory, Map<string, number[]>>();

/** At most six model summaries per owner in ten minutes; beyond that the call is still remembered, with the deterministic summary. */
function consumeSummaryAllowance(people: PeopleMemory, scopeKey: string): boolean {
  const scopes = recentSummaries.get(people) ?? new Map<string, number[]>();
  recentSummaries.set(people, scopes);
  const now = Date.now();
  const recent = (scopes.get(scopeKey) ?? []).filter(time => now - time < WINDOW_MILLISECONDS);
  if (recent.length >= SUMMARIES_PER_WINDOW) { scopes.set(scopeKey, recent); return false; }
  scopes.set(scopeKey, [...recent, now]);
  return true;
}

/** One bounded model call in the existing chat usage lane. Any failure falls back to the deterministic summary. */
function callSummarizer(people: PeopleMemory, scopeKey: string, chatModel: ShannonChatModel | undefined): CallSummarizer | undefined {
  if (!chatModel || chatModel.mode === 'local-stub' || !consumeSummaryAllowance(people, scopeKey)) return undefined;
  return async (turns, names) => {
    const message = [`名前: ${names.length ? names.map(name => `${name}さん`).join('、') : '(なし)'}`,
      ...turns.map(turn => `${turn.role === 'shannon' ? 'シャノン' : '話し手'}: ${turn.text}`)].join('\n');
    const request = { scopeKey, systemPrompt: SUMMARY_INSTRUCTIONS, history: [], message };
    const result = chatModel.generateVoice
      ? await chatModel.generateVoice({ ...request, useWebSearch: false, conversationClass: 'direct' })
      : await chatModel.generate({ ...request, generateThreadTitle: false });
    return acceptedSummary(result.reply, turns);
  };
}
