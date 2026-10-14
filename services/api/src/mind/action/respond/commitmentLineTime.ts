/**
 * The canonical words for a promise's time (`say_time_as`), as the server writes them in the fact sentence of its notice
 * (`commitmentLine.ts`). She never writes a time (owner decision 2026-10-14, by form: 「事実は決まった文＋シャノンの一言」).
 *
 * 05:00–11:59 as written (9時20分), noon 昼の12時, 13:00–17:59 午後 (午後2時), 18:00–23:59 夜の (夜の9時20分), 00:00–04:59 夜中の
 * (夜中の0時20分, 夜中の1時). The second phrase is the 24-hour form, for reference.
 */
export interface CommitmentClockFacts {
  /** Owner-local 「HH:MM」 when the promise has a clock time; anything else (「今日」) means it has none. */
  when: string | null;
}

function clockOf(when: string | null): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(when ?? '');
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

/** The phrases for the promise's time, the first being the fact sentence's; none without a clock time. */
export function canonicalTimePhrases(facts: CommitmentClockFacts): string[] {
  const clock = clockOf(facts.when);
  if (!clock) return [];
  const minute = clock.minute === 0 ? '時' : `時${clock.minute}分`;
  const full = `${clock.hour}${minute}`;
  if (clock.hour >= 5 && clock.hour < 12) return [full];
  if (clock.hour < 5) return [`夜中の${clock.hour}${minute}`, full];
  if (clock.hour === 12) return [`昼の12${minute}`, full];
  if (clock.hour < 18) return [`午後${clock.hour - 12}${minute}`, full];
  return [`夜の${clock.hour - 12}${minute}`, full];
}
