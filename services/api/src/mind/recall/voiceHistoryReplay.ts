import { isOwnerOnly, type CompanionStateSnapshot, type MemoryAudience } from '@shannon/cognition';
import { earlierConversationSummaryInstructions } from '../../infra/models/chatModelSupport.js';
import { notePlanEvent } from '../../infra/models/anthropic/cacheWarmTurns.js';
import type { ConversationStore, ReplayChannel } from '../memory/memoryPorts.js';
import { MemoryWithholding, replaySummaryFor, visibleReplayMessages, type VisibleMessage } from '../memory/memoryVisibilityPorts.js';
import { DisclosureGate } from '../inhibition/disclosurePorts.js';
import type { ConversationReplay, ReplayRule, ToolTraceReader } from './conversationWindow.js';
import {
  coversLive, isOperatorNote, spokenItem, voiceHistorySummaryOn, voiceSummaryItem, voiceSummaryWanted, voiceSummaryWindow, type VoiceWindow,
} from './voiceHistory.js';
import { liveConversation } from './replaySilence.js';

/**
 * The voice replay of the owner's decision of 2026-10-14 (`voiceHistory.ts`, `SHANNON_VOICE_HISTORY_SUMMARY`): read, judged and
 * rendered for one turn. `conversationReplay` (`conversationWindow.ts`) asks it first and replays its budget window when it answers
 * null (another channel, only open items, the switch off, or a store without epochs).
 */

/** What the replay of one turn reads (`conversationReplay`). */
export interface ReplayInput {
  state: CompanionStateSnapshot; store: ConversationStore; scopeKey: string; threadId: string; present: MemoryAudience;
  environment: Readonly<Record<string, string | undefined>>; tools: ToolTraceReader | undefined; rule: ReplayRule;
}

/** The trace block of the replayed turns from `start` (`conversationWindow.ts`), handed in so this module imports none of it. */
export type ReplayTraces = (tools: ToolTraceReader, state: CompanionStateSnapshot, store: ConversationStore, scopeKey: string, threadId: string,
  messages: readonly VisibleMessage[], start: number) => string;

/** A visible message as the voice summary replays it: its spoken text, operator notices and empty messages left out. */
function spokenEntries(messages: readonly VisibleMessage[]): VisibleMessage[] {
  return messages.flatMap(entry => {
    const content = isOperatorNote(entry.message) ? '' : spokenItem(entry.item.content);
    return content ? [{ ...entry, item: { role: entry.item.role, content } }] : [];
  });
}

/**
 * The voice summary's versions as this turn may use them: one that covers live messages, that no forget reached since its chain
 * started (`withholdsReplaySummary`, as the replay summary), and that the audience may hear (`allowsThreadSummary`, marked for
 * unlabelled text with others present). Built only from what the owner alone would be replayed (`voiceHistorySummary.ts`).
 */
function usableVoiceSummaries(input: ReplayInput, ids: readonly string[]) {
  const records = input.store.voiceSummaries?.(input.scopeKey, input.threadId) ?? [];
  const gate = new DisclosureGate(input.present, input.state, input.store, input.scopeKey);
  const allowed = records.length > 0 && gate.allowsThreadSummary(input.threadId);
  const withholding = new MemoryWithholding(input.state, input.store, input.scopeKey);
  const verdicts = new Map<number, boolean>();
  const usable = (version: number) => {
    const record = records.find(item => item.version === version);
    if (!record) return false;
    // Judged first: a forgotten turn also leaves the live messages, so a version it reached may no longer cover them.
    if (!verdicts.has(version)) verdicts.set(version, !withholding.withholdsReplaySummary(input.threadId, record));
    return verdicts.get(version)! && allowed && coversLive(record, ids) >= 0;
  };
  const newest = records.find(record => usable(record.version));
  const candidate = newest ? { version: newest.version, covered: coversLive(newest, ids) } : null;
  /** The versions a forget reached, among those judged this turn: deleted after the turn's synchronous work. */
  const forgotten = () => [...verdicts].flatMap(([version, clean]) => clean ? [] : [version]);
  return { records, marker: gate.unlabelledMarker, usable, candidate, forgotten };
}

/** The voice epoch of this turn, read and, at a cut, written; null when the store keeps none or fails. */
function voiceEpoch(input: ReplayInput, entries: readonly VisibleMessage[], summaries: ReturnType<typeof usableVoiceSummaries>): VoiceWindow | null {
  const { store, scopeKey, threadId } = input;
  if (!store.replayEpoch || !store.saveReplayEpoch || store.keepsReplayEpochs?.() === false) return null;
  let window: VoiceWindow | null;
  try {
    window = voiceSummaryWindow({ ids: entries.map(entry => entry.message.id), items: entries.map(entry => entry.item),
      budgetCharacters: input.rule.budgetCharacters, previous: store.replayEpoch(scopeKey, threadId, 'voice'),
      usable: summaries.usable, candidate: summaries.candidate, at: new Date().toISOString() });
  } catch { return null; }
  if (!window) return null;
  if (window.rebased) {
    try { store.saveReplayEpoch(scopeKey, threadId, 'voice', window.record); } catch { /* the next turn cuts again */ }
  }
  notePlanEvent('voice', window.rebased ? 'epoch_rebase' : 'epoch_kept');
  return window;
}

/**
 * The voice replay under the summary (`voiceHistory.ts`): the epoch's summary, then its exchanges. A turn whose next one will
 * pass the window's limit asks the background for a newer summary, after this turn's synchronous work (never before the reply).
 * Without a voice epoch (a store that keeps none), the window as without the summary; without a summary, what fell out of the
 * window is the replay summary's, in the turn's context, as before.
 */
export function summarizedVoiceReplay(
  channel: ReplayChannel, openOnly: boolean, input: ReplayInput, at: string | undefined, replayedToolTraces: ReplayTraces,
): ConversationReplay | null {
  const { state, store, scopeKey, threadId, present, environment, tools } = input;
  if (channel !== 'voice' || openOnly || !voiceHistorySummaryOn(environment)) return null;
  const visible = visibleReplayMessages(state, store, scopeKey, threadId, present, input.rule.maximumMessages + 1);
  const live = liveConversation('voice', visible.messages, at, environment);
  const entries = spokenEntries(live.messages);
  const summaries = usableVoiceSummaries(input, entries.map(entry => entry.message.id));
  const window = voiceEpoch(input, entries, summaries);
  if (!window) return null;
  if (voiceSummaryWanted(window)) askForVoiceSummary(store, scopeKey, threadId);
  forgetVoiceSummaries(store, scopeKey, threadId, summaries.forgotten());
  const frozen = window.summaryVersion ? summaries.records.find(record => record.version === window.summaryVersion) : undefined;
  const history = [...frozen ? [voiceSummaryItem(frozen.summary, summaries.marker)] : [], ...window.items];
  const toolBlock = tools && isOwnerOnly(present) ? replayedToolTraces(tools, state, store, scopeKey, threadId, entries, window.start) : '';
  const truncated = window.start > 0 || visible.reachedLimit || live.cut > 0;
  // Without a summary of its own, what the window left out is the replay summary's, as before (never for a long silence alone).
  const { stored, fallback } = !frozen && window.start > 0 ? replaySummaryBlock(input) : { stored: undefined, fallback: '' };
  return {
    history, start: window.start, characters: window.characters, truncated, ...(stored ? { summary: stored.text } : {}),
    epoch: { number: window.record.epoch, rebased: window.rebased },
    request: turnContext => {
      const context = [turnContext, live.line, fallback, toolBlock].filter(Boolean).join('\n\n');
      return { ...(context ? { turnContext: context } : {}), history };
    },
  };
}

/** The replay summary as the turn's context gives it (`earlierConversationSummaryInstructions`), as without the voice summary. */
function replaySummaryBlock(input: ReplayInput) {
  const stored = replaySummaryFor(input.state, input.store, input.scopeKey, input.threadId, input.present, 'voice');
  if (!stored) return { stored, fallback: '' };
  const limit = stored.structured ? Math.max(640, Array.from(stored.text).length) : undefined;
  return { stored, fallback: earlierConversationSummaryInstructions(stored.text, limit) };
}

/** Deletes the versions a forget reached, after this turn's synchronous work (the worker also does at its next run). */
function forgetVoiceSummaries(store: ConversationStore, scopeKey: string, threadId: string, versions: readonly number[]): void {
  if (!versions.length || !store.deleteVoiceSummaries) return;
  setImmediate(() => {
    try { store.deleteVoiceSummaries!(scopeKey, threadId, versions); } catch { /* the worker deletes them at its next run */ }
  });
}

/** Marks the thread's want for a newer voice summary once this turn's synchronous work is done: never before its request. */
function askForVoiceSummary(store: ConversationStore, scopeKey: string, threadId: string): void {
  if (!store.markVoiceSummaryWanted) return;
  const wantedAt = new Date().toISOString();
  setImmediate(() => {
    try { store.markVoiceSummaryWanted!(scopeKey, threadId, wantedAt); } catch { /* the next turn asks again */ }
  });
}
