import { beforeEach, describe, expect, it } from 'vitest';
import { applyPlanUpdate, planFromSeeds } from '@shannon/mind';
import { ACT_INPUT_SCHEMA } from '../src/contracts/minecraftActContract.js';
import { ATTACK_SECONDS_MAX, ENDERMAN_FIGHT_SECONDS_MAX, FIGHT_RANGE_MAX, FIGHT_SECONDS_MAX, GO_RANGE, HUNT_RANGE, LIMITS_MANUAL_LINE } from '../src/contracts/minecraftActLimits.js';
import { handProblem } from '../src/contracts/minecraftActHandRules.js';
import { SHORT_ACT_DESCRIPTION } from '../src/contracts/minecraftActShortContract.js';
import type { ActHand } from '../src/contracts/minecraftActTypes.js';
import { mergeEnemies } from '../src/surfaces/minecraft/minecraftLlmcLiveEnemies.js';
import { reachSuffix } from '../src/surfaces/minecraft/minecraftLlmcReachWords.js';
import { fightRepeatLines, forgetFightRepeats, noteFights, REPEAT_SECONDS } from '../src/surfaces/minecraft/minecraftLlmcFightRepeat.js';
import { isFailureCopy, planLines, replanBrief, type BriefInput } from '../src/surfaces/minecraft/minecraftLlmcReplanBrief.js';
import { REPLAN_SYSTEM } from '../src/surfaces/minecraft/minecraftLlmcReplan.js';

describe('a walled and angry hostile is said as one that cannot come, with its height against her feet (11/26 end run 5)', () => {
  const self = { x: 172, y: 60, z: -363 };
  const raw = { threats: ['#41 enderman 5.1m (172,55,-364) 北1・下5・壁の向こうで届かない・怒っている（向かって来る）'] };
  it('writes 足元より 5 下 and 来られない, and no 向かって来る', () => {
    const [line] = mergeEnemies(raw, self).threats ?? [];
    expect(line).toBe('#41 enderman 5.1m (172,55,-364) 北1・足元より 5 下・壁の向こうで届かない・怒っているが来られない');
    expect(line).not.toContain('向かって来る');
    // A walled line grows by the height words (it is one line of the live state; the frame's own line, mood and all, is 62).
    expect(line!.length).toBeLessThanOrEqual(raw.threats[0]!.length + 4);
  });
  it('leaves a low height, a calm one and one that is not walled as they were', () => {
    expect(mergeEnemies({ threats: ['#41 enderman 5.1m (172,58,-364) 北1・下2・壁の向こうで届かない・怒っている（向かって来る）'] }, self).threats?.[0])
      .toBe('#41 enderman 5.1m (172,58,-364) 北1・下2・壁の向こうで届かない・怒っているが来られない');
    expect(mergeEnemies({ threats: ['#41 enderman 5.1m (172,55,-364) 北1・下5・壁の向こうで届かない・怒っていない（目を合わせず叩かなければ来ない）'] }, self).threats?.[0])
      .toBe('#41 enderman 5.1m (172,55,-364) 北1・足元より 5 下・壁の向こうで届かない');
    expect(mergeEnemies({ threats: ['#41 enderman 5.1m (172,55,-364) 北1・下5・見える（射線の中）・怒っている（向かって来る）'] }, self).threats?.[0])
      .toBe('#41 enderman 5.1m (172,55,-364) 北1・下5・見える（射線の中）');
  });
  it('says it in the frame suffix too', () => {
    expect(reachSuffix({ name: 'enderman', reach: 'walled', angry: true })).toBe('・壁の向こうで届かない・怒っているが来られない');
    expect(reachSuffix({ name: 'enderman', reach: 'in_sight', angry: true })).toContain('向かって来る');
  });
});

describe('the repeat line also comes when the stopped fights add up to 90 seconds', () => {
  beforeEach(() => forgetFightRepeats());
  const stop = (ms: number) => JSON.stringify({ v: 1, done: 0, of: 1, ms, lines: [{ i: 0, do: 'fight', status: 'stopped', code: 'limit_time', line: '時間切れ（元: enderman #41 は来なかった）', goal: 'failed', end: 'finished' }] });
  const input = { hands: [{ do: 'fight', target: 'enderman', seconds: 120 }] };
  it('says nothing for one long stop, and the line at the second when the sum passes 90 s', () => {
    noteFights('t', input, stop(120_400), null, 0);
    expect(fightRepeatLines('t', null, 1000)).toEqual([]);
    noteFights('t', input, stop(60_000), null, 190_000);
    const [line] = fightRepeatLines('t', null, 191_000);
    expect(line).toContain('enderman #41 への fight が 2 回続けて止まった');
    expect(line).toContain('止まった時間の合計 180 秒');
  });
  it('stays quiet at two short stops, and says the third as before', () => {
    expect(REPEAT_SECONDS).toBe(90);
    noteFights('t', input, stop(20_000), null, 0);
    noteFights('t', input, stop(20_000), null, 30_000);
    expect(fightRepeatLines('t', null, 31_000)).toEqual([]);
    noteFights('t', input, stop(20_000), null, 60_000);
    expect(fightRepeatLines('t', null, 61_000)[0]).toContain('3 回続けて止まった');
  });
});

describe('the plan made again is not handed a stop line as a caution, unless the stall is stops in one spot', () => {
  const FAILED = 'fight: 届かない（元: 自分の屋根の蓋 (150,69,-342) が #38 の目を隠し…';
  const planned = planFromSeeds([{ title: 'パールを集める', kind: 'pearl', doneWhen: 'have:ender_pearl>=14' }])!;
  const tree = applyPlanUpdate(planned, { ops: [{ op: 'caution', id: planned.nodes[0]!.id, text: FAILED },
    { op: 'caution', id: planned.nodes[0]!.id, text: '足元より 5 下の穴の中の個体は歩いて届かない' }] }, { at: new Date(0).toISOString() }).tree;
  const input = (kind: string): BriefInput => ({ goal: 'エンドラを討伐して', seconds: 900, stall: { kind, why: '止まった', node: planned.nodes[0]!.id },
    tree, doneStatus: null, now: [], facts: [], results: [], queue: [], earlier: [], sameNode: 0, knowledge: '' });
  it('leaves the copy out for another kind of stall and keeps what was found', () => {
    const text = replanBrief(input('node_stalled'));
    expect(text).not.toContain('自分の屋根の蓋');
    expect(text).toContain('足元より 5 下の穴の中の個体');
    expect(replanBrief(input('same_spot_stops'))).toContain('自分の屋根の蓋');
    expect(planLines(tree).join('\n')).toContain('自分の屋根の蓋');
  });
  it('also leaves out a copy that has its place first (cautionFact writes 「(x,y,z) の fight: …」)', () => {
    expect(isFailureCopy('(150,69,-342) の fight: 届かない（元: 蓋が目を隠し…')).toBe(true);
    expect(isFailureCopy('足元より 5 下の穴の中の個体は歩いて届かない')).toBe(false);
  });
  it('tells the plan maker to write what was found, with the reason', () => {
    expect(REPLAN_SYSTEM).toContain('何が分かったか 1 文');
    expect(REPLAN_SYSTEM).toContain('理由: 止まりの文は 1 回の失敗の言い方');
  });
});

describe('the words of the hand limits are written from the numbers the check holds', () => {
  const hand = (value: Record<string, unknown>) => value as unknown as ActHand;
  const field = (name: 'seconds' | 'range'): string => (ACT_INPUT_SCHEMA as unknown as { properties: { hands: { items: { properties: Record<string, { description: string }> } } } })
    .properties.hands.items.properties[name]!.description;
  it('has the same numbers as handProblem for attack, fight by id and by kind, and the ranges', () => {
    expect(handProblem(hand({ do: 'attack', target: '#1', seconds: ATTACK_SECONDS_MAX }))).toBeNull();
    expect(handProblem(hand({ do: 'attack', target: '#1', seconds: ATTACK_SECONDS_MAX + 1 }))).toContain(`${ATTACK_SECONDS_MAX} まで`);
    expect(handProblem(hand({ do: 'fight', target: '#41', seconds: FIGHT_SECONDS_MAX }))).toBeNull();
    expect(handProblem(hand({ do: 'fight', target: '#41', seconds: FIGHT_SECONDS_MAX + 1 }))).not.toBeNull();
    expect(handProblem(hand({ do: 'fight', target: 'enderman', seconds: ENDERMAN_FIGHT_SECONDS_MAX }))).toBeNull();
    expect(handProblem(hand({ do: 'fight', target: 'enderman', seconds: ENDERMAN_FIGHT_SECONDS_MAX + 1 }))).not.toBeNull();
    expect(handProblem(hand({ do: 'fight', target: 'enderman', range: FIGHT_RANGE_MAX + 1, seconds: 60 }))).not.toBeNull();
    expect(handProblem(hand({ do: 'go', to: { x: 0, y: 0, z: 0 }, range: GO_RANGE[1] + 1 }))).not.toBeNull();
    expect(handProblem(hand({ do: 'hunt', target: 'cow', range: HUNT_RANGE[1] + 1 }))).not.toBeNull();
    // The values as confirmed in the code of 11/26 (the numbers in the check, not only the names).
    expect([30, 60, 150, 4, 16, 48]).toEqual([ATTACK_SECONDS_MAX, FIGHT_SECONDS_MAX, ENDERMAN_FIGHT_SECONDS_MAX, GO_RANGE[1], FIGHT_RANGE_MAX, HUNT_RANGE[1]]);
  });
  it('says those numbers in the schema, the short manual (once) and the stage knowledge', () => {
    expect(field('seconds')).toContain(`attack ${ATTACK_SECONDS_MAX} まで`);
    expect(field('seconds')).toContain(`${FIGHT_SECONDS_MAX}、名前 enderman なら ${ENDERMAN_FIGHT_SECONDS_MAX}`);
    expect(field('range')).toContain(`fight 0〜${FIGHT_RANGE_MAX}`);
    expect(SHORT_ACT_DESCRIPTION.split(LIMITS_MANUAL_LINE)).toHaveLength(2);
    expect(LIMITS_MANUAL_LINE).toContain('丸めない');
  });
});
