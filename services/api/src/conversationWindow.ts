import { isOwnerOnly, type CompanionStateSnapshot, type MemoryAudience } from '@shannon/cognition';
import type { ShannonConversationItem } from './chatModel.js';
import { earlierConversationSummaryInstructions } from './chatModelSupport.js';
import type { ConversationStore } from './conversationStore.js';
import { usableReplaySummary, visibleReplayMessages, type VisibleMessage } from './memoryVisibility.js';
import { conversationSecrets, type SecretCheck } from './conversationSecrets.js';
import { UNLINKED_TURN, maskedTraceCalls, toolTracePrompt, traceLabel, type ToolTraceRecord } from './shannonToolTrace.js';
import { shannonTool } from './shannonTools.js';

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

/** Where the replay reads what her tools did in the replayed turns (`shannonToolTurns.ts`). */
export interface ToolTraceReader {
  traces(scopeKey: string, threadId: string, turnIds: readonly string[], since?: string): readonly ToolTraceRecord[];
}

/**
 * The replayed history of one owner-thread turn. Withholding and disclosure are applied first
 * (`visibleReplayMessages`), the budget second, so a forgotten or withheld turn is never replayed
 * and never counted.
 *
 * With `tools` and the owner alone, what her tools did in the replayed turns follows the system prompt as a block of
 * its own (`toolTracePrompt`), inside the budget: when it does not fit beside the window, older messages make room.
 * The caller passes `tools` only while the server itself knows nobody else is there (`toolTraceReader`). A trace goes
 * with its stored turn, and only while both his words and her reply of that turn are replayed, so a turn that is
 * withheld (also only his words, by evidence) or out of the window brings none; a turn not in the Talk (her reply was
 * cut off) brings its calls by time. Names and targets that now repeat what must reach nobody but the owner are masked.
 * The block is only in `request()`, the model's input; never with anyone else present.
 */
export function conversationReplay(
  channel: 'text' | 'voice', state: CompanionStateSnapshot, store: ConversationStore, scopeKey: string, threadId: string,
  present: MemoryAudience, environment: Readonly<Record<string, string | undefined>> = process.env, tools?: ToolTraceReader,
  /** Only what may be shown to anyone (a turn someone other than the owner wrote): no summary, no marked message. */
  openOnly = false,
): ConversationReplay {
  const rule = replayRule(channel, environment);
  const visible = visibleReplayMessages(state, store, scopeKey, threadId, present, rule.maximumMessages + 1);
  const items = openOnly ? openItems(visible.messages.map(entry => entry.item)) : visible.messages.map(entry => entry.item);
  let window = replayWindow(items, rule);
  const traced = (start: number) => tools && isOwnerOnly(present) ? replayedToolTraces(tools, state, store, scopeKey, threadId, visible.messages, start) : '';
  let toolBlock = traced(window.start);
  if (toolBlock && window.characters + toolBlock.length > rule.budgetCharacters) {
    window = replayWindow(items, { ...rule, budgetCharacters: Math.max(0, rule.budgetCharacters - toolBlock.length) });
    toolBlock = traced(window.start);
  }
  const truncated = window.start > 0 || visible.reachedLimit;
  // A summary has no label of its own: with others it is marked, so it is never given where only open items may be.
  const summary = truncated && !openOnly ? usableReplaySummary(state, store, scopeKey, threadId, present) : undefined;
  const history = window.history;
  return {
    ...window, truncated, ...(summary ? { summary } : {}),
    request: systemPrompt => ({
      systemPrompt: [summary ? `${systemPrompt}\n\n${earlierConversationSummaryInstructions(summary)}` : systemPrompt, toolBlock].filter(Boolean).join('\n\n'),
      history,
    }),
  };
}

/** The trace block of the replayed turns from `start`, newest first; replies are counted from the newest (notes are not replies). */
function replayedToolTraces(
  tools: ToolTraceReader, state: CompanionStateSnapshot, store: ConversationStore, scopeKey: string, threadId: string,
  messages: readonly VisibleMessage[], start: number,
): string {
  const inWindow = messages.slice(start);
  // A turn whose words are withheld (by evidence too) while her reply is still replayed brings no trace.
  const heard = new Set(messages.filter(entry => entry.message.role === 'user').map(entry => entry.message.sourceExperienceId));
  const replies = inWindow.filter(entry => entry.message.role === 'assistant' && entry.message.sourceExperienceId
    && !entry.message.sourceExperienceId.includes(':')).reverse();
  const turnIds = [...new Set(replies.map(entry => entry.message.sourceExperienceId!))];
  const since = inWindow[0]?.message.observedAt;
  let records: readonly ToolTraceRecord[];
  let secrets: SecretCheck | null;
  try {
    records = tools.traces(scopeKey, threadId, turnIds, since);
    if (!records.length) return '';
    try { secrets = conversationSecrets(state, store, scopeKey); } catch { secrets = null; }
  } catch { return ''; }
  const byTurn = new Map(records.map(record => [record.turnId, record]));
  const turns: Array<{ record: ToolTraceRecord; label: string; at: string }> = [];
  turnIds.forEach((turnId, index) => {
    const record = byTurn.get(turnId);
    const reply = replies.find(entry => entry.message.sourceExperienceId === turnId);
    if (record && heard.has(turnId)) turns.push({ record, label: traceLabel(index + 1), at: reply?.message.observedAt ?? record.recordedAt });
  });
  // A turn not in the Talk: what it wrote, moved or deleted really happened; what it only looked at is not told.
  for (const record of records) {
    if (!record.turnId.startsWith(UNLINKED_TURN) || (since !== undefined && record.recordedAt < since)) continue;
    const calls = record.calls.filter(call => shannonTool(call.tool)?.effect === 'write');
    if (calls.length) turns.push({ record: { ...record, calls }, label: traceLabel('unstored'), at: record.recordedAt });
  }
  turns.sort((left, right) => right.at.localeCompare(left.at));
  return toolTracePrompt(turns.map(turn => ({ record: { ...turn.record, calls: maskedTraceCalls(turn.record.calls, secrets) }, label: turn.label })));
}

/** The replayed messages without a marked one, and without any reply (one or several) that answered a marked message. */
export function openItems(items: readonly ShannonConversationItem[]): ShannonConversationItem[] {
  const open: ShannonConversationItem[] = [];
  let skipReplies = false;
  for (const item of items) {
    if (item.role === 'user') { skipReplies = item.content.includes('【機微:'); if (!skipReplies) open.push(item); continue; }
    if (!skipReplies && !item.content.includes('【機微:')) open.push(item);
  }
  return open;
}
