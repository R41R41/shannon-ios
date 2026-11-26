import { describe, expect, it } from 'vitest';
import { actResultText, llmcStoredResult } from '../src/surfaces/minecraft/minecraftLlmc.js';
import { fightLongWords, queueLines, type QueueWordsItem } from '../src/surfaces/minecraft/minecraftLlmcQueueWords.js';
import { repeatedFailures, stopCodesOf, stopsOf, withStopCodes } from '../src/surfaces/minecraft/minecraftLlmcRepeat.js';
import { minecraftLlmcLive, createFoodTrend } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { createLlmcEvents, forgetLlmcEvents } from '../src/surfaces/minecraft/minecraftLlmcBody.js';
import { MC_ACT_TOOL, type ActInput, type ActResult } from '../src/contracts/minecraftActContract.js';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';

/**
 * The fight that stopped (3rd run of 11/26, the Nether pearl section): the head read a line cut at 160 characters, no time for the 26 s the stop had taken, a queue
 * line that said 「残り 約 7 秒」 for a fight of 90 s, and a stop line (「無い」) that did not tell not being seen from having no way.
 */
// The line as the head received it (history sequence 6471): the body's, cut at 160 characters.
const CLIPPED = '無い: fight 止まった enderman_not_visible: 近くに目が見える屋根の場所が無い。最寄りの #1135 は 南東 16m (137,64,-309): その高さの開けた地面へ go で寄ってから probe kind=roofsite で場所を選ぶ。48m 内のエンダーマン 13 体はどれも…';
function result(ms: number, extra: Partial<ActResult> = {}): ActResult {
  return { v: 1, ok: false, done: 1, of: 3, stoppedBy: 'failure', ms, at: { x: 124, y: 62, z: -319 }, hp: 20, food: 20,
    lines: [
      { i: 1, do: 'go', status: 'done', line: 'go 着いた (124,62,-319) 道 2 歩・掘 0・置 0・引き直し 0 回（0.6秒）', goal: 'done', end: 'finished' },
      { i: 2, do: 'fight', status: 'stopped', line: CLIPPED, goal: 'not_started', end: 'finished', code: 'enderman_not_visible', motorOps: 0 },
      { i: 3, do: 'pickup', status: 'skipped', line: '未実行', goal: 'not_started', end: 'not_run' },
    ], ...extra } as ActResult;
}

describe('a fight line cut by the body', () => {
  it('says the line was cut when it ends in 「…」 at the body limit, and only then', () => {
    expect(CLIPPED.length).toBe(160);
    const text = actResultText(result(1_200));
    expect(text).toContain('この行は体が 160 字で切って送った');
    expect(actResultText(result(1_200, { lines: [{ ...result(1).lines[1]!, line: '無い: 届かない' }] }))).not.toContain('160 字で切って');
  });
  it('does not touch the history of a result: the stored text is the shown text', () => {
    const text = actResultText(result(1_200));
    expect(llmcStoredResult(MC_ACT_TOOL, text)).toEqual({ stored: text, shown: null });
  });
});

describe('the time a stopped fight took', () => {
  it('tells the seconds of a long fight stop, less those the done hands before it say', () => {
    const text = actResultText(result(26_600));
    expect(text).toContain('この fight の手は止まるまでに約 26 秒かかった（act 全体 26.6 秒）');
  });
  it('says nothing of a stop that came back at once, or of an act that went well', () => {
    expect(actResultText(result(400))).not.toContain('止まるまでに約');
    expect(actResultText(result(26_600, { ok: true }))).not.toContain('止まるまでに約');
    expect(actResultText(result(9_000))).not.toContain('止まるまでに約');
  });
  it('does not say what the body did in that time', () => {
    expect(actResultText(result(31_400))).toContain('その間に体が何をしていたかは頭に届いていない');
    expect(actResultText(result(31_400))).not.toContain('見張');
  });
});

describe('a queue line for a fight that waits', () => {
  const input = (seconds?: number): ActInput => ({ hands: [{ do: 'fight', target: 'enderman', ...(seconds ? { seconds } : {}) } as never], why: 'test' }) as ActInput;
  const item = (hands: ActInput): QueueWordsItem => ({ item: 'q47', node: 'n3', why: '屋根の中で待つ', input: hands, pre: undefined, done: undefined, startedAt: 1, because: null, reason: () => null });
  it('puts the ceiling beside the estimate on the running item', () => {
    const lines = queueLines([item(input(90))], null, { progress: { hand: 1, of: 1, repeat: 1, iteration: 1 } as never, leftMs: 7_178 });
    expect(lines[0]).toContain('残り約 7 秒（この fight の見積もりは 90 秒の半分。');
    expect(lines[0]).toContain('90 秒まで続くことがあり、結果はその時まで来ない');
  });
  it('is for a fight only, and uses the default of 20 when no seconds is written', () => {
    expect(fightLongWords({ hands: [{ do: 'go' } as never], why: 'x' } as ActInput, null)).toBe('');
    expect(fightLongWords(input(), 1)).toContain('20 秒まで');
  });
});

describe('the codes beside the body stop lines', () => {
  const json = JSON.stringify(result(26_600));
  it('reads the code, word and cell of a stopped hand', () => {
    expect(stopCodesOf(json)).toEqual([{ cell: '124,62,-319', word: '無い', code: 'enderman_not_visible' }]);
    expect(stopCodesOf('not json')).toEqual([]);
  });
  it('puts the code after the stop line of the same cell and word', () => {
    const codes = stopCodesOf(json);
    expect(withStopCodes(['(124,62,-319) 無い 4秒前', '(124,62,-319) 見られる 9秒前', '(1,2,3) 無い 5秒前', '(124,62,-319) 無い ×4 20秒前'], codes))
      .toEqual(['(124,62,-319) 無い 4秒前（enderman_not_visible）', '(124,62,-319) 見られる 9秒前', '(1,2,3) 無い 5秒前',
        '(124,62,-319) 無い ×4 20秒前（enderman_not_visible）']);
  });
  it('is still counted by the repeat reading', () => {
    const lines = withStopCodes(['(124,62,-319) 無い ×4 20秒前'], stopCodesOf(json));
    expect(stopsOf(lines)).toEqual([{ cell: '124,62,-319', reason: '無い', count: 4 }]);
    expect(repeatedFailures({ stops: lines })[0]).toContain('「無い」で 4 回止まった');
  });
  it('reaches the live state through the events of the task', () => {
    forgetLlmcEvents();
    const events = createLlmcEvents('t-fightview');
    events.noteStops(json);
    const world = { position: { x: 124, y: 62, z: -319 }, health: 20, food: 20, recentStops: ['(124,62,-319) 無い 4秒前'] };
    const observation = { schemaVersion: 1, bodyId: 'minecraft:s', sequence: 1, stateAt: 'x', receivedAt: 'x', connected: true, state: { world }, facts: { alive: true } } as unknown as BodyObservation;
    const live = minecraftLlmcLive({ observation, elapsedMinutes: 1, trend: createFoodTrend(), events: [], stopCodes: events.stopCodes() });
    expect(live.stops).toEqual(['(124,62,-319) 無い 4秒前（enderman_not_visible）']);
    forgetLlmcEvents();
  });
});

describe('fightLongWords: the running hand decides', () => {
  it('says nothing while a non-fight hand runs, even if a fight follows it', () => {
    const input = { hands: [{ do: 'go' }, { do: 'fight', seconds: 90 }], why: 'x' } as unknown as ActInput;
    expect(fightLongWords(input, 1)).toBe('');
    expect(fightLongWords(input, 2)).toContain('90 秒まで');
  });
});
