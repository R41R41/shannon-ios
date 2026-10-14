import type { FeelingAudience, FeelingChannel, FeelingEvent, ReplyHabit, ReplyOpener } from './feelingEvent.js';

/**
 * The repetition watch v0 (Syzygy ADR-0013 D9): of her own recent words in front of one audience, how they opened (「ライ氏、」,
 * 「ひゃっ」), her habits (「えへへ」) and the drawers she reached into twice in a row. Pure; counted from the closed facts of her
 * own reply events (never her words). The watch is per audience: what she said to the owner alone is not counted in front of others.
 * 2026-10-14: twelve of fourteen replies opened with 「ライ氏、」 and every touch line with 「ひゃっ」.
 */
export interface RepetitionWatch {
  audience: FeelingAudience;
  /** How many of her replies were looked at (the newest, at most `REPETITION_LIMITS.replies`). */
  replies: number;
  openers: Partial<Record<ReplyOpener, number>>;
  habits: Partial<Record<ReplyHabit, number>>;
  /** Touch lines (channel body) and how many of the last ones opened the same way in a row. */
  touchLines: number;
  touchOpenerRun: { opener: ReplyOpener; run: number } | null;
  /** A drawer used in each of her last two replies. */
  drawerRun: string | null;
}

export const REPETITION_LIMITS = Object.freeze({ replies: 8, touchLines: 5, overusedShare: 0.3, overusedHabit: 2 });

const OPENER_WORDS: Readonly<Record<ReplyOpener, string>> = Object.freeze({ rai_shi: '「ライ氏、」', hya: '「ひゃっ」', eh: '「えっ」', other: '' });
const HABIT_WORDS: Readonly<Record<ReplyHabit, string>> = Object.freeze({ ehehe: '「えへへ」', apology: '謝る言葉' });

function runOf(openers: readonly ReplyOpener[]): { opener: ReplyOpener; run: number } | null {
  const first = openers[0];
  if (!first || first === 'other') return null;
  let run = 0;
  while (run < openers.length && openers[run] === first) run += 1;
  return { opener: first, run };
}

/** The watch over her newest reply events (any order) for one audience. */
export function watchRepetition(events: readonly FeelingEvent[], audience: FeelingAudience): RepetitionWatch {
  const own = events.filter(event => event.kind === 'own_reply' && event.audience === audience)
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  const of = (channels: readonly FeelingChannel[], limit: number) => own.filter(event => channels.includes(event.channel)).slice(0, limit);
  const replies = of(['text', 'voice'], REPETITION_LIMITS.replies);
  const touchLines = of(['body'], REPETITION_LIMITS.touchLines);
  const openers: Partial<Record<ReplyOpener, number>> = {};
  const habits: Partial<Record<ReplyHabit, number>> = {};
  for (const event of replies) {
    const opener = event.facts.opener ?? 'other';
    openers[opener] = (openers[opener] ?? 0) + 1;
    for (const habit of event.facts.habits ?? []) habits[habit] = (habits[habit] ?? 0) + 1;
  }
  const [last, before] = [...replies, ...touchLines].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  const drawerRun = last?.facts.drawers?.find(kind => before?.facts.drawers?.includes(kind)) ?? null;
  return { audience, replies: replies.length, openers, habits, touchLines: touchLines.length,
    touchOpenerRun: runOf(touchLines.map(event => event.facts.opener ?? 'other')), drawerRun };
}

/** What she should not lean on again: openers over the share, habits used twice or more, a touch opener twice in a row, a drawer twice. */
export function repetitionLine(watch: RepetitionWatch): string {
  const overused = (Object.entries(watch.openers) as [ReplyOpener, number][])
    .filter(([opener, count]) => opener !== 'other' && watch.replies > 1 && count / watch.replies > REPETITION_LIMITS.overusedShare)
    .map(([opener, count]) => `書き出し${OPENER_WORDS[opener]}が直近${watch.replies}件中${count}件`);
  const habits = (Object.entries(watch.habits) as [ReplyHabit, number][]).filter(([, count]) => count >= REPETITION_LIMITS.overusedHabit)
    .map(([habit, count]) => `${HABIT_WORDS[habit]}が${count}件`);
  const run = watch.touchOpenerRun;
  const touch = run && run.run >= 2 ? [`触れられた時のひとことが${OPENER_WORDS[run.opener]}で${run.run}回続いた`] : [];
  const drawer = watch.drawerRun ? ['同じ切り返しが2回続いた'] : [];
  const found = [...overused, ...habits, ...touch, ...drawer];
  return found.length ? `最近使った言い方: ${found.join('、')}。同じ書き出し・口癖・切り返しは、今回は避ける。` : '';
}

/** The watch as closed numbers for the chooser and the Observer. */
export function repetitionFacts(watch: RepetitionWatch): Record<string, number | string> {
  return {
    replies_seen: watch.replies, opener_rai_shi: watch.openers.rai_shi ?? 0, opener_hya: watch.openers.hya ?? 0, opener_eh: watch.openers.eh ?? 0,
    habit_ehehe: watch.habits.ehehe ?? 0, habit_apology: watch.habits.apology ?? 0, touch_opener_run: watch.touchOpenerRun?.run ?? 0,
    drawer_run: watch.drawerRun ?? 'none',
  };
}
