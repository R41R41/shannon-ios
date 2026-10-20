import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OWNER_AUDIENCE } from '@shannon/cognition';
import { memoryWorld } from './support/memoryWorld.js';
import { createTaskMemory } from '../src/mind/memory/taskMemory.js';
import { createLocalApiKernel } from '../src/wiring/apiKernelWiring.js';
import { BackgroundUpdateCoordinator } from '../src/mind/sleep/backgroundUpdates.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonChatModelResult } from '../src/infra/models/chatModel.js';
import { MINECRAFT_INTENT_REFUSALS, MinecraftBody, type MinecraftBodyDependencies } from '../src/surfaces/minecraft/minecraftBody.js';
import { configuredMinecraftBody } from '../src/contracts/minecraftBodyContract.js';
import { SQLiteMinecraftTurnLog } from '../src/mind/action/respond/store/surfaceTurnStore.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { promptOf } from './modelPrompt.js';
import { DatabaseSync } from 'node:sqlite';
import { SkillMemory } from '../src/mind/memory/skillMemory.js';
import { SkillImporter } from '../src/mind/memory/skillImport.js';
import { standardSkillPack } from '../src/infra/config/standardSkillPack.js';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { minecraftSituation, minecraftSkillContext } from '../src/surfaces/minecraft/minecraftSkillPointers.js';
import { milestoneFollowMemory, milestoneSteps } from '../src/surfaces/minecraft/minecraftMilestoneFollow.js';
import { MILESTONE_TARGET_SECONDS, milestoneLines } from '../src/surfaces/minecraft/minecraftStage.js';
import { carriedItemCounts } from '../src/surfaces/minecraft/minecraftItems.js';
import { ROUTE_PLAN, createRoutePlanning, forgetRoutes, planWanted, routeFrom, routeInput, routeLines } from '../src/surfaces/minecraft/minecraftRoutePlanner.js';
import { configuredMinecraftRoutePlanner } from '../src/wiring/minecraftRouteWiring.js';

/**
 * Minecraft run 19 (2026-10-20, 10:54 JST): the owner's in-game 「続けて」 was refused twice as `queue_unavailable`, with a reply
 * about "the selected model", while her body worked on; what she remembered saying was 「はいはい、続けますよ」. Her own turn was not
 * visible to the check of its source: it had recalled her own interests (`si-…`), which no read knew.
 */
const worlds: Array<{ close(): void }> = [];
const directories: string[] = [];
afterEach(() => {
  worlds.splice(0).forEach(world => world.close());
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('a turn that recalled her own interests', () => {
  it('is read as visible while she would show those interests to the owner, and not when one is gone', () => {
    const w = memoryWorld(); worlds.push(w);
    let index = '- si-6f3c05fc65071a1a: 星の話（会話から）';
    (w.store as unknown as { selfInterestProjection: () => string }).selfInterestProjection = () => index;
    const memory = createTaskMemory({ state: w.store, conversations: w.store, ownerScope: 'owner', ownerAlone: () => true, now: w.now });
    const turn = w.store.appendTurn('owner', 'platform:minecraft:x', '続けて', 'はい', w.now(), { recalledMemoryIds: ['si-6f3c05fc65071a1a'] } as never);
    const later = w.store.appendTurn('owner', 'platform:minecraft:x', 'まだ？', 'うん', w.now(), { recalledMemoryIds: [turn.id] } as never);
    expect(memory.read('owner', [turn.id], OWNER_AUDIENCE).map(item => item.id)).toEqual([turn.id]);
    // A later turn that recalled it, and the interest itself, as items.
    expect(memory.read('owner', [later.id], OWNER_AUDIENCE)).toHaveLength(1);
    expect(memory.read('owner', ['si-6f3c05fc65071a1a'], OWNER_AUDIENCE)).toMatchObject([{ applicability: 'her own interest' }]);
    // An interest she no longer shows (dropped at night, or not for this audience): closed, as before.
    index = '';
    const memoryAfter = createTaskMemory({ state: w.store, conversations: w.store, ownerScope: 'owner', ownerAlone: () => true, now: w.now });
    expect(memoryAfter.read('owner', [turn.id], OWNER_AUDIENCE)).toEqual([]);
    // Not an id of that form: unknown, as before.
    const other = w.store.appendTurn('owner', 't', 'x', 'y', w.now(), { recalledMemoryIds: ['si-nothex'] } as never);
    expect(memoryAfter.read('owner', [other.id], OWNER_AUDIENCE)).toEqual([]);
  });
});

class GameModel implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'test-model';
  readonly requests: ShannonChatModelRequest[] = [];
  async generate(request: ShannonChatModelRequest): Promise<ShannonChatModelResult> {
    this.requests.push(request);
    return { mode: this.mode, model: this.model, reply: 'はいはい、続けますよ。',
      ...(request.offerMinecraftIntent ? { minecraftIntent: { kind: 'task' as const, goal: '羊を探す' } } : {}) };
  }
  async generateVoice(request: ShannonChatModelRequest): Promise<ShannonChatModelResult> { return this.generate(request); }
}
const OWNER_UUID = 'b9191317-c52d-4d67-85fe-ab831e6db146';

function harness(intent: Pick<MinecraftBodyDependencies, 'fcaIntent' | 'fcaAdmission'>) {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-run19-')); directories.push(directory);
  const path = join(directory, 'shannon.sqlite'), now = () => '2026-10-20T01:54:24.000Z';
  const store = new SQLiteShannonStore({ path, now }), background = new BackgroundUpdateCoordinator(store, store);
  const turns = new SQLiteMinecraftTurnLog(path), model = new GameModel(), lines: string[] = [];
  const configuration = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'minebot',
    servers: [{ serverId: 'world', ownerUuid: OWNER_UUID, title: 'world', onlineMode: true }] }) })!;
  const api = createLocalApiKernel(now, { chatModel: model, stateStore: store, conversationStore: store, knowledgeStore: store, background });
  const body = new MinecraftBody({ configuration, stateStore: store, conversationStore: store, background, now, chatModel: model, turns,
    conversation: { textTurn: input => api.textTurn(input) }, peopleEnabled: () => false, log: line => lines.push(line), ...intent });
  worlds.push({ close: () => { turns.close(); store.close(); } });
  const turn = (requestId: string) => body.turn('owner', 'minebot', { requestId, serverId: 'world', conversation: { kind: 'channel' },
    speaker: { uuid: OWNER_UUID, name: 'Rai1241' }, message: '続けて', observedAt: now() });
  return { store, model, lines, turn, background };
}

describe('「続けて」 refused, and said as it was', () => {
  it('says a refusal known before her reply in her own words, offers no intent, and keeps what she said', async () => {
    let asked = 0;
    const h = harness({ fcaAdmission: () => 'others_present', fcaIntent: async input => { asked += 1; return input.intent; } });
    const response = await h.turn('one');
    expect(promptOf(h.model.requests.at(-1)!)).toContain(MINECRAFT_INTENT_REFUSALS.others_present);
    expect(h.model.requests.at(-1)!.offerMinecraftIntent).toBeUndefined();
    expect(response.reply).toBe('はいはい、続けますよ。');
    expect(response.intent).toEqual({ kind: 'none', goal: '' });
    expect(asked).toBe(1);
    expect(h.lines).toEqual(['Shannon Minecraft intent refused reason=others_present kind=- stage=before_reply']);
    await h.background.waitForIdle('owner');
  });
  it('leaves a body without a frame to the check after her reply, so that a stop still reaches the body task', async () => {
    const h = harness({ fcaAdmission: () => 'body_unavailable', fcaIntent: async input => input.intent });
    await h.turn('three');
    expect(h.model.requests.at(-1)!.offerMinecraftIntent).toBe(true);
    expect(h.lines).toEqual([]);
    await h.background.waitForIdle('owner');
  });
  it('sends the words of a refusal found after her reply, notes them in her thread, and keeps the reason off the wire', async () => {
    const h = harness({ fcaAdmission: () => null,
      fcaIntent: async () => ({ kind: 'none', goal: '', rejected: 'queue_unavailable', reason: 'turn_not_visible' }) });
    const response = await h.turn('two');
    expect(response.reply).toBe(MINECRAFT_INTENT_REFUSALS.turn_not_visible);
    expect(response.reply).not.toContain('選択中のモデル');
    expect(response.intent).toEqual({ kind: 'none', goal: '', rejected: 'queue_unavailable' });
    const thread = response.threadId;
    expect(h.store.conversationHistory('owner', thread).map(message => message.content)).toContain(MINECRAFT_INTENT_REFUSALS.turn_not_visible);
    await h.background.waitForIdle('owner');
  });
});

const observation = (world: Record<string, unknown>): BodyObservation => ({ schemaVersion: 1, bodyId: 'minecraft:world', sequence: 1,
  stateAt: 'x', receivedAt: 'x', connected: true,
  state: { world: { dimension: 'overworld', health: 20, food: 20, time: '1000', margin: { darkInSeconds: 600 }, nearbyThreats: [], ...world,
    inventory: ((world.inventory as string[] | undefined) ?? []).map(item => { const [name, count] = item.split('×'); return { name, count: Number(count ?? 1) }; }) } },
  facts: { dimension: 'overworld' } }) as unknown as BodyObservation;
// Run 19 at D10: iron pickaxe and bucket, no bed, the igloo's bed 13 m north-east; at D50 in snowy plains with the village 171 m east.
const D10 = ['iron_pickaxe', 'bucket', 'stone_axe', 'spruce_planks×12', 'cooked_salmon×2'];
const reminders = (world: Record<string, unknown>) => minecraftSkillContext(minecraftSituation(observation(world), { failedStepsInARow: 0 }), new Set()).fields.reminders ?? [];

describe('a bed or a village she knows of, before the sheep', () => {
  it('goes for a remembered bed first, with the tools and its place, whatever the body adds after the row', () => {
    const lines = reminders({ inventory: D10, rememberedPlaces: { bed: '13m 北東 (69,66,4) ×2 掘れば持てる', furnace: '13m 北東 (68,66,4)' } });
    expect(lines).toContain('置かれたベッドが場所の記憶にある（13m 北東、69,66,4）。羊を探すより先に取りに行く: mc.move-to（x=69、y=66、z=4、goalType=near、range=2）'
      + '→ mc.dig-block-at（x=69、y=66、z=4、takeEquipment=true）。壊すとベッドが手に入る（イグルーや村の家のベッドも同じ）');
    // With a bed of her own, carried or set, or at night, or with a threat near: no such line.
    expect(reminders({ inventory: [...D10, 'white_bed'], rememberedPlaces: { bed: '13m 北東 (69,66,4) ×2' } }).join()).not.toContain('置かれたベッド');
    expect(reminders({ inventory: D10, rememberedPlaces: { bed: '13m 北東 (69,66,4) ×2', respawn: '0m (69,66,4)' } }).join()).not.toContain('置かれたベッド');
    expect(reminders({ inventory: D10, time: '15000', margin: undefined, rememberedPlaces: { bed: '13m 北東 (69,66,4) ×2' } }).join()).not.toContain('置かれたベッド');
    expect(reminders({ inventory: D10, nearbyThreats: [{ name: 'zombie', distance: 9 }], rememberedPlaces: { bed: '13m 北東 (69,66,4) ×2' } }).join()).not.toContain('置かれたベッド');
  });
  it('goes to a remembered village first where sheep do not spawn and none is in sight (run 19: snowy plains, then a frozen ocean)', () => {
    const village = { rememberedPlaces: { village: '171m 東 (287,85,13)' } };
    expect(reminders({ inventory: D10, biome: 'snowy_plains', ...village }).join()).toContain('村が場所の記憶にある（171m 東、287,85,13）。ここ（snowy_plains）は羊が出ないので');
    expect(reminders({ inventory: D10, biome: 'frozen_ocean', ...village }).join()).toContain('mc.move-to（x=287、y=85、z=13、goalType=near、range=8）');
    expect(reminders({ inventory: D10, biome: 'plains', ...village }).join()).not.toContain('村が場所の記憶にある');
    expect(reminders({ inventory: D10, biome: 'snowy_plains', nearbyEntities: [{ name: 'sheep', distance: 20 }], ...village }).join()).not.toContain('村が場所の記憶にある');
  });
  it('puts it first in the bed step\'s procedure too', () => {
    const memory = milestoneFollowMemory({ milestone: '食料と羊とベッド', decisions: 3 });
    const situation = memory.situate(minecraftSituation(observation({ inventory: D10, rememberedPlaces: { bed: '13m 北東 (69,66,4) ×2' } }), { failedStepsInARow: 0 }));
    expect(situation.milestoneName).toBe('食料と羊とベッド');
    expect(situation.milestoneSteps?.[1]).toMatch(/^置かれたベッドが場所の記憶にある/u);
    expect(situation.milestoneSteps?.[2]).toMatch(/^羊を探す/u);
  });
});
describe('legacy-minecraft draft-11', () => {
  it('revises mc-food-and-bed on draft-10, mc-iron-and-bucket and mc-diamond-obsidian on draft-9, with no new skill', () => {
    const memory = new SkillMemory({ database: new DatabaseSync(':memory:'), createsSchema: true, defer: task => task(), log: () => {} });
    const importer = new SkillImporter({ memory, ownerScopeKey: 'owner', check: () => ({ carries: () => false }), tools: () => [] });
    const at = (minutes: number) => new Date(Date.parse('2026-10-20T00:00:00.000Z') + minutes * 60_000).toISOString();
    (['draft-1', 'draft-2', 'draft-3', 'draft-4', 'draft-6', 'draft-7', 'draft-8', 'draft-9', 'draft-10'] as const).forEach((revision, index) => {
      const pack = standardSkillPack('legacy-minecraft', revision)!;
      importer.apply('owner', pack, { planHash: importer.dryRun('owner', pack).planHash, approvalReference: 'x' }, at(index));
    });
    const pack = standardSkillPack('legacy-minecraft', 'draft-11')!;
    const plan = importer.dryRun('owner', pack);
    expect(plan.problems).toEqual([]);
    expect(plan.capacity.added).toBe(0);
    expect(pack.skills.find(skill => skill.name === 'mc-food-and-bed')!.body).toContain('置かれたベッドは、壊せば持てる');
    expect(pack.skills.find(skill => skill.name === 'mc-iron-and-bucket')!.body).toContain('燃料は石炭を先に使う');
    expect(pack.skills.map(skill => skill.name)).toEqual(['mc-food-and-bed', 'mc-iron-and-bucket', 'mc-diamond-obsidian']);
    expect(pack.skills.find(skill => skill.name === 'mc-diamond-obsidian')!.body).toContain('mc.stair-mine（targetY=-58）');
    expect(pack.skills.find(skill => skill.name === 'mc-food-and-bed')!.body).toContain('takeEquipment=true');
  });
});
describe('the time budget to the Nether and the steps from the diamonds on', () => {
  const facts = (inventory: string[]) => ({ counts: carriedItemCounts({ inventory: inventory.map(item => { const [name, count] = item.split('×'); return { name, count: Number(count ?? 1) }; }) }, {}),
    dimension: 'overworld', netherReached: false, bedPlaced: true });
  it('gives the step its seconds, and when late what to cut (run 19: the iron pickaxe and bucket at 535 s, budget 420 s)', () => {
    const atIron = ['stone_pickaxe', 'stone_axe', 'oak_planks×12', 'white_bed', 'cooked_beef×6'];
    expect(milestoneLines(facts(atIron), 300)).toContain('時間の目安: 「鉄」は420秒までに（いま300秒、あと120秒）');
    expect(milestoneLines(facts(atIron), 535).at(-1)).toMatch(/^時間の目安: 「鉄」は420秒までに。いま535秒で115秒遅れている。寄り道を切る: 掘りすぎ/u);
    expect(milestoneLines(facts(atIron))).toHaveLength(2);
    expect(MILESTONE_TARGET_SECONDS['ネザー']).toBe(1_800);
  });
  it('has the diamonds, the obsidian and the gate as procedures with the body\'s tools', () => {
    expect(milestoneSteps('ダイヤ', 3).join('\n')).toContain('mc.stair-mine（targetY=-58）');
    expect(milestoneSteps('黒曜石', 3).join('\n')).toContain('mc.use-item-on-block（溶岩の溜まりの座標、itemName=water_bucket、count=10）');
    expect(milestoneSteps('ゲート', 3).join('\n')).toContain('mc.build-structure（structureName=nether_portal、x、y、z、facing）');
  });
});
describe('her route to the Nether, planned once by a strong model', () => {
  beforeEach(() => forgetRoutes());
  const answer = { legs: [
    { milestone: '木と石のツルハシ', goal: '近くの森で原木と石', where: 'スポーンの北 20m', targetSeconds: 140 },
    { milestone: '食料と羊とベッド', goal: '村でベッドとパン', where: '東 171m の村', x: 287, y: 85, z: 13, targetSeconds: 900 },
    { milestone: 'エンド', goal: 'x', where: 'x', targetSeconds: 10 },
    { milestone: '鉄', goal: '洞窟で鉄30', where: '北の洞窟', targetSeconds: 400 },
    { milestone: '木', goal: '戻り', where: 'x', targetSeconds: 50 },
  ] };
  it('keeps only the order\'s steps, in its order, never later than the owner\'s budget', () => {
    const route = routeFrom(answer, 30, 0, 'start')!;
    expect(route.legs.map(leg => leg.milestone)).toEqual(['木と石のツルハシ', '食料と羊とベッド', '鉄']);
    expect(route.legs.map(leg => leg.targetSeconds)).toEqual([140, 600, 400]);
    expect(route.legs[1]).toMatchObject({ x: 287, y: 85, z: 13 });
    expect(routeFrom({ legs: [] }, 0, 0, 'start')).toBeNull();
    expect(routeLines(route, '食料と羊とベッド')).toEqual(['ルート（最初の計画、30秒）:', '済 木と石のツルハシ: 近くの森で原木と石／スポーンの北 20m／140秒まで',
      '▶ 食料と羊とベッド: 村でベッドとパン／東 171m の村（287,85,13）／600秒まで', '・ 鉄: 洞窟で鉄30／北の洞窟／400秒まで']);
  });
  it('is asked at the start, and again only when a step is late, with replans left and the last plan old enough', () => {
    const route = routeFrom(answer, 30, 0, 'start')!;
    expect(planWanted(null, '木', 5)).toBe('start');
    expect(planWanted(route, '鉄', 600)).toBeNull();
    expect(planWanted(route, '鉄', 400 + ROUTE_PLAN.lateSeconds)).toBe('late');
    expect(planWanted({ ...route, replans: ROUTE_PLAN.replans }, '鉄', 900)).toBeNull();
    expect(planWanted({ ...route, plannedAtSeconds: 500 }, '鉄', 700)).toBeNull();
    expect(planWanted(null, 'ネザー要塞', 5)).toBeNull();
  });
  it('gives the planner where she is and what the body knows of the land', () => {
    const input = routeInput({ biome: 'snowy_plains', position: { x: 1, y: 70, z: 2 }, mapSummary: '溶岩池 西 90m (−88,63,4)', rememberedPlaces: { village: '171m 東 (287,85,13)' },
      inventory: [{ name: 'oak_log', count: 3 }] }, 12, '木');
    expect(input).toContain('地図の要約: 溶岩池 西 90m');
    expect(input).toContain('持ち物: oak_log×3');
    expect(input).toContain('既定の目安（秒）: 木 60');
  });
  it('asks once in a step without making the decision wait, takes the answer when it comes, and keeps it', async () => {
    const lines: string[] = [];
    let asked = 0;
    const planning = createRoutePlanning({ kept: undefined, taskId: 'task', log: line => lines.push(line),
      planner: async () => { asked += 1; return answer; } });
    const first = planning.situate({ milestoneName: '木', elapsedSeconds: 10 }, { biome: 'plains' });
    expect(first.route).toBeUndefined();
    planning.situate({ milestoneName: '木', elapsedSeconds: 12 }, { biome: 'plains' });
    expect(asked).toBe(1);
    await planning.close();
    await new Promise(resolve => setTimeout(resolve, 5));
    const kept = planning.checkpoint();
    expect(kept.minecraftRoute?.legs).toHaveLength(3);
    expect(kept.minecraftRouteAsks).toBe(1);
    const next = createRoutePlanning({ kept: kept.minecraftRoute, keptAsks: kept.minecraftRouteAsks, taskId: 'task', log: () => {}, planner: async () => { asked += 1; return answer; } });
    expect(next.situate({ milestoneName: '鉄', elapsedSeconds: 300 }, {}).route?.[0]).toBe('ルート（最初の計画、10秒）:');
    expect(asked).toBe(1);
    expect(lines).toEqual(['Shannon Minecraft route asked task=task reason=start at=10', expect.stringMatching(/^Shannon Minecraft route planned task=task legs=3 reason=start askedMs=\d+$/u)]);
    // A planner that keeps failing is not asked again at every step.
    const failing = createRoutePlanning({ kept: undefined, keptAsks: ROUTE_PLAN.asks, taskId: 'task', log: () => {}, planner: async () => { asked += 1; throw new Error('x'); } });
    failing.situate({ milestoneName: '木', elapsedSeconds: 10 }, {});
    expect(asked).toBe(1);
  });
  it('lets a replan when late give the steps left until a minute after it, never past the Nether\'s 1,800 s', () => {
    const late = routeFrom({ legs: [{ milestone: '鉄', goal: '洞窟', where: '北', targetSeconds: 1_000 }, { milestone: 'ネザー', goal: 'g', where: 'w', targetSeconds: 2_400 }] }, 900, 1, 'late')!;
    expect(late.legs.map(leg => leg.targetSeconds)).toEqual([960, 1_800]);
  });
  it('does not keep a stopped step waiting for the planner', async () => {
    let aborted = false;
    const planning = createRoutePlanning({ kept: undefined, taskId: 'task', log: () => {},
      planner: (_system, _input, signal) => new Promise(resolve => { signal.addEventListener('abort', () => { aborted = true; resolve(null); }); }) });
    planning.situate({ milestoneName: '木', elapsedSeconds: 5 }, {});
    const started = Date.now();
    await planning.close(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(aborted).toBe(true);
    expect(planning.checkpoint()).toEqual({ minecraftRouteAsks: 1 });
  });
  it('charges a request that got no answer at its upper bound', async () => {
    const charged: number[] = [];
    const planner = configuredMinecraftRoutePlanner({ SHANNON_MINECRAFT_ROUTE_PLAN: 'on' }, { recordUsage: usage => charged.push(usage.estimatedCostUsd),
      client: { messages: { create: async () => { throw new Error('network'); } } } })!;
    await expect(planner('s', 'i', new AbortController().signal)).rejects.toThrow('network');
    expect(charged).toHaveLength(1);
    expect(charged[0]).toBeGreaterThan(0);
  });
  it('charges the call as a decision is and returns the parsed answer; off by default', async () => {
    expect(configuredMinecraftRoutePlanner({ ANTHROPIC_API_KEY: 'key' }, { recordUsage: () => {} })).toBeUndefined();
    const charged: number[] = [];
    let sent: { model?: string } = {};
    const planner = configuredMinecraftRoutePlanner({ SHANNON_MINECRAFT_ROUTE_PLAN: 'on' }, { recordUsage: usage => charged.push(usage.estimatedCostUsd),
      client: { messages: { create: (async (body: { model: string }) => { sent = body; return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(answer) }],
        usage: { input_tokens: 3_000, output_tokens: 1_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }; }) as never } } })!;
    expect(await planner('system', 'input', new AbortController().signal)).toEqual(answer);
    expect(sent.model).toBe('claude-opus-5-5');
    expect(charged).toHaveLength(1);
    expect(charged[0]).toBeGreaterThan(0);
  });
});