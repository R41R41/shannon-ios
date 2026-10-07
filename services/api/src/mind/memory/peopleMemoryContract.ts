/** People memory's contract: who she remembers, their calls, items and platform links, and what a people store does (Syzygy ADR-0008 stage 3, S2: moved unchanged out of `store/peopleMemoryStore.ts`, which keeps the SQLite store and re-exports this). */
import type { MemoryDisclosure } from '@shannon/cognition';

/** A person Shannon has met with the owner. Rows live in the existing `people` table. */
export interface RememberedPerson {
  id: string;
  displayName: string;
  aliases: readonly string[];
  howKnown: string;
  createdAt: string;
  updatedAt: string;
  /** Set while the owner has asked Shannon to forget this person. Nothing about them is used. */
  forgottenAt?: string;
}

export type PersonCallStatus = 'open' | 'remembered' | 'discarded';

/** One 「友人も一緒」 period of a call, or one day of a platform conversation. */
export interface PersonCall {
  callId: string;
  threadId?: string;
  /** Where it took place: absent for a voice call, otherwise the platform (`discord`, `line`, …). */
  source?: string;
  /** How the place is shown to the owner, for example 「友人グループ（Discord）」. */
  label?: string;
  status: PersonCallStatus;
  personIds: readonly string[];
  /** People this call created; removed again if the owner chooses 「今回は残さない」. */
  createdPersonIds: readonly string[];
  /** A name that matched more than one remembered person and is still unresolved. */
  pendingName?: string;
  startedAt: string;
  updatedAt: string;
}

export type PersonMemoryKind = 'summary' | 'turn' | 'fact' | 'promise' | 'topic';

export interface PersonMemoryItem {
  id: string;
  callId: string;
  kind: PersonMemoryKind;
  /** Who a fact or promise is about. Absent for the call's summary and turns. */
  personId?: string;
  text: string;
  evidence?: string;
  disclosure: MemoryDisclosure;
  observedAt: string;
}

export interface PeopleMemoryStore {
  listPeople(scopeKey: string): readonly RememberedPerson[];
  person(scopeKey: string, personId: string): RememberedPerson | null;
  createPerson(scopeKey: string, input: { displayName: string; howKnown: string; aliases?: readonly string[] }, at: string): RememberedPerson;
  updatePerson(scopeKey: string, personId: string, input: { displayName?: string; aliases?: readonly string[]; forgottenAt?: string | null }, at: string): RememberedPerson | null;
  /** Moves every call and item of `fromId` to `intoId`, keeps its names as aliases, and removes it. */
  mergePeople(scopeKey: string, intoId: string, fromId: string, at: string): RememberedPerson | null;
  call(scopeKey: string, callId: string): PersonCall | null;
  saveCall(scopeKey: string, call: PersonCall): PersonCall;
  /** Replaces what is remembered from one call. */
  replaceCallItems(scopeKey: string, callId: string, items: readonly Omit<PersonMemoryItem, 'callId'>[]): void;
  /** Removes a call's items and the people it created, leaving only a content-free tombstone. */
  discardCall(scopeKey: string, callId: string, at: string): boolean;
  items(scopeKey: string): readonly PersonMemoryItem[];
  setItemDisclosure(scopeKey: string, itemId: string, disclosure: MemoryDisclosure): boolean;
  /** Adds items to a call, or rewrites the text of an item that already exists. The owner's own label is kept. */
  upsertCallItems(scopeKey: string, callId: string, items: readonly Omit<PersonMemoryItem, 'callId'>[]): void;
  /** Remembered platform conversation periods that were updated inside a window. */
  platformCalls(scopeKey: string, startAt: string, endAt: string): readonly PersonCall[];
  /** The person a platform account belongs to, if it has been seen. */
  platformPerson(scopeKey: string, platform: string, userId: string): PlatformPersonLink | null;
  linkPlatformPerson(scopeKey: string, link: PlatformPersonLink): void;
  platformLinks(scopeKey: string): readonly PlatformPersonLink[];
  /** The owner-managed identity registry: the person an account was registered for, and a candidate row for a new one. */
  registryPersonId(scopeKey: string, platform: string, userId: string): string | null;
  recordRegistryCandidate(scopeKey: string, platform: string, userId: string, personId: string, at: string): void;
  /** Records one mirrored message once. Returns the earlier record when the request was already seen. */
  platformReceipt(scopeKey: string, platform: string, requestId: string): PlatformTurnReceipt | null;
  recordPlatformReceipt(scopeKey: string, receipt: PlatformTurnReceipt): void;
  /** Stored non-owner messages of one local day: in one conversation, and in all. */
  platformTurnCounts(scopeKey: string, dayKey: string, threadKey: string): { conversation: number; total: number };
}

export interface PlatformPersonLink {
  platform: string;
  userId: string;
  personId: string;
  displayName: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface PlatformTurnReceipt {
  platform: string;
  requestId: string;
  payloadHash: string;
  threadKey: string;
  dayKey: string;
  /** Empty when the message was received but not stored (a bot, a cap, a forgotten person). */
  itemId: string;
  outcome: string;
  createdAt: string;
}
