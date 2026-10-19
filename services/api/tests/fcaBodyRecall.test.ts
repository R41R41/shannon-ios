import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OWNER_AUDIENCE } from '@shannon/cognition';
import { BODY_RECALL, createBodyTaskRecall } from '../src/mind/recall/bodyTaskRecall.js';
import type { TaskMemory, TaskMemoryItem } from '../src/mind/memory/taskMemoryPorts.js';
import { SemanticMemoryRecall, DEFAULT_SEMANTIC_MEMORY_CONFIG } from '../src/mind/recall/semanticMemoryRecall.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { MemoryEmbeddingWorker } from '../src/mind/memory/memoryEmbeddingWorker.js';
import { DeterministicMemoryModelGateway } from '../src/mind/recall/memoryModels.js';
import { createTaskRuntimeWiring } from '../src/wiring/taskRuntimeWiring.js';
import { createAnthropicFcaModel } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { message, scriptedAnthropic, withoutCacheMarkers } from './support/anthropicFixtures.js';
import { definition } from './fcaCoreToolsHarness.js';
import { minecraftRecallCues } from '../src/surfaces/minecraft/minecraftRecallCues.js';
import { minecraftSituation } from '../src/surfaces/minecraft/minecraftSkillPointers.js';

/**
 * A body task's recall (2026-10-19), on a pool shaped like production run 15's: past episodes of the same goal, most of them a stale result
 * ("身体の状態が変わりました"), 56 deaths of one line, and a few records that say something (the night underground, the iron and the furnace,
 * a nether trip).
 */
const item = (id: string, summary: string, observedAt: string): TaskMemoryItem => ({ id, summary, observedAt, evidence: '過去の作業の観測',
  applicability: 'recorded observation', confidence: null, conflicts: [], detailRef: id });
const STALE = Array.from({ length: 20 }, (_, index) => item(`stale-${index}`, `タスク経験 [failure] 目的: エンドラを倒して\n行動: {"id":"toolu_0${index}abc","name":"minecraft.observe","input":{}}\n観測結果: 身体の状態が変わりました。最新の観測から判断し直してください。`, `2026-10-14T13:0${index % 10}:00.000Z`));
const DEATHS = Array.from({ length: 56 }, (_, index) => item(`death-${index}`, `ゲームの記憶: 10月${10 + (index % 9)}日の深夜、マイクラで死んだ（モンスター）。`, `2026-10-${String(10 + (index % 9)).padStart(2, '0')}T15:00:00.000Z`));
const USEFUL = [
  item('night', 'タスク経験 [success] 目的: エンドラを討伐してください\n行動: 夜になる前に縦穴を掘って入り、地下で石炭と鉄鉱石を掘り続けた。ゾンビは入れなかった。', '2026-10-16T12:00:00.000Z'),
  item('iron', 'タスク経験 [success] 目的: エンドラを討伐してください\n行動: かまどを作業台のそばに置き、raw_iron を精錬して鉄のツルハシを作った。棒を先に作っておく。', '2026-10-16T13:00:00.000Z'),
  item('nether', 'タスク経験 [failure] 目的: エンドラを討伐してください\n行動: ネザーでガストの火の玉に当たって体力が減った。黒曜石の門の近くに戻る。', '2026-10-17T13:00:00.000Z'),
];
const ALL = [...STALE, ...DEATHS, ...USEFUL];

function memoryOf(items: readonly TaskMemoryItem[], forgotten = new Set<string>()) {
  const calls = { search: 0, read: 0, sources: 0 };
  const memory: TaskMemory = {
    available: () => true,
    search(_scope, _query, _present, limit = 8) { calls.search += 1; return [...items].sort((a, b) => b.observedAt.localeCompare(a.observedAt)).slice(0, limit); },
    read(_scope, ids) { calls.read += 1; return ids.flatMap(id => forgotten.has(id) ? [] : items.filter(entry => entry.id === id)); },
    sources(_scope, ids) { calls.sources += 1; return ids.map(id => `source:${id}`); },
    async execute() { throw new Error('unused'); },
  };
  return { memory, calls, forgotten };
}
const state = { snapshot: () => ({}) as never };
type JevAsked = { questions: object; parse(answers: Record<string, unknown>): unknown; fallback(): unknown };
const situation = (overrides: Partial<ReturnType<typeof minecraftSituation>>) => ({ night: false, darkSoon: false, threatNear: false, lowHealth: false,
  hungry: false, stalled: false, idleWaiting: false, readyForNether: false, inNether: false, blazeNear: false, bedWanted: false, stage: 3 as const, calm: true, ...overrides });
const input = (cues: ReturnType<typeof minecraftRecallCues>) => ({ scopeKey: 'owner', taskId: 't1', goal: 'エンドラを討伐してください', cues, present: OWNER_AUDIENCE });

describe('a body task\'s recall: the pool once a task, the situation each decision', () => {
  it('shows the night record at night, the furnace record by day at the iron stage, never a stale result, and the deaths as one', async () => {
    const m = memoryOf(ALL);
    const recall = createBodyTaskRecall({ memory: m.memory, state });
    const night = minecraftRecallCues(null, situation({ night: true, threatNear: true, calm: false }), []);
    const atNight = await recall.packet(input(night));
    expect(atNight.packet.items[0]!.id).toBe('night');
    // 56 deaths of one line are one group; the searches came back full (40), so the count is a lower bound.
    expect(atNight.packet.items.some(entry => /^（死んだ記録×\d+\+、最後 2026-10-18）/u.test(entry.summary))).toBe(true);
    expect(atNight.packet.items.length).toBeLessThanOrEqual(BODY_RECALL.items);
    const byDay = await recall.packet(input(minecraftRecallCues(null, situation({}), [])));
    expect(byDay.packet.items[0]!.id).toBe('iron');
    for (const packet of [atNight.packet, byDay.packet]) {
      expect(packet.items.some(entry => entry.summary.includes('身体の状態が変わりました'))).toBe(false);
      expect(packet.items.every(entry => entry.summary.length <= BODY_RECALL.text + 30)).toBe(true);
      expect(packet.sourceIds).toEqual(packet.items.map(entry => `source:${entry.id}`));
    }
    // The pool was made once (three searches: the goal, the game and the goal, the game's own records); each decision only read what it showed.
    expect(m.calls.search).toBe(3);
    expect(atNight.measure).toMatchObject({ groups: 4, shown: atNight.packet.items.length, tags: expect.arrayContaining(['night', 'threat', 'stage3']) });
    expect(atNight.measure.poolMs).not.toBeNull(); expect(byDay.measure.poolMs).toBeNull();
  });
  it('shows nothing when nothing fits the situation, and never what was forgotten after the pool was made', async () => {
    const m = memoryOf(ALL);
    const recall = createBodyTaskRecall({ memory: m.memory, state });
    const none = await recall.packet(input({ words: ['エリトラ'], tags: [] }));
    expect(none.packet).toMatchObject({ status: 'no_match', items: [], sourceIds: [] });
    m.forgotten.add('night');
    const night = await recall.packet(input(minecraftRecallCues(null, situation({ night: true, calm: false }), [])));
    expect(night.packet.items.map(entry => entry.id)).not.toContain('night');
    expect(night.packet.sourceIds).not.toContain('source:night');
  });
  it('makes the pool again after its decisions, and joins the memories nearest the goal by embedding once', async () => {
    const m = memoryOf(STALE);
    let nearest = 0;
    const recall = createBodyTaskRecall({ memory: { ...m.memory, read: (_scope, ids) => ids.flatMap(id => USEFUL.filter(entry => entry.id === id)) }, state,
      nearest: async () => { nearest += 1; return { status: 'used', hits: [{ id: 'iron', similarity: 0.55 }], elapsedMilliseconds: 1 }; } });
    const cues = minecraftRecallCues(null, situation({}), []);
    await recall.packet(input(cues));
    await new Promise(resolve => setImmediate(resolve));
    const second = await recall.packet(input(cues));
    expect(second.packet.items.map(entry => entry.id)).toEqual(['iron']);
    for (let index = 0; index < BODY_RECALL.poolDecisions; index++) await recall.packet(input(cues));
    expect(nearest).toBe(2);
    expect(m.calls.search).toBe(6);
  });
  it('with Jev on, keeps only what Jev is sure helps (none allowed), and the situation order when Jev fails', async () => {
    const m = memoryOf(ALL);
    const cues = minecraftRecallCues(null, situation({ night: true, calm: false }), []);
    const sure = createBodyTaskRecall({ memory: m.memory, state, jevOn: true, jev: { async decide(request: JevAsked) {
      const answers = Object.fromEntries(Object.keys(request.questions).map((key, index) => [key, { noul: index === 1 ? 0.95 : 0.2 }]));
      return { value: request.parse(answers), source: 'jev' };
    } } as never });
    const kept = await sure.packet(input(cues));
    expect(kept.packet.items).toHaveLength(1);
    expect(kept.measure.jev).toMatchObject({ source: 'jev', kept: 1 });
    const failing = createBodyTaskRecall({ memory: m.memory, state, jevOn: true, jev: { async decide(request: JevAsked) { return { value: request.fallback(), source: 'fallback' }; } } as never });
    const fallback = await failing.packet(input(cues));
    expect(fallback.packet.items[0]!.id).toBe('night');
    expect(fallback.measure.jev).toMatchObject({ source: 'fallback', kept: 0 });
  });
});

describe('a body task\'s recall after review', () => {
  it('never puts a memory forgotten since the pool was made to Jev', async () => {
    const m = memoryOf(ALL);
    const sent: string[] = [];
    const recall = createBodyTaskRecall({ memory: m.memory, state, jevOn: true, jev: { async decide(request: JevAsked & { state: { memories: Record<string, string> } }) {
      sent.push(...Object.values(request.state.memories));
      return { value: request.fallback(), source: 'fallback' };
    } } as never });
    const cues = minecraftRecallCues(null, situation({ night: true, calm: false }), []);
    await recall.packet(input(cues));
    expect(sent.some(text => text.includes('縦穴'))).toBe(true);
    sent.length = 0;
    m.forgotten.add('night');
    await recall.packet(input(cues));
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.some(text => text.includes('縦穴'))).toBe(false);
  });
  it('gives no recall, never an error, when a read fails, and does not make the pool again at once', async () => {
    const m = memoryOf(ALL);
    let fail = true;
    const memory = { ...m.memory, search: (...args: Parameters<TaskMemory['search']>) => { if (fail) throw new Error('TASK_MEMORY_LINEAGE_LIMIT'); return m.memory.search(...args); } };
    const recall = createBodyTaskRecall({ memory, state });
    const cues = minecraftRecallCues(null, situation({}), []);
    const first = await recall.packet(input(cues));
    expect(first.packet).toMatchObject({ status: 'failed', items: [], sourceIds: [] });
    fail = false;
    const second = await recall.packet(input(cues));
    expect(second.packet.items).toEqual([]);
    expect(m.calls.search).toBe(0);
  });
  it('counts only her own deaths as deaths, not a task record that mentions one', async () => {
    const own = item('own', 'ゲームの記憶: 10月19日の夜、マイクラで死んだ（モンスター）。', '2026-10-19T12:00:00.000Z');
    const task = item('task', 'タスク経験 [success] 目的: x\n行動: {"name":"mc.attack-continuously","input":{"entityName":"zombie"}}\n観測結果: zombieは死んだ。\n解釈: y', '2026-10-19T12:01:00.000Z');
    const recall = createBodyTaskRecall({ memory: memoryOf([own, task]).memory, state });
    const { packet } = await recall.packet(input(minecraftRecallCues(null, situation({ lowHealth: true, calm: false }), [])));
    expect(packet.items.map(entry => entry.id).sort()).toEqual(['own', 'task']);
    expect(packet.items.find(entry => entry.id === 'task')!.summary).toBe('[success] attack-continuously(zombie): zombieは死んだ。');
  });
});
describe('the recall cues of a Minecraft body', () => {
  it('name the night, the threats in Japanese and by id, the stage, a recent failure and a death the body reports', () => {
    const observation = { state: { world: { nearbyThreats: [{ name: 'zombie', distance: 4 }], dimension: 'overworld', deaths: [{ cause: 'zombie' }] } }, facts: {} } as never;
    const cues = minecraftRecallCues(observation, situation({ night: true, threatNear: true, stage: 2, calm: false }), [{ name: 'mc.craft-one', ok: false }]);
    expect(cues.tags).toEqual(expect.arrayContaining(['night', 'threat', 'stage2', 'failure', 'died']));
    expect(cues.urgent).toEqual(expect.arrayContaining(['夜', 'zombie', 'ゾンビ', '死んだ']));
    expect(cues.words).toEqual(expect.arrayContaining(['石のツルハシ', 'craft-one']));
  });
});

describe('embeddings held in memory', () => {
  const directories: string[] = [];
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
  it('reads the vectors once while the index says nothing changed, and again when a memory is added and embedded', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-body-recall-'));
    directories.push(directory);
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 19, 0, minute)).toISOString();
    const store = new SQLiteShannonStore({ path: join(directory, 'shannon.sqlite'), now: () => at(500) });
    const say = (minute: number, user: string, reply: string) => store.appendTurn('owner', 'mc', user, reply, at(minute),
      { capturedStateVersion: 0, messageEmotion: { valence: 0, arousal: 0.3, openness: 0.35, expression: 'calm' } });
    say(1, '夜は縦穴に入って地下で掘った', '地下なら敵が来ない。');
    say(2, 'かまどで鉄を精錬した', '棒を先に作っておく。');
    const gateway = new DeterministicMemoryModelGateway();
    const worker = new MemoryEmbeddingWorker(store, store, gateway, store, { now: () => at(500) });
    await worker.runOnce();
    let reads = 0;
    const read = store.embeddingCandidates.bind(store);
    store.embeddingCandidates = (scope, model, limit) => { reads += 1; return read(scope, model, limit); };
    const recall = new SemanticMemoryRecall(gateway, store, { ...DEFAULT_SEMANTIC_MEMORY_CONFIG, minimumSimilarity: -1 });
    const ask = () => recall.nearest({ scopeKey: 'owner', query: '夜の地下', snapshot: store.snapshot('owner'), present: OWNER_AUDIENCE, limit: 5 });
    const first = await ask();
    expect(first.hits.length).toBeGreaterThan(0);
    await ask();
    expect(reads).toBe(1);
    say(3, 'ネザーでブレイズを倒した', 'ブレイズロッドが手に入った。');
    await worker.runOnce();
    const before = reads;
    expect((await ask()).hits.length).toBeGreaterThan(first.hits.length);
    await ask();
    expect(reads - before).toBe(1);
  });
});
describe('a body task\'s recall in its decision', () => {
  it('is asked with the body\'s cues, pins its sources, and reaches the model; any other task never asks it', async () => {
    const h = actionHarness(() => '2026-10-19T08:00:00.000Z');
    const asked: unknown[] = [], pinned: string[][] = [], seen: unknown[] = [];
    const packet = { contextVersion: 'body', observedAt: 'x', status: 'ready' as const, items: [USEFUL[0]!], sourceIds: ['source:night'] };
    const make = (keepBody: boolean) => createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', now: () => '2026-10-19T08:00:00.000Z', ownerAlone: () => true,
      model: { async decide(input) { seen.push(input.recall ?? null); return { decision: { kind: 'wait', summary: 'w' }, history: [{ role: 'assistant', native: 'x' }] }; },
        toolResults: results => ({ results }) },
      stepPorts: () => ({ keepBodyTools: () => keepBody, observeMemory: ids => { pinned.push([...ids]); return true; },
        bodyRecall: { cancel() {}, async packet(request) { asked.push(request.cues); return { packet, measure: { poolMs: 1, pool: 1, groups: 1, shown: 1, chars: 10, tags: [], jev: null } }; } },
        body: { start() {}, revision: () => 0, context: () => ({ revision: 0, observation: null }), guard: async () => true, toolSignal: (_name: string, parent: AbortSignal) => parent,
          close: async () => {}, recallCues: () => ({ words: ['夜'], tags: ['night'] }) } as never }) });
    const driver = make(true);
    const root = driver.runtime.ensureRoot('owner');
    driver.runtime.createChild('owner', root.id, { title: 'body', goal: 'エンドラ', completionCriteria: 'x' }, 'body-1');
    await driver.tick(); await driver.drain(); await driver.close();
    expect(asked).toEqual([{ words: ['夜'], tags: ['night'] }]);
    expect(pinned).toEqual([['source:night']]);
    expect(seen).toEqual([packet]);
    const other = make(false);
    other.runtime.createChild('owner', root.id, { title: 'research', goal: '調べる', completionCriteria: 'x' }, 'other-1');
    await other.tick(); await other.drain(); await other.close();
    expect(asked).toHaveLength(1);
    h.close();
  });
  it('is part of a transient decision\'s live state, never stored, as its id, text and day', async () => {
    const fixture = scriptedAnthropic([message([{ type: 'tool_use', id: 'w', name: 'fca_wait', input: { summary: '待つ' } }], 'tool_use')]);
    const model = createAnthropicFcaModel({ apiKey: 'synthetic', model: 'claude-sonnet-5-5', fetcher: fixture.fetcher, recordUsage() {} });
    const core = definition('mc.skill-1', 'minecraft_body');
    await model.decide({ task: { id: 't', title: 'x', goal: 'x', completionCriteria: 'x' }, messages: [], history: [], tools: [core], coreTools: [core], catalog: [],
      transient: { observation: { marker: 'OBS' } }, body: { revision: 1, observation: null },
      recall: { contextVersion: 'body', observedAt: 'x', status: 'ready', items: [USEFUL[0]!], sourceIds: ['s'] } } as never, new AbortController().signal);
    const messages = withoutCacheMarkers(fixture.bodies[0]!.messages as Array<{ role: string; content: unknown; clear_at?: string }>);
    const live = JSON.parse(String(messages.find(entry => entry.clear_at === 'next_user_message')!.content));
    expect(live.recall).toEqual({ items: [{ id: 'night', text: USEFUL[0]!.summary, day: '2026-10-16' }] });
    expect(messages.filter(entry => entry.role === 'user').map(entry => JSON.stringify(entry.content)).join('')).not.toContain('縦穴');
  });
});