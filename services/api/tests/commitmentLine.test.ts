import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SHANNON_ONE_LINE_VOICE_INNER } from '@shannon/cognition';
import {
  COMMITMENT_LINE_INSTRUCTIONS, PROMISE_PHRASES_V1, commitmentFactSentence, commitmentLineInstructions, commitmentMessage, commitmentRequest,
  neutralCommitmentLine, promisePhraseChoice, promisePhraseChoices, promisePhraseSchema, wakePromise, type CommitmentFacts, type CommitmentLineWriter,
  type PromisePhraseChoice,
} from '../src/mind/action/respond/commitmentLine.js';
import { commitmentFacts, commitmentLinePreparer } from '../src/wiring/commitmentLinesWiring.js';
import { dueCommitmentCandidate } from '../src/mind/action/respond/commitmentInitiative.js';
import { extractProspectiveMemories } from '../src/mind/memory/prospectiveMemory.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { SQLiteInitiativeStore } from '../src/surfaces/outreach/store/initiativeStore.js';
import { SQLiteInitiativeSources } from '../src/surfaces/outreach/store/initiativeSources.js';
import { apiSourceFile } from './support/sources.js';

/**
 * A promise's notice (owner decision 2026-10-14, by form: 「事実は決まった文＋シャノンの一言」): the server's fixed fact sentence
 * (its time, its exact words, how late), with one phrase of hers from a fixed list or none. No free text of hers reaches him.
 */
const directory = mkdtempSync(join(tmpdir(), 'shannon-commitment-line-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const SAID = '2026-09-24T01:00:00.000Z';
const NINE = '2026-09-25T00:00:00.000Z'; // 09:00 in Tokyo, the day after
const ALONE: CommitmentFacts = { title: '明日プレゼンの練習しよう', when: '今日', overdueMinutes: null, others: false };
const TIMED: CommitmentFacts = { title: '起こして', when: '09:20', overdueMinutes: 0, others: false };

describe('the fact sentence: fixed, neutral, always correct', () => {
  it('states the canonical time, the exact promise and how late, for on time, late, the night, noon, midnight and a date only', () => {
    expect(commitmentFactSentence(TIMED)).toBe('9時20分の約束：「起こして」');
    expect(commitmentFactSentence({ ...TIMED, overdueMinutes: 1 })).toBe('9時20分の約束：「起こして」');
    expect(commitmentFactSentence({ ...TIMED, overdueMinutes: 47 })).toBe('9時20分の約束：「起こして」（47分遅れのお知らせ）');
    expect(commitmentFactSentence({ ...TIMED, overdueMinutes: 125 })).toBe('9時20分の約束：「起こして」（2時間5分遅れのお知らせ）');
    expect(commitmentFactSentence({ ...TIMED, when: '21:20' })).toBe('夜の9時20分の約束：「起こして」');
    expect(commitmentFactSentence({ ...TIMED, when: '12:00' })).toBe('昼の12時の約束：「起こして」');
    expect(commitmentFactSentence({ ...TIMED, when: '14:30' })).toBe('午後2時30分の約束：「起こして」');
    expect(commitmentFactSentence({ ...TIMED, when: '00:20' })).toBe('夜中の0時20分の約束：「起こして」');
    expect(commitmentFactSentence({ ...TIMED, title: '薬を飲む', when: '23:30', overdueMinutes: 450, quietHeld: true }))
      .toBe('夜の11時30分の約束：「薬を飲む」（夜のあいだは控えていたため、7時からのお知らせ・7時間30分遅れ）');
    expect(commitmentFactSentence(ALONE)).toBe('今日の約束：「プレゼンの練習しよう」');
    // With anyone else there: the time, never the promise's words.
    expect(commitmentFactSentence({ ...TIMED, others: true })).toBe('9時20分の約束の時刻です（内容はアプリで確認できます）。');
    expect(neutralCommitmentLine({ ...ALONE, others: true })).not.toContain('プレゼン');
  });

  it('reads the facts from the promise itself: its time, how late, and whether the night held it', () => {
    expect(commitmentFacts({ title: '歯医者に電話する', published_at: '2026-09-25T05:00:00.000Z' }, '2026-09-25T05:20:00.000Z', 'Asia/Tokyo', false))
      .toEqual({ title: '歯医者に電話する', when: '14:00', overdueMinutes: 20, others: false });
    expect(commitmentFacts({ title: '薬を飲む', published_at: '2026-09-25T14:30:00.000Z' }, '2026-09-25T22:00:00.000Z', 'Asia/Tokyo', false))
      .toEqual({ title: '薬を飲む', when: '23:30', overdueMinutes: 450, others: false, quietHeld: true });
    expect(commitmentFacts({ title: '掃除', published_at: null }, NINE, 'Asia/Tokyo', false)).toEqual({ title: '掃除', when: '今日', overdueMinutes: null, others: false, dayLabel: '今日' });
    const source = readFileSync(apiSourceFile('initiativeStore.ts'), 'utf8');
    expect(source).not.toContain('という約束が残っています');
    expect(source).not.toContain('今、続けますか');
  });
});

describe('the review of f23a3c94: late with others, 「あとで」, a date only the next day, cheerful phrases', () => {
  it('with anyone else there says 「の約束の時刻です」 only on time; late, a notice with its lateness and the content hidden', () => {
    expect(commitmentFactSentence({ ...TIMED, others: true })).toBe('9時20分の約束の時刻です（内容はアプリで確認できます）。');
    expect(commitmentFactSentence({ ...TIMED, others: true, overdueMinutes: 47 })).toBe('9時20分の約束のお知らせです（47分遅れ・内容はアプリで確認できます）。');
    expect(commitmentFactSentence({ ...TIMED, title: '薬を飲む', when: '23:30', overdueMinutes: 450, quietHeld: true, others: true }))
      .toBe('夜の11時30分の約束のお知らせです（夜のあいだは控えていたため、7時からのお知らせ・7時間30分遅れ・内容はアプリで確認できます）。');
    expect(commitmentFactSentence({ ...TIMED, others: true, overdueMinutes: 47 })).not.toContain('起こして');
  });

  it('counts lateness from max(its time, 「あとで」): a reminder told when asked is not late and takes no late phrase', () => {
    const snoozed = { title: '起こして', published_at: '2026-10-14T00:20:00.000Z', remind_after: '2026-10-14T03:20:00.000Z' };
    const asked = commitmentFacts(snoozed, '2026-10-14T03:21:00.000Z', 'Asia/Tokyo', false);
    expect(asked).toEqual({ title: '起こして', when: '09:20', overdueMinutes: 1, others: false, deferredTo: '12:20' });
    expect(commitmentFactSentence(asked)).toBe('9時20分の約束：「起こして」（あとで、と頼まれていた分）');
    expect(promisePhraseChoices(asked).map(entry => entry.text)).not.toContain('…ごめん、遅れちゃった。');
    expect(commitmentMessage({ phrase: '…ごめん、遅れちゃった。', position: 'after' }, asked)).toBe('9時20分の約束：「起こして」（あとで、と頼まれていた分）');
    // Late from the time he asked for, not from 09:20, and that time is named.
    expect(commitmentFactSentence(commitmentFacts(snoozed, '2026-10-14T03:40:00.000Z', 'Asia/Tokyo', false))).toBe('9時20分の約束：「起こして」（昼の12時20分に、と頼まれていた分・20分遅れ）');
    // A 「あとで」 before its time changes nothing.
    expect(commitmentFacts({ ...snoozed, remind_after: '2026-10-14T00:00:00.000Z' }, '2026-10-14T00:30:00.000Z', 'Asia/Tokyo', false).overdueMinutes).toBe(10);
  });

  it('reads 「あとで」 from the stored promise: told at the time he asked for, with no lateness', async () => {
    const path = join(directory, `snooze-${Math.random().toString(36).slice(2)}.sqlite`);
    const state = new SQLiteShannonStore({ path, now: () => '2026-10-14T03:21:00.000Z' });
    const threadId = state.createThread('owner', 'いつものトーク');
    const memory = extractProspectiveMemories('明日9:20に起こして', '2026-10-13T12:58:33.359Z')[0]!;
    state.apply('owner', { type: 'prospective-memory-upserted', memory: { ...memory, updatedAt: '2026-10-14T00:21:00.000Z', remindAfter: '2026-10-14T03:20:00.000Z' } });
    const initiatives = new SQLiteInitiativeStore(path, () => '2026-10-14T03:21:00.000Z', null, { promisesOnTime: true });
    const sources = new SQLiteInitiativeSources(path);
    const lines = commitmentLinePreparer({ writer: new FakeWriter({ phrase: '…ごめん、遅れちゃった。', position: 'after' }), scopeKey: 'owner', timeZone: 'Asia/Tokyo',
      snapshot: key => state.snapshot(key), delivered: (key, item) => sources.delivered(key, item), others: () => false });
    expect(initiatives.deliverDuePromises('2026-10-14T03:19:00.000Z', 'Asia/Tokyo', await lines('2026-10-14T03:19:00.000Z'))).toEqual({ due: 0, sent: 0 });
    initiatives.deliverDuePromises('2026-10-14T03:21:00.000Z', 'Asia/Tokyo', await lines('2026-10-14T03:21:00.000Z'));
    expect(state.conversationHistory('owner', threadId).at(-1)?.content).toBe('9時20分の約束：「起こして」（あとで、と頼まれていた分）');
    sources.close(); initiatives.close(); state.close();
  });

  it('names a date-only promise by its date when it is not today', () => {
    const facts = commitmentFacts({ title: '部屋の掃除', published_at: null, due_date: '2026-10-13' }, '2026-10-14T03:00:00.000Z', 'Asia/Tokyo', false);
    expect(commitmentFactSentence(facts)).toBe('10月13日の約束：「部屋の掃除」');
    expect(commitmentFactSentence({ ...facts, others: true })).toBe('10月13日の約束のお知らせです（内容はアプリで確認できます）。');
    expect(commitmentFactSentence(commitmentFacts({ title: '部屋の掃除', published_at: null, due_date: '2026-10-14' }, '2026-10-14T03:00:00.000Z', 'Asia/Tokyo', false)))
      .toBe('今日の約束：「部屋の掃除」');
  });

  it('offers the cheerful phrases only on time', () => {
    const late = promisePhraseChoices({ ...TIMED, overdueMinutes: 47 }).map(entry => entry.text);
    const onTime = promisePhraseChoices(TIMED).map(entry => entry.text);
    for (const cheerful of ['えへへ、', 'ねえねえ、', 'ふふん、ちゃんと覚えてましたよ。', 'べつに、言いたかったわけじゃないですけど。']) {
      expect(onTime).toContain(cheerful);
      expect(late).not.toContain(cheerful);
      expect(commitmentMessage({ phrase: cheerful, position: 'before' }, { ...TIMED, overdueMinutes: 47 })).toBe('9時20分の約束：「起こして」（47分遅れのお知らせ）');
    }
  });
});

describe('every sentence states only what is literally true when it is told (review of da980080)', () => {
  const at = (iso: string) => iso;
  it('says 「あとで」 for a deferred promise, never 「時刻です」, and names the time he asked for whenever it counts minutes', () => {
    const snoozed = { title: '起こして', published_at: '2026-10-14T00:20:00.000Z', remind_after: '2026-10-14T03:21:00.000Z' };
    const onTime = commitmentFacts(snoozed, at('2026-10-14T03:21:30.000Z'), 'Asia/Tokyo', true);
    expect(commitmentFactSentence(onTime)).toBe('9時20分の約束のお知らせです（あとで、と頼まれていた分・内容はアプリで確認できます）。');
    expect(commitmentFactSentence({ ...onTime, others: false })).toBe('9時20分の約束：「起こして」（あとで、と頼まれていた分）');
    const late = commitmentFacts(snoozed, at('2026-10-14T03:41:00.000Z'), 'Asia/Tokyo', true);
    expect(commitmentFactSentence(late)).toBe('9時20分の約束のお知らせです（昼の12時21分に、と頼まれていた分・20分遅れ・内容はアプリで確認できます）。');
    expect(commitmentFactSentence({ ...late, others: false })).toBe('9時20分の約束：「起こして」（昼の12時21分に、と頼まれていた分・20分遅れ）');
    // Deferred into the night and told at 7:00: the time he asked for, the night, and no minutes.
    const night = commitmentFacts({ ...snoozed, remind_after: '2026-10-14T15:05:00.000Z' }, at('2026-10-14T22:00:30.000Z'), 'Asia/Tokyo', false);
    expect(commitmentFactSentence(night)).toBe('9時20分の約束：「起こして」（夜中の0時5分に、と頼まれていた分・夜のあいだは控えていたため、7時からのお知らせ）');
    expect(commitmentFactSentence({ ...night, others: true }))
      .toBe('9時20分の約束のお知らせです（夜中の0時5分に、と頼まれていた分・夜のあいだは控えていたため、7時からのお知らせ・内容はアプリで確認できます）。');
  });

  it('tells a date-only promise of an earlier day as a notice, late for her phrases, without minutes', () => {
    const facts = commitmentFacts({ title: '部屋の掃除', published_at: null, due_date: '2026-10-13' }, '2026-10-14T03:00:00.000Z', 'Asia/Tokyo', true);
    expect(commitmentFactSentence(facts)).toBe('10月13日の約束のお知らせです（内容はアプリで確認できます）。');
    const choices = promisePhraseChoices({ ...facts, others: false }).map(entry => entry.text);
    expect(choices).toContain('…ごめん、遅れちゃった。');
    expect(choices).not.toContain('えへへ、');
    expect(commitmentFactSentence({ ...facts, others: false })).not.toMatch(/\d+分|時間/u);
  });

  it('finds a promise about waking him only by its words for waking', () => {
    for (const title of ['起こして', '7時に起こす', '目覚ましをかける', 'めざましで起きる', '起床の確認', '起きる時間を守る', '起こしに来て', 'モーニングコールして',
      'アラームをかける', 'アラームセットしておいて', '明日ちゃんと起きれるように', '起きられるようにしてね']) expect(wakePromise(title), title).toBe(true);
    for (const title of ['昨日起こったこと', '早起きの習慣', '何が起こるか見る', '起き上がりこぼし', '行動を起こす', '事を起こす', '問題を起こすな', '騒ぎを起こす']) {
      expect(wakePromise(title), title).toBe(false);
    }
  });

  it('ignores a stale 「あとで」 of another day for a date-only promise, and does not say 「7時から」 when told later than that', () => {
    // Deferred to yesterday's 12:21; told today at its usual 9:00 (a date-only promise of yesterday): not deferred, a past day, late.
    // (`eligible_at` is the usual notice on the day it is told: today's 9:00, `dueCommitmentCandidate`.)
    const stale = commitmentFacts({ title: '部屋の掃除', published_at: null, due_date: '2026-10-13', remind_after: '2026-10-13T03:21:00.000Z',
      eligible_at: '2026-10-14T00:00:00.000Z' }, '2026-10-14T00:00:30.000Z', 'Asia/Tokyo', false);
    expect(stale.deferredTo).toBeUndefined();
    expect(commitmentFactSentence(stale)).toBe('10月13日の約束：「部屋の掃除」');
    expect(promisePhraseChoices(stale).map(entry => entry.text)).not.toContain('えへへ、');
    // A deferral held overnight and told at 9:30 (after an outage): the night, but no 「7時から」.
    const outage = commitmentFacts({ title: '起こして', published_at: '2026-10-14T00:20:00.000Z', remind_after: '2026-10-14T15:05:00.000Z' },
      '2026-10-15T00:30:00.000Z', 'Asia/Tokyo', false);
    expect(commitmentFactSentence(outage)).toBe('9時20分の約束：「起こして」（夜中の0時5分に、と頼まれていた分・夜のあいだは控えていたため）');
    const plainNight = commitmentFacts({ title: '薬を飲む', published_at: '2026-10-14T14:30:00.000Z' }, '2026-10-15T00:30:00.000Z', 'Asia/Tokyo', false);
    expect(commitmentFactSentence(plainNight)).toBe('夜の11時30分の約束：「薬を飲む」（夜のあいだは控えていたため・10時間遅れ）');
  });

  it('holds over a table of its time × 「あとで」 × when it is told × a date only × who is there, in two time zones', () => {
    const onTimeOnly = new Set(PROMISE_PHRASES_V1.filter(entry => entry.only === 'on_time').map(entry => entry.text));
    const phraseClock = (phrase: string) => {
      const match = /^(夜中の|昼の|午後|夜の|夕方の)?(\d+)時(?:(\d+)分)?$/u.exec(phrase);
      if (!match) throw new Error(`unparsed ${phrase}`);
      const hour = Number(match[2]) + (match[1] === '午後' || match[1] === '夜の' ? 12 : 0);
      return hour * 60 + Number(match[3] ?? 0);
    };
    const plus = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();
    let checked = 0;
    for (const zone of [{ name: 'Asia/Tokyo', offset: 9 * 60 }, { name: 'Asia/Kolkata', offset: 5 * 60 + 30 }]) {
      const clockOf = (iso: string) => ((Math.round(Date.parse(iso) / 60_000) + zone.offset) % 1440 + 1440) % 1440;
      // An owner-local 2026-10-DD at HH:MM as an instant.
      const local = (day: number, minutes: number) => new Date(Date.UTC(2026, 9, day, 0, minutes - zone.offset)).toISOString();
      const quiet = (iso: string) => { const minutes = clockOf(iso); return minutes >= 23 * 60 || minutes < 7 * 60; };
      const nextLocal = (iso: string, minutes: number) => { let t = plus(iso, 1); while (clockOf(t) !== minutes) t = plus(t, 1); return plus(t, 0.5); };
      // A date-only promise's usual notice on the day it is told is today's 9:00 (its date is today or earlier).
      const dues = [{ due: local(14, 9 * 60 + 20) }, { due: local(14, 23 * 60 + 30) }, { due: null, date: '2026-10-14', eligible: local(14, 9 * 60) },
        { due: null, date: '2026-10-13', eligible: local(14, 9 * 60) }];
      for (const due of dues) {
        const reminds = due.due
          ? [null, plus(due.due, -30), plus(due.due, 181), due.due === local(14, 23 * 60 + 30) ? local(15, 65) : local(15, 5)]
          // A date-only promise: none, later the same day, and a stale one of an earlier day.
          : [null, local(14, 12 * 60 + 21), local(12, 12 * 60 + 21)];
        for (const remind of reminds) {
          const deferred = remind !== null && (due.due ? Date.parse(remind) > Date.parse(due.due) : Date.parse(remind) > Date.parse(due.eligible!));
          const anchor = deferred ? remind! : due.due ?? local(14, 9 * 60);
          const deliveries = [plus(anchor, 0.5), plus(anchor, 20),
            ...(quiet(anchor) ? [nextLocal(anchor, 7 * 60), nextLocal(anchor, 9 * 60 + 30)] : [])].filter(time => !quiet(time) && Date.parse(time) >= Date.parse(anchor));
          for (const delivered of deliveries) {
            for (const others of [false, true]) {
              const facts = commitmentFacts({ title: '起こして', published_at: due.due, remind_after: remind, due_date: due.date ?? null, eligible_at: due.eligible ?? null },
                delivered, zone.name, others);
              const sentence = commitmentFactSentence(facts);
              const minutesLate = due.due !== null && Date.parse(delivered) - Date.parse(anchor) >= 2 * 60_000;
              const pastDay = due.date !== undefined && due.date < `2026-10-${String(new Date(Date.parse(delivered) + zone.offset * 60_000).getUTCDate()).padStart(2, '0')}`;
              checked += 1;
              const label = `${sentence} [${zone.name} due ${due.due ?? due.date} remind ${remind} at ${delivered}]`;
              if (sentence.includes('時刻です')) expect(!deferred && !pastDay && !minutesLate, label).toBe(true);
              if (others && !deferred && !pastDay && !minutesLate) expect(sentence, label).toContain('時刻です');
              // 「あとで」 is said only when it was asked for after the usual time.
              expect(sentence.includes('頼まれていた分'), label).toBe(deferred);
              // Every minutes count, added to the time it names, is the time it is told.
              const lateMatch = /(?:(\d+)時間)?(?:(\d+)分)?遅れ/u.exec(sentence);
              if (lateMatch && (lateMatch[1] || lateMatch[2])) {
                const count = Number(lateMatch[1] ?? 0) * 60 + Number(lateMatch[2] ?? 0);
                const named = /（([^（、・]+)に、と頼まれていた分/u.exec(sentence)?.[1] ?? sentence.split('の約束')[0]!;
                expect((phraseClock(named) + count) % 1440, label).toBe(clockOf(delivered));
              }
              if (deferred && quiet(anchor)) expect(sentence, label).not.toMatch(/\d+分遅れ|時間遅れ/u);
              // 「7時からのお知らせ」 only when told within a quarter of an hour of 7:00.
              if (sentence.includes('7時からのお知らせ')) expect(clockOf(delivered) >= 7 * 60 && clockOf(delivered) < 7 * 60 + 15, label).toBe(true);
              const late = minutesLate || (pastDay && !deferred);
              const choices = promisePhraseChoices({ ...facts, others: false }).map(entry => entry.text);
              if (late) for (const phrase of onTimeOnly) expect(choices, label).not.toContain(phrase);
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(90);
  });

  it('computes a date-only promise\'s usual notice on the day it is told, from the stored promise', () => {
    const state = new SQLiteShannonStore({ path: join(directory, `eligible-${Math.random().toString(36).slice(2)}.sqlite`), now: () => SAID });
    const memory = extractProspectiveMemories('明日プレゼンの練習しよう', SAID)[0]!;
    state.apply('owner', { type: 'prospective-memory-upserted', memory: { ...memory, remindAfter: '2026-09-25T03:21:00.000Z' } });
    // Due 2026-09-25 (09:00): told on the 26th at 09:00, the 25th's 「あとで」 is stale.
    const [candidate] = dueCommitmentCandidate('owner', state.snapshot('owner'), '2026-09-26T00:00:30.000Z');
    expect(candidate).toMatchObject({ due_date: '2026-09-25', eligible_at: '2026-09-26T00:00:00.000Z', remind_after: '2026-09-25T03:21:00.000Z' });
    expect(commitmentFacts(candidate!, '2026-09-26T00:00:30.000Z', 'Asia/Tokyo', false).deferredTo).toBeUndefined();
    state.close();
  });

  it('with SHANNON_PROMISE_ON_TIME off, the topic loop is handed the prepared lines and shows the promise', async () => {
    const f = fixture();
    f.setNow(NINE);
    const prepared = await commitmentLinePreparer({ writer: null, scopeKey: 'owner', timeZone: 'Asia/Tokyo', snapshot: key => f.state.snapshot(key),
      delivered: (key, item) => f.sources.delivered(key, item), others: () => false })(NINE);
    // `fixture()` builds the store without promisesOnTime: the switch off.
    expect(f.initiatives.runOnce(NINE, 'Asia/Tokyo', new Map(), undefined, prepared)).toMatchObject({ sent: 1 });
    expect(f.state.conversationHistory('owner', f.threadId).at(-1)?.content).toBe('今日の約束：「プレゼンの練習しよう」');
    f.close();
  });
});

describe('her one phrase: an enum, exact match only', () => {
  it('holds no digit, numeral, time, day, period or relative-time word in any phrase (a static check of the list)', () => {
    const words = /\p{N}|[〇零一二三四五六七八九十百千万廿卅半]|時|分|秒|日|週|月|年|曜|今|朝|夜|昼|晩|宵|夕|午|前|後|明|昨|次|先|来|頃|ごろ|すぐ|まだ|さっき|あさ|よる|ひる|いま(?![すせし])|あした|きのう|now|am|pm/iu;
    for (const entry of PROMISE_PHRASES_V1) {
      expect(entry.text, entry.text).not.toMatch(words);
      expect(entry.positions.length).toBeGreaterThan(0);
      // Only a late phrase admits lateness, and it never says how late.
      if (/遅/u.test(entry.text)) expect(entry.only, entry.text).toBe('late');
    }
    expect(PROMISE_PHRASES_V1.length).toBeGreaterThanOrEqual(20);
    expect(new Set(PROMISE_PHRASES_V1.map(entry => entry.text)).size).toBe(PROMISE_PHRASES_V1.length);
  });

  it('offers late phrases only when late and wake phrases only for a promise about waking', () => {
    const texts = (facts: CommitmentFacts) => promisePhraseChoices(facts).map(entry => entry.text);
    expect(texts({ ...TIMED, title: '歯医者に電話する' })).not.toContain('…ごめん、遅れちゃった。');
    expect(texts({ ...TIMED, title: '歯医者に電話する' })).not.toContain('起きてー！');
    expect(texts({ ...TIMED, title: '歯医者に電話する', overdueMinutes: 47 })).toContain('…ごめん、遅れちゃった。');
    expect(texts(TIMED)).toContain('起きてー！');
    expect(promisePhraseChoice({ phrase: '…ごめん、遅れちゃった。', position: 'before' }, TIMED)).toBeNull();
    expect(promisePhraseChoice({ phrase: '起きてー！', position: 'after' }, { ...TIMED, title: '歯医者に電話する' })).toBeNull();
    // The schema's enum is this promise's list and nothing else.
    const schema = promisePhraseSchema({ ...TIMED, title: '歯医者に電話する' }) as { properties: { phrase: { enum: string[] } } };
    expect(schema.properties.phrase.enum).toEqual(['', ...texts({ ...TIMED, title: '歯医者に電話する' })]);
  });

  it('uses only an exact phrase of the list, in a place it takes; anything else is the fact alone', () => {
    expect(commitmentMessage({ phrase: 'ライ氏、', position: 'before' }, TIMED)).toBe('ライ氏、9時20分の約束：「起こして」');
    expect(commitmentMessage({ phrase: '忘れてませんよね？', position: 'before' }, TIMED)).toBe('9時20分の約束：「起こして」忘れてませんよね？');
    expect(commitmentMessage({ phrase: '…ごめん、遅れちゃった。', position: 'after' }, { ...TIMED, overdueMinutes: 47 }))
      .toBe('9時20分の約束：「起こして」（47分遅れのお知らせ）…ごめん、遅れちゃった。');
    for (const answer of [{ phrase: 'ライ氏', position: 'before' }, { phrase: 'ライ氏、 ', position: 'before' }, { phrase: '', position: 'before' }, null, 'ライ氏、',
      { phrase: 'ライ氏、9時20分ですよ！', position: 'before' }, { line: '今、9時20分だよ！' }]) {
      expect(commitmentMessage(answer, TIMED), JSON.stringify(answer)).toBe('9時20分の約束：「起こして」');
    }
    // With anyone else there no phrase is used.
    expect(commitmentMessage({ phrase: 'ライ氏、', position: 'before' }, { ...TIMED, others: true })).toBe('9時20分の約束の時刻です（内容はアプリで確認できます）。');
  });

  it('never lets the model\'s free text reach him: whatever it answers, the message is the fact sentence and at most one listed phrase', () => {
    let seed = 7;
    const random = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const junk = ['今、9時20分だよ！', '明日の9時半ね', 'ライ氏、', '…ごめん、遅れちゃった。', '起きてー！', '{時刻}ですよ', 'ほらほら！今だよ', 'ok', '', '忘れてませんよね？ 9時'];
    const allowed = new Set(PROMISE_PHRASES_V1.map(entry => entry.text));
    for (let index = 0; index < 2_000; index += 1) {
      const facts = { ...TIMED, title: index % 2 ? '起こして' : '歯医者に電話する', overdueMinutes: index % 3 ? 0 : 47 };
      const answer = { phrase: junk[random(junk.length)], position: ['before', 'after', 'middle'][random(3)], line: junk[random(junk.length)] };
      const message = commitmentMessage(answer, facts);
      const fact = commitmentFactSentence(facts);
      expect(message.includes(fact), message).toBe(true);
      const rest = message.replace(fact, '');
      expect(rest === '' || allowed.has(rest), message).toBe(true);
    }
  });

  it('tells the model only late or not, waking or not, and the phrases: not the promise\'s words, nor its time', () => {
    const request = JSON.parse(commitmentRequest({ ...TIMED, title: '歯医者に電話する', overdueMinutes: 5 })) as Record<string, unknown>;
    expect(Object.keys(request).sort()).toEqual(['about_waking', 'late', 'phrases']);
    expect(JSON.stringify(request)).not.toMatch(/歯医者|9:20|09:20/u);
    expect(COMMITMENT_LINE_INSTRUCTIONS).not.toMatch(/sulk|mood|feeling|すね|気分/iu);
    expect(COMMITMENT_LINE_INSTRUCTIONS).toMatch(/Only the listed phrases exist/u);
    expect(commitmentLineInstructions(false)).toBe(COMMITMENT_LINE_INSTRUCTIONS);
    expect(commitmentLineInstructions(true)).toContain(SHANNON_ONE_LINE_VOICE_INNER);
  });
});

function fixture() {
  const path = join(directory, `promise-${Math.random().toString(36).slice(2)}.sqlite`);
  let now = SAID;
  const state = new SQLiteShannonStore({ path, now: () => now });
  const threadId = state.createThread('owner', 'いつものトーク');
  state.apply('owner', { type: 'prospective-memory-upserted', memory: extractProspectiveMemories('明日プレゼンの練習しよう', SAID)[0]! });
  const initiatives = new SQLiteInitiativeStore(path, () => now);
  const sources = new SQLiteInitiativeSources(path);
  const close = () => { sources.close(); initiatives.close(); state.close(); };
  return { state, threadId, initiatives, sources, close, setNow: (value: string) => { now = value; } };
}

class FakeWriter implements CommitmentLineWriter {
  readonly asked: CommitmentFacts[] = [];
  constructor(private readonly answer: unknown) {}
  async write(_scopeKey: string, facts: CommitmentFacts): Promise<PromisePhraseChoice | null> {
    this.asked.push(facts);
    return promisePhraseChoice(this.answer, facts);
  }
}

describe('at the moment it is due', () => {
  const prepare = (f: ReturnType<typeof fixture>, writer: CommitmentLineWriter | null, others = false) => commitmentLinePreparer({
    writer, scopeKey: 'owner', timeZone: 'Asia/Tokyo', snapshot: scopeKey => f.state.snapshot(scopeKey),
    delivered: (scopeKey, itemId) => f.sources.delivered(scopeKey, itemId), others: () => others,
  });

  it('delivers the fact with her phrase, asked once, on the voiced path (it takes no moment cap)', async () => {
    const f = fixture();
    f.setNow(NINE);
    const writer = new FakeWriter({ phrase: 'ふふん、ちゃんと覚えてましたよ。', position: 'before' });
    const lines = prepare(f, writer);
    const prepared = await lines(NINE);
    expect(writer.asked).toEqual([expect.objectContaining({ title: '明日プレゼンの練習しよう', others: false })]);
    expect(f.initiatives.runOnce(NINE, 'Asia/Tokyo', new Map(), undefined, prepared)).toMatchObject({ sent: 1 });
    expect(f.state.conversationHistory('owner', f.threadId).at(-1)?.content).toBe('ふふん、ちゃんと覚えてましたよ。今日の約束：「プレゼンの練習しよう」');
    expect(await lines(NINE)).toEqual(new Map());
    expect(writer.asked).toHaveLength(1);
    f.close();
  });

  it('never loses the promise: no phrase, a phrase off the list or no writer give the fact sentence alone', async () => {
    for (const writer of [new FakeWriter(null), new FakeWriter({ phrase: 'ライ氏、15時の会議の約束です。', position: 'before' }), null]) {
      const f = fixture();
      f.setNow(NINE);
      const prepared = await prepare(f, writer)(NINE);
      expect(f.initiatives.runOnce(NINE, 'Asia/Tokyo', new Map(), undefined, prepared)).toMatchObject({ sent: 1 });
      expect(f.state.conversationHistory('owner', f.threadId).at(-1)?.content).toBe('今日の約束：「プレゼンの練習しよう」');
      f.close();
    }
  });

  it('uses the private-safe fact sentence with anyone else at her body, and asks the model nothing', async () => {
    const f = fixture();
    f.setNow(NINE);
    const writer = new FakeWriter({ phrase: 'ライ氏、', position: 'before' });
    const prepared = await prepare(f, writer, true)(NINE);
    expect(writer.asked).toEqual([]);
    f.initiatives.runOnce(NINE, 'Asia/Tokyo', new Map(), undefined, prepared);
    expect(f.state.conversationHistory('owner', f.threadId).at(-1)?.content).toBe('今日の約束の時刻です（内容はアプリで確認できます）。');
    f.close();
  });

  it('writes nothing in the quiet hours', async () => {
    const f = fixture();
    const writer = new FakeWriter({ phrase: 'ライ氏、', position: 'before' });
    expect(await prepare(f, writer)('2026-09-24T15:00:00.000Z')).toEqual(new Map()); // 00:00 in Tokyo
    expect(writer.asked).toEqual([]);
    f.close();
  });
});
