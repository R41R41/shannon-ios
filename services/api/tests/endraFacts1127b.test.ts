import { beforeEach, describe, expect, it } from 'vitest';
import { furnaceReachLine, ironSearchLine, preparationShortage } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';
import { dayBedAdviceTold, forgetDayBedAdvice, withStopReadings } from '../src/surfaces/minecraft/minecraftLlmcBodyFacts.js';
import { packLines } from '../src/surfaces/minecraft/minecraftLlmcPack.js';
import { dayBedLine } from '../src/surfaces/minecraft/minecraftNightArms.js';

/** 11/27 run 8: the iron count said as a fact, the shortage with what is left, the full pack, the stops' kinds, the furnace's reach, and the day's sleep words. */
const T0 = Date.parse('2026-01-01T00:00:00Z');
const row = '鉄鉱石 ×9 最寄り (-129,66,-151) 北 12m・下 5 埋まり・17マス掘り歩き｜空気に面した最寄り (-131,28,-140) 西 6m・下 43 9個の塊・階段39段+歩き36m';
const scan = { trigger: 'login', at: new Date(T0).toISOString(), center: { x: -125, y: 71, z: -140 }, text: '鉄', rows: [row] };
const ARMOUR = '頭: iron_helmet(残り165/165)・胸: iron_chestplate(残り240/240)・脚: iron_leggings(残り225/225)・足: iron_boots(残り195/195)';
const world = (extra: Record<string, unknown> = {}) => ({ position: { x: -125, y: 71, z: -140 }, mapLandmarks: [], scan, ...extra });
const pack = (extra: Record<string, number> = {}) => new Map<string, number>([['stone_pickaxe', 1], ['iron_ingot', 2], ...Object.entries(extra)]);
const p2 = { id: 'p2', title: '鉄を取りバケツと防具を作る', doneWhen: 'have:iron_ingot>=20', target: { item: 'iron_ingot', count: 20 } } as never;

describe('the iron count is the node condition, not a stock to keep', () => {
  it('does not say 20 are wanted; says the count is used up by what is made, and that the node can be closed or its condition rewritten', () => {
    const line = ironSearchLine(world({ worn: ARMOUR }), pack({ bucket: 1 }), 'overworld', p2, T0 + 60_000)!;
    expect(line).not.toContain('20 要る');
    expect(line).toContain('この節の条件はインゴット 20 本');
    expect(line).toContain('作る物（防具・バケツなど）に使うとインゴットは減る');
    expect(line).toContain('在庫を 20 本に保つ必要は無く');
    expect(line).toContain('plan.update で set state=done');
    expect(line).toContain('doneWhen を書き直してよい');
    expect(line).toContain('make は材料不足で止まる');
  });
  it('says the made things as a fact only when the node names them and the worn list is read', () => {
    const worn = ironSearchLine(world({ worn: ARMOUR }), pack({ bucket: 1 }), 'overworld', p2, T0 + 60_000)!;
    expect(worn).toContain('この節が作る物の今: 鉄の防具は 4/4 着ている（兜・胸当て・脚当て・靴）・バケツは持っている');
    const partly = ironSearchLine(world({ worn: '頭: iron_helmet(残り165/165)・胸: なし・脚: なし・足: なし' }), pack(), 'overworld', p2, T0 + 60_000)!;
    expect(partly).toContain('鉄の防具は 1/4 着ている（兜）。まだ 胸当て・脚当て・靴');
    expect(partly).toContain('バケツはまだ無い');
    // no worn list in the frame: no fact is made up
    expect(ironSearchLine(world(), pack(), 'overworld', p2, T0 + 60_000)).not.toContain('この節が作る物の今: 鉄の防具');
    // a node that names no armour, no tool and no bucket, with no readable target of that kind: no line
    const plain = { id: 'p2', title: '鉄を掘る', doneWhen: 'have:iron_ingot>=20', target: { item: 'iron_ingot', count: 20 } } as never;
    expect(ironSearchLine(world({ worn: ARMOUR }), pack(), 'overworld', plain, T0 + 60_000)).not.toContain('この節が作る物の今');
    const noTarget = { id: 'p2', title: '鉄を掘る', doneWhen: 'have:iron_ingot>=20' } as never;
    expect(ironSearchLine(world({ worn: ARMOUR }), pack(), 'overworld', noTarget, T0 + 60_000)).not.toContain('この節が作る物の今');
  });
  it('an armour or tool target is read from the target', () => {
    const node = { id: 'p3', title: '装備', doneWhen: 'have:iron_ingot>=3', target: { item: 'iron_pickaxe', count: 1 } } as never;
    expect(ironSearchLine(world({ worn: ARMOUR }), pack({ iron_pickaxe: 1 }), 'overworld', node, T0 + 60_000)).toContain('iron_pickaxe は持っている');
  });
  it('puts the pieces of the clumps beside the number wanted, with the reason a short clump is not the pick', () => {
    const marks = ['鉄鉱石[iron_ore] (216,39,-14) 東1・南8・下16 ×1 見えている'];
    const line = ironSearchLine(world({ worn: ARMOUR, mapLandmarks: marks }), pack(), 'overworld', p2, T0 + 60_000)!;
    expect(line).toContain('鉄の塊の個数と掘る段数: 見えている鉄 ×1・下 16／走査の鉄 9 個の塊・階段 39 段');
    expect(line).toContain('要る生の鉄は 18 個');
    expect(line).toContain('個数が足りる塊を先に選ぶ');
  });
});

describe('the End shortage: what is left, the two bed numbers, the reason of the bow', () => {
  const counts = new Map<string, number>([['white_bed', 7], ['obsidian', 7], ['cobblestone', 42], ['ender_eye', 11], ['water_bucket', 1], ['iron_sword', 1]]);
  const line = preparationShortage({ dimension: 'overworld', counts, food: 500, nowKinds: ['stronghold'], worn: [] })!;
  it('says the title as a fact and the numbers with what is left', () => {
    expect(line.startsWith('準備の不足（エンドへ入る前に要る物（')).toBe(true);
    expect(line).toContain('ベッド（エンドの点検は 8・戦いの目標は 10） 7/8（あと 1）');
    expect(line).toContain('黒曜石（エンドの戦い用・目標 12。ポータルの 10 とは別） 7/8（あと 1）');
    expect(line).toContain('足場のブロック 42/64（あと 22）');
  });
  it('says once that 8 is the check and 10 the aim, and gives the bow and arrows their reason in the same sentence', () => {
    expect(line).toContain('ベッドの点検が通るのは 8 本から。10 本は戦いの目標で、節が済む条件を 10 本にしなくてよい');
    expect(line).toContain('弓・矢は、要塞へ向かう道中の短い節で作る物で、遠い往復はしない（そろわなくても入れる）');
    expect(line).not.toContain('取りに出る節は書かなくてよい');
  });
  it('keeps the other stages and the empty shortage as they were', () => {
    const full = new Map<string, number>([['white_bed', 8], ['obsidian', 8], ['cobblestone', 64], ['ender_eye', 12], ['water_bucket', 1], ['iron_sword', 1], ['bow', 1], ['arrow', 30]]);
    expect(preparationShortage({ dimension: 'overworld', counts: full, food: 500, nowKinds: ['stronghold'], worn: [] })).toBeNull();
    const gate = preparationShortage({ dimension: 'overworld', counts: new Map([['iron_pickaxe', 1]]), food: 50, nowKinds: ['portal'], worn: [] })!;
    expect(gate).not.toContain('（あと');
  });
});

describe('the full pack: why 10, what fills a slot, which way of freeing room holds', () => {
  const lines = ['dirt×64', 'cobblestone×64'];
  it('says it beside the free count while under 10, with tidy only where tidy is offered', () => {
    const four = packLines(lines, { free: 4 }).join('\n');
    expect(four).toContain('mine と拾う dig の前に空きを 10 以上にする');
    expect(four).toContain('go・vertical で掘り進む手は満杯でも止まらないので、その前に drop を足さなくてよい');
    expect(four).toContain('掘る岩の種類ごとに 1 マス埋まる');
    expect(four).toContain('水が近い所や 3 m 以内では投げた物を拾い直す');
    expect(four).toContain('3 m 以上離れてから drop する');
    expect(four).not.toContain('tidy にするか');
    expect(packLines(lines, { free: 2 }).join('\n')).toContain('tidy にするか、3 m 以上離れてから drop する');
    expect(packLines(lines, { free: 12 }).join('\n')).not.toContain('空きを 10 以上にする');
  });
});

describe('the stops: what limit_dig and inventory_full are, with the number the limit is set against', () => {
  it('adds one reading line only for the codes that are there', () => {
    const stops = ['(216,39,-14) 掘れない ×2 45秒前（limit_dig）', '(210,40,-15) 満杯 143秒前（inventory_full）'];
    const said = withStopReadings(stops);
    expect(said.slice(0, 2)).toEqual(stops);
    expect(said[2]).toContain('limit_dig＝掘る数の上限 maxDig に着いた（水のせいではない）');
    expect(said[2]).toContain('maxDig は n+5 以上');
    expect(said[2]).toContain('inventory_full＝持ち物が満杯');
    expect(withStopReadings(['(251,25,-44) 届かない 6秒前（unreachable）'])).toEqual(['(251,25,-44) 届かない 6秒前（unreachable）']);
  });
});

describe('the reach of a furnace', () => {
  const at = (y: number, marks: string[]) => ({ position: { x: 0, y, z: 0 }, mapLandmarks: marks });
  it('says the vertical distance, the 5 m reach and the furnace to make below, only while something is to smelt and none is within 5 m', () => {
    const line = furnaceReachLine(at(30, ['F かまど (214,48,-24) 西1・北2・上7']), new Map([['raw_iron', 1], ['cobblestone', 3]]))!;
    expect(line).toContain('(214,48,-24) は足元より 18 m 上');
    expect(line).toContain('furnace は 5 m を超えると使えない');
    expect(line).toContain('下で掘る間は下に炉を作る（丸石 8 個で作れる。今 3 個）');
    expect(furnaceReachLine(at(46, ['F かまど (214,48,-24) 西1']), new Map([['raw_iron', 1]]))).toBeNull();
    expect(furnaceReachLine(at(30, ['F かまど (214,48,-24) 西1']), new Map([['cobblestone', 9]]))).toBeNull();
    expect(furnaceReachLine(at(30, []), new Map([['raw_iron', 1]]))).toBeNull();
  });
});

describe('the day sleep words are not repeated in full', () => {
  const bed = new Map([['white_bed', 1]]);
  beforeEach(() => forgetDayBedAdvice());
  it('keeps the clock, the cost of waiting and the rule against a sleep standing in for work in both forms; the explanation only in the full one', () => {
    const full = dayBedLine({ time: '3000' }, bed, 'overworld')!;
    const brief = dayBedLine({ time: '3000' }, bed, 'overworld', false, true, true)!;
    for (const line of [full, brief]) {
      expect(line).toContain('昼（寝られるまで');
      expect(line).toContain('なにも進まない');
      expect(line).toContain('寝られるまで 7 分以上ある間は、sleep だけの手');
    }
    expect(full).toContain('夜の地上は敵が増えて危なく');
    expect(brief).not.toContain('夜の地上は敵が増えて危なく');
    expect(brief.length).toBeLessThan(full.length * 0.7);
  });
  it('says the explanation in full the first time and again only after 8 minutes', () => {
    expect(dayBedAdviceTold('t1', 0)).toBe(false);
    expect(dayBedAdviceTold('t1', 60_000)).toBe(true);
    expect(dayBedAdviceTold('t1', 7 * 60_000)).toBe(true);
    expect(dayBedAdviceTold('t1', 9 * 60_000)).toBe(false);
    expect(dayBedAdviceTold('t2', 60_000)).toBe(false);
  });
});
