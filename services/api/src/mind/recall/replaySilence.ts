import type { ReplayChannel } from '../memory/memoryPorts.js';
import type { VisibleMessage } from '../memory/memoryVisibilityPorts.js';
import { serverEnvironment } from '../../infra/config/serverEnvironment.js';

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * A long silence in a voice Talk (owner's Windows call, 2026-10-14: a new call joined a Talk whose last words, an Ender Dragon
 * request, were four days old, and she took them up as current). Voice only, and only where the turn gives its time.
 * - `cutoffMilliseconds` (`SHANNON_VOICE_REPLAY_GAP_HOURS`, 12): what was said before the newest silence this long is not replayed
 *   (recall still brings it back when his words are about it). Twelve hours: a night, never a pause within one conversation; and
 *   above the one-hour stable cache, so the cut moves only at a turn whose provider cache has expired anyway, then stays put.
 * - `markMilliseconds` (`SHANNON_VOICE_REPLAY_MARK_HOURS`, 3): an owner message after a silence this long is replayed with it
 *   (「[前のやり取りから約4時間後]」), from two stored times: bytes that never change between turns. The time since the newest
 *   message is said in the turn's own context only. `SHANNON_VOICE_REPLAY_GAP_HOURS=0` (or `off`) replays without either.
 */
export interface ReplayGapRule { cutoffMilliseconds: number; markMilliseconds: number }

const HOUR_MILLISECONDS = 3_600_000;

export function voiceReplayGap(environment: Environment = serverEnvironment()): ReplayGapRule | null {
  const value = environment.SHANNON_VOICE_REPLAY_GAP_HOURS?.trim().toLowerCase() ?? '';
  if (['0', 'off', 'false', 'disabled'].includes(value)) return null;
  const hours = (text: string | undefined, fallback: number, maximum: number) => {
    const parsed = text?.trim() ? Number(text) : Number.NaN;
    return Number.isFinite(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
  };
  const cutoff = hours(value, 12, 24 * 30);
  const mark = hours(environment.SHANNON_VOICE_REPLAY_MARK_HOURS, 3, cutoff);
  return { cutoffMilliseconds: cutoff * HOUR_MILLISECONDS, markMilliseconds: Math.min(mark, cutoff) * HOUR_MILLISECONDS };
}

/** 「約4時間」「約3日」. */
function elapsedWords(milliseconds: number): string {
  const hours = milliseconds / HOUR_MILLISECONDS;
  return hours < 24 ? `約${Math.max(1, Math.round(hours))}時間` : `約${Math.round(hours / 24)}日`;
}

/** Where the live conversation starts: after the newest silence of at least `cutoff`, the length when that silence is the one before `at`. */
export function afterLongSilence(times: readonly string[], at: string, cutoff: number): number {
  const gap = (from: string | undefined, to: string | undefined) => Date.parse(to ?? '') - Date.parse(from ?? '');
  if (times.length && gap(times.at(-1), at) >= cutoff) return times.length;
  for (let index = times.length - 1; index > 0; index -= 1) {
    if (gap(times[index - 1], times[index]) >= cutoff) return index;
  }
  return 0;
}

/** The replayed messages from the live conversation's start, an owner message after a silence marked with it; and the turn's line. */
export function silenceAwareMessages(messages: readonly VisibleMessage[], at: string, rule: ReplayGapRule): {
  messages: VisibleMessage[]; cut: number; line: string;
} {
  const cut = afterLongSilence(messages.map(entry => entry.message.observedAt), at, rule.cutoffMilliseconds);
  const kept = messages.slice(cut).map((entry, index) => {
    // The silence before the live conversation's first message is told too: the time of the message before it is stored as well.
    const before = messages[cut + index - 1]?.message.observedAt;
    const gap = before ? Date.parse(entry.message.observedAt) - Date.parse(before) : Number.NaN;
    if (entry.message.role !== 'user' || !(gap >= rule.markMilliseconds)) return entry;
    return { ...entry, item: { ...entry.item, content: `[前のやり取りから${elapsedWords(gap)}後] ${entry.item.content}` } };
  });
  const newest = messages.at(-1)?.message.observedAt;
  const since = newest ? Date.parse(at) - Date.parse(newest) : Number.NaN;
  const line = since >= rule.markMilliseconds
    ? `[会話の間] 前のやり取りは${elapsedWords(since)}前。いまの話はそこから続いているとは限らない。それより前の話題は、彼が触れたときだけ話す。` : '';
  return { messages: kept, cut, line };
}

/** The messages of the live conversation (`silenceAwareMessages`): a voice turn that gives its time; otherwise all, unchanged. */
export function liveConversation(channel: ReplayChannel, messages: readonly VisibleMessage[], at: string | undefined, environment: Environment) {
  const rule = channel === 'voice' && at ? voiceReplayGap(environment) : null;
  return rule && at ? silenceAwareMessages(messages, at, rule) : { messages: [...messages], cut: 0, line: '' };
}

