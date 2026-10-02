import type { CompanionStateSnapshot, MemoryAudience } from '@shannon/cognition';
import type { ShannonConversationItem } from './chatModel.js';
import { earlierConversationSummaryInstructions } from './chatModelSupport.js';
import type { ConversationStore } from './conversationStore.js';
import { usableReplaySummary, visibleReplayMessages } from './memoryVisibility.js';

/**
 * How much of a thread is replayed to the reply model. The window is a character budget, not a
 * message count: messages are taken newest first until the budget is full, so a thread of short
 * messages (a word game) replays hundreds of exchanges and a thread of long ones replays fewer.
 * What falls out is covered by the replay summary (`conversationReplaySummary.ts`).
 */
export interface ReplayRule {
  /** Characters of message text replayed. Filled newest first. */
  budgetCharacters: number;
  /** Never more messages than this, whatever their length. */
  maximumMessages: number;
  /** The newest messages are replayed even when they alone exceed the budget. */
  minimumMessages: number;
  /** Bound of one message among the newest `minimumMessages`. Absent: replayed exactly as stored. */
  recentCharacters?: number;
  /** Bound of one older message. */
  olderCharacters: number;
  /** Spoken text: whitespace runs become one space and an empty message is dropped. */
  spoken: boolean;
}

export const REPLAY_BUDGET_DEFAULT = 12_000;
export const REPLAY_BUDGET_MINIMUM = 2_000;
export const REPLAY_BUDGET_MAXIMUM = 60_000;
export const REPLAY_MAXIMUM_MESSAGES = 400;
/** Bound of the replay summary given to a model. */
export const REPLAY_SUMMARY_CHARACTERS = 600;

/**
 * Text chat: the newest 20 messages exactly as stored (the rule before the budget existed, so a
 * short thread sends the same bytes), then older messages clipped to 1,500 characters while the
 * budget lasts.
 */
export function textReplayRule(budgetCharacters = REPLAY_BUDGET_DEFAULT): ReplayRule {
  return { budgetCharacters, maximumMessages: REPLAY_MAXIMUM_MESSAGES, minimumMessages: 20, olderCharacters: 1_500, spoken: false };
}

/** Voice: every message clipped to 600 characters as before; the newest 8 (the old maximum) always. */
export function voiceReplayRule(budgetCharacters = REPLAY_BUDGET_DEFAULT): ReplayRule {
  return { budgetCharacters, maximumMessages: REPLAY_MAXIMUM_MESSAGES, minimumMessages: 8, recentCharacters: 600, olderCharacters: 600, spoken: true };
}

/** `SHANNON_CONVERSATION_REPLAY_CHARACTERS` and `SHANNON_VOICE_REPLAY_CHARACTERS`, each held to 2,000…60,000. */
export function replayBudgets(environment: Readonly<Record<string, string | undefined>> = process.env): { text: number; voice: number } {
  return {
    text: boundedBudget(environment.SHANNON_CONVERSATION_REPLAY_CHARACTERS),
    voice: boundedBudget(environment.SHANNON_VOICE_REPLAY_CHARACTERS),
  };
}

function boundedBudget(value: string | undefined): number {
  const parsed = value?.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return REPLAY_BUDGET_DEFAULT;
  return Math.min(REPLAY_BUDGET_MAXIMUM, Math.max(REPLAY_BUDGET_MINIMUM, Math.trunc(parsed)));
}

export function replayRule(channel: 'text' | 'voice', environment: Readonly<Record<string, string | undefined>> = process.env): ReplayRule {
  const budgets = replayBudgets(environment);
  return channel === 'text' ? textReplayRule(budgets.text) : voiceReplayRule(budgets.voice);
}

export interface ReplayWindow {
  history: ShannonConversationItem[];
  /** Index in the input of the oldest replayed message; the input length when nothing is replayed. */
  start: number;
  /** Characters of message text in `history`. */
  characters: number;
}

/** The newest contiguous run of `messages` (oldest first) that the rule replays. */
export function replayWindow(messages: readonly ShannonConversationItem[], rule: ReplayRule): ReplayWindow {
  const history: ShannonConversationItem[] = [];
  let characters = 0;
  let start = messages.length;
  for (let index = messages.length - 1; index >= 0 && history.length < rule.maximumMessages; index -= 1) {
    const message = messages[index]!;
    const recent = history.length < rule.minimumMessages;
    const content = bounded(message.content, recent ? rule.recentCharacters : rule.olderCharacters, rule.spoken);
    if (!content) { start = index; continue; }
    if (!recent && characters + content.length > rule.budgetCharacters) break;
    history.push({ role: message.role, content });
    characters += content.length;
    start = index;
  }
  return { history: history.reverse(), start, characters };
}

function bounded(content: string, limit: number | undefined, spoken: boolean): string {
  const text = spoken ? content.trim().replace(/\s+/gu, ' ') : content;
  if (limit === undefined || text.length <= limit) return text;
  const characters = Array.from(text);
  if (characters.length <= limit) return text;
  return spoken ? characters.slice(0, limit).join('') : `${characters.slice(0, limit - 1).join('')}…`;
}

export interface ConversationReplay extends ReplayWindow {
  /** Earlier visible messages exist that are not replayed. */
  truncated: boolean;
  /** The replay summary, present only when the window is truncated and the summary may be used here. */
  summary?: string;
  /** The model request fields: the history, and the system prompt with the summary block when there is one. */
  request(systemPrompt: string): { systemPrompt: string; history: ShannonConversationItem[] };
}

/**
 * The replayed history of one owner-thread turn. Withholding and disclosure are applied first
 * (`visibleReplayMessages`), the budget second, so a forgotten or withheld turn is never replayed
 * and never counted.
 */
export function conversationReplay(
  channel: 'text' | 'voice', state: CompanionStateSnapshot, store: ConversationStore, scopeKey: string, threadId: string,
  present: MemoryAudience, environment: Readonly<Record<string, string | undefined>> = process.env,
): ConversationReplay {
  const rule = replayRule(channel, environment);
  const visible = visibleReplayMessages(state, store, scopeKey, threadId, present, rule.maximumMessages + 1);
  const window = replayWindow(visible.messages.map(entry => entry.item), rule);
  const truncated = window.start > 0 || visible.reachedLimit;
  const summary = truncated ? usableReplaySummary(state, store, scopeKey, threadId, present) : undefined;
  return {
    ...window, truncated, ...(summary ? { summary } : {}),
    request: systemPrompt => ({
      systemPrompt: summary ? `${systemPrompt}\n\n${earlierConversationSummaryInstructions(summary)}` : systemPrompt,
      history: window.history,
    }),
  };
}
