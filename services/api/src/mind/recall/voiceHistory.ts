import { switchOn } from '@shannon/switches';
import type { ShannonConversationItem } from '../../infra/models/chatModel.js';
import { OPERATOR_NOTE_KIND } from '../../contracts/operatorContract.js';
import type { ReplayEpochRecord, VoiceSummaryRecord } from '../memory/memoryPorts.js';

/**
 * The voice history of the owner's decision of 2026-10-14 (「要約してキャッシュ効くなら一番上のにしたい」;
 * `SHANNON_VOICE_HISTORY_SUMMARY`, default on, effective only with replay epochs and the voice plan): the last few exchanges,
 * after a summary of everything said before them in the call. Measured before it: 36–48 replayed messages a voice turn, and her
 * habits of the day before (how she opened, her interjections, her apologies) spread through them more strongly than her
 * instructions.
 *
 * Hysteresis, as the FCA history's D2: an epoch starts with the newest `lowMessages` (four exchanges) after the summary it
 * freezes (`ReplayEpochRecord.summaryVersion`), is only appended to, and is cut again once it holds more than `highMessages`
 * (eight exchanges) and a summary that covers what the cut leaves out is ready. Until one is ready (the background writes it after
 * a turn, `voiceHistorySummary.ts`) the epoch goes on, up to `hardMessages`; past that, or past the character budget, it is cut
 * with what there is, and the window then starts right after what the newest summary covers, so nothing falls between them.
 * Every turn of an epoch therefore repeats the previous turn's request up to its words (the plan's BP2), summary included.
 */
export const VOICE_HISTORY = Object.freeze({ lowMessages: 8, highMessages: 16, hardMessages: 24, readySlackMessages: 2 });

/** The summary as the window carries it, at most this long (its writer's own bound). */
export const VOICE_SUMMARY_CHARACTERS = 600;

/** The first replayed item when the epoch has a summary: a marked user turn, never her words and never his. */
export const VOICE_SUMMARY_HEADER = '[ここまでの通話のまとめ（前のやり取りを短くしたもの。引用ではない）]';

type Environment = Readonly<Record<string, string | undefined>>;

export function voiceHistorySummaryOn(environment: Environment): boolean {
  return switchOn(environment, 'SHANNON_REPLAY_EPOCHS') && switchOn(environment, 'SHANNON_CLAUDE_CACHE_PLAN_VOICE')
    && switchOn(environment, 'SHANNON_VOICE_HISTORY_SUMMARY');
}

/**
 * A notice of the operator's (`operator-note`): neutral text about Minecraft operations someone did on the owner's behalf,
 * stored in the Talk as `assistant` because the store has no other role. It is not her words, so the voice history and its
 * summary leave it out; what it says reaches a turn as facts through the workspace's notices (`promptLayout.ts`, a task's
 * outcome) and the task projection.
 */
export function isOperatorNote(message: { sourceExperienceId?: string }): boolean {
  return message.sourceExperienceId?.startsWith(`${OPERATOR_NOTE_KIND}:`) === true;
}

/** A spoken message as it is replayed: whitespace runs as one space, at most 600 characters, empty when nothing is left. */
export function spokenItem(content: string): string {
  const text = content.trim().replace(/\s+/gu, ' ');
  const characters = Array.from(text);
  return characters.length <= 600 ? text : characters.slice(0, 600).join('');
}

/** What a voice turn's window is computed from: the live conversation's messages (operator notices out), oldest first. */
export interface VoiceWindowInput {
  ids: readonly string[];
  items: readonly ShannonConversationItem[];
  budgetCharacters: number;
  previous: ReplayEpochRecord | undefined;
  /** Whether a version may still be replayed now (it exists, covers live messages, no forget reached it, the audience allows it). */
  usable(version: number): boolean;
  /** The newest version that may be replayed now, with where its cover ends (an index in `ids`); null without one. */
  candidate: { version: number; covered: number } | null;
  at: string;
}

export interface VoiceWindow {
  start: number;
  items: ShannonConversationItem[];
  characters: number;
  record: ReplayEpochRecord;
  rebased: boolean;
  /** The version replayed first; 0 for none. */
  summaryVersion: number;
}

const characterCount = (items: readonly ShannonConversationItem[]) => items.reduce((sum, item) => sum + item.content.length, 0);

/** Where a cut keeps from: the newest `lowMessages`. */
const cutTarget = (length: number) => Math.max(0, length - VOICE_HISTORY.lowMessages);

/** Whether a summary is ready for a cut: it covers all but the newest `lowMessages` (less a little slack for a late write). */
function summaryReady(input: VoiceWindowInput): boolean {
  return input.candidate !== null && input.candidate.covered >= cutTarget(input.items.length) - 1 - VOICE_HISTORY.readySlackMessages;
}

/** The epoch's window as it renders now, or null when it must be cut again. */
function continued(input: VoiceWindowInput): VoiceWindow | null {
  const previous = input.previous;
  if (!previous || previous.summaryVersion === undefined || previous.budgetCharacters !== input.budgetCharacters) return null;
  if (previous.summaryVersion > 0 && !input.usable(previous.summaryVersion)) return null;
  const start = input.ids.indexOf(previous.startMessageId);
  if (start < 0) return null;
  const items = input.items.slice(start);
  const characters = characterCount(items);
  if (characters > input.budgetCharacters || items.length > VOICE_HISTORY.hardMessages) return null;
  if (items.length > VOICE_HISTORY.highMessages && summaryReady(input)) return null;
  return { start, items, characters, record: previous, rebased: false, summaryVersion: previous.summaryVersion };
}

/** A new epoch: the newest `lowMessages` after a ready summary; otherwise from right after what the newest summary covers. */
function rebased(input: VoiceWindowInput): VoiceWindow {
  const length = input.items.length;
  const target = cutTarget(length);
  const covered = input.candidate?.covered ?? -1;
  let start = covered >= target - 1 ? target : Math.max(covered + 1, length - VOICE_HISTORY.highMessages);
  // The character budget, newest first; the newest `lowMessages` always stay.
  let characters = characterCount(input.items.slice(start));
  while (start < target && characters > input.budgetCharacters) {
    characters -= input.items[start]!.content.length;
    start += 1;
  }
  const summaryVersion = input.candidate?.version ?? 0;
  const record: ReplayEpochRecord = {
    epoch: (input.previous?.epoch ?? 0) + 1, startMessageId: input.ids[start]!, fullFromMessageId: input.ids[Math.max(start, target)]!,
    budgetCharacters: input.budgetCharacters, startedAt: input.at, summaryVersion,
  };
  return { start, items: input.items.slice(start), characters, record, rebased: true, summaryVersion };
}

/** The window of a voice turn under the summary (see `VOICE_HISTORY`); null when nothing can be replayed. */
export function voiceSummaryWindow(input: VoiceWindowInput): VoiceWindow | null {
  if (!input.items.length) return null;
  return continued(input) ?? rebased(input);
}

/** Whether the background should extend the summary now: the next turn will hold more than `highMessages`. */
export function voiceSummaryWanted(window: Pick<VoiceWindow, 'items'>): boolean {
  return window.items.length + 2 > VOICE_HISTORY.highMessages;
}

/** The summary as the first replayed item (`marker`: the disclosure gate's marker for unlabelled text with others present). */
export function voiceSummaryItem(summary: string, marker: string): ShannonConversationItem {
  return { role: 'user', content: `${VOICE_SUMMARY_HEADER}\n${marker}${summary}` };
}

/** Whether a stored version covers the live conversation: both its ends are among its messages, in order. */
export function coversLive(record: Pick<VoiceSummaryRecord, 'coversFromMessageId' | 'coveredThroughMessageId'>, ids: readonly string[]): number {
  const from = ids.indexOf(record.coversFromMessageId);
  const through = ids.indexOf(record.coveredThroughMessageId);
  return from >= 0 && through >= from ? through : -1;
}
