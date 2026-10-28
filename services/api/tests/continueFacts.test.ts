import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { PlanPromise, PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import type { ActInput } from '../src/contracts/minecraftActContract.js';
import { forgetOnceFacts, offer, pending } from '../src/surfaces/minecraft/minecraftLlmcOnceFacts.js';
import { activeMinutes, meterLine } from '../src/surfaces/minecraft/minecraftLlmcRoad.js';
import { createHitWatch, deliverOnceFacts, foodCandidates, foodLine, handEffect, holderLine, inputFacts, lifeOf, controlOf, nextGains, onceFor, packLines,
  queueNowLines, stopFactsOf, vitalsLine } from '../src/surfaces/minecraft/minecraftLlmcFacts.js';
import { llmcTokens } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { V2_ALWAYS } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';
import { nearWorthy } from '../src/surfaces/minecraft/minecraftLlmcReachWords.js';
import { foodFirstLine } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';
import { benchDProbes, extractRequestBytes, forgetBench, type MaxState, type Variant } from './helpers/extractRequestBytes.js';
import { judge, loadFixtures } from '../../../tools/continue-verify/judge.js';
import { v2tree } from './helpers/planTreeV2.js';

/**
 * The continue contract, chapter 8 (「判断に届ける事実」, D6's norm) and boundary 10 (bench D): whatever version of the input a decision reads, the facts of the table are in the
 * LAST REQUEST'S BYTES, by their values and ids (not by a heading). The head is run from the body's frames to the bytes the model's request is made of (`extractRequestBytes`),
 * and nothing is sent. Fixtures: `measure/urgent-max-input`, `live-before-after-fish`, `inventory-full-facts`, `queue-and-effects-in-input`, `one-time-fact-delivery`,
 * `meter-clock-excludes-holds` and `control/fight-damage-facts`.
 */
const fixture = (name: string) => JSON.parse(fs.readFileSync(new URL(`./fixtures/continue/${name}.json`, import.meta.url), 'utf8')) as Record<string, any>;
afterEach(() => { forgetBench(); forgetOnceFacts(); });

const frame = (world: Record<string, unknown>, extra: Record<string, unknown> = {}, facts: Record<string, unknown> = {}): BodyObservation => ({ schemaVersion: 1, bodyId: 'b', sequence: 1, stateAt: 't',
  receivedAt: 't', connected: true, state: { world: world, ...extra } as never, facts: facts as never });
const promise = (id: number, item: string, count: number, use: string): PlanPromise => ({ id, rev: 1, item, count, use, state: 'open', ledger: [] });

describe('boundary 10: the largest input keeps the facts of the table in the last request, in the normal, the urgent and the shortened version', () => {
  const sample = fixture('measure/urgent-max-input');
  const state = sample.input.state as MaxState;
  // The scene's items by their values: planks 2 (the promise 3 says 今 2), 7 obsidian (the promise 6), and the food she carries is in `state.foods`.
  const options = {
    state, inventory: [{ name: 'oak_planks', count: 2 }, { name: 'obsidian', count: 7 }, { name: 'cobbled_deepslate', count: 64 }, { name: 'cobbled_deepslate', count: 41 }, { name: 'dirt', count: 35 }],
    promises: [promise(3, 'planks', 4, '作業台'), promise(4, 'food', 20, '地下で食べる分'), promise(5, 'stick', 2, 'はしご'), promise(6, 'obsidian', 10, '黒曜石の枠')],
    hands: [{ hands: [{ do: 'attack', target: '#2601' }] }, { hands: [{ do: 'go', to: { x: 172, y: -19, z: 236 } }] }] as ActInput[],
    results: ['act 全部済み（1/1）'],
  };
  const MUST = sample.expected.eachVersionMustContain as string[];
  const variants: Variant[] = ['normal', 'urgent', 'compressed'];

  it.each(variants)('%s: every value and id of the fixture is in the last request\'s bytes', async variant => {
    const got = await extractRequestBytes({ ...options, variant, taskId: `max-${variant}`, ...variant === 'compressed' ? { compactAboveTokens: 16_000 } : {} });
    const missing = MUST.filter(word => !got.lastMessage.includes(word));
    expect(missing).toEqual([]);
    // The live state is the long one: the filler's long result is in it, and the request is large.
    expect(got.bytes.length).toBeGreaterThan(30_000);
  });

  it('is the version it says: the urgent one has the short live state, the shortened one the facts in their shortened form', async () => {
    const [normal, urgent, compressed] = await Promise.all(variants.map(variant => extractRequestBytes({ ...options, variant, taskId: `kind-${variant}`,
      ...variant === 'compressed' ? { compactAboveTokens: 16_000 } : {} })));
    expect(JSON.stringify(urgent!.live.body.mode)).toContain('急ぎの版');
    expect(normal!.live.body.mode).toBeUndefined();
    expect(compressed!.live.body.mode).toBeUndefined();
    const pack = (live: Record<string, any>) => (live.body.facts as string[]).filter(line => line.startsWith('持ち物の空き') || line.startsWith('場所を取っている物'));
    // The pack: the normal and urgent versions say what takes the slots on a line of its own; the shortened version has one line.
    expect(pack(normal!.live)).toHaveLength(2);
    expect(pack(urgent!.live)).toHaveLength(2);
    expect(pack(compressed!.live)).toHaveLength(1);
    expect(pack(compressed!.live)[0]).toContain('空き 0');
    expect(pack(compressed!.live)[0]).toContain('満杯');
    expect(pack(normal!.live)[1]).toMatch(/場所を取っている物: .*（\d マス）/u);
  });

  it('says the facts in values, and none of them asks for anything: 命令の文が無い', async () => {
    const got = await extractRequestBytes({ ...options, variant: 'normal', taskId: 'plain' });
    const lines = got.live.body.facts as string[];
    expect(lines.length).toBeGreaterThanOrEqual(8);
    for (const line of lines) expect(line).not.toMatch(/しなさい|してください|すること|べき|しろ|行け|食べろ|捨てろ/u);
    // The values the fixture asks for, each on the line that owns it.
    expect(lines.find(line => line.startsWith('体力'))).toBe('体力 6.4/20・満腹 11/20・食べ物 bread×1（+11 点）');
    expect(lines.find(line => line.startsWith('直近'))).toMatch(/^直近 10 秒で 2 回ダメージを受けた（合計 10\.2: 5\.3（9 秒前）・4\.9（4 秒前））。その時近くにいた敵: zombie #2601 2\.1m$/u);
    expect(lines.find(line => line.startsWith('体を動かしている物'))).toBe('体を動かしている物: 反射 floor-melee（相手 #2601）・命 3');
    expect(lines.filter(line => line.startsWith('約束 #'))).toEqual([
      '約束 #3 作業台用の板 4: 今 2（足りない 2）', '約束 #4 地下で食べる分の食料 20 点: 今 11 点（足りない 9）',
      '約束 #5 はしご用の棒 2: 今 0（足りない 2）', '約束 #6 黒曜石の枠用の黒曜石 10: 今 7（足りない 3）']);
    expect(lines.find(line => line.startsWith('近くの食べ物'))).toBe('近くの食べ物の候補（24 m 以内の動物と魚）: cod #501 18.2m (188,-18,236)');
    // The queue: each item with its state, its time left and what its hands will do.
    expect(got.live.body.queue).toEqual([
      expect.stringMatching(/^▶ q52 .* 実行中: .*残り 20 秒（見込み）・予定: attack #2601$/u),
      expect.stringMatching(/^・ q53 .* 待ち: .*予定: go \(172,-19,236\)$/u), expect.stringMatching(/^あと 1 つ足せる/u)]);
  });

  it('the shortened version does not carry the facts said once; the urgent one carries all but the preparation\'s', async () => {
    // The preparation's fact is the head's own (a node of the kind prep_descent unmet below the surface, offered by the normal decision); the instead's is the ledger's.
    offer('once-versions', 'promise_instead_lost:3:r1', '約束 #3 の代わりの条件が成り立たなくなった（作業台から 95 段離れた）');
    const text = (live: Record<string, any>) => JSON.stringify(live.body.events ?? []);
    const normal = await extractRequestBytes({ ...options, variant: 'normal', taskId: 'once-versions' });
    expect(text(normal.live)).toContain('代わりの条件が成り立たなくなった');
    expect(text(normal.live)).toContain('準備の節 p1（食料 40・作業台か板 4）は満たしていない');
    forgetBench();
    forgetOnceFacts();
    offer('once-versions', 'promise_instead_lost:3:r1', '約束 #3 の代わりの条件が成り立たなくなった（作業台から 95 段離れた）');
    offer('once-versions', 'prep_unmet:p1', '準備の節 p1 は満たしていない');
    const urgent = await extractRequestBytes({ ...options, variant: 'urgent', taskId: 'once-versions' });
    expect(text(urgent.live)).toContain('代わりの条件が成り立たなくなった');
    expect(text(urgent.live)).not.toContain('準備の節 p1');
    expect(pending('once-versions').map(fact => fact.key)).toEqual(['prep_unmet:p1']);
    // The shortened version says none of them, delivers none, and keeps both for the next input.
    forgetBench();
    forgetOnceFacts();
    offer('once-versions', 'promise_instead_lost:3:r1', '約束 #3 の代わりの条件が成り立たなくなった（作業台から 95 段離れた）');
    offer('once-versions', 'prep_unmet:p1', '準備の節 p1 は満たしていない');
    const compressed = await extractRequestBytes({ ...options, variant: 'compressed', taskId: 'once-versions', compactAboveTokens: 16_000 });
    expect(text(compressed.live)).not.toContain('代わりの条件');
    expect(compressed.lastMessage).not.toContain('準備の節 p1 は満たしていない');
    expect(pending('once-versions').map(fact => fact.key)).toEqual(['promise_instead_lost:3:r1', 'prep_unmet:p1']);
  });

  it('the system prompt is as it was: V2_ALWAYS is not touched, and the live state\'s growth is measured', async () => {
    expect(llmcTokens(V2_ALWAYS)).toBeLessThanOrEqual(8_800);
    const got = await extractRequestBytes({ ...options, variant: 'normal', taskId: 'size' });
    // What this chapter added to the live state, taken off again: the `facts` lines and the queue's 「予定」 and 「（見込み）」.
    const { facts, queue, ...rest } = got.live.body as Record<string, any>;
    const before = { ...rest, queue: (queue as string[]).map(line => line.replace(/・予定: .*$/u, '').replace(/ ?: 予定: .*$/u, '').replace(/（見込み）/u, '')) };
    const added = { factsTokens: llmcTokens(JSON.stringify(facts)), queueTokens: llmcTokens(JSON.stringify(queue)) - llmcTokens(JSON.stringify(before.queue)),
      liveBefore: llmcTokens(JSON.stringify(before)), liveAfter: llmcTokens(JSON.stringify(got.live.body)), requestBytes: got.bytes.length };
    // Reported, not bounded by a rule: the largest input's normal version (8 fact lines).
    const others = Object.fromEntries(await Promise.all((['urgent', 'compressed'] as Variant[]).map(async variant => [variant, llmcTokens(JSON.stringify((await extractRequestBytes({ ...options, variant, taskId: `size-${variant}`,
      ...variant === 'compressed' ? { compactAboveTokens: 16_000 } : {} })).live.body.facts))])));
    console.info(`continueFacts size ${JSON.stringify({ ...added, factsTokensByVersion: { normal: added.factsTokens, ...others } })}`);
    expect(added.liveAfter - added.liveBefore).toBeLessThan(700);
    expect(added.liveAfter).toBeLessThan(12_000);
  });
});

describe('live-before-after-fish.json: cod and salmon within 24 m are food candidates, both listed, none made up', () => {
  const sample = fixture('measure/live-before-after-fish');
  const near = sample.input.raw.near as { name: string; id: number; distance: number }[];
  const world = { food: 12, inventory: [{ name: 'bread', count: 1 }], nearbyEntities: near.map(item => ({ name: item.name, id: item.id, kind: item.name === 'zombie' ? 'hostile' : 'passive', distance: item.distance,
    position: { x: 100 + item.distance, y: 64, z: 0 } })) };
  const observation = frame(world);

  it('the candidates are the fish and the animals within 24 m, the zombie not among them', () => {
    expect(foodCandidates(observation).map(item => `${item.name} #${item.id} ${item.distance}`)).toEqual(['cod #501 18.2', 'salmon #502 21']);
  });
  it('the normal and the urgent version both list the two, and list nothing that is not there', () => {
    const normal = foodLine(observation, 6)!, urgent = foodLine(observation, 3)!;
    for (const word of sample.expected.shownMustContain.normal as string[]) expect(normal).toContain(word);
    for (const word of sample.expected.shownMustContain.urgent as string[]) expect(urgent).toContain(word);
    expect(normal.match(/#\d+/gu)).toHaveLength(2);
    expect(urgent.match(/#\d+/gu)).toHaveLength(2);
    expect(sample.expected.invented).toBe(0);
    expect(foodLine(frame({ ...world, nearbyEntities: [] }), 3)).toBeNull();
  });
  it('with more than three, the urgent version keeps the nearest three and the normal one lists more', () => {
    const many = frame({ ...world, nearbyEntities: Array.from({ length: 8 }, (_, index) => ({ name: 'cow', id: 10 + index, distance: 3 + index, position: { x: 0, y: 64, z: 0 } })) });
    expect(foodLine(many, 3)!.match(/#\d+/gu)).toEqual(['#10', '#11', '#12']);
    expect(foodLine(many, 6)!.match(/#\d+/gu)).toHaveLength(6);
    expect(foodCandidates(frame({ nearbyEntities: [{ name: 'cow', id: 1, distance: 25, position: { x: 0, y: 0, z: 0 } }] }))).toEqual([]);
  });
  it('a fish is food for the near lines when food is wanted, and nothing when it is not (a pufferfish never)', () => {
    expect(nearWorthy('cod', 18.2, { food: true, sheep: true, folk: false })).toBe(true);
    expect(nearWorthy('salmon', 30, { food: true, sheep: true, folk: false })).toBe(false);
    expect(nearWorthy('cod', 18.2, { food: false, sheep: false, folk: false })).toBe(false);
    expect(nearWorthy('pufferfish', 5, { food: true, sheep: true, folk: false })).toBe(false);
  });
});

describe('control/fight-damage-facts.json: the blows of the last ten seconds, her health and the food she can eat', () => {
  const sample = fixture('control/fight-damage-facts');
  it('three blows in ten seconds are told with the count and the sum, and the health and the bread beside them', () => {
    let clock = 1_000_000;
    const watch = createHitWatch(() => clock);
    const hits = sample.input.hits as { t: number; amount: number }[];
    const hp = (t: number) => 6.4 + hits.reduce((sum, hit) => hit.t > t ? sum + hit.amount : sum, 0);
    let seq = 0;
    const at = (t: number) => { clock = 1_000_000 + t * 1000; watch.note({ ...frame({ health: hp(t) }), sequence: seq += 1 }); };
    at(-10);
    for (const hit of hits) at(hit.t);
    at(0);
    const urgent = [vitalsLine(frame({ health: 6.4, food: 11, inventory: [{ name: 'bread', count: 1 }] })), watch.line()].join('\n');
    for (const word of sample.expected.urgentMustContain as string[]) expect(urgent).toContain(word);
  });
  it('the window is ten seconds: a blow older than that is not told, and a rise of health is not a blow', () => {
    let clock = 0;
    const watch = createHitWatch(() => clock);
    let seq = 0;
    const note = (health: number) => watch.note({ ...frame({ health }), sequence: seq += 1 });
    note(20);
    clock = 1_000;
    note(14.7);
    clock = 3_000;
    note(18);
    expect(watch.line()).toBe('直近 10 秒で 1 回ダメージを受けた（合計 5.3: 5.3（2 秒前））');
    clock = 12_000;
    expect(watch.line()).toBeNull();
  });
  it('is named by the frame that holds the blow: a hostile within 6 m is said beside it, a far one is not', () => {
    let clock = 0, seq = 0;
    const watch = createHitWatch(() => clock);
    const at = (health: number, distance: number) => watch.note({ ...frame({ health, nearbyThreats: [{ id: 9, name: 'skeleton', distance }] }), sequence: seq += 1 });
    at(20, 12);
    clock = 1_000;
    at(17, 12);
    expect(watch.line()).toBe('直近 10 秒で 1 回ダメージを受けた（合計 3.0: 3.0（0 秒前））');
    clock = 2_000;
    at(15, 4.5);
    expect(watch.line()).toContain('その時近くにいた敵: skeleton #9 4.5m');
  });
});

describe('the blows watch reads frames in their order', () => {
  it('an older frame of the same connection is not read, so health lost is not counted twice; another connection starts the count again', () => {
    let clock = 0;
    const watch = createHitWatch(() => clock);
    const at = (sequence: number, health: number, connectionId = 'c1') => watch.note({ ...frame({ health }, { bodyRun: { bodyBoot: 'b', connectionId } }), sequence });
    at(10, 20);
    clock = 1_000;
    at(12, 15);
    clock = 1_500;
    at(11, 20);
    clock = 2_000;
    at(13, 15);
    expect(watch.recent().map(hit => hit.amount)).toEqual([5]);
    clock = 3_000;
    at(1, 8, 'c2');
    expect(watch.recent().map(hit => hit.amount)).toEqual([5]);
    clock = 4_000;
    at(2, 6, 'c2');
    expect(watch.recent().map(hit => hit.amount)).toEqual([5, 2]);
  });
});

describe('who holds the body, her life, and what is held (state.control, state.life)', () => {
  it('reads the holder as the body writes it, and tolerates what it leaves out', () => {
    const observation = frame({}, { control: { holder: { kind: 'reflex', reflex: 'floor-melee', target: 2601 }, waiting: [{ command: 'q53', since: 'a', behind: 'floor-melee' }] }, life: { life: 3 } });
    expect(holderLine(observation)).toBe('体を動かしている物: 反射 floor-melee（相手 #2601）・命 3・1 件が反射の後を待っている');
    expect(controlOf(frame({}, { control: { holder: { kind: 'nonsense' } } }))).toBeNull();
    expect(holderLine(frame({}, {}, { life: 4 }))).toBe('命 4');
    expect(lifeOf(frame({}))).toBeNull();
    expect(holderLine(frame({}))).toBeNull();
  });
  it('says each kind of holder in the body\'s words', () => {
    const line = (holder: Record<string, unknown>, extra: Record<string, unknown> = {}) => holderLine(frame({}, { control: { holder, waiting: [], ...extra }, life: { life: 1 } }));
    expect(line({ kind: 'idle' })).toBe('体を動かしている物: 無し（止まっている）・命 1');
    expect(line({ kind: 'command', command: 'q52', item: 'q52' })).toBe('体を動かしている物: 命令 q52（q52）・命 1');
    expect(line({ kind: 'bridge', after: 'floor-melee', hold: 'shield', target: 5 })).toBe('体を動かしている物: 反射の後のつなぎ（盾を構えている・floor-melee の後・相手 #5）・命 1');
    expect(line({ kind: 'cleanup', command: 'q3' })).toBe('体を動かしている物: 片付け（q3）・命 1');
    expect(line({ kind: 'idle' }, { reflexEpisode: { reflex: 'floor-melee', target: 7, hands: 3, hits: 5, since: 'x' } }))
      .toBe('体を動かしている物: 無し（止まっている）・反射 floor-melee の戦いが続いている（相手 #7・3 手・5 打）・命 1');
    expect(line({ kind: 'reflex', reflex: 'floor-melee', target: 7, episode: true }, { reflexEpisode: { reflex: 'floor-melee', hands: 3, hits: 5, since: 'x' } }))
      .toBe('体を動かしている物: 反射 floor-melee（相手 #7）。この戦いで 3 手・5 打・命 1');
  });
});

describe('inventory-full-facts.json: the free slots, what the next hands add, and what fills the pack', () => {
  const sample = fixture('measure/inventory-full-facts');
  const stacks = [{ name: 'cobbled_deepslate', count: 64 }, { name: 'cobbled_deepslate', count: 41 }, { name: 'dirt', count: 35 },
    ...Array.from({ length: 33 }, (_, index) => ({ name: `junk_${index}`, count: 1 }))];
  const observation = frame({ inventory: stacks });
  const make: ActInput[] = [{ hands: [{ do: 'make', item: 'diamond_pickaxe' }] }];
  it('a full pack with a make ahead says 空き 0, the item the hand makes, and 満杯', () => {
    const lines = packLines(observation, make, false);
    for (const word of sample.expected.liveMustContain as string[]) expect(lines.join('\n')).toContain(word);
    expect(lines).toEqual(['持ち物の空き 0/36（満杯）・次の手で増える見込み: make diamond_pickaxe で +1 個', '場所を取っている物: cobbled_deepslate×105（2 マス）・dirt×35（1 マス）']);
    expect(sample.expected.bodyDropsNothing).toBe(true);
  });
  it('shortened, it is one line; with room it says only the free slots', () => {
    expect(packLines(observation, make, true)).toEqual(['持ち物の空き 0/36（満杯）・次の手で増える見込み: make diamond_pickaxe で +1 個']);
    expect(packLines(frame({ inventory: stacks.slice(0, 10) }), [], false)).toEqual(['持ち物の空き 26/36']);
    expect(packLines(frame({ inventory: stacks.slice(0, 34) }), [], false)[0]).toBe('持ち物の空き 2/36（もうすぐ満杯）');
    expect(packLines(frame({}), make, false)).toEqual([]);
  });
  it('the gains are what the hands add, and a go adds nothing', () => {
    expect(nextGains([{ hands: [{ do: 'go', to: { x: 1, y: 2, z: 3 } }, { do: 'craft', item: 'bread', count: 3 }, { do: 'mine', item: 'iron_ore', count: 4 }] }]))
      .toEqual(['craft bread で +3 個', 'mine iron_ore で +4 個（拾う）']);
  });
});

describe('queue-and-effects-in-input.json: the queue\'s items with what their hands will do, and the head refuses nothing', () => {
  const sample = fixture('measure/queue-and-effects-in-input');
  it('the running item shows its time left and its effect, the waiting one its effect', () => {
    const item = sample.input.queue[0];
    const lines = queueNowLines(['▶ q33 [p1] 近い鉄へ 実行中: 手 1/1・残り約 60 秒', 'あと 2 つ足せる（足した項目は q33 の後ろに付く）'],
      [{ hands: [{ do: 'go', to: { x: 183, y: 63, z: 198 }, seconds: 90 }] }]);
    expect(lines).toEqual(['▶ q33 [p1] 近い鉄へ 実行中: 手 1/1・残り 60 秒（見込み）・予定: go (183,63,198)', 'あと 2 つ足せる（足した項目は q33 の後ろに付く）']);
    for (const word of sample.expected.liveMustContain as string[]) expect(lines.join('\n') + item.item).toContain(word);
  });
  it('the head does not read the input for the same aim and refuses nothing: the second go is a line of its own', () => {
    expect(sample.expected.headRefuses).toBe(false);
    const lines = queueNowLines(['▶ q33 実行中: 残り約 60 秒', '・ q34 待ち', 'あと 1 つ足せる'],
      [{ hands: [{ do: 'go', to: { x: 183, y: 63, z: 198 } }] }, { hands: [{ do: 'go', to: { x: 183, y: 63, z: 198 } }, { do: 'dig', at: [{ x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 4 }] }], repeat: 2 }]);
    expect(lines[0]).toContain('予定: go (183,63,198)');
    expect(lines[1]).toBe('・ q34 待ち: 予定: go (183,63,198) → dig (1,2,3)ほか 1（2 回繰り返す）');
  });
  it('writes what a hand will do in the hand\'s own words', () => {
    expect(handEffect({ do: 'place', block: 'cobblestone', at: [{ x: 1, y: 2, z: 3 }] })).toBe('place cobblestone (1,2,3)');
    expect(handEffect({ do: 'vertical', dir: 'down', shape: 'stairs', toY: 10 })).toBe('vertical down stairs y=10');
    expect(handEffect({ do: 'go', goals: [{ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }], rel: true })).toBe('go 2 か所のどれか (1,2,3)（足元からの相対）');
  });
});

describe('where a go or a vertical stopped is told from the result\'s fields', () => {
  const result = (lines: unknown[]) => JSON.stringify({ v: 1, ok: false, done: 0, of: lines.length, lines, at: { x: 0, y: 0, z: 0 }, hp: 20, food: 20, ms: 1 });
  it('a go that stopped says how far the goal is from where it stopped and from the search\'s end', () => {
    const json = result([{ i: 1, do: 'go', status: 'stopped', line: 'go 止まった', goal: 'partial', end: 'finished', progress: { unit: 'meter', done: 12.3, left: null, at: { x: 5, y: 60, z: 7 }, fromStopM: 35.9, searchEndM: 27.5 } }]);
    expect(stopFactsOf(json)).toEqual(['go の止まり: 止まった位置 (5,60,7) から行き先まで 35.9 m（道探しの先端からは 27.5 m）']);
  });
  it('a vertical says the steps that are still valid and how many are left; a hand that reached its aim says nothing', () => {
    const json = result([{ i: 1, do: 'vertical', status: 'stopped', line: 'v', code: 'limit_dig', goal: 'partial', end: 'finished', progress: { unit: 'step', done: 24, left: 31, at: { x: 1, y: 40, z: 2 } } },
      { i: 2, do: 'go', status: 'done', line: 'go 済', goal: 'done', end: 'finished', progress: { unit: 'meter', done: 3, left: 0, fromStopM: 0 } }]);
    expect(stopFactsOf(json)).toEqual(['vertical の止まり: (1,40,2) で止まった・今も有効な段 24・残り 31 段（limit_dig）']);
    expect(stopFactsOf('not json')).toEqual([]);
    expect(stopFactsOf(undefined)).toEqual([]);
  });
});

describe('one-time-fact-delivery.json: a fact said once is delivered when the last request\'s bytes hold it, and until then it is offered again', () => {
  const sample = fixture('measure/one-time-fact-delivery');
  const FACT = '約束 #3 の代わりの条件が成り立たなくなった（作業台から 95 段離れた）';
  const base = { state: fixture('measure/urgent-max-input').input.state as MaxState };
  const common = { ...base, promises: [promise(3, 'planks', 4, '作業台')], taskId: 'once-delivery' };

  it('d0300 (shortened) leaves it out and keeps it, d0301 (normal) takes it in and delivers it, d0302 does not say it again', async () => {
    offer('once-delivery', 'promise_instead_lost:3:r1', FACT);
    const states: Record<string, { inLastRequest: boolean }> = {};
    const decisions = sample.input.decisions as { d: string; compressedOut?: boolean }[];
    for (const decision of decisions) {
      const got = await extractRequestBytes({ ...common, variant: decision.compressedOut ? 'compressed' : 'normal', ...decision.compressedOut ? { compactAboveTokens: 16_000 } : {} });
      states[decision.d] = { inLastRequest: got.lastMessage.includes(FACT) };
    }
    expect(Object.fromEntries(Object.entries(states).map(([d, value]) => [d, value.inLastRequest]))).toEqual(sample.expected.inLastRequest);
    expect(pending('once-delivery')).toEqual([]);
  });
  it('the delivery looks at the request\'s last message only, by the words (quotes escaped as the live state is)', () => {
    offer('once-last', 'k1', '「代わりの条件」が "切れた"');
    expect(deliverOnceFacts('once-last', { messages: [{ role: 'user', content: '「代わりの条件」が "切れた"' }, { role: 'system', content: JSON.stringify({ events: ['別の文'] }) }] })).toEqual([]);
    expect(pending('once-last')).toHaveLength(1);
    expect(deliverOnceFacts('once-last', { messages: [{ role: 'system', content: JSON.stringify({ events: ['「代わりの条件」が "切れた"'] }) }] })).toEqual(['k1']);
    expect(pending('once-last')).toEqual([]);
    expect(onceFor('once-last', 'normal')).toEqual([]);
  });
});

describe('meter-clock-excludes-holds.json: the meter counts the seconds the task ran, not the seconds it was held', () => {
  const sample = fixture('measure/meter-clock-excludes-holds');
  const tree: PlanTree = { ...v2tree({ revision: 1, current: 'p1', nodes: [
    { id: 'p1', parentId: null, order: 0, title: '鉄', state: 'continue', kind: 'iron' } as never,
    { id: 'p2', parentId: null, order: 1, title: 'エンドでドラゴン', state: 'wait', kind: 'dragon' } as never] }), promises: [] };
  const observation = frame({ dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, inventory: [{ name: 'bed', count: 1 }, { name: 'crafting_table', count: 1 }, { name: 'bread', count: 8 }, { name: 'cooked_beef', count: 8 }] });
  it('the wall clock of the fixture is 5,693 s and the hold 4,749 s: the meter says 944 and 594 late', () => {
    const { wallSinceStart, heldSeconds, milestone } = sample.input;
    expect(activeMinutes(wallSinceStart / 60, heldSeconds * 1000)! * 60).toBeCloseTo(sample.expected.meterNowSec, 6);
    const line = meterLine(tree, observation, wallSinceStart / 60, heldSeconds * 1000)!;
    expect(line).toContain(`今 ${sample.expected.meterNowSec} 秒（保留の 4,749 秒を除く）`);
    expect(line).toContain(`${milestone.name} 目安 ${milestone.targetSec} 秒（${sample.expected.lateness} 秒遅れ）`);
    for (const word of sample.expected.mustNotContain as string[]) expect(line).not.toContain(word);
  });
  it('a task that was never held counts as it did', () => {
    expect(meterLine(tree, observation, 812 / 60)).toBe(meterLine(tree, observation, 812 / 60, 0));
    expect(meterLine(tree, observation, 812 / 60)).toContain('今 812 秒・次の節目');
    expect(activeMinutes(null, 1000)).toBeNull();
    expect(activeMinutes(1, 90_000)).toBe(0);
  });
});

describe('inputFacts: the lines in order, and the shortened form', () => {
  it('has nothing to say for a frame that holds nothing', () => {
    expect(inputFacts(frame({}), {}, false)).toEqual({ lines: [], compressed: [] });
  });
  it('lists food only when food is wanted', () => {
    const observation = frame({ health: 20, food: 20, nearbyEntities: [{ name: 'cow', id: 1, distance: 5, position: { x: 0, y: 0, z: 0 } }] });
    expect(inputFacts(observation, { wantsFood: false }, false).lines.some(line => line.startsWith('近くの食べ物'))).toBe(false);
    expect(inputFacts(observation, { wantsFood: true }, false).lines.some(line => line.startsWith('近くの食べ物'))).toBe(true);
  });
  it('the promise lines are four at most and the same in every version', () => {
    const promises = [1, 2, 3, 4, 5, 6].map(id => promise(id, 'coal', 1, `用${id}`));
    const facts = inputFacts(frame({ inventory: [{ name: 'coal', count: 1 }] }), { promises }, false);
    expect(facts.lines.filter(line => line.startsWith('約束 #'))).toHaveLength(4);
    expect(facts.compressed).toEqual(facts.lines);
    expect(inputFacts(frame({ inventory: [{ name: 'coal', count: 1 }] }), { promises }, true).lines).toEqual(facts.lines);
  });
});

describe('through the lifecycle: where a go stopped, and the meter\'s clock', () => {
  const state = fixture('measure/urgent-max-input').input.state as MaxState;
  const GO = JSON.stringify({ v: 1, ok: false, done: 0, of: 1, at: { x: 0, y: 0, z: 0 }, hp: 20, food: 20, ms: 1, lines: [{ i: 1, do: 'go', status: 'stopped', line: 'go 止まった', goal: 'partial', end: 'finished',
    progress: { unit: 'meter', done: 12.3, left: null, at: { x: 5, y: 60, z: 7 }, fromStopM: 35.9, searchEndM: 27.5 } }] });
  const STOP = 'go の止まり: 止まった位置 (5,60,7) から行き先まで 35.9 m（道探しの先端からは 27.5 m）';

  it.each(['normal', 'urgent', 'compressed'] as Variant[])('%s: the stop of a go that ended after the last decision is in the last request, whatever the long result of the act became', async variant => {
    const got = await extractRequestBytes({ state, variant, taskId: `stop-${variant}`, ran: [GO], results: [`act 止まった\n${'長い結果 '.repeat(2_000)}\n事実: 止まった位置 (5,60,7) から行き先まで 35.9 m`],
      ...variant === 'compressed' ? { compactAboveTokens: 16_000 } : {} });
    expect(got.live.body.facts).toContain(STOP);
  });
  it('is told with the decision after the result and not again with the next', async () => {
    const first = await extractRequestBytes({ state, variant: 'normal', taskId: 'stop-once', ran: [GO] });
    expect(first.live.body.facts).toContain(STOP);
    const next = await extractRequestBytes({ state, variant: 'normal', taskId: 'stop-once' });
    expect(next.live.body.facts).not.toContain(STOP);
  });
  it('the meter of a task that was held counts the running seconds: 944 s, 594 late, and says how many seconds it leaves out', async () => {
    const sample = fixture('measure/meter-clock-excludes-holds');
    const got = await extractRequestBytes({ state: { ...state, hp: 20, food: 20, hits: [], queue: [], promises: [], filler: { resultChars: 0, liveLines: 0, nearMobs: 0 } }, variant: 'normal', taskId: 'meter',
      dragon: true, wallSeconds: sample.input.wallSinceStart, heldMs: sample.input.heldSeconds * 1000,
      inventory: [{ name: 'bed', count: 1 }, { name: 'crafting_table', count: 1 }, { name: 'bread', count: 8 }, { name: 'cooked_beef', count: 8 }] });
    expect(got.live.body.meter).toContain(`今 ${sample.expected.meterNowSec} 秒（保留の 4,749 秒を除く）`);
    expect(got.live.body.meter).toContain(`${sample.expected.lateness} 秒遅れ`);
    for (const word of sample.expected.mustNotContain as string[]) expect(got.lastMessage).not.toContain(word);
  });
});

describe('the preparation before the descent (kind prep_descent) is a food node for the food-first line and the near creatures', () => {
  const tree = v2tree({ revision: 1, current: 'p4', nodes: [
    { id: 'p3', parentId: null, order: 0, title: '食料40点と下る準備', state: 'continue', kind: 'prep_descent', doneWhen: 'food>=40&作業台か板 4' } as never,
    { id: 'p4', parentId: null, order: 1, title: '鉄（24〜36）', state: 'continue', kind: 'iron' } as never] });
  it('the line points at p3 while health does not come back and nothing is carried to eat', () => {
    expect(foodFirstLine(tree.nodes, 'p4', null)).toBe('回復が先: 食料の節 [p3] 食料40点と下る準備');
    expect(foodFirstLine(tree.nodes, 'p3', null)).toBeNull();
  });
});

describe('bench D through the judge: boundary 10 passes on the bytes of the real request', () => {
  it('the judge finds every value of the table in the normal, the urgent and the shortened version, and the fact said once carried until it arrived', async () => {
    const sample = fixture('measure/urgent-max-input'), oneTime = fixture('measure/one-time-fact-delivery');
    const state = sample.input.state as MaxState;
    let second = 0;
    const at = () => new Date(Date.UTC(2026, 9, 28, 4, 0, second += 1)).toISOString();
    const probes = await benchDProbes({ state, inventory: [{ name: 'oak_planks', count: 2 }, { name: 'obsidian', count: 7 }, { name: 'cobbled_deepslate', count: 64 }, { name: 'cobbled_deepslate', count: 41 }, { name: 'dirt', count: 35 }],
      promises: [promise(3, 'planks', 4, '作業台'), promise(4, 'food', 20, '地下で食べる分'), promise(5, 'stick', 2, 'はしご'), promise(6, 'obsidian', 10, '黒曜石の枠')],
      hands: [{ hands: [{ do: 'attack', target: '#2601' }] }, { hands: [{ do: 'go', to: { x: 172, y: -19, z: 236 } }] }] as ActInput[] },
    { key: 'promise_instead_lost:3:r1', text: '約束 #3 の代わりの条件が成り立たなくなった（作業台から 95 段離れた）', decisions: oneTime.input.decisions }, at);
    const verdict = judge({ meta: { run: 'bench-d', scene: 'boundary-10', benches: ['D'], headRev: 'facts', bodyRev: 'none' }, rows: [], receipts: [], trace: [], probes }, loadFixtures());
    expect(verdict.pass, verdict.text).toBe(true);
    expect(verdict.checks.map(check => check.id)).toEqual(expect.arrayContaining(['last request (normal)', 'last request (urgent)', 'last request (compressed)']));
  });
});
