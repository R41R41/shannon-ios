import {
  OWNER_AUDIENCE, SHANNON_OWNER_NAME, UNKNOWN_GUEST_PRESENCE, UNLABELLED_DISCLOSURE_MARKER, filterMeaningfulInterests, memoryIdentifier,
  visibleMemoryText, type CompanionStateSnapshot, type MemoryAudience, type MemoryDisclosure,
} from '@shannon/cognition';
import { OWNER_CONTEXT_HEADER, OWNER_CONTEXT_SECRET_MARK, OWNER_CONTEXT_WRITING_HEADER, type AutonomyOwnerContext, type OwnerContextBlock } from './autonomyLoopOwnerContext.js';
import type { ShannonConversationItem } from './chatModel.js';
import type { ConversationStore } from './mind/memory/store/conversationStore.js';
import { replayWindow } from './mind/recall/conversationWindow.js';
import type { DailyMindReader } from './dailyMind.js';
import { DisclosureGate } from './mind/inhibition/memoryDisclosure.js';
import { visibleReplayMessages } from './mind/memory/memoryVisibility.js';
import type { PeopleMemory } from './mind/memory/peopleMemory.js';
import { prepareTurnCognitiveContext } from './turnCognitiveContext.js';

/**
 * The owner's context for her own activity (owner decision 2026-10-02, Syzygy ADR-0003: 「基本的に全部見ていい」). Core: memory.
 *
 * One bounded block, built on the spot through the entry points a conversation uses and from nothing else: the
 * disclosure gate over the owner's state, the profile projection, the replay of the most recent Talks, the
 * deterministic recall of a turn, people memory, and today's focus. Nothing is copied into a store of the loop,
 * no model is called, and nothing is written. What the owner asked her to forget is gone here because it is gone
 * from those entry points.
 *
 * Two audiences, because her thinking stays in her head and her words do not:
 * - her thinking is the owner alone (`OWNER_AUDIENCE`): what a one-to-one conversation with him may use;
 * - what she writes in her study (a story, a note) and a message of hers are judged as if someone whose name is not
 *   known could read it (`UNKNOWN_GUEST_PRESENCE`): a story is meant to be shown one day, and
 *   a push banner or her body may show a message to anyone: what the owner asked to keep secret, what he marked
 *   機微 by hand, and what was said with an unnamed guest present never reach that prompt. While someone else is
 *   present every protected line also carries the marker a conversation with other people present uses.
 */
export interface OwnerContextSources {
  /** The owner's stored state, or null while there is none. */
  snapshot(scopeKey: string, at: string): CompanionStateSnapshot | null;
  conversations: ConversationStore;
  /** The profile projection a conversation with the owner alone starts from. */
  profile?: { promptProjection(scopeKey: string): string | null };
  people?: Pick<PeopleMemory, 'recall' | 'listPeople'>;
  dailyMind?: Pick<DailyMindReader, 'currentFocus'>;
}

/** The share of the block each part may take. What a part leaves unused is not handed on: the block only gets smaller. */
const SHARE = Object.freeze({ about: 0.3, talk: 0.4, recalled: 0.15, people: 0.1, focus: 0.05 });
const LINE_CHARACTERS = 200;
/** One replayed message; with who said it in front, it stays inside a line. */
const MESSAGE_CHARACTERS = 190;
const RECENT_THREADS = 2;
const MARKER = /【機微:[^】]*】/gu;
/** How many texts her free text is checked against, and how much of each. What she was just shown comes first. */
const SECRETS_MAXIMUM = 4_000;
const SECRET_CHARACTERS = 2_000;

type Mode = 'thinking' | 'writing' | 'message' | 'message_others';
/** The gate of a message, and the words of what her thinking was shown that this gate withholds. */
interface Unspeakable { gate: DisclosureGate; words: string[] }

/**
 * A label that says secret whatever a later correction or a narrower category made of it: stored as a secret, or said
 * with a guest present whose name was never established. Such an item never leaves her thinking.
 */
function storedSecret(disclosure: MemoryDisclosure | undefined): boolean {
  return disclosure?.category === 'secret' || disclosure?.category === 'unknown_audience'
    || (disclosure?.audience?.kind === 'people' && disclosure.audience.unknownGuest === true);
}

/** The ids of his stored items that must reach nobody else: what the gate of an unnamed guest leaves out, and what is stored as a secret. */
function protectedIds(state: CompanionStateSnapshot, guest: DisclosureGate): ReadonlySet<string> {
  const kept = guest.snapshot();
  const open = new Set([...kept.userFacts, ...kept.relationships, ...kept.prospectiveMemories].map(item => item.id));
  return new Set([...state.userFacts, ...state.relationships, ...state.prospectiveMemories]
    .filter(item => !open.has(item.id) || storedSecret(item.disclosure)).map(item => item.id));
}

export function createOwnerContext(sources: OwnerContextSources, options: { characters: number; timeZone: string }): AutonomyOwnerContext {
  const build = (scopeKey: string, at: string, topic: string, mode: Mode): OwnerContextBlock | null => {
    const state = sources.snapshot(scopeKey, at);
    if (!state) return null;
    const alone = mode === 'thinking';
    const marked = mode === 'message_others';
    const present: MemoryAudience = alone ? OWNER_AUDIENCE : UNKNOWN_GUEST_PRESENCE;
    const budget = Math.max(0, alone ? options.characters : Math.floor(options.characters / 2));
    const gate = new DisclosureGate(present, state, sources.conversations, scopeKey);
    const guest = alone ? new DisclosureGate(UNKNOWN_GUEST_PRESENCE, state, sources.conversations, scopeKey) : gate;
    // What her thinking is shown that a message could never carry: collected while the block is built, for the check of her own free text.
    const unspeakable: Unspeakable | null = alone ? { gate: guest, words: [] } : null;
    let secret: ReadonlySet<string>;
    // Without knowing which items are secret nothing of his can be handed on safely: then there is no block.
    try { secret = protectedIds(state, guest); } catch { return null; }
    // A marker tells her to check before she speaks; without anyone else present there is nothing to check.
    const shown = (text: string) => (marked ? text : text.replace(MARKER, ''));
    const parts = [
      part('〈覚えていること〉', guarded(() => about(sources, gate, state, scopeKey, alone, marked, secret)), budget * SHARE.about),
      part('〈最近のふたりの会話（古い順）〉', guarded(() => talk(sources, state, scopeKey, present, marked, budget * SHARE.talk, options.timeZone, unspeakable)), budget * SHARE.talk, 'newest'),
      part('〈いま追っていることに近い記憶〉', guarded(() => recalled(sources, state, scopeKey, at, topic, present, options.timeZone, unspeakable, secret).map(shown)), budget * SHARE.recalled),
      // The people she remembers: for her thinking, and for her writing without what the gate of a message withholds. A message is not given them.
      ...(alone || mode === 'writing' ? [part('〈覚えている人〉', guarded(() => people(sources, state, scopeKey, topic, guest, alone)), budget * SHARE.people)] : []),
      part('〈今日の関心〉', guarded(() => focus(sources, gate, scopeKey, at, options.timeZone, marked, unspeakable)), budget * SHARE.focus),
    ].filter(Boolean);
    if (!parts.length) return null;
    const section = [mode === 'writing' ? OWNER_CONTEXT_WRITING_HEADER : OWNER_CONTEXT_HEADER, ...parts].join('\n');
    if (!unspeakable) return { section, secrets: [] };
    // Without the list of what must reach nobody else her free text could not be checked: then she is given no block at all.
    try {
      return { section, secrets: secrets(sources, state, scopeKey, unspeakable) };
    } catch { return null; }
  };
  return {
    forThinking: (scopeKey, at, topic) => build(scopeKey, at, topic, 'thinking'),
    forWriting: (scopeKey, at, topic) => build(scopeKey, at, topic, 'writing'),
    forMessage: (scopeKey, at, topic, others) => build(scopeKey, at, topic, others ? 'message_others' : 'message'),
  };
}

/** A part that cannot be read is left out; the rest of the block stands. */
function guarded(read: () => string[]): string[] {
  try { return read(); } catch { return []; }
}

/**
 * The lines that fit the part's share, under its title; nothing when no line fits. Lines are kept from the front,
 * or, for a list whose newest lines are last (`newest`), from the end.
 */
function part(title: string, lines: readonly string[], characters: number, keep: 'first' | 'newest' = 'first'): string {
  const kept: string[] = [];
  let used = 0;
  for (const line of keep === 'newest' ? [...lines].reverse() : lines) {
    const text = clip(line, LINE_CHARACTERS);
    if (!text) break;
    // A first line longer than the share is cut to it, so a long list of names does not empty the part.
    if (used + text.length > characters) {
      if (!kept.length && characters >= 24) kept.push(clip(text, Math.floor(characters)));
      break;
    }
    kept.push(text);
    used += text.length;
  }
  if (keep === 'newest') kept.reverse();
  return kept.length ? [title, ...kept].join('\n') : '';
}

/** What she knows about him: facts, relationships, open promises, interests, and, alone, the answers of the profile projection. */
function about(sources: OwnerContextSources, gate: DisclosureGate, state: CompanionStateSnapshot, scopeKey: string, alone: boolean, marked: boolean, secret: ReadonlySet<string>): string[] {
  const disclosed = gate.snapshot();
  const line = (id: string, original: string, stored: Parameters<DisclosureGate['marker']>[1], prefix = '') => {
    const text = visibleMemoryText(state, id, original);
    // Her thinking sees a secret with its mark; nothing else is given it at all.
    if (!text || (!alone && secret.has(id))) return [];
    return [`- ${alone && secret.has(id) ? OWNER_CONTEXT_SECRET_MARK : ''}${marked ? gate.marker(id, stored) : ''}${prefix}${text}`];
  };
  const newest = <T extends { observedAt?: string; createdAt?: string }>(items: readonly T[]) =>
    [...items].sort((left, right) => (right.observedAt ?? right.createdAt ?? '').localeCompare(left.observedAt ?? left.createdAt ?? ''));
  const interests = filterMeaningfulInterests(disclosed.interests).flatMap(interest => visibleMemoryText(state, memoryIdentifier('interest', interest), interest) ?? []).slice(0, 6);
  const lines = [
    ...newest(disclosed.userFacts).flatMap(item => line(item.id, item.statement, item.disclosure)),
    ...newest(disclosed.relationships).flatMap(item => line(item.id, item.statement, item.disclosure)),
    // A promise goes with the turn it was made in, as in the conversation's own prompt.
    ...newest(disclosed.prospectiveMemories.filter(item => item.status === 'pending'
      && (!item.sourceExperienceId || visibleMemoryText(state, item.sourceExperienceId, item.summary) !== null)))
      .flatMap(item => line(item.id, item.summary, item.disclosure, '約束: ')),
    ...(interests.length ? [`- ${marked ? UNLABELLED_DISCLOSURE_MARKER : ''}最近の関心: ${interests.join('、')}`] : []),
  ];
  // The projection is already filtered for forgetting and corrections; it has no labels, so it is for her thinking only.
  // An answer that only repeats a fact above is not listed twice.
  const answers = alone ? projectionAnswers(sources.profile?.promptProjection(scopeKey) ?? '').filter(answer => !lines.some(known => known.includes(answer.answer))) : [];
  // An answer has no label of its own: it is secret when it says what a secret item says.
  const secretWords = [...state.userFacts, ...state.relationships].filter(item => secret.has(item.id)).flatMap(item => [item.statement, visibleMemoryText(state, item.id, item.statement) ?? '']).filter(Boolean);
  return [...lines, ...answers.map(item => `- ${secretWords.some(words => item.answer.includes(words) || words.includes(item.answer)) ? OWNER_CONTEXT_SECRET_MARK : ''}${item.question === item.answer ? item.answer : `${item.question}: ${item.answer}`}`)];
}

/** The `[User knowledge]` lines of the profile projection as question and answer, without their bookkeeping. */
function projectionAnswers(projection: string): { question: string; answer: string }[] {
  const start = projection.indexOf('[User knowledge]\n');
  if (start < 0) return [];
  const body = projection.slice(start + '[User knowledge]\n'.length).split('\n\n[')[0] ?? '';
  return body.split('\n').filter(line => line.startsWith('- ')).flatMap(line => {
    const text = line.slice(2).replace(/\s*\(confidence [^)]*\)\s*$/u, '');
    const cut = text.indexOf(': ');
    return cut > 0 ? [{ question: text.slice(0, cut), answer: text.slice(cut + 2) }] : [];
  });
}

/** The newest messages of the most recent Talks, through the replay the reply model gets: forgetting and disclosure first, a character budget second. */
function talk(sources: OwnerContextSources, state: CompanionStateSnapshot, scopeKey: string, present: MemoryAudience, marked: boolean, characters: number, timeZone: string, unspeakable: Unspeakable | null): string[] {
  const lines: string[] = [];
  let left = Math.floor(characters);
  for (const thread of sources.conversations.listThreads(scopeKey).slice(0, RECENT_THREADS)) {
    if (left < 40) break;
    const replayed = visibleReplayMessages(state, sources.conversations, scopeKey, thread.threadId, present, 60).messages;
    // Outside her thinking only completed turns are replayed. A message of hers that belongs to no turn (one she started, a
    // reminder, the summary of a call) has no label to be judged by, and may speak of something secret.
    const turns = unspeakable ? null : new Set((sources.conversations.experiencesById?.(scopeKey, [...new Set(replayed.flatMap(entry => entry.message.sourceExperienceId ?? []))]) ?? []).map(turn => turn.id));
    const visible = turns ? replayed.filter(entry => entry.message.sourceExperienceId !== undefined && turns.has(entry.message.sourceExperienceId)) : replayed;
    const withheld = new Set(unspeakable ? visible.filter(entry => !unspeakable.gate.allowsMessage(entry.message)).map(entry => entry.message.id) : []);
    for (const entry of visible) if (withheld.has(entry.message.id)) unspeakable!.words.push(entry.message.content);
    // With someone else present the user side carries the marker the gate gave it; otherwise the stored words as they are.
    // Her thinking sees a secret turn with its mark.
    const items: ShannonConversationItem[] = visible.map(entry => ({
      role: entry.message.role, content: `${withheld.has(entry.message.id) ? OWNER_CONTEXT_SECRET_MARK : ''}${marked ? entry.item.content : entry.message.content}`,
    }));
    const window = replayWindow(items, {
      budgetCharacters: left, maximumMessages: 40, minimumMessages: 0, recentCharacters: MESSAGE_CHARACTERS, olderCharacters: MESSAGE_CHARACTERS, spoken: true,
    });
    if (!window.history.length) continue;
    const last = visible.at(-1)?.message.observedAt;
    if (lines.length) lines.push('（別のTalk）');
    if (last) lines.push(`（最後のやりとり: ${day(last, timeZone)}）`);
    lines.push(...window.history.map(item => `${item.role === 'user' ? SHANNON_OWNER_NAME : 'ボク'}: ${item.content}`));
    left -= window.characters;
  }
  return lines;
}

/** Memories that fit what she is pursuing, by the deterministic recall of a turn: no model, the same gates. */
function recalled(sources: OwnerContextSources, state: CompanionStateSnapshot, scopeKey: string, at: string, topic: string, present: MemoryAudience, timeZone: string, unspeakable: Unspeakable | null, secret: ReadonlySet<string>): string[] {
  if (!topic.trim()) return [];
  const candidates = sources.people?.recall(scopeKey, state, topic, present).candidates ?? [];
  const secretPeople = new Set(candidates.filter(item => storedSecret(item.disclosure)).map(item => item.id));
  const context = prepareTurnCognitiveContext(state, sources.conversations, {
    scopeKey, message: topic, occurredAt: at, channel: 'text', present, timeZone, locationLabels: [],
    // Outside her thinking, what was said with an unnamed guest present is not even a candidate.
    additionalCandidates: unspeakable ? candidates : candidates.filter(item => !secretPeople.has(item.id)),
  });
  const isSecret = (id: string) => secret.has(id) || secretPeople.has(id) || Boolean(unspeakable && !unspeakable.gate.allowsRecallId(id));
  for (const memory of unspeakable ? context.memories : []) if (isSecret(memory.id)) unspeakable!.words.push(memory.summary);
  return context.memories.filter(memory => unspeakable || !secret.has(memory.id))
    .map(memory => `- ${unspeakable && isSecret(memory.id) ? OWNER_CONTEXT_SECRET_MARK : ''}(${memory.observedAt.slice(0, 10)}) ${memory.summary}`);
}

/**
 * Who she remembers, and what was last talked about with them. Her thinking sees all of it, a secret with its mark; her
 * writing only what the gate of an unnamed guest lets through and what was not said with an unnamed guest present.
 */
function people(sources: OwnerContextSources, state: CompanionStateSnapshot, scopeKey: string, topic: string, guest: DisclosureGate, alone: boolean): string[] {
  if (!sources.people) return [];
  const known = sources.people.listPeople(scopeKey).filter(person => !person.forgottenAt).slice(0, 8);
  const secret = (item: { recallId: string; disclosure: MemoryDisclosure }) => storedSecret(item.disclosure) || !guest.allows(item.recallId, item.disclosure);
  const items = [...sources.people.recall(scopeKey, state, topic, OWNER_AUDIENCE).items].filter(item => item.kind !== 'turn')
    .filter(item => alone || !secret(item))
    .sort((left, right) => right.observedAt.localeCompare(left.observedAt)).slice(0, 4);
  return [
    ...(known.length ? [`- ${known.map(person => `${person.displayName}さん`).join('、')}`] : []),
    ...items.map(item => `- ${alone && secret(item) ? OWNER_CONTEXT_SECRET_MARK : ''}(${item.observedAt.slice(0, 10)} ${item.audienceLabel}) ${item.text.replace(/\n/gu, ' / ')}`),
  ];
}

/** Today's focus: hers, built from his interests. Dropped when it repeats something that must not reach this audience. */
function focus(sources: OwnerContextSources, gate: DisclosureGate, scopeKey: string, at: string, timeZone: string, marked: boolean, unspeakable: Unspeakable | null): string[] {
  const current = sources.dailyMind?.currentFocus(scopeKey, at, timeZone);
  if (!current) return [];
  const text = `${current.topic}（${current.reason}）`;
  if (unspeakable?.gate.mentionsWithheld(text)) unspeakable.words.push(current.topic, current.reason);
  return gate.mentionsWithheld(text) ? [] : [`- ${marked ? UNLABELLED_DISCLOSURE_MARKER : ''}${text}`];
}

/**
 * The words of everything that must reach nobody but the owner, by the rule a conversation with an unnamed guest
 * applies: what her thinking was just shown that this rule withholds, then every stored item, recent turn and person
 * memory it withholds. They are returned for checking her own free text and nothing else.
 */
function secrets(sources: OwnerContextSources, state: CompanionStateSnapshot, scopeKey: string, unspeakable: Unspeakable): string[] {
  const { gate } = unspeakable;
  // Whatever of his state a conversation with an unnamed guest would not be given: an item withheld by its own label, and
  // one derived from a withheld turn, whatever its own label says. Each with its wording as stored and as she is shown it.
  const kept = gate.snapshot();
  const secret = protectedIds(state, gate);
  const worded = (id: string, text: string, evidence?: string) => [text, visibleMemoryText(state, id, text) ?? '', evidence ?? ''];
  const items = [
    ...state.userFacts.filter(item => secret.has(item.id)).flatMap(item => worded(item.id, item.statement, item.evidence)),
    ...state.relationships.filter(item => secret.has(item.id)).flatMap(item => worded(item.id, item.statement, item.evidence)),
    ...state.prospectiveMemories.filter(item => secret.has(item.id)).flatMap(item => worded(item.id, item.summary)),
    ...state.interests.filter(interest => !kept.interests.includes(interest)),
  ];
  // A turn is withheld with its own label, and also when a secret was in front of her when she answered it.
  const turns = sources.conversations.experienceCandidates(scopeKey).filter(turn => storedSecret(turn.disclosure) || !gate.allowsTurn(turn))
    .flatMap(turn => [turn.userMessage, turn.shannonReply]);
  const told = sources.people ? sources.people.recall(scopeKey, state, '', OWNER_AUDIENCE).items
    .filter(item => storedSecret(item.disclosure) || !gate.allows(item.recallId, item.disclosure)).map(item => item.text) : [];
  const all = [...new Set([...unspeakable.words, ...items, ...told, ...turns].map(text => text.trim().slice(0, SECRET_CHARACTERS)).filter(Boolean))];
  // A list too long to check in full would leave some of it unchecked: then she is given no block.
  if (all.length > SECRETS_MAXIMUM) throw new Error('OWNER_CONTEXT_SECRETS_TOO_MANY');
  return all;
}

function clip(value: string, maximum: number): string {
  const text = value.replace(/\s+/gu, ' ').trim();
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

function day(at: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('ja-JP', { timeZone, month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
  } catch { return at.slice(0, 16); }
}
