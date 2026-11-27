import { describe, expect, it } from 'vitest';
import type { ActHand, ActResult } from '../src/contracts/minecraftActContract.js';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { altitudeLine, hopsOfResult, measuredSpeed, sampleOf, type AltitudeInput, type GoHop, type SpeedSample } from '../src/surfaces/minecraft/minecraftLlmcAltitude.js';
import { hopsLine, queueLines } from '../src/surfaces/minecraft/minecraftLlmcQueueWords.js';
import { FULL_COST, packLines } from '../src/surfaces/minecraft/minecraftLlmcPack.js';
import { stopFactsOf, THREAT_EXPOSED_WORDS } from '../src/surfaces/minecraft/minecraftLlmcFacts.js';

/**
 * The line of height and speed, the line of her recent gos with the gos that stopped in it, the full pack's words and the threat_exposed stop (the run of 11/27:
 * about 34 minutes below the surface, the same go with only maxDig changed over twenty times, a drop before every go on a pack that does not stop a go).
 */
const base: AltitudeInput = { dimension: 'overworld', feet: { x: 398, y: -24, z: 545 }, goal: { x: 398, y: 64, z: 1275 }, lastDropM: null, samples: [], tune: {}, underAttack: false };
const hop = (done: number, target: number | null, stop: string | null = null, extra: Partial<GoHop> = {}): GoHop =>
  ({ done, target, stop, seconds: null, fromY: null, toY: null, ...extra });

describe('the line of height and speed (altitudeLine)', () => {
  it('underground, 88 m below a goal 730 m away: says the height, each way\'s speed as a guide, the comparison, and the faster way', () => {
    const line = altitudeLine(base)!;
    expect(line).toContain('高さ：今 y=-24、行き先 y=64 → 88 m 下（地下）。行き先まで水平 730 m');
    expect(line).toContain('地表を歩く 約 2〜4 m/s（目安）');
    expect(line).toContain('地下の水平掘り 約 0.3〜0.5 m/s（目安。満杯・敵・つるはし作り直しを含む）');
    expect(line).toContain('柱で上がる 約 1.7 秒/段（目安）');
    expect(line).toContain('階段で上がる 約 3.5 秒/段（目安）');
    // 730 m at 0.5 and 0.3 m/s is 24 and 41 minutes; 88 steps at 1.7 and 3.5 s is 2.5 and 5.1 minutes, and 730 m on the surface 3 and 6 minutes
    expect(line).toContain('比べ：地下を掘り進めば 約 24〜41 分');
    expect(line).toContain('上がってから歩けば 上がり 約 2.5〜5.1 分＋歩き 約 3〜6.1 分');
    expect(line).toContain('先に vertical up で地表へ上がってから go する方が速い目安');
    // facts and a guide, no order: the line never says 「すべき」 and does not name a shape (the body's no_place sentence says the kinds)
    expect(line).not.toMatch(/べき|しろ|しなさい/u);
    expect(line).not.toContain('toward');
  });
  it('says the y the last go lost, and leaves the advice out when enemies are on her or the goal is under 150 m away', () => {
    expect(altitudeLine({ ...base, lastDropM: 32 })).toContain('直近の go で y が 32 m 下がった（地下へ入った）');
    expect(altitudeLine({ ...base, lastDropM: 3 })).not.toContain('下がった');
    expect(altitudeLine({ ...base, underAttack: true })).not.toContain('vertical up');
    expect(altitudeLine({ ...base, underAttack: true })).toContain('比べ：');
    const near = altitudeLine({ ...base, goal: { x: 398, y: 64, z: 665 } })!;
    expect(near).toContain('行き先まで水平 120 m');
    expect(near).not.toContain('vertical up');
  });
  it('says nothing on the surface, under 20 m of gap, under 100 m away, in another dimension, with no goal, or when the goal is as deep as she is', () => {
    expect(altitudeLine({ ...base, feet: { x: 398, y: 60, z: 545 }, goal: { x: 437, y: 110, z: 1275 } })).toBeNull();
    expect(altitudeLine({ ...base, goal: { x: 437, y: -6, z: 1275 } })).toBeNull();
    expect(altitudeLine({ ...base, goal: { x: 398, y: 64, z: 640 } })).toBeNull();
    expect(altitudeLine({ ...base, dimension: 'the_nether' })).toBeNull();
    expect(altitudeLine({ ...base, dimension: null })).toBeNull();
    expect(altitudeLine({ ...base, goal: null })).toBeNull();
    // going down to a stronghold's room (a goal at y 20, she at -24 or at 60) is not a climb
    expect(altitudeLine({ ...base, goal: { x: 465, y: -30, z: 1484 } })).toBeNull();
    expect(altitudeLine({ ...base, feet: { x: 398, y: 64, z: 545 }, goal: { x: 465, y: 20, z: 1484 } })).toBeNull();
  });
  it('uses what the gos measured (two or more over all of their metres and seconds) and says 目安 only for a way that has no measure', () => {
    const samples: SpeedSample[] = [{ metres: 20, seconds: 50, under: true }, { metres: 30, seconds: 70, under: true }, { metres: 40, seconds: 12, under: false }];
    expect(measuredSpeed(samples, true)!.mps).toBeCloseTo(50 / 120, 5);
    expect(measuredSpeed(samples, false)).toBeNull();
    const line = altitudeLine({ ...base, samples, tune: { pillar: 1300 } })!;
    expect(line).toContain('地下の go（掘り進み） 実測 約 0.4 m/s（直近 2 本の go');
    expect(line).toContain('地表を歩く 約 2〜4 m/s（目安）');
    expect(line).toContain('柱で上がる 実測 約 1.3 秒/段');
    expect(line).toContain('階段で上がる 約 3.5 秒/段（目安）');
  });
  it('takes a go\'s speed only from a go of 8 m over 5 s with its y known', () => {
    expect(sampleOf(hop(30, 30, null, { seconds: 60, toY: -20 }))).toEqual({ metres: 30, seconds: 60, under: true });
    expect(sampleOf(hop(30, 30, null, { seconds: 60, toY: 64 }))!.under).toBe(false);
    expect(sampleOf(hop(5, 5, null, { seconds: 60, toY: -20 }))).toBeNull();
    expect(sampleOf(hop(30, 30, null, { seconds: 2, toY: -20 }))).toBeNull();
    expect(sampleOf(hop(30, 30, null, { seconds: null, toY: -20 }))).toBeNull();
  });
  it('comes with the lines of the queue (an open item\'s goal, else the last go\'s) and not without the queue\'s altitude data', () => {
    const frame = { state: { world: { dimension: 'overworld', position: { x: 398.4, y: -23.5, z: 545.2 } } } } as unknown as BodyObservation;
    const kept = { lastGoal: { x: 398, y: 64, z: 1275 }, lastDropM: null, samples: [], tune: {} };
    const said = queueLines([], frame, { progress: null, leftMs: 0 }, { wakeMs: 6000, leftMs: 0, altitude: kept });
    expect(said[0]).toBe('列に項目なし');
    expect(said[1]).toContain('高さ：今 y=-24、行き先 y=64 → 88 m 下（地下）');
    expect(queueLines([], frame, { progress: null, leftMs: 0 }, { wakeMs: 6000, leftMs: 0 })).toEqual(['列に項目なし']);
    const item = { item: 'q1', node: null, why: 'x', input: { hands: [{ do: 'go', goals: [{ x: 700, y: 63, z: 1500 }] } as ActHand], why: 'x' }, pre: undefined, done: undefined, startedAt: 1,
      because: null, reason: () => null };
    const running = queueLines([item], frame, { progress: null, leftMs: 5000 }, { wakeMs: 6000, leftMs: 5000, altitude: kept });
    expect(running.some(line => line.startsWith('高さ：今 y=-24、行き先 y=63'))).toBe(true);
  });
});

describe('the line of her recent gos (hopsLine) counts the gos that stopped', () => {
  const act = (lines: unknown[], hands: Array<Partial<ActHand>>) => ({ result: { v: 1, ok: false, done: 0, of: lines.length, ms: 1, lines, at: { x: 0, y: 0, z: 0 }, hp: 20, food: 20 } as unknown as ActResult,
    hands: hands as ActHand[] });
  it('reads a go that stopped as its goal\'s distance and the metres made, with the way it ended; a stop that does not say how far its goal was is left out', () => {
    const { result, hands } = act([
      { i: 1, do: 'go', status: 'stopped', code: 'limit_time', progress: { unit: 'meter', done: 4, left: 108, fromStopM: 108, at: { x: 1, y: -20, z: 1 } } },
      { i: 2, do: 'go', status: 'stopped', code: 'dead_end', progress: { unit: 'meter', done: 3 } },
      { i: 3, do: 'go', status: 'stopped', code: 'dead_end', progress: { unit: 'meter', done: 0, left: 5, fromStopM: 5 } },
      { i: 4, do: 'go', status: 'done', progress: { unit: 'meter', done: 0, left: 0 } },
      { i: 5, do: 'mine', status: 'done', progress: { unit: 'item', done: 2, left: 0 } }], [{ do: 'go' }, { do: 'go' }, { do: 'go' }, { do: 'go' }, { do: 'mine' }]);
    expect(hopsOfResult(result, hands, 40_000, 10, -20)).toEqual([{ done: 4, target: 112, stop: '秒数の上限', seconds: null, fromY: 10, toY: -20 }]);
  });
  it('takes the seconds of an act whose only slow hand is the go', () => {
    const line = { i: 2, do: 'go', status: 'done', progress: { unit: 'meter', done: 30, left: 0 } };
    const only = act([{ i: 1, do: 'drop', status: 'done' }, line], [{ do: 'drop' }, { do: 'go' }]);
    expect(hopsOfResult(only.result, only.hands, 42_000, null, null)[0]!.seconds).toBe(42);
    const mixed = act([{ i: 1, do: 'mine', status: 'done' }, line], [{ do: 'mine' }, { do: 'go' }]);
    expect(hopsOfResult(mixed.result, mixed.hands, 42_000, null, null)[0]!.seconds).toBeNull();
  });
  it('is not said when the last go\'s goal was 15 m or more away, though the median of the last five is small (the run of 11/27: 152 of 200 decisions)', () => {
    // 11・112・5・2・4: the model was sending long gos; the ones that stopped (by seconds, digging limit, a hostile) never entered the line
    const stopped = [hop(11, 11), hop(2, 40, '秒数の上限'), hop(5, 5), hop(2, 2), hop(4, 112, '掘る数の上限')];
    expect(hopsLine(stopped, [5000])).toBeNull();
    expect(hopsLine([hop(2, 90, '敵で止まった'), hop(5, 5), hop(3, 3), hop(2, 2), hop(4, 4)], [5000])).toContain('行き先 90 m に対し進んだ 2 m（敵で止まった）');
  });
  it('a short go that stopped near the goal (dead_end after 3 m of 40) is a long go, not a short hop', () => {
    expect(hopsLine([hop(5, 5), hop(7, 7), hop(3, 40, '道が行き止まり')], [3000])).toBeNull();
  });
  it('keeps the old warning for the scenes where short gos did follow each other', () => {
    // the owner's test of 11/24 (try1124b): 40 finished gos with a median of 6 steps against a decision of 2 to 3 s
    const arrived = [5, 7, 5, 11, 8].map(metres => hop(metres, metres));
    const line = hopsLine(arrived, [2800, 3100, 2500])!;
    expect(line).toContain('行き先 11 m に対し進んだ 11 m（着いた）');
    expect(line).toContain('判断 1 回に約 3 秒かかるので、この長さだと次の手が届くまで体は止まっている');
    // a run of short moves that stopped one after the other near their goals (each goal under 15 m away)
    const stops = [hop(2, 8, '道が行き止まり'), hop(3, 8, '体が進めず止まった'), hop(4, 10, '秒数の上限')];
    expect(hopsLine(stops, [4000])).toContain('行き先 8 m に対し進んだ 2 m（道が行き止まり）');
    // facts only
    expect(line).not.toContain('15 m 以上');
    expect(line).not.toContain('並べる');
  });
});

describe('the full pack\'s words and the threat_exposed stop', () => {
  it('says first that a go and a vertical do not stop on a full pack, then which hands do', () => {
    expect(FULL_COST.startsWith('go・vertical は止まらない（掘った石は足元に落ちるだけ。canPlace 用の石は残す）')).toBe(true);
    expect(FULL_COST).toContain('mine・pickup・make・かまどの取り出しは止まる');
    expect(FULL_COST).not.toContain('dig・pickup・make の物も入らず止まる');
    expect(packLines(['cobblestone×64'], { free: 0 }).join(' ')).toContain('go・vertical は止まらない');
  });
  it('a vertical stopped by threat_exposed gets the three ways beside its stop line; other codes get none', () => {
    const result = (code: string) => JSON.stringify({ v: 1, ok: false, done: 0, of: 1, ms: 1, at: { x: 0, y: 0, z: 0 }, hp: 20, food: 20,
      lines: [{ i: 1, do: 'vertical', status: 'stopped', line: 'v', code, goal: 'partial', end: 'finished', progress: { unit: 'step', done: 6, left: 20, at: { x: 1, y: 40, z: 2 } } }] });
    const lines = stopFactsOf(result('threat_exposed'));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(THREAT_EXPOSED_WORDS);
    expect(THREAT_EXPOSED_WORDS).toContain('届かない所の敵は fight しても縮まらない');
    expect(THREAT_EXPOSED_WORDS).toContain('(1) exposeOk を付けた vertical など別の掘り方 (2) canPlace で射線を切る (3) 敵が来るのを待つ');
    expect(stopFactsOf(result('limit_dig'))).toHaveLength(1);
  });
});
