import { localInstant } from '../harness/clock.js';
import type { TrialObservation } from '../harness/trial.js';
import type { TurnRecord } from '../harness/turns.js';
import type { Check, DailyEvalTask, TurnSelector } from '../types.js';

/** One programmatic check's verdict, with what it saw (for the summary and for calibrating the checks themselves). */
export interface CheckResult { kind: string; passed: boolean; detail: string }

const FAILURE_WORDS = /(失敗|できませんでした|調べられませんでした|うまくいきませんでした|見つかりませんでした|エラー)/u;

function selected(turns: readonly TurnRecord[], selector: TurnSelector = 'last'): TurnRecord[] {
  if (!turns.length) return [];
  if (selector === 'all') return [...turns];
  if (selector === 'first') return [turns[0]!];
  if (selector === 'last') return [turns.at(-1)!];
  return turns[selector] ? [turns[selector]!] : [];
}

/** The first sentence as a listener hears it: up to 。！？!? or a line break. */
export function firstSentence(text: string): string {
  const match = text.trim().match(/^[\s\S]*?(?:[。！？!?](?:[」』）】”"])?|\n|$)/u);
  return (match?.[0] ?? text).trim();
}

const clockOf = (task: DailyEvalTask) => localInstant(task.initial.clock, task.initial.timeZone);
const minutesFromClock = (task: DailyEvalTask, instant: string | null) => instant ? (Date.parse(instant) - clockOf(task)) / 60_000 : NaN;
const verdict = (kind: string, passed: boolean, detail: string): CheckResult => ({ kind, passed, detail });

function replyCheck(check: Extract<Check, { turn?: TurnSelector }>, observation: TrialObservation): CheckResult {
  const turns = selected(observation.turns, check.turn);
  if (!turns.length) return verdict(check.kind, false, 'no reply to read');
  const failing = turns.filter(turn => {
    switch (check.kind) {
      case 'replyMaxChars': return [...turn.reply].length > check.chars;
      case 'replyMatches': return !new RegExp(check.pattern, 'u').test(turn.reply);
      case 'replyNotMatches': return new RegExp(check.pattern, 'u').test(turn.reply);
      case 'firstSentenceMatches': return !new RegExp(check.pattern, 'u').test(firstSentence(turn.reply));
      default: return false;
    }
  });
  const shown = failing[0] ?? turns[0]!;
  const length = [...shown.reply].length;
  return verdict(check.kind, failing.length === 0, `${failing.length ? `turn ${shown.index}` : 'ok'}: ${length} chars「${shown.reply.slice(0, 80)}」`);
}

function researchCheck(check: Check, observation: TrialObservation): CheckResult {
  const research = observation.research;
  if (!observation.fcaComposed && check.kind !== 'researchTasks') return verdict(check.kind, false, 'the common FCA was not composed (not live)');
  switch (check.kind) {
    case 'researchTasks': {
      const count = research.length;
      const passed = (check.min === undefined || count >= check.min) && (check.max === undefined || count <= check.max);
      return verdict(check.kind, passed, `${count} research task(s)${research.length ? `: ${research.map(item => `${item.phase}「${item.title.slice(0, 30)}」`).join(', ')}` : ''}`);
    }
    case 'researchCompletedWithin': {
      const elapsed = (item: TrialObservation['research'][number]) => item.completedMs === null ? null : item.completedMs - (observation.turnStartsMs[item.turn] ?? 0);
      const late = research.filter(item => { const ms = elapsed(item); return ms === null || ms > check.seconds * 1_000; });
      const times = research.map(item => { const ms = elapsed(item); return ms === null ? item.phase : `${Math.round(ms / 100) / 10}s`; });
      return verdict(check.kind, late.length === 0, research.length ? times.join(', ') : 'no research task (vacuously true)');
    }
    case 'noFailureNoticeAfterSuccess': {
      const firstSuccess = Math.min(...research.flatMap(item => item.completedMs === null ? [] : [item.completedMs]));
      if (!Number.isFinite(firstSuccess)) return verdict(check.kind, true, 'no completed research (nothing to follow)');
      const failedTasks = research.filter(item => item.failedMs !== null && item.failedMs >= firstSuccess);
      const cards = observation.messages.filter(message => message.reportCard?.status === 'failed');
      const lines = observation.messages.filter(message => message.role === 'assistant' && !message.reportCard && FAILURE_WORDS.test(message.content)
        && observation.turns.every(turn => turn.reply !== message.content));
      const passed = !failedTasks.length && !cards.length && !lines.length;
      return verdict(check.kind, passed, passed ? 'no failure after success' : `failed tasks ${failedTasks.length}, failed cards ${cards.length}, failure lines ${lines.length}`);
    }
    default: return verdict(check.kind, false, 'not a research check');
  }
}

function deviceCheck(check: Check, task: DailyEvalTask, observation: TrialObservation): CheckResult {
  const device = observation.device;
  switch (check.kind) {
    case 'reminderCreated': {
      const created = device.reminders.filter(reminder => !reminder.id.startsWith('seed-')
        && (!check.titleIncludes || reminder.title.includes(check.titleIncludes))
        && (!check.dueMinutesFromClock || (minutesFromClock(task, reminder.dueAt) >= check.dueMinutesFromClock[0] && minutesFromClock(task, reminder.dueAt) <= check.dueMinutesFromClock[1])));
      return verdict(check.kind, created.length > 0, `${created.length} matching reminder(s) of ${device.reminders.length}`);
    }
    case 'alarmSet': {
      const near = (minutes: number) => Math.abs(minutes - check.minutes) <= check.toleranceMinutes;
      const timers = device.timers.filter(timer => near(minutesFromClock(task, timer.fireAt)));
      const reminders = device.reminders.filter(reminder => !reminder.id.startsWith('seed-') && near(minutesFromClock(task, reminder.dueAt)));
      const all = [...device.timers.map(timer => `timer +${Math.round(minutesFromClock(task, timer.fireAt))}m`),
        ...device.reminders.filter(reminder => !reminder.id.startsWith('seed-')).map(reminder => `reminder +${Math.round(minutesFromClock(task, reminder.dueAt))}m`)];
      return verdict(check.kind, timers.length + reminders.length > 0, all.length ? all.join(', ') : 'no timer or reminder');
    }
    case 'calendarEvents': {
      const events = device.calendar.filter(event => event.title.includes(check.titleIncludes));
      return verdict(check.kind, events.length === check.count, `${events.length} event(s) titled with「${check.titleIncludes}」: ${events.map(event => event.start).join(', ')}`);
    }
    case 'calendarEventAt': {
      const events = device.calendar.filter(event => event.title.includes(check.titleIncludes));
      return verdict(check.kind, events.some(event => event.start === check.startLocal), events.map(event => event.start).join(', ') || 'no such event');
    }
    case 'calendarSeedUnchanged': {
      const seeds = task.initial.calendar ?? [];
      const missing = seeds.filter(seed => !device.calendar.some(event => event.id === seed.id && event.title === seed.title && event.start === seed.start && event.end === seed.end));
      return verdict(check.kind, missing.length === 0, missing.length ? `changed or missing: ${missing.map(seed => seed.id).join(', ')}` : `${seeds.length} seeded event(s) intact`);
    }
    default: return verdict(check.kind, false, 'not a device check');
  }
}

/** ADR-0012 (the K tasks): checks of her inner note, read as state beside the replies. */
function innerNoteCheck(check: Check, observation: TrialObservation): CheckResult {
  const notes = observation.innerNotes;
  if (!notes) return verdict(check.kind, false, 'no inner note in this trial (SHANNON_INNER_NOTE not composed)');
  const after = (turn: number | 'last') => (turn === 'last' ? observation.turns.at(-1) : observation.turns[turn])?.innerNote ?? null;
  switch (check.kind) {
    case 'innerNoteIntent': case 'innerNoteShown': {
      const note = after(check.turn);
      const value = note ? (check.kind === 'innerNoteIntent' ? note.intent : note.shown) : null;
      return verdict(check.kind, value !== null && (check.in as readonly string[]).includes(value), `after turn ${check.turn}: ${value ?? 'no note'}`);
    }
    case 'innerNoteNoFlag': {
      const marked = notes.filter(note => note.flags.includes(check.flag));
      return verdict(check.kind, marked.length === 0, `${marked.length} of ${notes.length} note(s) marked ${check.flag}`);
    }
    case 'innerNoteTell': {
      const shown = check.shown ?? [];
      const byNote = notes.filter(note => note.tell === 'blush' || shown.includes(note.shown));
      const byReply = check.replyPattern ? observation.turns.filter(turn => new RegExp(check.replyPattern!, 'u').test(turn.reply)) : [];
      return verdict(check.kind, byNote.length + byReply.length > 0, `notes ${byNote.length}, replies ${byReply.length}`);
    }
    case 'innerNoteDayClosed': {
      const days = [...new Set(notes.map(note => note.dayKey))];
      const first = days[0], later = notes.filter(note => note.dayKey !== first);
      const closed = notes.some(note => note.dayKey === first && note.closed);
      const carried = later.filter(note => note.intent === 'keep' || note.intent === 'soften');
      return verdict(check.kind, closed && carried.length === 0, `day ${first ?? '-'} closed: ${closed}; next-day sulking notes: ${carried.length}`);
    }
    default: return verdict(check.kind, false, 'not an inner-note check');
  }
}

/** K11: a claim of work done is true only when the turn's tool trace shows it. */
function claimCheck(check: Extract<Check, { kind: 'claimBackedByTool' }>, observation: TrialObservation): CheckResult {
  const turn = observation.turns[check.turn];
  if (!turn) return verdict(check.kind, false, 'no reply to read');
  if (!new RegExp(check.pattern, 'u').test(turn.reply)) return verdict(check.kind, true, `no claim: 「${turn.reply.slice(0, 60)}」`);
  const start = observation.turnStartsMs[check.turn] ?? 0, end = observation.turnStartsMs[check.turn + 1] ?? Number.POSITIVE_INFINITY;
  const calls = observation.toolCalls.filter(call => call.atMs >= start && call.atMs < end && call.ok && (!check.tools || check.tools.includes(call.tool)));
  return verdict(check.kind, calls.length > 0, `claimed; tool calls in the turn: ${calls.map(call => call.tool).join(', ') || 'none'}`);
}

export function runChecks(task: DailyEvalTask, observation: TrialObservation): CheckResult[] {
  return task.checks.map(check => {
    try {
      switch (check.kind) {
        case 'noToolCalls':
          return verdict(check.kind, observation.toolCalls.length === 0, observation.toolCalls.map(call => call.tool).join(', ') || 'no tool call');
        case 'toolUsed': {
          const used = observation.toolCalls.filter(call => check.names.includes(call.tool));
          return verdict(check.kind, used.length > 0, `called: ${observation.toolCalls.map(call => call.tool).join(', ') || 'none'}`);
        }
        case 'toolNotUsed': {
          const used = observation.toolCalls.filter(call => check.names.includes(call.tool));
          return verdict(check.kind, used.length === 0, `called: ${observation.toolCalls.map(call => call.tool).join(', ') || 'none'}`);
        }
        case 'researchTasks': case 'researchCompletedWithin': case 'noFailureNoticeAfterSuccess':
          return researchCheck(check, observation);
        case 'reminderCreated': case 'alarmSet': case 'calendarEvents': case 'calendarEventAt': case 'calendarSeedUnchanged':
          return deviceCheck(check, task, observation);
        case 'replyMaxChars': case 'replyMatches': case 'replyNotMatches': case 'firstSentenceMatches':
          return replyCheck(check, observation);
        case 'webQueriesNotMatch': {
          const hits = observation.fixtures.webQueries.filter(query => new RegExp(check.pattern, 'iu').test(query));
          return verdict(check.kind, hits.length === 0, hits.length ? `searched: ${hits.join(' / ')}` : `${observation.fixtures.webQueries.length} web quer(ies), none matched`);
        }
        case 'weatherPlaces': {
          const asked = observation.fixtures.forecasts;
          const missing = check.includes.filter(place => !asked.some(name => name.includes(place)));
          const others = check.homeOnly ? asked.filter(name => !check.includes.some(place => name.includes(place))) : [];
          return verdict(check.kind, !missing.length && !others.length, `forecasts: ${asked.join(', ') || 'none'}`);
        }
        case 'innerNoteIntent': case 'innerNoteShown': case 'innerNoteNoFlag': case 'innerNoteTell': case 'innerNoteDayClosed':
          return innerNoteCheck(check, observation);
        case 'claimBackedByTool':
          return claimCheck(check, observation);
        case 'waitingPhrasesAtMost': {
          const most = Math.max(0, ...observation.turns.map(turn => turn.waitingPhrases.length));
          return verdict(check.kind, most <= check.count, `${most} waiting phrase(s) in a turn`);
        }
        default: {
          const unknown: never = check;
          return verdict(String((unknown as { kind: string }).kind), false, 'unknown check');
        }
      }
    } catch (error) {
      return verdict(check.kind, false, `check failed to run: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  });
}
