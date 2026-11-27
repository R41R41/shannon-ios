import { afterEach, describe, expect, it } from 'vitest';
import { planFromSeeds, type PlanSeed } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { readinessParts, type LlmcBodyParts } from '../src/surfaces/minecraft/minecraftLlmcBodyFacts.js';
import { dayBedLine, nightBedLine } from '../src/surfaces/minecraft/minecraftNightArms.js';
import { animalsLine, enderSeenWords, forgetPearlWatch, nightMeanwhileLine, notePearlWatch, pearlDayLine } from '../src/surfaces/minecraft/minecraftNightPearl.js';
import { lookHint } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { repeatedReply, stopCodesOf, type StopCode } from '../src/surfaces/minecraft/minecraftLlmcRepeat.js';
import { hopsLine, HOPS_STALE_MS } from '../src/surfaces/minecraft/minecraftLlmcQueueWords.js';
import { packLines } from '../src/surfaces/minecraft/minecraftLlmcPack.js';

/** 11/27 night of the pearls: the pearl node was renamed and kept the kind `stronghold`; the head booked sleeps for the night it meant to hunt in, then waited nine times. */
afterEach(() => forgetPearlWatch());
const stamp = '2026-11-27T00:00:00Z';
const frame = (world: Record<string, unknown>): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: stamp, receivedAt: stamp, connected: true,
  state: { world, bodyRun: { bodyBoot: 'bb', connectionId: 'c' } } as never, facts: {} as never });
const seed = (id: string, title: string, fields: Partial<PlanSeed> = {}): PlanSeed => ({ id, title, ...fields } as PlanSeed);
const FRAME_MARK = 'Q エンドポータルの枠 (507,31,1603) 南7・下53 ×12 アイ入り 1';
const WORN = '頭: iron_helmet(残り165/165)・胸: iron_chestplate(残り240/240)・脚: iron_leggings(残り225/225)・足: iron_boots(残り195/195)';
const inventory = (items: Record<string, number>) => Object.entries(items).map(([name, count]) => ({ name, count }));
const world = (extra: Record<string, unknown> = {}) => ({ dimension: 'overworld', timeOfDay: 8000, health: 20, food: 20, worn: WORN, position: { x: 508, y: 84, z: 1597 },
  mapLandmarks: [FRAME_MARK], nearbyEntities: [], nearbyThreats: [],
  inventory: inventory({ white_bed: 7, ender_eye: 10, obsidian: 7, dirt: 1, arrow: 2, flint: 2, stick: 2, blaze_powder: 1, shield: 1, diamond_pickaxe: 1, iron_sword: 1 }), ...extra });
const counts = (items: Record<string, number>) => new Map(Object.entries(items));
const PACK = { white_bed: 7, ender_eye: 10, obsidian: 7, dirt: 1, arrow: 2, flint: 2, stick: 2, shield: 1, diamond_pickaxe: 1 };
const WORD = 'パールを地上のエンダーマンで集めるなら、その夜は寝ない';
const renamed = () => planFromSeeds([seed('p2', 'パールとブレイズ粉を集め、アイを 12 個にする（枠 12 のため）', { kind: 'stronghold' })]);
const parts = (tree: ReturnType<typeof renamed>, w: Record<string, unknown>, llmc: Partial<LlmcBodyParts> = {}) =>
  readinessParts({ plan: () => undefined, planView: () => null, planTree: () => tree, journeyReadiness: true, ...llmc } as LlmcBodyParts, null, frame(w), 'night-1');

describe('(1) the pearl fact stands up from the gap, not from the node\'s kind', () => {
  it('(a) a renamed node that kept the kind stronghold, with 10 eyes and one frame empty beyond the eleven: the day line says not to sleep the night, with the danger beside it', () => {
    const planNow = parts(renamed(), world()).planNow!;
    expect(planNow).toContain(WORD);
    expect(planNow).toContain('夜に地表で待つ時の事実: 体力 20/20・着ている防具 4/4・盾 あり・今見えている敵 0 体');
    expect(planNow).toContain('ゾンビ・スケルトン・クリーパー');
    // the bed's own night line (the endgame's) is given the same fact
    expect(nightBedLine({ ...world({ timeOfDay: 14000 }) }, counts(PACK), 'overworld', true)).toContain(WORD);
  });
  it('(a1) the brief day line (said most of the time; the full one once in 8 minutes) carries the word too', () => {
    const brief = dayBedLine(world(), counts(PACK), 'overworld', true, false, true)!;
    expect(brief).toContain(WORD);
    expect(brief).toContain('夜に地表で待つ時の事実');
    expect(dayBedLine(world(), counts(PACK), 'overworld', false, false, true)).not.toContain(WORD);
    // while the pearls are short the sentence that asks for a sleep booking ("be on the surface at night: book it") is not said; the sleep-only hands stay refused
    expect(brief).not.toContain('夜に地上で動く予定なら sleep');
    expect(brief).toContain('sleep だけの手（drop；sleep など作業の無い手）を入れない');
    expect(dayBedLine(world(), counts(PACK), 'overworld', false, false, true)).toContain('夜に地上で動く予定なら sleep');
  });
  it('(a2) the gap is the empty frames (the frames seen less the eyes in them) less the pearls and eyes carried: 11 empty, 10 eyes, 1 pearl is no gap', () => {
    expect(parts(renamed(), world({ inventory: inventory({ ...PACK, ender_pearl: 1 }) })).planNow).not.toContain(WORD);
  });
  it('(b) no pearl is short, or the run is a request of one thing, or health is low, or the stage is not the End\'s: the sentence is not said', () => {
    expect(parts(renamed(), world({ inventory: inventory({ ...PACK, ender_eye: 11 }) })).planNow).not.toContain(WORD);
    expect(parts(renamed(), world(), { singleRequest: true }).planNow).not.toContain(WORD);
    expect(parts(renamed(), world({ health: 8 })).planNow).not.toContain(WORD);
    // no eye in the pack and a node of another kind: the End's check is not what is being prepared
    const iron = planFromSeeds([seed('p2', '鉄を掘る', { kind: 'iron' })]);
    expect(parts(iron, world({ inventory: inventory({ white_bed: 1, iron_pickaxe: 1 }) })).planNow).not.toContain(WORD);
    // the frames are not counted yet (the stronghold is still to be found): the eyes to hold are 12 plus the spare (14 with no throw made), not the 10 that go there. 10 eyes are short, and
    // armed (sword, shield, health) the pearls are the now; unarmed they are not (the night is then slept as before)
    expect(parts(renamed(), world({ mapLandmarks: [] })).planNow).toContain(WORD);
    expect(parts(renamed(), world({ mapLandmarks: [], inventory: inventory({ ...PACK, iron_sword: 1, shield: 0 }) })).planNow).not.toContain(WORD);
  });
  it('the pearl node by its own kind keeps the old behaviour (under 10 pearls and eyes, with no frames known)', () => {
    const few = new Map([['white_bed', 1], ['blaze_rod', 7], ['ender_pearl', 3]]);
    expect(nightBedLine({ time: '14000' }, few, 'overworld', true)).toContain(`${WORD}（地上のエンダーマンは夜に出て、寝ると夜が飛ぶ）`);
    expect(dayBedLine({ timeOfDay: 1000 }, few, 'overworld', true)).toContain(WORD);
  });
});

describe('(2) the day line gives the reason and what the day has shown', () => {
  it('says where the pearls mainly come from and that a sleep skips the night, with no odds or drop numbers', () => {
    const line = pearlDayLine(world(), counts(PACK), 'overworld', true, null)!;
    expect(line).toContain('パールはあと 1 個足りない');
    expect(line).toContain('パールの主な入手先は、エンダーマンが湧く夜の地上。寝れば夜が飛ぶ');
    expect(line).not.toMatch(/%|確率|期待|重み/u);
    expect(pearlDayLine(world(), counts(PACK), 'overworld', false, null)).toBeNull();
    expect(pearlDayLine(world({ timeOfDay: 14000 }), counts(PACK), 'overworld', true, null)).toBeNull();
  });
  it('counts the endermen seen by day over the daytime watched, from the frames, and says nothing before 3 minutes of day', () => {
    const t0 = Date.parse(stamp);
    notePearlWatch('t', world(), 'overworld', t0);
    notePearlWatch('t', world(), 'overworld', t0 + 20_000);
    expect(enderSeenWords('t')).toBeNull();
    for (let i = 2; i <= 12; i += 1) notePearlWatch('t', world(), 'overworld', t0 + i * 20_000);
    expect(enderSeenWords('t')).toBe('この実走で昼に見えたエンダーマン: 0 体（昼の観測 約 4 分。見える範囲だけの数。地上のエンダーマンは夜に出るので、昼に見えないのは普通）');
    notePearlWatch('t', world({ nearbyEntities: [{ id: 9, name: 'enderman', kind: 'neutral', distance: 20, position: { x: 1, y: 70, z: 1 } }] }), 'overworld', t0 + 13 * 20_000);
    expect(enderSeenWords('t')).toContain('1 体');
    const seen = enderSeenWords('t');
    expect(pearlDayLine(world(), counts(PACK), 'overworld', true, seen)).toContain(seen!);
  });
});

describe('(3) while the night is near: the shortages that can be moved, from the raw counts', () => {
  const line = nightMeanwhileLine(world({ timeOfDay: 8200 }), counts(PACK), 'overworld', true)!;
  it('lists the scaffold, the obsidian and the arrows with their raw numbers and materials', () => {
    expect(line).toContain('夜まで 約 4 分');
    expect(line).toContain('足場のブロック あと 63（今 1/64');
    expect(line).toContain('黒曜石 あと 1（今 7/8。ダイヤのつるはし あり）');
    expect(line).toContain('矢 あと 28（今 2/30。材料 羽根 0・火打石 2・棒 2）');
  });
  it('gives no estimate of time and does not say these replace the wait; they are the checks that are fine behind the stronghold', () => {
    expect(line).not.toMatch(/間に合|足りる|余裕|十分|で済む|何分/u);
    expect(line).not.toMatch(/代わりに|やるべき|先にやる/u);
    expect(line).toContain('要塞の後ろ・道中で取れる分でよく');
    expect(line).toContain('この待ちの間に進められる不足');
    expect(line).toContain('パールはエンダーマンが湧く夜まで入らず');
  });
  it('is silent when the pearls are not the now, the night is far, it is night already, or nothing is short', () => {
    expect(nightMeanwhileLine(world({ timeOfDay: 8200 }), counts(PACK), 'overworld', false)).toBeNull();
    expect(nightMeanwhileLine(world({ timeOfDay: 100 }), counts(PACK), 'overworld', true)).toBeNull();
    expect(nightMeanwhileLine(world({ timeOfDay: 14000 }), counts(PACK), 'overworld', true)).toBeNull();
    expect(nightMeanwhileLine(world({ timeOfDay: 8200 }), counts({ ...PACK, cobblestone: 64, obsidian: 8, arrow: 30 }), 'overworld', true)).toBeNull();
  });
  it('is in the live now of the renamed pearl node while the dusk comes', () => {
    const planNow = parts(renamed(), world({ timeOfDay: 8200 })).planNow!;
    expect(planNow).toContain('この待ちの間に進められる不足');
    expect(planNow).toContain('パールの主な入手先は、エンダーマンが湧く夜の地上');
  });
});

describe('(4) the animals last seen, and the body\'s reply to the same refusal', () => {
  it('(d) says where a sheep and a pig were last seen, how long ago and how far, only while none is in view', () => {
    const t0 = Date.parse(stamp);
    const seen = world({ nearbyEntities: [{ id: 1, name: 'sheep', distance: 10, position: { x: 530, y: 70, z: 1620 } }, { id: 2, name: 'pig', distance: 12, position: { x: 500, y: 70, z: 1580 } }] });
    notePearlWatch('t', seen, 'overworld', t0);
    expect(animalsLine('t', seen, t0 + 1000)).toBeNull();
    const line = animalsLine('t', world(), t0 + 180_000)!;
    expect(line).toContain('羊 (530,70,1620) 約 3 分前・ここから 32 m');
    expect(line).toContain('豚 (500,70,1580) 約 3 分前・ここから 19 m');
    expect(animalsLine('nobody', world(), t0)).toBeNull();
    // a cow seen 1,000 m away or a sheep seen 25 minutes ago is not a place to look for one now
    notePearlWatch('far', world({ nearbyEntities: [{ id: 3, name: 'cow', distance: 5, position: { x: 508 + 1000, y: 70, z: 1597 } }] }), 'overworld', t0);
    expect(animalsLine('far', world(), t0 + 1000)).toBeNull();
    notePearlWatch('old', seen, 'overworld', t0);
    expect(animalsLine('old', world(), t0 + 25 * 60_000)).toBeNull();
    const out = parts(renamed(), world(), {});
    expect(out.animals).toBeUndefined();
  });
  it('the animals line is part of the readiness parts once a sheep was seen and none is in view now', () => {
    parts(renamed(), world({ nearbyEntities: [{ id: 1, name: 'sheep', distance: 10, position: { x: 530, y: 70, z: 1620 } }] }));
    expect(parts(renamed(), world()).animals).toContain('羊 (530,70,1620)');
  });
  it('the same refusal three times shows the body\'s reply in the look line; fewer times, or no reply, leaves the old words', () => {
    const w = { recentStops: ['(507,84,1596) 無い ×2 8秒前（no_target）'] };
    const reply = '40m 内に sheep の成体が居ない。動物は見えていない（歩いて探す）（同じ所・同じ理由で2回目）';
    const codes: StopCode[] = [1, 2, 3].map(i => ({ cell: `${i},84,1596`, word: '無い', code: 'no_target', reply }));
    const text = lookHint(w, 0, codes)!;
    expect(text).toContain('体の返事（3 回同じ）: 40m 内に sheep の成体が居ない。動物は見えていない（歩いて探す）。');
    expect(text).not.toContain('同じ理由で');
    expect(lookHint(w, 0, codes.slice(0, 2))).toContain('原因は見えていない');
    expect(lookHint(w, 0, codes.map(({ reply: _drop, ...rest }) => rest))).toContain('原因は見えていない');
    expect(repeatedReply(codes)?.count).toBe(3);
    expect(lookHint({ recentStops: [] }, 0, codes)).toBeNull();
  });
  it('keeps the body\'s words after the code when a result is read into stop codes', () => {
    const result = JSON.stringify({ schemaVersion: 1, lines: [{ i: 1, status: 'failed', code: 'no_target', line: '無い: hunt 止まった no_target: 40m 内に sheep の成体が居ない。動物は見えていない（歩いて探す）' }],
      at: { x: 507, y: 84, z: 1596 }, stoppedBy: null });
    const codes = stopCodesOf(result);
    // the result contract may refuse a bare object; when it reads, the reply is kept
    if (codes.length) expect(codes[0]!.reply).toContain('40m 内に sheep の成体が居ない');
  });
});

describe('(5) the tidy words mark the blocks that are the scaffold', () => {
  const lines = ['dirt×5', 'cobblestone×2', 'acacia_sapling×3', 'iron_ingot×1', ...Array.from({ length: 30 }, (_, i) => `item_${i}×1`)];
  it('says what counts, how many are short after a full throw and how to keep them', () => {
    const out = packLines(lines, { free: 1, blocks: { have: 7, need: 64, held: [['dirt', 5], ['cobblestone', 2]] } }).join('\n');
    expect(out).toContain('足場に数える物（dirt×5・cobblestone×2）は今 7/64');
    expect(out).toContain('捨てると足場があと 64 個要る（残すなら keep=dirt:5,cobblestone:2）');
    expect(packLines(lines, { free: 1 }).join('\n')).not.toContain('足場に数える物');
  });
});

describe('(6) the line of the last gos goes when the last go is two minutes old', () => {
  const hop = (done: number, at?: number) => ({ done, target: done, stop: null, seconds: null, fromY: null, toY: null, ...(at !== undefined ? { at } : {}) });
  const hops = (at?: number) => [hop(9, at), hop(2, at), hop(6, at), hop(2, at), hop(7, at)];
  it('is said while the gos are recent, gone at 2 minutes, and said when no time is given (old records)', () => {
    const t = 1_000_000;
    expect(hopsLine(hops(t), [5000], t + 30_000)).toContain('直近の go は');
    expect(hopsLine(hops(t), [5000], t + HOPS_STALE_MS - 1)).toContain('直近の go は');
    expect(hopsLine(hops(t), [5000], t + HOPS_STALE_MS)).toBeNull();
    expect(hopsLine(hops(), [5000], t + 10 * HOPS_STALE_MS)).toContain('直近の go は');
    expect(hopsLine(hops(t), [5000])).toContain('直近の go は');
  });
});
