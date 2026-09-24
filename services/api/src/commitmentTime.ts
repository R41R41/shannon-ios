// Shared by the intent recognizer and deadline resolver, longest forms first.
export const COMMITMENT_DATE_SOURCE = '今日|明後日|あさって|明日|あした|来週の?[月火水木金土日]曜(?:日)?|[月火水木金土日]曜(?:日)?|(?:\\d{4}年)?\\d{1,2}月\\d{1,2}日';
export const COMMITMENT_VAGUE_SOURCE = '後で|あとで|次回|今度|今週末|来週末|来週|週末|旅行後|旅行のあと';
export const COMMITMENT_TEMPORAL_SOURCE = `(?:${COMMITMENT_DATE_SOURCE}|${COMMITMENT_VAGUE_SOURCE})`;

/** Resolve explicit calendar dates against the source utterance, never job time. */
export function commitmentDeadline(text: string, observedAt: string, timeZone = 'Asia/Tokyo'): {
  dueHint?: string; dueDate?: string; dueAt?: string; timeZone: string;
} {
  const parts = (date: Date) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(part => [part.type, part.value]));
  let local: Record<string, string>;
  try { local = parts(new Date(observedAt)); } catch { return { timeZone }; }
  const year = Number(local.year);
  const today = new Date(Date.UTC(year, Number(local.month) - 1, Number(local.day)));
  const temporal = text.match(new RegExp(COMMITMENT_DATE_SOURCE, 'u'));
  const vague = text.match(new RegExp(COMMITMENT_VAGUE_SOURCE, 'u'));
  if (!temporal) return { timeZone, ...(vague ? { dueHint: vague[0] } : {}) };
  const hint = temporal[0];
  const date = new Date(today);
  const explicit = hint.match(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日/u);
  const weekday = hint.match(/([月火水木金土日])曜/u);
  if (explicit) {
    date.setUTCFullYear(Number(explicit[1] ?? year), Number(explicit[2]) - 1, Number(explicit[3]));
    if (date.getUTCMonth() !== Number(explicit[2]) - 1 || date.getUTCDate() !== Number(explicit[3])) {
      return { timeZone, dueHint: hint };
    }
    // An omitted year is ambiguous when the date has passed; don't invent one.
    if (!explicit[1] && date < today) return { timeZone, dueHint: hint };
  } else if (weekday) {
    const target = '日月火水木金土'.indexOf(weekday[1]!);
    const offset = hint.startsWith('来週')
      ? 7 - ((today.getUTCDay() + 6) % 7) + ((target + 6) % 7)
      : (target - today.getUTCDay() + 7) % 7;
    date.setUTCDate(date.getUTCDate() + offset);
  } else {
    date.setUTCDate(date.getUTCDate() + (/明後日|あさって/u.test(hint) ? 2 : /明日|あした/u.test(hint) ? 1 : 0));
  }
  const dueDate = date.toISOString().slice(0, 10);
  const clock = text.match(/(午前|午後)?\s*(\d{1,2})(?:時(?:(\d{1,2})分|半)?|:(\d{2}))/u);
  if (!clock) return { dueHint: hint, dueDate, timeZone };
  let hour = Number(clock[2]);
  const minute = clock[3] ? Number(clock[3]) : clock[4] ? Number(clock[4]) : clock[0].endsWith('半') ? 30 : 0;
  if (clock[1] === '午後' && hour < 12) hour += 12;
  if (clock[1] === '午前' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return { dueHint: `${hint} ${clock[0]}`, dueDate, timeZone };
  const desired = date.getTime() + (hour * 60 + minute) * 60_000;
  let instant = desired;
  for (let attempt = 0; attempt < 3; attempt++) {
    const p = parts(new Date(instant));
    instant += desired - Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  }
  const check = parts(new Date(instant));
  const valid = `${check.year}-${check.month}-${check.day}` === dueDate
    && Number(check.hour) === hour && Number(check.minute) === minute;
  // During a DST overlap/nonexistent local time, keep the date/hint, not a guessed instant.
  const adjacent = [-3_600_000, 3_600_000].some(delta => {
    const p = parts(new Date(instant + delta));
    return `${p.year}-${p.month}-${p.day}` === dueDate && Number(p.hour) === hour && Number(p.minute) === minute;
  });
  return { dueHint: `${hint} ${clock[0]}`, dueDate, timeZone,
    ...(valid && !adjacent ? { dueAt: new Date(instant).toISOString() } : {}) };
}
