import { promiseStanding, restoreCompanionState, visibleMemoryText, type CompanionStateSnapshot, type ProspectiveMemory } from '@shannon/cognition';
import type { CandidateRow } from './initiativeSelection.js';
export { neutralCommitmentLine } from './commitmentLine.js';

const QUIET_START_HOUR = 23;
/** 「あとで」 re-arms exactly one later reminder, never sooner than this. */
export const SNOOZE_MILLISECONDS = 3 * 60 * 60_000;

function localParts(at: string, timeZone: string): { day: string; hour: number } | null {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(at)).map(part => [part.type, part.value]));
    return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
  } catch { return null; }
}

/** A date without a clock time becomes eligible in the part of the day the owner named. */
function eligibleHour(memory: ProspectiveMemory): number {
  const hint = memory.dueHint ?? '';
  return /今夜|今晩|明晩|夜|晩/u.test(hint) ? 19 : /夕方/u.test(hint) ? 17 : /昼|午後/u.test(hint) ? 12 : 9;
}

function visiblePending(state: CompanionStateSnapshot): ProspectiveMemory[] {
  return state.prospectiveMemories.filter(memory => memory.status === 'pending'
    && visibleMemoryText(state, memory.id, memory.summary)
    && (!memory.sourceExperienceId || visibleMemoryText(state, memory.sourceExperienceId, memory.summary)));
}

export function commitmentItemId(memory: ProspectiveMemory): string {
  return `commitment:${memory.id}:${memory.updatedAt}`;
}

/**
 * A promise that asks her only to speak up at a time (to wake him, call him, remind him): kept by telling him. 「結果を教えて」「調べて
 * 知らせて」 ask for something more than the notice of the time, and are never closed by it (review of the heart branch).
 */
const TELLING_REQUEST = /(?:起こして|声(?:を)?(?:かけて|掛けて)|リマインドして|思い出させて|呼んで)/u;

/**
 * Closes what she kept by telling him (owner 2026-10-19: a wake-up of 9:20 stayed an open promise for days): a pending request to be
 * told something at a time, whose notice was delivered at its time, is completed. Anything else stays pending; once its time is long
 * past it is no longer told as open (`promiseStanding`). Returns the ids it closed. Never throws.
 */
export function closeToldRequests(state: { snapshot(scopeKey: string): CompanionStateSnapshot; apply(scopeKey: string, event: {
  type: 'prospective-memory-status-changed'; memoryId: string; status: 'completed' }): unknown }, scopeKey: string, at: string,
  delivered: (scopeKey: string, itemId: string) => boolean): string[] {
  try {
    const told = visiblePending(state.snapshot(scopeKey))
      // Hours past its time (`PROMISE_PAST_HOURS`), so a 「あとで」 to the notice still re-arms it in the meantime (`resolveReminderReply`).
      .filter(memory => TELLING_REQUEST.test(memory.summary) && isDue(memory, at) && promiseStanding(memory, at) === 'past'
        && delivered(scopeKey, commitmentItemId(memory)));
    for (const memory of told) state.apply(scopeKey, { type: 'prospective-memory-status-changed', memoryId: memory.id, status: 'completed' });
    return told.map(memory => memory.id);
  } catch { return []; }
}

function isDue(memory: ProspectiveMemory, at: string): boolean {
  if (memory.remindAfter && Date.parse(memory.remindAfter) > Date.parse(at)) return false;
  if (memory.dueAt) return Date.parse(memory.dueAt) <= Date.parse(at);
  if (!memory.dueDate) return false;
  const local = localParts(at, memory.timeZone ?? 'Asia/Tokyo');
  return Boolean(local) && local!.day >= memory.dueDate && local!.hour >= eligibleHour(memory);
}

/** A reminder is a proposal to resume a promise, never evidence of its completion. */
export type DueCommitmentCandidate = CandidateRow & { score: number; remind_after?: string | null; due_date?: string | null; eligible_at?: string | null };

/** The instant of an owner-local date at an hour (`YYYY-MM-DD`, 0..23) in a time zone, or null. */
export function zonedInstant(date: string, hour: number, timeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  if (!match) return null;
  const guess = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), hour);
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
      minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(guess)).map(part => [part.type, part.value]));
    const seen = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    return new Date(guess - (seen - guess)).toISOString();
  } catch { return null; }
}

function usualNotice(memory: ProspectiveMemory, at: string): string | null {
  const timeZone = memory.timeZone ?? 'Asia/Tokyo';
  const today = localParts(at, timeZone)?.day ?? memory.dueDate!;
  return zonedInstant(today > memory.dueDate! ? today : memory.dueDate!, eligibleHour(memory), timeZone);
}

export function dueCommitmentCandidate(scopeKey: string, raw: unknown, at: string): DueCommitmentCandidate[] {
  const state = restoreCompanionState(scopeKey, raw, at);
  return visiblePending(state).filter(memory => isDue(memory, at)).map(memory => ({
    item_id: commitmentItemId(memory), source_id: 'commitment',
    source_title: 'ふたりの約束', title: visibleMemoryText(state, memory.id, memory.summary)!, url: '',
    summary: memory.id, published_at: memory.dueAt ?? null, discovered_at: memory.updatedAt, score: 0.8,
    // 「あとで」 (snooze) asks for the reminder at remindAfter: its lateness counts from there (`commitmentFacts`).
    remind_after: memory.remindAfter ?? null, due_date: memory.dueDate ?? null,
    // A date-only promise's usual notice time on the day it is told (its date, or today when that is later, at the hour of its part
    // of the day): a 「あとで」 counts only when it asked for later than that (an older one is stale; review of 2b82e623).
    eligible_at: !memory.dueAt && memory.dueDate ? usualNotice(memory, at) : null,
  })).sort((a, b) => (a.published_at ?? a.discovered_at).localeCompare(b.published_at ?? b.discovered_at));
}

/**
 * The one-message-per-day slot belongs to a promise that becomes due later the
 * same day. Without this, a spontaneous topic at 07:00 would spend the slot
 * before a date-only promise is eligible at 09:00 and the promise would never
 * be mentioned. The daily limit, quiet hours and cooldown are unchanged.
 */
export function commitmentAwaitingTodaySlot(
  scopeKey: string, raw: unknown, at: string, ownerTimeZone: string, alreadyDelivered: (itemId: string) => boolean,
): boolean {
  const state = restoreCompanionState(scopeKey, raw, at);
  const today = localParts(at, ownerTimeZone);
  if (!today) return false;
  return visiblePending(state).some(memory => {
    if ((!memory.dueAt && !memory.dueDate) || isDue(memory, at) || alreadyDelivered(commitmentItemId(memory))) return false;
    // Step in quarter hours, the loop's own recheck interval, until quiet hours begin.
    for (let instant = Date.parse(at) + 15 * 60_000; ; instant += 15 * 60_000) {
      const local = localParts(new Date(instant).toISOString(), ownerTimeZone);
      if (!local || local.day !== today.day || local.hour >= QUIET_START_HOUR) return false;
      if (isDue(memory, new Date(instant).toISOString())) return true;
    }
  });
}
