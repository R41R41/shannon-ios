import { describe, expect, it, beforeEach } from 'vitest';
import { fightRepeatLines, forgetFightRepeats, noteFights, REPEAT_MIN } from '../src/surfaces/minecraft/minecraftLlmcFightRepeat.js';

const frame = (pearls: number, gold: number, ids: Array<[number, number]>) => ({
  connected: true, stateAt: '2026-11-26T04:00:00.000Z', facts: {},
  state: { world: { dimension: 'overworld', inventory: [{ name: 'ender_pearl', count: pearls }, { name: 'gold_ingot', count: gold }],
    nearbyThreats: ids.map(([id, distance]) => ({ id, name: 'enderman', distance })), nearbyEntities: [] } },
}) as never;
const stopped = (text: string, code = 'enderman_did_not_arrive') => JSON.stringify({ v: 1, done: 0, of: 1, lines: [{ i: 0, do: 'fight', status: 'stopped', code, line: text, goal: 'failed', end: 'stopped' }] });
const input = { hands: [{ do: 'fight', target: 'enderman', seconds: 120 }] };
const T = (min: number) => min * 60_000;

describe('the fights at the same target, counted by the head', () => {
  beforeEach(() => forgetFightRepeats());
  it('says nothing before the count, then the count, the minutes, the pearls, the others and the other way', () => {
    for (let k = 0; k < REPEAT_MIN - 1; k++) noteFights('t', input, stopped('fight 止まった moved: enderman #58 屋根中央に留まれない。与えた打撃 0（振り 0）'), frame(2, 7, [[58, 20]]), T(k));
    expect(fightRepeatLines('t', frame(2, 7, [[58, 20]]), T(2))).toEqual([]);
    noteFights('t', input, stopped('fight 止まった moved: enderman #58 屋根中央に留まれない。与えた打撃 0（振り 0）'), frame(2, 7, [[58, 20]]), T(2));
    const [line] = fightRepeatLines('t', frame(2, 7, [[58, 20], [61, 14.4], [70, 30]]), T(9));
    expect(line).toContain('enderman #58 への fight が 3 回続けて止まった（最初から 9 分・パール +0（2/13）・与えた打撃 計 0）');
    expect(line).toContain('enderman_did_not_arrive（3 回続き）');
    expect(line).toContain('近くの別のエンダーマン 2 体（最寄り 14m）');
    expect(line).toContain('金の延べ棒 15.6 個で平均 1 個。いま持っている金の延べ棒 7 個');
    expect(line).toContain('変わらない限り何度呼んでも届かない');
  });
  it('counts a target named only by the hand when the body words carry no id, and says no other is near', () => {
    for (let k = 0; k < 3; k++) noteFights('t', input, stopped('届かない（元: 怒っているが 15 秒近づかない）'), frame(0, 0, []), T(k));
    const [line] = fightRepeatLines('t', frame(0, 0, []), T(3));
    expect(line).toContain('enderman への fight が 3 回続けて止まった');
    expect(line).toContain('近くに別のエンダーマンは見えていない');
    expect(line).not.toContain('与えた打撃');
  });
  it('starts again on a kill, a done fight, another target, or after a long gap', () => {
    const bad = stopped('fight 止まった moved: enderman #58 届かない');
    for (let k = 0; k < 3; k++) noteFights('t', input, bad, frame(0, 0, [[58, 9]]), T(k));
    noteFights('t', input, stopped('fight enderman #58 死んだ', 'target_killed'), frame(1, 0, [[58, 9]]), T(3));
    expect(fightRepeatLines('t', frame(1, 0, [[58, 9]]), T(3))).toEqual([]);
    for (let k = 0; k < 2; k++) noteFights('t', input, bad, frame(1, 0, [[58, 9]]), T(4 + k));
    noteFights('t', input, stopped('fight 止まった moved: enderman #59 届かない'), frame(1, 0, [[58, 9]]), T(6));
    expect(fightRepeatLines('t', frame(1, 0, [[58, 9]]), T(6))).toEqual([]);
    for (let k = 0; k < 3; k++) noteFights('t', input, bad, frame(1, 0, [[58, 9]]), T(7 + k));
    expect(fightRepeatLines('t', frame(1, 0, [[58, 9]]), T(9))).toHaveLength(1);
    expect(fightRepeatLines('t', frame(1, 0, [[58, 9]]), T(30))).toEqual([]);
  });
  it('does not count a hand that did not run', () => {
    const skipped = JSON.stringify({ v: 1, done: 0, of: 1, lines: [{ i: 0, do: 'fight', status: 'skipped', line: '未実行', goal: 'not_started', end: 'not_run' }] });
    for (let k = 0; k < 4; k++) noteFights('t', input, skipped, frame(0, 0, []), T(k));
    expect(fightRepeatLines('t', frame(0, 0, []), T(4))).toEqual([]);
  });
});
