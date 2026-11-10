import { describe, expect, it } from 'vitest';
import {
  ACT_DESCRIPTION, ACT_INPUT_SCHEMA, actExpectedMilliseconds, actMilliseconds, actProblem, MC_ACT_TOOL,
  type ActHand, type ActInput,
} from '../src/contracts/minecraftActContract.js';
import { handFieldNames, handProblem } from '../src/contracts/minecraftActHandRules.js';
import { actToShort, handToLine, lineToHand, SHORT_ACT_DESCRIPTION, shortToAct } from '../src/contracts/minecraftActShortContract.js';
import { validSkillInput } from '../src/surfaces/minecraft/minecraftControlValidation.js';
import { llmcPrepare } from '../src/surfaces/minecraft/minecraftLlmc.js';
import { seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { V2_ALWAYS, V2_STAGES } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';

const sources = (n: number) => Array.from({ length: n }, (_, x) => ({ x, y: 64, z: 1 }));
const obsidian = (extra: Partial<ActHand> = {}): ActInput => ({ hands: [{ do: 'obsidian', at: sources(22), ...extra }] });
const barter = (count?: number): ActInput => ({ hands: [{ do: 'use', item: 'gold_ingot', target: 'piglin',
  ...(count === undefined ? {} : { count }) }] });

describe('S8 obsidian input and time', () => {
  it.each([1, 22, 24])('passes %i sources with 300 s unchanged to the body', n => {
    const input = obsidian({ at: sources(n), count: n, seconds: 300 });
    expect(validSkillInput(input, ACT_INPUT_SCHEMA)).toBe(true);
    expect(actProblem(input)).toBeNull();
    expect(llmcPrepare(MC_ACT_TOOL, input)).toEqual({ input, fixes: [], problem: null });
    expect(shortToAct(actToShort(input))).toEqual({ act: input, errors: [] });
    expect(actMilliseconds(input)).toBe(320_000);
  });

  it('leaves count and seconds absent for body defaults, and estimates every named source', () => {
    const input = obsidian();
    expect(llmcPrepare(MC_ACT_TOOL, input)).toEqual({ input, fixes: [], problem: null });
    expect(shortToAct(actToShort(input))).toEqual({ act: input, errors: [] });
    expect(actMilliseconds(input)).toBe(110_000);
    expect(actExpectedMilliseconds(obsidian({ seconds: 300 }))).toBe(196_000);
    expect(actExpectedMilliseconds(obsidian({ count: 1, seconds: 300 }))).toBe(28_000);
    expect(actMilliseconds(obsidian({ seconds: 5 }))).toBe(25_000);
  });

  it.each([0, 25])('refuses %i sources', n => {
    expect(actProblem(obsidian({ at: sources(n) }))).toContain('at は溶岩の源のマス 1〜24');
    expect(llmcPrepare(MC_ACT_TOOL, obsidian({ at: sources(n) })).problem).not.toBeNull();
  });

  it.each([4.99, 300.01])('refuses obsidian seconds=%s', seconds => {
    expect(actProblem(obsidian({ seconds }))).toContain('seconds は 5〜300');
  });

  it('preserves dig/place and other time bounds after widening the common schema', () => {
    expect(handProblem({ do: 'dig', at: sources(17) })).toContain('at は 16');
    expect(handProblem({ do: 'place', block: 'cobblestone', at: sources(17) })).toContain('at は 16');
    expect(handProblem({ do: 'go', to: sources(1)[0], seconds: 121 })).toContain('seconds は 5〜120');
    expect(handProblem({ do: 'mine', block: 'iron_ore', at: sources(1), seconds: 121 })).toContain('seconds は 5〜120');
    expect(actMilliseconds({ hands: [{ do: 'dig', at: sources(16) }], repeat: 8 })).toBe(170_000);
  });
});

describe('S6 batched piglin barter', () => {
  it.each([undefined, 1, 3, 64])('accepts count=%s and preserves it through short and JSON preparation', count => {
    const input = barter(count);
    expect(handFieldNames('use')).toContain('count');
    expect(validSkillInput(input, ACT_INPUT_SCHEMA)).toBe(true);
    expect(actProblem(input)).toBeNull();
    expect(llmcPrepare(MC_ACT_TOOL, input)).toEqual({ input, fixes: [], problem: null });
    expect(lineToHand(handToLine(input.hands[0]!))).toEqual(input.hands[0]);
    expect(shortToAct(actToShort(input))).toEqual({ act: input, errors: [] });
    expect(actMilliseconds(input)).toBeGreaterThanOrEqual(6_000);
    expect(actMilliseconds(input)).toBeLessThanOrEqual(170_000);
  });

  it.each([0, -1, 1.5, 65, NaN, Infinity])('refuses count=%s before sending', count => {
    expect(actProblem(barter(count))).toContain('count は 1〜64 の整数');
    expect(llmcPrepare(MC_ACT_TOOL, barter(count)).problem).not.toBeNull();
  });

  it('retains a batch in its short line and reserves the inspection wait for a kind or an id', () => {
    const input = barter(3);
    expect(handToLine(input.hands[0]!)).toBe('use gold_ingot target=piglin count=3');
    expect(actMilliseconds(input)).toBe(38_000);
    expect(actExpectedMilliseconds(input)).toBe(18_000);
    expect(actMilliseconds({ hands: [{ ...input.hands[0]!, target: '#42' }] })).toBe(38_000);
    expect(actMilliseconds({ hands: [{ do: 'use', item: 'bucket', at: sources(1) }] })).toBe(5_000);
    expect(ACT_DESCRIPTION).toContain('count 個まで交換');
    expect(SHORT_ACT_DESCRIPTION).toContain('[count=N]');
  });
});

describe('S8 and S6 stage knowledge', () => {
  it('describes auto sprint, guarded lava bridges and the body waypoint failure without changing End bridges', () => {
    const nether = V2_STAGES.nether;
    for (const fact of ['体が安全な所だけ走る', 'sprint:false', '3 マスの溝の走り跳びには sprint:true', '64 個以上', '2.5 倍',
      '体が両脇の床と足の高さの壁も置く', 'place を 1 マスずつ出す必要は無い', '最大 5 個', 'maxPlace 40〜100',
      '24m、次に 12m', '6 回まで', '体が中継点（n 回）でも進めなかった']) expect(nether).toContain(fact);
    expect(nether).not.toMatch(/既定で走らない|橋の材料が尽きない/u);
    expect(V2_STAGES.end).toContain('go の canPlace は足元の床だけで、壁は作らない');
    expect(V2_ALWAYS).not.toContain('体が中継点');
  });

  it('reads fortress districts and scan coverage before inferring absence', () => {
    const nether = V2_STAGES.nether;
    for (const fact of ['world.scan', '432m', '境から 50m 以上', 'radius=16', '未確認', '9 割未満', '150m',
      '溶岩の湖や崖の少ない向きを 1 つ選ぶ', '最大 30 秒', '120 秒まで', '20% 増える', '描画の距離の 39%',
      '約 121m までに無い（この先はまだ読めていない）']) expect(nether).toContain(fact);
    expect(nether).not.toMatch(/帯に並ぶ|radius=32|z 軸|直角の向き/u);
    const plan = seedPlan('エンドラを討伐してください', 'the_nether');
    const fortress = plan?.nodes.find(node => node.title === 'ネザー要塞を探す');
    expect(fortress?.note).toContain('432m区画');
    expect(fortress?.note).not.toContain('帯');
    expect(fortress?.note).not.toContain('南北');
  });

  it('describes portal clearing, alternate ignition and a single 22-source obsidian hand', () => {
    const prep = V2_STAGES.prep;
    for (const fact of ['at の 1 段下', '村や人の物・液体では止まる', '泣く黒曜石もダイヤのツルハシ',
      'ファイヤーチャージ（荒廃したポータルの箱）', 'enter:false', '点火は未', 'count=22・seconds=300',
      'count 省略時は at の数', '1 回の注水で面を固め']) expect(prep).toContain(fact);
    expect(SHORT_ACT_DESCRIPTION).not.toContain('地図の L、8 つまで');
    expect(SHORT_ACT_DESCRIPTION).toContain('count（省略時は座標の数）');
  });

  it('compares pearl routes and explains enderman selection and stop evidence', () => {
    const pearl = V2_STAGES.pearl;
    for (const fact of ['count=N', '最大 3 体', '戻る時間・夜までの待ち', '怒っている個体を先', '8〜48m',
      '30m 以内を先', 'enderman_not_visible', 'mc_probe kind=roofsite', '15 秒', 'enderman_did_not_arrive',
      'そちら側に屋根を作り直す', 'lost', 'id・距離・方角・マス', '黒曜石以外']) expect(pearl).toContain(fact);
    expect(pearl).not.toContain('ネザーの 3 方向を見てから');
  });

  it('keeps the overworld night as the pearls\' way when no warped forest is found (review 11/10, K10)', () => {
    const pearl = V2_STAGES.pearl;
    for (const fact of ['森が見つからない時の道', '地上でも戦い方は同じ', 'パールを地上で集める時は別: ロッドが 7 本あれば出て']) expect(pearl).toContain(fact);
    const tree = seedPlan('エンドラを討伐してください')!;
    const pearls = tree.nodes.find(node => node.title === 'エンダーパール14以上')!;
    const ways = tree.nodes.filter(node => node.parentId === pearls.id);
    expect(ways.map(node => node.title)).toContain('歪んだ森が見つからない時は、地上の夜の平らな所でエンダーマン（天井2）');
    expect(ways.every(node => node.kind === 'pearl')).toBe(true);
    expect(tree.nodes.length).toBeLessThanOrEqual(64);
  });
});

describe('the roofsite probe (S6, body fb180c10)', () => {
  it('is a kind of mc_probe with a radius of 4 to 24 (16 when not given)', async () => {
    const { PROBE_KINDS } = await import('../src/contracts/minecraftProbeContract.js');
    const { prepareProbeInput } = await import('../src/surfaces/minecraft/minecraftLlmcProbeInput.js');
    expect(PROBE_KINDS).toContain('roofsite');
    expect(prepareProbeInput({ kind: 'roofsite' }, { feet: null, creatures: [] })).toMatchObject({ input: { kind: 'roofsite', radius: 16 } });
    expect(prepareProbeInput({ kind: 'enderman_roof', radius: 40 }, { feet: null, creatures: [] })).toMatchObject({ input: { kind: 'roofsite', radius: 24 } });
  });
});
