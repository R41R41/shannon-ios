import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveMoment } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { LIVE_COMMENTARY_ENGINE, LiveCommentary, type LiveWriteRequest } from '../src/surfaces/minecraft/minecraftLiveCommentary.js';
import { LiveSpeechOutbox } from '../src/surfaces/minecraft/minecraftLiveSpeech.js';
import { createMomentDetector } from '../src/surfaces/minecraft/minecraftMoments.js';
import { sceneLines, sceneOf } from '../src/surfaces/minecraft/minecraftLiveScene.js';
import { SCENE_KINDS, SCENE_LINE_LIMITS, cleanSceneLine, sceneLinePrompt, sceneLineRules } from '../src/surfaces/minecraft/minecraftSceneLine.js';
import { MinecraftLive } from '../src/surfaces/minecraft/minecraftLive.js';

const T0 = Date.parse('2026-01-15T10:00:00.000Z');
let sequence = 0;
const frame = (world: Record<string, unknown> = {}, facts: Record<string, string | number | boolean | null> = {}): BodyObservation => ({
  schemaVersion: 1, bodyId: 'minecraft:world', sequence: sequence++, stateAt: new Date(T0).toISOString(), receivedAt: new Date(T0).toISOString(), connected: true,
  state: { world: { dimension: 'overworld', health: 20, food: 20, time: '1000', inventory: [], ...world } },
  facts: { alive: true, dimension: 'overworld', ...facts },
});
const zombie = (distance: number, more: Record<string, unknown> = {}) => ({ name: 'zombie', kind: 'hostile', distance, canReachMe: true, ...more });
const kinds = (moments: readonly LiveMoment[]) => moments.map(moment => moment.kind);

describe('the fight, read from one frame to the next', () => {
  it('tells the first hit at once, and the next only after twenty quiet seconds', () => {
    const detector = createMomentDetector();
    detector.observe(frame({ nearbyThreats: [zombie(5)] }), T0);
    const hit = detector.observe(frame({ health: 17.5, nearbyThreats: [zombie(1.5)] }), T0 + 400);
    expect(hit.map(moment => [moment.kind, moment.facts])).toEqual([['attacked', { from: 'ゾンビ', count: 1, health: 18 }]]);
    // Hit after hit in the same fight: not told again.
    expect(kinds(detector.observe(frame({ health: 15, nearbyThreats: [zombie(1.5)] }), T0 + 1_200))).toEqual([]);
    expect(kinds(detector.observe(frame({ health: 12.5, nearbyThreats: [zombie(1.5)] }), T0 + 2_000))).toEqual([]);
    // Twenty seconds without a hostile at her, then another one hits: told again.
    detector.observe(frame({ health: 20, nearbyThreats: [] }), T0 + 10_000);
    detector.observe(frame({ health: 20, nearbyThreats: [] }), T0 + 31_000);
    detector.observe(frame({ health: 20, nearbyThreats: [zombie(4)] }), T0 + 32_000);
    expect(kinds(detector.observe(frame({ health: 18, nearbyThreats: [zombie(1.5)] }), T0 + 32_500))).toContain('attacked');
  });

  it('does not take a hostile behind rock for an attacker', () => {
    const detector = createMomentDetector();
    detector.observe(frame({}), T0);
    expect(kinds(detector.observe(frame({ health: 18, nearbyThreats: [zombie(2, { canReachMe: false })] }), T0 + 400))).not.toContain('attacked');
  });

  it('tells getting away once, when nothing that can reach her has been near for eight seconds', () => {
    const detector = createMomentDetector();
    detector.observe(frame({}), T0);
    detector.observe(frame({ health: 16, nearbyThreats: [zombie(1.5)] }), T0 + 400);
    expect(kinds(detector.observe(frame({ health: 16, nearbyThreats: [zombie(14)] }), T0 + 1_000))).toEqual([]);
    expect(kinds(detector.observe(frame({ health: 16, nearbyThreats: [zombie(14)] }), T0 + 5_000))).toEqual([]);
    const away = detector.observe(frame({ health: 16, nearbyThreats: [zombie(15)] }), T0 + 9_500);
    expect(away.map(moment => [moment.kind, moment.facts])).toEqual([['got_away', { health: 16 }]]);
    expect(kinds(detector.observe(frame({ health: 16, nearbyThreats: [] }), T0 + 12_000))).toEqual([]);
  });

  it('tells a creeper at her side, a blow with no hostile near, and a hostile that stood at her and is gone', () => {
    const detector = createMomentDetector();
    detector.observe(frame({ nearbyThreats: [{ name: 'creeper', kind: 'hostile', distance: 7, canReachMe: true }] }), T0);
    const scare = detector.observe(frame({ nearbyThreats: [{ name: 'creeper', kind: 'hostile', distance: 3, canReachMe: true, ignited: true }] }), T0 + 400);
    expect(scare.map(moment => [moment.kind, moment.facts])).toEqual([['scared', { from: 'クリーパー', distance: 3, lit: true }]]);
    const fall = detector.observe(frame({ health: 12, nearbyThreats: [] }), T0 + 800);
    expect(kinds(fall)).toContain('surprised');
    const other = createMomentDetector();
    other.observe(frame({ nearbyThreats: [zombie(3, { id: 7 })] }), T0);
    const gone = other.observe(frame({ nearbyThreats: [] }), T0 + 400);
    expect(gone.map(moment => [moment.kind, moment.facts])).toEqual([['killed', { name: 'ゾンビ' }]]);
  });

  it('tells a body coming back to life, and names who was at her when she fell', () => {
    const detector = createMomentDetector();
    detector.observe(frame({ nearbyThreats: [zombie(2)] }), T0);
    const fell = detector.observe(frame({ health: 0, nearbyThreats: [] }, { alive: false }), T0 + 400);
    expect(fell.map(moment => [moment.kind, moment.facts])).toEqual([['died', { cause: '', from: 'ゾンビ' }]]);
    const back = detector.observe(frame({ health: 20 }), T0 + 1_700);
    expect(kinds(back)).toEqual(['respawned']);
  });

  it('tells a view she can name once it changes, and a person who came near after a while without one', () => {
    const detector = createMomentDetector();
    detector.observe(frame({ biome: 'plains', nearbyEntities: [{ name: 'Someone', kind: 'player', distance: 30 }] }), T0);
    expect(kinds(detector.observe(frame({ biome: 'plains' }), T0 + 400))).toEqual([]);
    expect(detector.observe(frame({ biome: 'cherry_grove' }), T0 + 800).map(moment => [moment.kind, moment.facts])).toEqual([['scenery', { place: '桜の林' }]]);
    // A biome she has no plain word for is not told.
    expect(kinds(detector.observe(frame({ biome: 'weird_biome_x' }), T0 + 1_200))).not.toContain('scenery');
    detector.observe(frame({ biome: 'plains' }), T0 + 2_000);
    const near = detector.observe(frame({ biome: 'plains', nearbyEntities: [{ name: 'Someone', kind: 'player', distance: 8 }] }), T0 + 100_000);
    expect(near.map(moment => [moment.kind, moment.facts])).toEqual([['player_near', { distance: 8 }]]);
    expect(kinds(detector.observe(frame({ biome: 'plains', nearbyEntities: [{ name: 'Someone', kind: 'player', distance: 6 }] }), T0 + 100_400))).toEqual([]);
  });
});

describe('the scene of a voice', () => {
  const trail = [{ at: T0 - 2_000, health: 20 }, { at: T0 - 1_000, health: 16 }];

  it('is made from the frame: who stands at her, her health and how fast it fell, what she holds, who is near', () => {
    const scene = sceneOf(frame({ health: 12, food: 5, nearbyThreats: [zombie(2), zombie(4), { name: 'skeleton', kind: 'hostile', distance: 12, canReachMe: true }],
      inventory: [{ name: 'iron_sword', count: 1 }, { name: 'shield', count: 1 }], nearbyEntities: [{ name: 'Someone', kind: 'player', distance: 9 }] }),
    { now: T0, trail, doing: '穴を掘っている' });
    expect(scene).toMatchObject({ health: 12, lost: 8, weapon: 'sword', shield: true, bow: false, person: 9, doing: '穴を掘っている' });
    expect(scene.threats.map(threat => threat.name)).toEqual(['ゾンビ', 'ゾンビ', 'スケルトン']);
    const lines = sceneLines(scene).join('\n');
    expect(lines).toContain('体力: 半分より多く残っている（この3秒で一気に減った）');
    expect(lines).not.toMatch(/20のうち|体力: [^（\n]*\d/u); // her health is told in words, not read out as a number
    expect(lines).toContain('ゾンビ2体（いちばん近くて2m）');
    expect(lines).toContain('持っている武器: 剣と盾');
    expect(lines).toContain('近くに人がいる（9mほど）');
    expect(lines).toContain('お腹がすいている');
  });

  it('reads the odds only from what is at her: nothing near, none; a lone zombie with a sword and health, good; hurt or many, bad', () => {
    const quiet = sceneOf(frame({ nearbyThreats: [zombie(20)] }), { now: T0, trail: [], doing: '' });
    expect(quiet.odds).toBeNull();
    const good = sceneOf(frame({ health: 19, nearbyThreats: [zombie(3)], inventory: [{ name: 'stone_sword', count: 1 }] }), { now: T0, trail: [], doing: '' });
    expect(good.odds).toBe('good');
    const bare = sceneOf(frame({ health: 19, nearbyThreats: [zombie(3), zombie(4)] }), { now: T0, trail: [], doing: '' });
    expect(bare.odds).toBe('bad');
    const hurt = sceneOf(frame({ health: 5, nearbyThreats: [zombie(3)], inventory: [{ name: 'iron_sword', count: 1 }] }), { now: T0, trail: [], doing: '' });
    expect(hurt.odds).toBe('bad');
  });
});

describe('the scene line', () => {
  const moment = (kind: LiveMoment['kind'], facts: LiveMoment['facts'] = {}): LiveMoment => ({ kind, key: `${kind}:1`, at: T0, facts });
  const scene = sceneOf(frame({ health: 9, nearbyThreats: [zombie(2)] }), { now: T0, trail: [], doing: '階段状に深く掘り下がっている' });

  it('is written from the fact and the scene, and never from her plan, her aim or her earlier work', () => {
    const { system, message } = sceneLinePrompt({ identity: '[私]ボクはシャノン。', persona: '', scene, main: moment('attacked', { from: 'ゾンビ', count: 1, health: 9 }), also: [],
      recentSame: ['いたたた！'], voice: true });
    expect(message).toContain('ゾンビに襲われはじめた。');
    expect(message).not.toContain('20のうち');
    expect(message).toContain('4字から28字、1文');
    expect(message).toContain('近くの敵: ゾンビ');
    expect(message).toContain('[さっき同じ種類の場面で言ったこと]\n- いたたた！');
    expect(message).toContain('避ける出だし: いたたた');
    expect(message).toContain('4字から28字');
    for (const text of [system, message]) expect(text).not.toContain('ベッド');
    expect(message).not.toContain('計画');
    expect(message).not.toContain('さっきあったこと');
    expect(message).not.toContain('取り組んでいること');
    // No line of the voice is handed over as an example (a model says the example back).
    expect(system).not.toMatch(/うわあ|襲われてるよ|危なかった|死んじゃった/u);
    expect(message).not.toMatch(/うわあ|襲われてるよ|危なかった|死んじゃった/u);
  });

  it('says why each rule is there, and puts the child she is in the system so that the request is read from the cache', () => {
    const rules = sceneLineRules(true);
    expect((rules.match(/なぜ/gu) ?? []).length).toBeGreaterThanOrEqual(6);
    expect(rules).toContain('ツンデレ・生意気');
    expect(rules).toContain('「〜だよ」');
    expect(sceneLineRules(true)).toBe(sceneLineRules(true));
    const a = sceneLinePrompt({ identity: 'X', persona: '', scene, main: moment('died', { cause: 'モンスターに殴られた' }), also: [], recentSame: [], voice: true });
    const b = sceneLinePrompt({ identity: 'X', persona: '', scene: null, main: moment('got_away', { health: 9 }), also: [], recentSame: [], voice: true });
    expect(a.system).toBe(b.system);
  });

  it('gives a guide for every kind it writes, a different feeling order from moment to moment, and the text length when it is not spoken', () => {
    for (const kind of SCENE_KINDS) {
      const { message } = sceneLinePrompt({ identity: '', persona: '', scene, main: moment(kind), also: [], recentSame: [], voice: false });
      expect(message).toContain('[この声がどんな音か]');
      expect(message).toContain('[今回の気持ちの候補]');
    }
    const orders = new Set(Array.from({ length: 12 }, (_, index) => sceneLinePrompt({ identity: '', persona: '', scene, main: { ...moment('attacked'), key: `attacked:${index}` }, also: [],
      recentSame: [], voice: true }).message.match(/\[今回の気持ちの候補\]\n- (.*)/u)![1]));
    expect(orders.size).toBeGreaterThan(2);
    expect(sceneLinePrompt({ identity: '', persona: '', scene, main: moment('scenery', { place: '森' }), also: [], recentSame: [], voice: false }).message).toContain('8字から80字');
  });

  it('keeps a cry short, lets a stretched sound and a mark through, and refuses a list, a link and one sentence that is too long', () => {
    expect(cleanSceneLine('うわああああ！襲われてるよお！', { voice: true, kind: 'attacked' })).toBe('うわああああ！襲われてるよお！');
    expect(cleanSceneLine('「はぁ、死んじゃった…」', { voice: true, kind: 'died' })).toBe('はぁ、死んじゃった…');
    expect(cleanSceneLine('ボク: ふう、危なかった', { voice: true, kind: 'got_away' })).toBe('ふう、危なかった');
    expect(cleanSceneLine('- うわっ', { voice: true, kind: 'attacked' })).toBeNull();
    expect(cleanSceneLine('https://example.com うわっ', { voice: true, kind: 'attacked' })).toBeNull();
    expect(cleanSceneLine('', { voice: true, kind: 'attacked' })).toBeNull();
    const long = 'うわっ！' + 'いたいよおおおおおおおおおおおおおおおおおおおおおおおおお';
    expect(cleanSceneLine(long, { voice: true, kind: 'attacked' })).toBe('うわっ！');
    expect(cleanSceneLine('あああああああああああああああああああああああああああああああああああ', { voice: true, kind: 'attacked' })).toBeNull();
    expect(Array.from(cleanSceneLine('わあ、きれいな桜の林だね！ずっと見ていたくなっちゃうよ、すごいなあ。', { voice: true, kind: 'scenery' })!).length).toBeLessThanOrEqual(SCENE_LINE_LIMITS.calmVoice);
  });
});

describe('her quiet, and the voice of a fight in the engine', () => {
  let clock = T0;
  beforeEach(() => { clock = T0; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function setup(options: { speechMode?: 'chatty' | 'needed'; working?: (seconds: number) => LiveMoment | null } = {}) {
    const listeners: Array<(moment: LiveMoment) => void> = [];
    const requests: LiveWriteRequest[] = [];
    const outbox = new LiveSpeechOutbox(() => clock);
    // The body tells its room in each poll: a reading that is not renewed goes out of date.
    const tell = () => outbox.receive([], { voice: true, humanSpeaking: false, sinceHumanMs: null, speechMode: options.speechMode ?? 'chatty', speechRate: 'normal' });
    tell();
    const engine = new LiveCommentary({
      live: { onMoment: listener => { listeners.push(listener); return () => undefined; }, inDanger: () => false,
        conversation: () => ({ replying: false, sinceHumanMilliseconds: null }), ...(options.working ? { working: options.working } : {}) },
      outbox, now: () => clock,
      write: async request => { requests.push(request); return `言葉:${request.main.kind}`; },
    });
    engine.start();
    return { engine, outbox, requests, tell, emit: (moment: LiveMoment) => listeners.forEach(listener => listener(moment)),
      settle: async () => { await vi.advanceTimersByTimeAsync(50); } };
  }
  const moment = (kind: LiveMoment['kind'], facts: LiveMoment['facts'] = {}): LiveMoment => ({ kind, key: `${kind}:${clock}`, at: clock, facts });

  it('writes a cry of a fight when she speaks only when needed, and hands the writer what she said lately of the same sort', async () => {
    const f = setup({ speechMode: 'needed' });
    f.emit(moment('attacked', { from: 'ゾンビ', count: 1, health: 14 }));
    await f.settle();
    expect(f.requests.map(request => request.main.kind)).toEqual(['attacked']);
    expect(f.requests[0]!.recentSame).toEqual([]);
    // Her monologue of the work is still left unwritten in that mode.
    f.emit(moment('thinking', { why: 'ざいりょうがほしい' }));
    await f.settle();
    expect(f.requests.map(request => request.main.kind)).toEqual(['attacked']);
    expect(f.engine.stats().muted).toBe(1);
  });

  it('gives a cry a short life: a line for a hit is not said ten seconds later', () => {
    expect(LIVE_COMMENTARY_ENGINE.lineLifetimeByKindMilliseconds.attacked).toBeLessThanOrEqual(10_000);
    expect(LIVE_COMMENTARY_ENGINE.lineLifetimeByKindMilliseconds.scared).toBeLessThanOrEqual(8_000);
    expect(LIVE_COMMENTARY_ENGINE.lineLifetimeByKindMilliseconds.task_done).toBeGreaterThanOrEqual(40_000);
  });

  it('asks for a word of what she is doing once she has been quiet for a while, but not before, and not when someone is talking with her', async () => {
    const working = vi.fn((seconds: number): LiveMoment | null => ({ kind: 'working', key: `working:${clock}`, at: clock, facts: { doing: '掘っている', seconds: Math.round(seconds) } }));
    const f = setup({ working });
    clock += 10_000;
    f.tell();
    await vi.advanceTimersByTimeAsync(LIVE_COMMENTARY_ENGINE.quietCheckMilliseconds + 10);
    expect(working).not.toHaveBeenCalled();
    clock += 14_000;
    f.tell();
    await vi.advanceTimersByTimeAsync(LIVE_COMMENTARY_ENGINE.quietCheckMilliseconds + 10);
    expect(working).toHaveBeenCalledTimes(1);
    expect(working.mock.calls[0]![0]).toBeGreaterThanOrEqual(22);
    expect(f.requests.map(request => request.main.kind)).toEqual(['working']);
    f.engine.stop();
  });

  it('does not fill the quiet when she is not chatty', async () => {
    const working = vi.fn((): LiveMoment | null => ({ kind: 'working', key: 'w', at: clock, facts: { doing: '掘っている', seconds: 30 } }));
    const f = setup({ speechMode: 'needed', working });
    clock += 40_000;
    f.tell();
    await vi.advanceTimersByTimeAsync(LIVE_COMMENTARY_ENGINE.quietCheckMilliseconds + 10);
    expect(working).not.toHaveBeenCalled();
    f.engine.stop();
  });
});

describe('the live view hands the scene and the quiet', () => {
  it('has a scene from the newest frame and a moment of what she does, and nothing while she has no task', () => {
    let current: BodyObservation | null = null;
    let now = T0;
    const live = new MinecraftLive({ now: () => now, frames: { latest: () => (current ? { observation: current, ageMs: 100 } : null), available: () => (current ? ['b'] : []) } });
    expect(live.scene()).toBeNull();
    expect(live.working(30)).toBeNull();
    current = frame({ health: 18, nearbyThreats: [zombie(3)] });
    live.frame('b', current, { newConnection: true });
    now += 500;
    live.frame('b', frame({ health: 14, nearbyThreats: [zombie(2)] }), { newConnection: false });
    current = frame({ health: 14, nearbyThreats: [zombie(2)] });
    expect(live.scene()).toMatchObject({ health: 14, lost: 4 });
    expect(live.working(30)).toBeNull();
    live.begin({ taskId: 't', scopeKey: 'owner', goal: 'ケーキを作る', origin: 'owner_request', createdAtMs: now, bodyId: 'b', netherReached: null });
    live.activity('t', { name: 'mc.mine-block', input: { blockName: 'stone' } });
    expect(live.working(30)?.facts).toMatchObject({ doing: '石を掘っている', seconds: 30 });
  });
});
