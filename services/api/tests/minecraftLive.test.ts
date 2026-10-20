import { describe, expect, it } from 'vitest';
import type { LiveMoment, WorkingEvent } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { MinecraftLive, type LiveFrames, type LiveTaskInfo } from '../src/surfaces/minecraft/minecraftLive.js';
import { LIVE_BLOCK_HEADER, liveBlock } from '../src/surfaces/minecraft/minecraftLiveBlock.js';
import { carriedWords, doingWords, mapWords, mobWords, timeWords } from '../src/surfaces/minecraft/minecraftLiveWords.js';

const T0 = Date.parse('2026-10-20T10:00:00.000Z');
let sequence = 0;
const observation = (world: Record<string, unknown> = {}, facts: Record<string, string | number | boolean | null> = {}): BodyObservation => ({
  schemaVersion: 1, bodyId: 'minecraft:world', sequence: sequence++, stateAt: new Date(T0).toISOString(), receivedAt: new Date(T0).toISOString(), connected: true,
  state: { world: { dimension: 'overworld', biome: 'snowy_plains', health: 20, food: 18, time: '2000', inventory: [], ...world } },
  facts: { alive: true, dimension: 'overworld', ...facts },
});
const stack = (name: string, count = 1) => ({ name, count });

function fixture(options: { origin?: string; world?: Record<string, unknown> } = {}) {
  let clock = T0, current: { observation: BodyObservation; at: number } | null = { observation: observation(options.world), at: T0 };
  const frames: LiveFrames = {
    latest: (_id, maxAge) => current && clock - current.at <= maxAge ? { observation: current.observation, ageMs: clock - current.at } : null,
    available: () => current ? ['minecraft:world'] : [],
  };
  const live = new MinecraftLive({ frames, now: () => clock });
  const task = (patch: Partial<LiveTaskInfo> = {}): LiveTaskInfo => ({ taskId: 'task', scopeKey: 'owner', goal: 'エンドラを討伐してください', origin: options.origin ?? 'owner_request',
    createdAtMs: T0, bodyId: 'minecraft:world', netherReached: null, ...patch });
  return { live, task, advance(ms: number) { clock += ms; }, show(next: BodyObservation | null) { current = next ? { observation: next, at: clock } : null; }, now: () => clock };
}

describe('the words', () => {
  it('names mobs and tools in her words, and says nothing it does not know as a sentence', () => {
    expect(mobWords('zombie')).toBe('ゾンビ');
    expect(mobWords('some_new_mob')).toBe('モンスター');
    expect(doingWords({ name: 'mc.mine-block', input: { blockName: 'iron_ore' } })).toBe('鉄鉱石を掘っている');
    expect(doingWords({ name: 'mc.mine-block', input: { blockName: 'oak_log' } })).toBe('原木を掘っている');
    expect(doingWords({ name: 'mc.craft-one', input: { itemName: 'iron_pickaxe' } })).toBe('鉄のツルハシを作っている');
    expect(doingWords({ name: 'mc.attack-continuously', input: { entityName: 'zombie' } })).toBe('ゾンビを相手に戦っている');
    expect(doingWords({ name: 'mc.something-new', input: {} })).toBe('マイクラの作業を進めている');
    expect(doingWords(null)).toBe('');
    expect([timeWords(500), timeWords(6000), timeWords(13_000), timeWords(18_000), timeWords(null)]).toEqual(['明け方', '昼', '夕方', '夜', '']);
  });
  it('says what she carries that is worth saying', () => {
    const counts = new Map([['iron_pickaxe', 1], ['iron_helmet', 1], ['iron_chestplate', 1], ['cooked_beef', 4], ['coal', 12], ['raw_iron', 8], ['white_bed', 1]]);
    expect(carriedWords(counts)).toEqual(['鉄のツルハシ', '防具2/4', '食べ物4個（焼いた物4）', 'ベッドを持っている', '鉄の原鉱×8', '石炭×12']);
    expect(carriedWords(new Map())).toEqual(['ツルハシはまだ無い', '食べ物は無い', 'ベッドは持っていない']);
  });
  it('shortens the map the body keeps', () => {
    const map = '構造物: 村: 171m 東 (287,85,13)／ネザー要塞: 90m 北 (1,2,3)\n鉱石: 鉄 5か所（10m 東）／ダイヤ 2か所（30m 南）\n溶岩の溜まり 1か所: 20m 西\n洞窟の入口 3か所（地表から）';
    expect(mapWords(map)).toBe('村(171m)・ネザー要塞(90m)・ダイヤ2か所・鉄5か所・溶岩1か所・洞窟の入口3か所');
    expect(mapWords(undefined)).toBe('');
  });
});

describe('liveBlock', () => {
  const snapshot = (patch = {}) => ({ frameAgeSeconds: 1, goal: 'エンドラを討伐してください', goalIsRequest: true, elapsedSeconds: 380, doing: '鉄鉱石を掘っている',
    milestone: { name: '鉄', next: 'バケツ', elapsed: 380 }, dimension: 'overworld', biome: 'snowy plains', time: '昼', health: 18, food: 14, threats: [],
    carried: ['鉄のツルハシ'], map: '村(171m)', furnace: null, recent: [], stuck: null, ...patch });

  it('is empty without a snapshot and says the body is away when it has no frame', () => {
    expect(liveBlock(null, { alone: true })).toBe('');
    expect(liveBlock(snapshot({ frameAgeSeconds: null }), { alone: true })).toContain('つながっていない');
  });
  it('tells the owner alone what he asked, and everyone else only that something was asked', () => {
    const alone = liveBlock(snapshot(), { alone: true });
    expect(alone.startsWith(LIVE_BLOCK_HEADER)).toBe(true);
    expect(alone).toContain('取り組んでいること: エンドラを討伐してください（ライ氏に頼まれた）');
    const shared = liveBlock(snapshot(), { alone: false });
    expect(shared).not.toContain('エンドラ');
    expect(shared).toContain('頼まれた作業の最中');
    // Her own pursuit is not his matter.
    expect(liveBlock(snapshot({ goalIsRequest: false, goal: '木を集める' }), { alone: false })).toContain('取り組んでいること: 木を集める');
  });
  it('says the step against its target seconds: early, and late', () => {
    expect(liveBlock(snapshot(), { alone: true })).toContain('「鉄」（目安は開始から7分00秒までで、いま6分20秒。あと40秒の目安）。次は「バケツ」');
    expect(liveBlock(snapshot({ elapsedSeconds: 500 }), { alone: true })).toContain('80秒遅れている');
    expect(liveBlock(snapshot({ milestone: { name: 'ドラゴン', next: null, elapsed: 380 } }), { alone: true })).toContain('今の段: 「ドラゴン」');
  });
  it('tells the body, the danger, what she carries, what she found, and how old the picture is', () => {
    const block = liveBlock(snapshot({ threats: ['ゾンビ6m', 'クリーパー12m'], recent: [{ ageSeconds: 130, line: '鉄の防具がそろった' }], frameAgeSeconds: 45, stuck: '掘る作業が20秒ほど進んでいない', furnace: '1台が動いている' }), { alone: true });
    expect(block).toContain('体力 18/20、満腹度 14/20');
    expect(block).toContain('いる所: オーバーワールド・snowy plains・昼');
    expect(block).toContain('近くの敵: ゾンビ6m、クリーパー12m');
    expect(block).toContain('持ち物の要点: 鉄のツルハシ');
    expect(block).toContain('見つけている物: 村(171m)');
    expect(block).toContain('さっきあったこと: 2分10秒前に鉄の防具がそろった');
    expect(block).toContain('詰まり気味: 掘る作業が20秒ほど進んでいない');
    expect(block).toContain('この様子は45秒前のもの');
    expect(liveBlock(snapshot(), { alone: true })).toContain('近くに敵はいない');
  });
});

describe('MinecraftLive', () => {
  it('has nothing to say without a task and a body', () => {
    const f = fixture();
    f.show(null);
    expect(f.live.snapshot()).toBeNull();
    expect(f.live.block({ alone: true })).toBe('');
  });

  it('describes a body in the world with no task as one that has nothing asked of it', () => {
    const f = fixture();
    const block = f.live.block({ alone: true });
    expect(block).toContain('特に頼まれた作業は無い');
    expect(block).toContain('体力 20/20');
  });

  it('tells the task, what runs, the step, and keeps the owner\'s words from the room', () => {
    const f = fixture({ world: { inventory: [stack('stone_pickaxe'), stack('cooked_beef', 6), stack('white_bed')], mapSummary: '構造物: 村: 171m 東 (1,2,3)' } });
    f.live.begin(f.task());
    f.live.activity('task', { name: 'mc.mine-block', input: { blockName: 'iron_ore' } });
    f.advance(130_000);
    f.show(observation({ inventory: [stack('stone_pickaxe'), stack('cooked_beef', 6), stack('white_bed')], mapSummary: '構造物: 村: 171m 東 (1,2,3)' }));
    const alone = f.live.block({ alone: true });
    expect(alone).toContain('エンドラを討伐してください');
    expect(alone).toContain('動き始めてから: 2分10秒');
    expect(alone).toContain('いましていること: 鉄鉱石を掘っている');
    expect(alone).toContain('今の段: 「鉄」');
    expect(alone).toContain('石のツルハシ');
    expect(alone).toContain('村(171m)');
    const room = f.live.block({ alone: false });
    expect(room).not.toContain('エンドラ');
    expect(room).toContain('いましていること: 鉄鉱石を掘っている');
    f.live.activity('task', null);
    expect(f.live.block({ alone: true })).not.toContain('いましていること');
  });

  it('shows her own pursuit to the room, and a request only to him', () => {
    const f = fixture({ origin: 'own_time' });
    f.live.begin(f.task({ goal: '木を集める' }));
    expect(f.live.block({ alone: false })).toContain('取り組んでいること: 木を集める');
  });

  it('adds exchanges about her work for the owner alone when they are given', () => {
    const f = fixture();
    const live = new MinecraftLive({ now: f.now, frames: { latest: () => ({ observation: observation(), ageMs: 0 }), available: () => ['minecraft:world'] },
      exchanges: minute => `掛け合いの手ざわり: ${minute}` });
    live.begin(f.task());
    expect(live.block({ alone: true })).toContain(`掛け合いの手ざわり: ${Math.floor(f.now() / 60_000)}`);
    expect(live.block({ alone: false })).not.toContain('掛け合いの手ざわり');
    expect(f.live.block({ alone: true })).not.toContain('掛け合いの手ざわり');
  });

  it('keeps the task through the gap between two steps, and lets it go afterwards', () => {
    const f = fixture();
    f.live.begin(f.task());
    f.live.end('task');
    f.advance(15_000);
    f.show(observation());
    expect(f.live.block({ alone: true })).toContain('エンドラを討伐してください');
    f.advance(10_000);
    f.show(observation());
    expect(f.live.block({ alone: true })).toContain('特に頼まれた作業は無い');
    f.live.begin(f.task());
    expect(f.live.block({ alone: true })).toContain('エンドラを討伐してください');
  });

  it('says the body is not in the world when its frame is old, with a task still on', () => {
    const f = fixture();
    f.live.begin(f.task());
    f.advance(130_000);
    expect(f.live.block({ alone: true })).toContain('つながっていない');
  });

  it('says how old the picture is when it is a little old', () => {
    const f = fixture();
    f.live.begin(f.task());
    f.advance(40_000);
    expect(f.live.block({ alone: true })).toContain('この様子は40秒前のもの');
  });

  it('lists the nearest hostiles with a wall between marked, at most three', () => {
    const f = fixture({ world: { nearbyThreats: [
      { name: 'skeleton', distance: 18, canReachMe: true }, { name: 'zombie', distance: 6.4, canReachMe: true }, { name: 'creeper', distance: 9, canReachMe: false },
      { name: 'spider', distance: 20, canReachMe: true }, { name: 'witch', distance: 40, canReachMe: true }] } });
    f.live.begin(f.task());
    expect(f.live.block({ alone: true })).toContain('近くの敵: ゾンビ6m、クリーパー9m（壁の向こう）、スケルトン18m');
  });

  it('tells the furnace', () => {
    const f = fixture({ world: { jobs: [{ status: 'running', remainingEstimateMs: 42_000, position: { x: 1, y: 2, z: 3 } }] } });
    f.live.begin(f.task());
    expect(f.live.block({ alone: true })).toContain('かまど: 1台が動いている（早いものであと約42秒）');
    f.show(observation({ jobs: [{ status: 'verification_due', remainingEstimateMs: 0 }] }));
    expect(f.live.block({ alone: true })).toContain('焼き上がった物が入っている');
  });

  it('feeds each frame to the detector, throttled, and tells the moments to its listeners', () => {
    const f = fixture();
    const heard: LiveMoment[] = [];
    f.live.onMoment(moment => heard.push(moment));
    f.live.onMoment(() => { throw new Error('a listener fails'); });
    f.live.frame('minecraft:world', observation({ inventory: [] }), { newConnection: true });
    f.advance(500);
    f.live.frame('minecraft:world', observation({ inventory: [stack('iron_pickaxe')] }), { newConnection: false });
    expect(heard.map(moment => moment.kind)).toEqual(['tool_made']);
    // Within 400 ms of the last reading nothing is read again.
    f.advance(100);
    f.live.frame('minecraft:world', observation({ inventory: [stack('iron_pickaxe'), stack('diamond')] }), { newConnection: false });
    expect(heard).toHaveLength(1);
    f.advance(400);
    f.live.frame('minecraft:world', observation({ inventory: [stack('iron_pickaxe'), stack('diamond')] }), { newConnection: false });
    expect(heard.map(moment => moment.kind)).toEqual(['tool_made', 'diamond_found']);
    expect(f.live.recentMoments().map(moment => moment.kind)).toEqual(['tool_made', 'diamond_found']);
    expect(f.live.block({ alone: true })).toContain('さっきあったこと');
  });

  it('knows she is in danger from the newest frame', () => {
    const f = fixture();
    f.live.frame('minecraft:world', observation({ health: 6 }), { newConnection: true });
    expect(f.live.inDanger()).toBe(true);
    f.advance(1000);
    f.live.frame('minecraft:world', observation({ health: 19 }), { newConnection: false });
    expect(f.live.inDanger()).toBe(false);
  });

  it('notices the step passed and the step late, once each', () => {
    const f = fixture({ world: { inventory: [stack('oak_planks', 8)] } });
    const heard: LiveMoment[] = [];
    f.live.onMoment(moment => heard.push(moment));
    f.live.begin(f.task());
    f.live.frame('minecraft:world', observation({ inventory: [stack('oak_planks', 8)] }), { newConnection: true });
    f.advance(500);
    // Stone pickaxe in hand: the step 「木と石のツルハシ」 (the first open one, the wood is in hand) is behind her.
    f.live.frame('minecraft:world', observation({ inventory: [stack('oak_planks', 8), stack('stone_pickaxe')] }), { newConnection: false });
    expect(heard.filter(moment => moment.kind === 'milestone_passed').map(moment => moment.facts.name)).toEqual(['木と石のツルハシ']);
    // A quarter of an hour on: the step she is at now is far past its target seconds.
    f.advance(900_000);
    f.live.frame('minecraft:world', observation({ inventory: [stack('oak_planks', 8), stack('stone_pickaxe')] }), { newConnection: false });
    f.live.frame('minecraft:world', observation({ inventory: [stack('oak_planks', 8), stack('stone_pickaxe')] }), { newConnection: false });
    expect(heard.filter(moment => moment.kind === 'milestone_late')).toHaveLength(1);
  });

  it('turns a stalled command into a moment and a line in the block for a while', () => {
    const f = fixture();
    const heard: LiveMoment[] = [];
    f.live.onMoment(moment => heard.push(moment));
    f.live.begin(f.task());
    const stalled: WorkingEvent = { seq: 1, at: new Date(T0).toISOString(), kind: 'action.stalled', subject: 'op1', data: { skill: 'mine-block', sinceProgressMs: 21_000 } };
    f.live.events('minecraft:world', [stalled, { ...stalled, seq: 2, kind: 'need.appeared' }]);
    expect(heard.map(moment => [moment.kind, moment.facts])).toEqual([['stuck', { what: '掘る作業', seconds: 21 }]]);
    expect(f.live.block({ alone: true })).toContain('詰まり気味: 掘る作業が21秒ほど進んでいない');
    f.advance(30_000);
    f.show(observation());
    expect(f.live.block({ alone: true })).not.toContain('詰まり気味');
  });

  it('counts the replies being written and the last time someone spoke to her', () => {
    const f = fixture();
    expect(f.live.conversation()).toEqual({ replying: false, sinceHumanMilliseconds: null });
    f.live.replying(true);
    f.live.replying(true);
    f.live.heard();
    f.advance(2_000);
    expect(f.live.conversation()).toEqual({ replying: true, sinceHumanMilliseconds: 2_000 });
    f.live.replying(false);
    expect(f.live.conversation().replying).toBe(true);
    f.live.replying(false);
    f.live.replying(false);
    expect(f.live.conversation().replying).toBe(false);
  });
});
