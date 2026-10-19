import { describe, expect, it } from 'vitest';
import { REACH_OUT_PACE_V1, nightStartedAt, ownerSaysUnwell, reachOutPaceHold } from '../src/mind/inhibition/reachOutPace.js';
import { withoutSilenceTally } from '../src/mind/action/ownTime/ownWordsTally.js';
import { ownerUnwell } from '../src/mind/action/ownTime/autonomyLoopObserve.js';
import { momentFactLine } from '../src/mind/attention/proactiveMoments.js';
import { dailyCount } from '../src/infra/config/dailyCount.js';
import { configuredAutonomy } from '../src/mind/inhibition/autonomyBudget.js';
import { agreementBefore, asksStance, bodyMovedLine, bodyReactionPrompt, BODY_AGREEMENT_LINES } from '../src/surfaces/body/bodyReactionPrompt.js';
import { isMovedTouch } from '../src/surfaces/body/bodyTouchReflex.js';
import { feelingTurnFromAnswers, feelingTurnQuestions } from '../src/contracts/feelingEventContract.js';
import { INITIAL_SHANNON_EXPRESSIVE_EMOTION } from '@shannon/cognition';

const TZ = 'Asia/Tokyo';
/** An instant at this JST wall-clock time on 2026-10-19. */
const jst = (hour: number, minute = 0) => new Date(Date.UTC(2026, 9, 19, hour - 9, minute)).toISOString();

describe('how often she starts a conversation (owner 2026-10-19)', () => {
  it('is three a day when unset, and still no cap when written unlimited', () => {
    expect(configuredAutonomy({}).maximumReachOutsPerDay).toBe(3);
    expect(configuredAutonomy({ SHANNON_AUTONOMY_MAX_REACH_OUTS: 'unlimited' }).maximumReachOutsPerDay).toBe(Number.POSITIVE_INFINITY);
    expect(dailyCount(undefined)).toBe(Number.POSITIVE_INFINITY);
    expect(dailyCount('', 3)).toBe(3);
  });

  it('allows one message through the night (23:00–7:00) and none more', () => {
    const base = { timeZone: TZ, sentToday: 0, maximumPerDay: 3, unwell: false };
    expect(nightStartedAt(jst(14), TZ)).toBeNull();
    expect(nightStartedAt(jst(23, 30), TZ)).toBe(jst(23));
    expect(reachOutPaceHold({ ...base, at: jst(23, 30), lastSentAt: jst(20) })).toBeNull();
    expect(reachOutPaceHold({ ...base, at: jst(23, 50), lastSentAt: jst(23, 10) })).toBe('night_quiet');
    expect(reachOutPaceHold({ ...base, at: jst(14), lastSentAt: jst(13) })).toBeNull();
    expect(reachOutPaceHold({ ...base, at: jst(14), sentToday: 3, lastSentAt: jst(13) })).toBe('daily_limit');
  });

  it('is fewer while he says he is unwell, and silent at night then', () => {
    const base = { timeZone: TZ, maximumPerDay: 3, unwell: true, lastSentAt: null };
    expect(reachOutPaceHold({ ...base, at: jst(14), sentToday: 1 })).toBeNull();
    expect(reachOutPaceHold({ ...base, at: jst(14), sentToday: REACH_OUT_PACE_V1.unwellPerDay })).toBe('owner_unwell');
    expect(reachOutPaceHold({ ...base, at: jst(23, 30), sentToday: 0 })).toBe('owner_unwell');
    expect(ownerSaysUnwell(['実はここんとこずっと風邪でさ。'])).toBe(true);
    expect(ownerSaysUnwell(['今日も仕事疲れたよ', 'スタバにいる'])).toBe(false);
    // Read through the owner context's replay (her own time opens no conversation store), for the last 36 hours.
    const asked: string[] = [];
    const ownerContext = { unwell: (_scope: string, _at: string, since: string) => { asked.push(since); return true; } };
    expect(ownerUnwell({ ownerContext } as never, 'owner', jst(14))).toBe(true);
    expect(asked).toEqual([new Date(Date.parse(jst(14)) - 36 * 3_600_000).toISOString()]);
    expect(ownerUnwell({} as never, 'owner', jst(14))).toBe(false);
  });
});

describe('her own message never tallies his quiet (owner 2026-10-19)', () => {
  it('drops the sentence that counts, keeps the rest, and is silence when nothing else was said', () => {
    expect(withoutSilenceTally('ライ氏、おかえりなさい。……べつに待ってたわけじゃないですけどね。19分くらい、ずっと静かだったんですから。'))
      .toBe('ライ氏、おかえりなさい。……べつに待ってたわけじゃないですけどね。');
    expect(withoutSilenceTally('ライ氏、2時間くらい静かだね。まだ寝てるならそれでいいけど、風邪あがりなんだから、ちゃんと休めてる？'))
      .toBe('まだ寝てるならそれでいいけど、風邪あがりなんだから、ちゃんと休めてる？');
    expect(withoutSilenceTally('……おかえり。00時台に何回か話しかけたのに、返事がなかったんだけど。')).toBe('……おかえり。');
    expect(withoutSilenceTally('……ふん。2時間もそばにいたのに、何も言わないんですか。')).toBe('……ふん。');
    expect(withoutSilenceTally('返事はいつでいいですよ。物語の続き、書けました。')).toBe('返事はいつでいいですよ。物語の続き、書けました。');
  });

  it('gives the moment as a fact without minutes or hours', () => {
    expect(momentFactLine({ kind: 'owner_returned', minutes: 19 })).not.toMatch(/\d/u);
    expect(momentFactLine({ kind: 'long_quiet', minutes: 120 })).not.toMatch(/\d|時間/u);
  });
});

describe('being carried on the screen is not a touch (owner 2026-10-19)', () => {
  it('asks no stance of a carry, and tells it as being moved, with a light word only when it keeps happening', () => {
    expect(isMovedTouch({ type: 'carry' })).toBe(true);
    expect(asksStance({ type: 'carry', part: 'other' })).toBe(false);
    expect(asksStance({ type: 'poke', part: 'cheek' })).toBe(true);
    expect(bodyMovedLine(1)).toContain('ふつうは何も言わずにそのまま運ばれる');
    expect(bodyMovedLine(3)).toContain('目が回りそう');
    const burst = { id: 'b', type: 'carry', count: 1, startedAt: '2026-10-17T07:04:00.000Z', lastAt: '2026-10-17T07:04:00.000Z' };
    const prompt = bodyReactionPrompt({
      touch: { type: 'carry', durationMs: 2_000, ongoing: false, part: 'other', region: 'body' } as never, audience: 'owner',
      feeling: { ...INITIAL_SHANNON_EXPRESSIVE_EMOTION }, burst: burst as never, sitting: [burst as never], said: [], conversation: [],
      at: '2026-10-17T07:04:01.000Z',
    });
    expect(prompt).toContain('触られたのとは違い、驚くことでも嫌がることでもない');
    expect(prompt).not.toContain('どう受け取るかは自分で決める');
  });

  it('tells the reflex what the exchange before it agreed', () => {
    expect(agreementBefore([{ role: 'user', content: 'じゃあ、手繋ぐね。' }, { role: 'assistant', content: '手を繋ぐのはいいですよ。' }])).toBe('announced');
    expect(agreementBefore([{ role: 'user', content: '元気？' }, { role: 'assistant', content: '元気です' }])).toBeNull();
    expect(BODY_AGREEMENT_LINES.permitted).toContain('不意打ちではない');
  });
});

describe('an apology read by its meaning (owner 2026-10-19)', () => {
  it('is asked only with the owner alone and only when wanted, and read back as a number', () => {
    expect(Object.keys(feelingTurnQuestions('', 'owner_alone', false, true))).toContain('amends');
    expect(Object.keys(feelingTurnQuestions('', 'owner_alone'))).not.toContain('amends');
    expect(Object.keys(feelingTurnQuestions('', 'people', false, true))).not.toContain('amends');
    const decision = feelingTurnFromAnswers({ stance: { choice: 'sulky' }, intensity: { choice: 'subtle' }, drawer: { choice: 'none' },
      amends: { noul: 0.83 } }, 'normal');
    expect(decision.amends).toBe(0.83);
  });
});
