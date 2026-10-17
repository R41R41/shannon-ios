import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { SkillMemory, fcaSkillTaskKey } from '../src/mind/memory/skillMemory.js';
import { SkillImporter, skillArtifactSha256 } from '../src/mind/memory/skillImport.js';
import { SKILL_CAPACITY, SKILL_GIST, skillGist } from '../src/mind/memory/skillDocument.js';
import { standardSkillPack } from '../src/infra/config/standardSkillPack.js';
import { bedSearchGivenUp, gistToolNames, minecraftSituation, minecraftSkillContext, minecraftSkillPointers, observeOnlyStep } from '../src/surfaces/minecraft/minecraftSkillPointers.js';
import { ADOPTIONS, adoptionTags, minecraftStage } from '../src/surfaces/minecraft/minecraftStage.js';
import { carriedItemCounts } from '../src/surfaces/minecraft/minecraftItems.js';
import { minecraftStage as loggedStage } from '../src/surfaces/minecraft/minecraftMilestoneLog.js';
import { createMinecraftTaskBody } from '../src/surfaces/minecraft/minecraftReflexAdapter.js';
import type { TaskRuntime, TaskStep } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import type { MinecraftControl } from '../src/surfaces/minecraft/minecraftControl.js';
import { inActionExecution } from '../src/infra/context/actionExecution.js';

/** Observation redesign P7 (owner 2026-10-17): stage pointers from what she carries, the bed gist without a window at stage 2. */
const BED = 'mc-bed-before-night', SCOUT = 'mc-opening-scout', IRON = 'mc-iron-and-bucket', TOOLCHAIN = 'mc-early-toolchain', PORTAL = 'mc-nether-portal';
const NAMES = new Set([BED, SCOUT, IRON, TOOLCHAIN, PORTAL, 'mc-night-retreat', 'mc-low-health', 'mc-food-and-pace', 'mc-nether-travel', 'mc-blaze-rods']);
const pointerOf = (skill: string) => minecraftSkillPointers(minecraftSituation(observation({ inventory: ['stone_pickaxe×1'] }), { failedStepsInARow: 0 }), new Set([skill]));
const calm = { failedStepsInARow: 0 };
const at = '2026-10-17T00:00:00.000Z';
const later = (minutes: number) => new Date(Date.parse(at) + minutes * 60_000).toISOString();
const pass = { carries: () => false };
const MORNING = { time: '100', margin: { darkInSeconds: 645 } }, NOON = { time: '6000', margin: { darkInSeconds: 350 } };
const STONE = ['oak_planks×4', 'stone_pickaxe×1'], BED_ITEM = 'white_bed×1';

/** The real frame's inventory: `{ name, count, durability? }` objects (body worldFrame.ts), never `name×count` strings. */
const stack = (item: string) => { const [name, count] = item.split('×'); return { name: name!, count: Number(count ?? 1), durability: 1 }; };
const framed = (world: Record<string, unknown>) => ({ ...world, ...(Array.isArray(world.inventory) ? { inventory: world.inventory.map(item => typeof item === 'string' ? stack(item) : item) } : {}) });
const counts = (...items: string[]) => carriedItemCounts({ inventory: items.map(stack) }, {});
const observation = (world: Record<string, unknown>, facts: Record<string, unknown> = {}): BodyObservation => ({ schemaVersion: 1, bodyId: 'minecraft:world',
  sequence: 1, stateAt: at, receivedAt: at, connected: true,
  state: { world: { dimension: 'overworld', health: 20, food: 20, time: '300', margin: { darkInSeconds: 635 }, inventory: [], nearbyThreats: [], ...framed(world) } },
  facts: { dimension: 'overworld', ...facts } } as unknown as BodyObservation);
const situation = (world: Record<string, unknown>, pace: Parameters<typeof minecraftSituation>[1] = calm) => minecraftSituation(observation(world), pace);
const pointers = (world: Record<string, unknown>, pace: Parameters<typeof minecraftSituation>[1] = calm, names: ReadonlySet<string> = NAMES) =>
  minecraftSkillPointers(situation(world, pace), names).map(line => line.split('（')[0]);

describe('the stage, from what she carries (stateless)', () => {
  it('is 1 without a stone pickaxe, 2 with one and no bed, 3 with a bed, 4 with an iron pickaxe or better (the real object frame)', () => {
    expect(minecraftStage(counts())).toBe(1);
    expect(minecraftStage(counts('oak_log×3', 'wooden_pickaxe×1', 'cobblestone×9'))).toBe(1);
    expect(minecraftStage(counts('stone_pickaxe×1'))).toBe(2);
    expect(minecraftStage(counts('stone_pickaxe×1', 'red_bed×1'))).toBe(3);
    expect(minecraftStage(counts('iron_pickaxe×1'))).toBe(4);
    expect(minecraftStage(counts('diamond_pickaxe×1', 'blue_bed×1'))).toBe(4);
    // An iron pickaxe is stage 4 whatever else is missing; a bed with no stone pickaxe is still stage 1.
    expect(minecraftStage(counts('netherite_pickaxe×1'))).toBe(4);
    expect(minecraftStage(counts('white_bed×1'))).toBe(1);
  });

  it('matches exact item ids: a golden pickaxe counts for nothing, bedrock and look-alike ids are no bed or pickaxe, underscore colours are beds', () => {
    expect(minecraftStage(counts('golden_pickaxe×1'))).toBe(1);
    expect(minecraftStage(counts('stone_pickaxe_head×1', 'wooden_pickaxe×1'))).toBe(1);
    expect(minecraftStage(counts('stone_pickaxe×1', 'bedrock×1'))).toBe(2);
    expect(minecraftStage(counts('stone_pickaxe×1', 'light_blue_bed×1'))).toBe(3);
    expect(minecraftStage(counts('stone_pickaxe×1', 'light_gray_bed×1'))).toBe(3);
    expect(minecraftStage(counts('stone_pickaxe×1', 'iron_pickaxe_broken×1'))).toBe(2);
    // A stack of zero is not carried.
    expect(minecraftStage(carriedItemCounts({ inventory: [{ name: 'stone_pickaxe', count: 0 }] }, {}))).toBe(1);
  });

  it('reads objects, name×count strings and slot facts alike, and is the very function the measurement logs use (one definition)', () => {
    const fromStrings = carriedItemCounts({ inventory: ['stone_pickaxe×1', 'red_bed×1'] }, {});
    expect(minecraftStage(fromStrings)).toBe(3);
    expect(minecraftStage(carriedItemCounts({ inventory: [] }, { 'slot:1': 'stone_pickaxe', 'slot:2': 'light_blue_bed' }))).toBe(3);
    expect(minecraftStage(carriedItemCounts({ inventory: { stone_pickaxe: 1 } }, {}))).toBe(2);
    expect(loggedStage).toBe(minecraftStage);
  });

  it('is read from the observation frame in the overworld only (null elsewhere)', () => {
    expect(situation({ inventory: ['stone_pickaxe×1'] }).stage).toBe(2);
    // The real frame's stacks (objects) are what the stage reads; before P7 only slot facts were read and the stage was almost always 1.
    expect(situation({ inventory: [{ name: 'stone_pickaxe', count: 1, durability: 0.9 }, { name: 'light_blue_bed', count: 1 }] }).stage).toBe(3);
    expect(minecraftSituation(observation({ inventory: [] }, { 'slot:1': 'stone_pickaxe', 'slot:2': 'red_bed' }), calm).stage).toBe(3);
    expect(minecraftSituation(observation({ dimension: 'the_nether', inventory: ['iron_pickaxe×1'] }, { dimension: 'the_nether' }), calm).stage).toBeNull();
    expect(minecraftSituation(null, calm).stage).toBeNull();
  });
});
describe('the stage pointers, in the calm slots after the safety ones', () => {
  it('points stage 1 at the early toolchain, stage 2 at the bed and the scout, stage 3 at iron, stage 4 at the Nether portal (by day)', () => {
    expect(pointers({ ...MORNING, inventory: ['oak_log×3'] })).toEqual([TOOLCHAIN]);
    expect(pointers({ ...NOON, inventory: STONE })).toEqual([BED, SCOUT]);
    expect(pointers({ ...NOON, inventory: [...STONE, BED_ITEM] })).toEqual([IRON]);
    expect(pointers({ ...NOON, inventory: ['iron_pickaxe×1', BED_ITEM] })).toEqual([PORTAL]);
    expect(pointers({ ...NOON, inventory: ['iron_pickaxe×1', BED_ITEM] }, { failedStepsInARow: 0, milestones: { netherReached: true } })).toEqual([]);
  });

  it('offers the bed at stage 2 by day with no window: the whole day, from the first minute, not only the last ten', () => {
    for (const day of [{ time: '0', margin: { darkInSeconds: 650 } }, MORNING, { time: '2000', margin: { darkInSeconds: 550 } }, NOON, { time: '11800', margin: { darkInSeconds: 61 } }]) {
      expect(pointers({ ...day, inventory: STONE })).toEqual([BED, SCOUT]);
    }
    // Without the stone pickaxe the old window still applies (the bed alone, only in the last ten minutes).
    expect(pointers({ ...MORNING, inventory: [] })).toEqual([TOOLCHAIN]);
    expect(pointers({ ...NOON, inventory: ['oak_log×3'] })).toEqual([BED, TOOLCHAIN]);
    expect(pointers({ time: '9000', margin: { darkInSeconds: 200 }, inventory: [] })).toEqual([BED, TOOLCHAIN]);
    // Even with no clock at all it is a day she can look in (nothing says it is dark).
    expect(pointers({ time: undefined, margin: undefined, inventory: STONE })).toEqual([BED, SCOUT]);
  });

  it('leaves the night, the last minute and a threat near to the night retreat alone (it stays exclusive)', () => {
    const retreat = ['mc-night-retreat'];
    expect(pointers({ time: '18000', margin: { darkInSeconds: 0 }, inventory: STONE })).toEqual(retreat);
    expect(pointers({ time: '11800', margin: { darkInSeconds: 60 }, inventory: STONE })).toEqual(retreat);
    expect(pointers({ time: '12500', margin: { darkInSeconds: 25 }, inventory: [] })).toEqual(retreat);
    expect(pointers({ ...NOON, inventory: STONE, nearbyThreats: [{ name: 'zombie', distance: 8 }] })).toEqual(retreat);
    expect(pointers({ ...NOON, inventory: [...STONE, BED_ITEM], nearbyThreats: [{ name: 'creeper', distance: 5 }] })).toEqual(retreat);
    expect(pointers({ time: '18000', margin: { darkInSeconds: 0 }, inventory: ['oak_log×1'] })).toEqual(retreat);
  });

  it('keeps the safety pointers first and the three-slot limit in a fixed order', () => {
    expect(pointers({ ...NOON, inventory: STONE, health: 6 })).toEqual(['mc-low-health', BED, SCOUT]);
    expect(pointers({ ...NOON, inventory: STONE, health: 6, food: 3 })).toEqual(['mc-low-health', BED, 'mc-food-and-pace']);
    expect(pointers({ ...NOON, inventory: STONE }, { failedStepsInARow: 4 })).toEqual([BED, 'mc-food-and-pace', SCOUT]);
    expect(pointers({ ...NOON, inventory: [...STONE, BED_ITEM], food: 3 })).toEqual(['mc-food-and-pace', IRON]);
    expect(pointers({ ...MORNING, inventory: ['oak_log×1'], health: 6, food: 2 })).toEqual(['mc-low-health', 'mc-food-and-pace', TOOLCHAIN]);
    // In the Nether the stage pointers are none, the Nether ones stay.
    expect(pointers({ dimension: 'the_nether', inventory: ['iron_pickaxe×1'] }, calm, NAMES)).toEqual(['mc-nether-travel']);
    expect(pointers({ dimension: 'the_nether', inventory: STONE, nearbyThreats: [] }, calm, NAMES)).toEqual(['mc-nether-travel']);
  });

  it('names only the skills she can read now (before the import: no pointer, no gist)', () => {
    expect(pointers({ ...NOON, inventory: STONE }, calm, new Set(['mc-night-retreat', 'mc-low-health']))).toEqual([]);
    expect(pointers({ ...NOON, inventory: STONE }, calm, new Set([SCOUT]))).toEqual([SCOUT]);
    const context = minecraftSkillContext(situation({ ...NOON, inventory: STONE }), NAMES, names => new Map(names.map(name => [name, [`2. ${name}`]] as const)));
    expect(context.pointed).toEqual([BED, SCOUT]);
    expect(context.fields.skillGists?.map(gist => gist.skill)).toEqual([BED, SCOUT]);
    expect(minecraftSkillContext(situation({ ...NOON, inventory: STONE }), new Set()).pointed).toEqual([]);
  });
});

describe('the no-sheep mark keeps working at stage 2 through the whole day', () => {
  const dusk = (seconds: number, world: Record<string, unknown> = {}) => observation({ time: String(13_000 - seconds * 20), margin: { darkInSeconds: seconds }, inventory: STONE, ...world });
  const offered = (seconds: number, noSheepDarkIn?: number) =>
    minecraftSkillPointers(minecraftSituation(dusk(seconds), { ...calm, ...(noSheepDarkIn === undefined ? {} : { noSheepDarkIn }) }), NAMES).map(line => line.split('（')[0]);

  it('drops the bed (not the scout) for the rest of the day once her sheep search found none, and brings it back the next morning', () => {
    expect(offered(640)).toEqual([BED, SCOUT]);
    const mark = bedSearchGivenUp(dusk(640));
    expect(mark).toBe(640);
    expect(offered(640, mark)).toEqual([SCOUT]);
    expect(offered(300, mark)).toEqual([SCOUT]);
    expect(offered(90, mark)).toEqual([SCOUT]);
    // The next morning (the countdown rises above the mark; a full day is 650 s) the mark is cleared by the body task's own rule.
    expect(offered(650, undefined)).toEqual([BED, SCOUT]);
  });

  it('is the same mark at dusk as before: a search in the last ten minutes closes the window for the day', () => {
    const mark = bedSearchGivenUp(dusk(400));
    expect(mark).toBe(400);
    expect(offered(400, mark)).toEqual([SCOUT]);
    expect(offered(120, mark)).toEqual([SCOUT]);
  });
});

describe('what counts as acting on a pointed skill (tool and argument), content-free', () => {
  const tags = (pointed: string[], name: string, input: unknown) => adoptionTags(pointed, { name, input }).map(item => `${item.skill}:${item.tag}`);

  it('matches the calls of each stage by tool and argument, only for a skill that was pointed', () => {
    expect(tags([BED, SCOUT], 'mc.find-nearest-entity', { entityType: 'Sheep' })).toEqual([`${BED}:sheep_search`, `${SCOUT}:sheep_search`]);
    expect(tags([SCOUT], 'mc.find-nearest-entity', { entityType: 'sheep' })).toEqual([`${SCOUT}:sheep_search`]);
    expect(tags([IRON], 'mc.find-nearest-entity', { entityType: 'sheep' })).toEqual([]);
    expect(tags([SCOUT], 'mc.find-nearest-entity', { entityType: 'cow' })).toEqual([]);
    expect(tags([SCOUT], 'mc.recall-places', { kind: 'village' })).toEqual([`${SCOUT}:village_check`]);
    expect(tags([SCOUT], 'mc.recall-places', { kind: 'water' })).toEqual([]);
    expect(tags([SCOUT], 'mc.find-structure', { structureType: 'village' })).toEqual([`${SCOUT}:village_check`]);
    expect(tags([SCOUT], 'mc.explore-for-structure', { structureType: 'village', direction: 'north' })).toEqual([`${SCOUT}:village_check`]);
    expect(tags([SCOUT], 'mc.explore-for-structure', { structureType: 'fortress' })).toEqual([]);
    expect(tags([SCOUT], 'mc.attack-continuously', { entityName: 'cow' })).toEqual([`${SCOUT}:food_hunt`]);
    expect(tags([BED], 'mc.attack-continuously', { entityName: 'sheep' })).toEqual([`${BED}:sheep_hunt`]);
    expect(tags([BED], 'mc.attack-continuously', { entityName: 'zombie' })).toEqual([]);
    expect(tags([BED], 'mc.craft-one', { itemName: 'white_bed' })).toEqual([`${BED}:bed_craft`]);
    expect(tags([BED], 'mc.craft-one', { itemName: 'oak_planks' })).toEqual([]);
    expect(tags([BED], 'mc.sleep-in-bed', {})).toEqual([`${BED}:bed_sleep`]);
    expect(tags([IRON], 'mc.mine-block', { blockName: 'deepslate_iron_ore', count: 3 })).toEqual([`${IRON}:iron_mine`]);
    expect(tags([IRON], 'mc.mine-block', { blockName: 'stone' })).toEqual([]);
    expect(tags([IRON], 'mc.find-blocks', { blockName: 'iron_ore' })).toEqual([`${IRON}:iron_find`]);
    expect(tags([IRON], 'mc.start-smelting', { inputItem: 'raw_iron', fuelItem: 'coal', x: 1, y: 2, z: 3 })).toEqual([`${IRON}:iron_smelt`]);
    expect(tags([IRON], 'mc.craft-one', { itemName: 'bucket' })).toEqual([`${IRON}:iron_tool_craft`]);
    expect(tags([IRON], 'mc.craft-one', { itemName: 'iron_pickaxe' })).toEqual([`${IRON}:iron_tool_craft`]);
    expect(tags([IRON], 'mc.craft-one', { itemName: 'iron_chestplate' })).toEqual([`${IRON}:iron_armor_craft`]);
    expect(tags([TOOLCHAIN], 'mc.mine-block', { blockName: 'oak_log' })).toEqual([`${TOOLCHAIN}:wood_gather`]);
    expect(tags([TOOLCHAIN], 'mc.craft-one', { itemName: 'stone_pickaxe' })).toEqual([`${TOOLCHAIN}:tool_craft`]);
    expect(tags([TOOLCHAIN], 'mc.mine-block', { blockName: 'cobblestone' })).toEqual([`${TOOLCHAIN}:stone_mine`]);
    expect(tags([PORTAL], 'mc.build-structure', { structureName: 'nether_portal' })).toEqual([`${PORTAL}:portal_build`]);
    expect(tags([PORTAL], 'mc.mine-block', { blockName: 'obsidian' })).toEqual([`${PORTAL}:obsidian_mine`]);
    expect(tags([PORTAL], 'mc.find-blocks', { blockName: 'lava' })).toEqual([`${PORTAL}:lava_find`]);
    expect(tags([PORTAL], 'mc.enter-portal', {})).toEqual([`${PORTAL}:portal_enter`]);
    expect(tags([PORTAL], 'mc.use-item-on-block', { x: 1, y: 2, z: 3, itemName: 'lava_bucket' })).toEqual([`${PORTAL}:lava_pour`]);
    expect(tags([PORTAL], 'mc.use-item-on-block', { x: 1, y: 2, z: 3, itemName: 'water_bucket' })).toEqual([`${PORTAL}:water_pour`]);
    expect(tags([PORTAL], 'mc.use-item-on-block', { x: 1, y: 2, z: 3, itemName: 'bucket' })).toEqual([]);
  });

  it('never throws on odd input, matches by exact tool name, and no skill pointed means no match', () => {
    for (const input of [null, undefined, 'sheep', 7, [], { entityType: 5 }, { entityType: ['sheep'] }]) {
      expect(() => adoptionTags(NAMES as unknown as string[], { name: 'mc.find-nearest-entity', input })).not.toThrow();
    }
    expect(tags([BED], 'mc.find-nearest-entity', 'sheep')).toEqual([]);
    expect(tags([BED], 'find-nearest-entity', { entityType: 'sheep' })).toEqual([]);
    expect(tags([], 'mc.sleep-in-bed', {})).toEqual([]);
    // The table is closed: unique tags per skill, each tag a plain lower-case word (it goes to the journal as it is).
    expect(ADOPTIONS.every(adoption => /^[a-z_]+$/u.test(adoption.tag))).toBe(true);
    expect(new Set(ADOPTIONS.map(adoption => adoption.tag)).size).toBe(ADOPTIONS.length);
  });
});

describe('the body task logs an adoption line while a stage skill is pointed (tool name and closed tags only)', () => {
  it('logs the stage, the skill, the tag and the tool for a matching call, and nothing for a call that matches nothing', async () => {
    const tools = [{ name: 'mine-block', readOnly: false }, { name: 'find-blocks', readOnly: true }];
    const world = observation({ ...NOON, inventory: [...STONE, BED_ITEM] });
    const control = { store: { body: () => 'minecraft:home', bind: () => true, safe: () => true }, available: () => ['minecraft:home'],
      frame: () => ({ poll: { skills: tools } }), observe: () => world, imagesUnavailable: () => false, settling: () => false, cancelTask() {} } as unknown as MinecraftControl;
    const step = { id: 'step', scopeKey: 'owner', taskId: 'task-iron', revision: 1, lease: { id: 'lease', holder: 'h', generation: 1 },
      snapshot: { task: { createdAt: at, summary: '' }, checkpoint: { consecutiveToolFailures: 0 }, history: [], sources: [] } } as unknown as TaskStep;
    const lines: string[] = [];
    const made = createMinecraftTaskBody({ control, runtime: { get: () => ({ phase: 'executing' }) } as unknown as TaskRuntime, step, entry: null, selector: null,
      ownerAlone: () => true, sourcesVisible: () => true, skillNames: () => NAMES, log: line => lines.push(line) });
    const lease = { id: 'lease', holder: 'h', generation: 1 }, abort = new AbortController();
    await inActionExecution({ lease, signal: abort.signal, permit: async () => true } as never, async () => {
      made.body.start(abort.signal);
      const context = made.body.context() as { skillPointers?: string[] };
      expect(context.skillPointers).toEqual([`${IRON}（ベッドがあり鉄のツルハシがまだ無い）`]);
      made.body.noteCall!({ id: 'a', name: 'mc.mine-block', input: { blockName: 'iron_ore', count: 3 } }, 'op-a');
      made.body.noteCall!({ id: 'b', name: 'mc.mine-block', input: { blockName: 'dirt' } }, 'op-b');
      made.body.noteCall!({ id: 'c', name: 'mc.find-blocks', input: { blockName: 'iron_ore' } }, 'op-c');
    });
    expect(lines.filter(line => line.includes('stage adoption'))).toEqual([
      `Shannon Minecraft stage adoption task=task-iron stage=3 skill=${IRON} tag=iron_mine tool=mc.mine-block`,
      `Shannon Minecraft stage adoption task=task-iron stage=3 skill=${IRON} tag=iron_find tool=mc.find-blocks`,
    ]);
    // Content-free: no argument value reaches the journal.
    expect(lines.join('\n')).not.toMatch(/iron_ore|dirt|count/u);
  });
});

describe('the new and rewritten skills of draft-4 and draft-5', () => {
  /** The body catalog's own tool names (`backend/src/services/minebot/instantSkills`, skillName): a skill may name only these as `mc.`. */
  const REAL_TOOLS = new Set(['mc.find-nearest-entity', 'mc.find-structure', 'mc.recall-places', 'mc.explore-for-structure', 'mc.craft-one', 'mc.sleep-in-bed',
    'mc.attack-continuously', 'mc.find-blocks', 'mc.mine-block', 'mc.start-smelting', 'mc.build-structure', 'mc.enter-portal', 'mc.place-block-at', 'mc.use-item-on-block']);
  const body = (revision: 'draft-4' | 'draft-5', name: string) => standardSkillPack('legacy-minecraft', revision)!.skills.find(entry => entry.name === name)!.body;
  const gistOf = (revision: 'draft-4' | 'draft-5', name: string) => skillGist(body(revision, name), observeOnlyStep);
  const sound = (gist: string[]) => gist.length === SKILL_GIST.lines && gist.every(line => [...line].length <= SKILL_GIST.width && !line.endsWith('…'));

  it.each([['draft-4', SCOUT], ['draft-4', IRON], ['draft-4', BED], ['draft-5', PORTAL]] as const)('%s %s: a gist of three whole lines within 90 characters, real tools only, no coordinates', (revision, name) => {
    const text = body(revision, name), gist = gistOf(revision, name);
    expect(sound(gist)).toBe(true);
    expect(gist.join('')).not.toContain('minecraft.observe');
    expect([...text.matchAll(/mc\.[a-z-]+/gu)].every(match => REAL_TOOLS.has(match[0]))).toBe(true);
    expect([...gistToolNames(gist)].every(tool => REAL_TOOLS.has(tool))).toBe(true);
    expect(text).not.toMatch(/-?\d+\s*,\s*-?\d+\s*,\s*-?\d+/u);
    // The import's own tool check reads these prefixes in the body: none may appear undeclared (only minecraft.observe is declared).
    expect([...text.matchAll(/\b(?:study|folder|aether|aetherFolder|ownerDocs|notion|voyager|schedule|places|web|task|memory|skill|minecraft)\.[a-z][a-zA-Z0-9_]*/gu)].map(match => match[0]).filter(tool => tool !== 'minecraft.observe')).toEqual([]);
  });

  it('mc-opening-scout: biome and animals to sheep and village likelihood, then the village check, then bed or food and iron', () => {
    const gist = gistOf('draft-4', SCOUT);
    expect(gist[0]).toMatch(/biome.*羊と村の見込み.*mc\.find-nearest-entity（sheep）/u);
    expect(gist[1]).toMatch(/村は mc\.recall-places か mc\.find-structure.*食料を集めつつ mc\.explore-for-structure（village）/u);
    expect(gist[2]).toMatch(/羊か村が見つかればベッドへ（mc-bed-before-night）.*食料を確保して鉄へ/u);
  });

  it('mc-iron-and-bucket: mine iron once fed, pickaxe 3 then bucket 3 then armour, no waiting at the furnace, another layer, no repeated failure', () => {
    const gist = gistOf('draft-4', IRON);
    expect(gist[0]).toMatch(/食料が足りたら鉄.*mc\.find-blocks.*mc\.mine-block.*つるはし3→バケツ3→防具/u);
    expect(gist[1]).toMatch(/mc\.start-smelting.*炉の前で待たない.*石炭と食料/u);
    expect(gist[2]).toMatch(/鉄が足りなくなったら mc\.find-blocks で別の層.*同じ場所の失敗を繰り返さない/u);
  });

  it('mc-nether-portal (draft-5): the lava pool, the obsidian and the portal are the three lines of the gist; iron comes after', () => {
    const gist = gistOf('draft-5', PORTAL);
    // Obsidian is mined with a diamond pickaxe only: the stage-4 (iron pickaxe) gist casts the frame in place and never says to mine it.
    expect(gist[0]).toMatch(/黒曜石は diamond_pickaxe でしか掘れない.*枠の型に溶岩を注ぎ.*水で固めて.*鋳造/u);
    expect(gist[1]).toMatch(/mc\.place-block-at.*mc\.use-item-on-block（lava_bucket）.*water_bucket/u);
    expect(gist[2]).toMatch(/着火.*mc\.enter-portal.*mc\.build-structure/u);
    expect(gist.join('')).not.toMatch(/黒曜石を掘|掘って/u);
    expect(gist.join('')).not.toContain('鉄');
    expect(body('draft-5', PORTAL).indexOf('鉄は先に')).toBeGreaterThan(body('draft-5', PORTAL).indexOf('mc.enter-portal'));
    expect(body('draft-5', PORTAL)).toContain('diamond_pickaxe');
    // The draft-2 text is the revision's base, and nothing the old text carried is lost but the order.
    const previous = standardSkillPack('legacy-minecraft', 'draft-2')!.skills.find(entry => entry.name === PORTAL)!;
    expect(standardSkillPack('legacy-minecraft', 'draft-5')!.skills[0]!.revises).toEqual({ bodySha256: previous.sha256 });
    expect(skillArtifactSha256(previous.body)).toBe(previous.sha256);
    for (const phrase of ['盾（板6＋鉄1）', 'バケツ（鉄3', '丸石を多め', 'ハーフブロック', 'ポータル面', '掘って10個集め']) expect(body('draft-5', PORTAL)).toContain(phrase);
  });

  const fresh = () => {
    const memory = new SkillMemory({ database: new DatabaseSync(':memory:'), createsSchema: true, defer: task => task(), log: () => {} });
    const importer = new SkillImporter({ memory, ownerScopeKey: 'owner', check: () => pass, tools: () => [] });
    const apply = (revision: 'draft-1' | 'draft-2' | 'draft-3' | 'draft-4' | 'draft-5', when: string) => {
      const next = standardSkillPack('legacy-minecraft', revision)!;
      return importer.apply('owner', next, { planHash: importer.dryRun('owner', next).planHash, approvalReference: 'owner-form-20261017' }, when);
    };
    apply('draft-1', at); apply('draft-2', later(1)); apply('draft-3', later(2));
    return { memory, importer, apply };
  };

  it('draft-5 imports after draft-4 (or before it) as one revision: problems empty, no capacity, the base exactly the imported draft-2 body', () => {
    for (const order of [['draft-4', 'draft-5'], ['draft-5', 'draft-4']] as const) {
      const { memory, importer, apply } = fresh();
      const retreat = memory.store.byName('owner', 'mc-night-retreat')!, portal = memory.store.byName('owner', PORTAL)!;
      const plan = importer.dryRun('owner', standardSkillPack('legacy-minecraft', order[0])!);
      expect(plan.problems).toEqual([]);
      expect(apply(order[0], later(3))).toHaveProperty('receipt');
      const second = importer.dryRun('owner', standardSkillPack('legacy-minecraft', order[1])!);
      expect(second.problems).toEqual([]);
      expect(second.capacity.added).toBe(order[1] === 'draft-5' ? 0 : 2);
      expect(apply(order[1], later(4))).toHaveProperty('receipt');
      const revised = memory.store.byName('owner', PORTAL)!;
      expect(revised.version).toBe(portal.version + 1);
      expect(skillArtifactSha256(revised.body)).toBe(standardSkillPack('legacy-minecraft', 'draft-5')!.skills[0]!.sha256);
      expect(memory.store.byName('owner', 'mc-night-retreat')).toMatchObject({ version: retreat.version, body: retreat.body });
      expect(memory.store.byName('owner', BED)!.version).toBeGreaterThan(1);
      expect(memory.index('owner').split('\n').filter(line => line.includes(PORTAL))).toHaveLength(1);
    }
  });

  it('draft-5 alone stops with on_trial when the Nether skill has been used, and then draft-4 is not affected', () => {
    const { memory, importer, apply } = fresh();
    memory.usedInTask('owner', fcaSkillTaskKey('task-portal'), PORTAL, later(3), 'gist');
    expect(importer.dryRun('owner', standardSkillPack('legacy-minecraft', 'draft-5')!).problems).toEqual([{ name: PORTAL, code: 'on_trial' }]);
    expect(importer.dryRun('owner', standardSkillPack('legacy-minecraft', 'draft-4')!).problems).toEqual([]);
    expect(apply('draft-4', later(4))).toHaveProperty('receipt');
    expect(SKILL_CAPACITY).toBe(25);
  });

  it('the stage pointer is to a skill she can read: pointed only after draft-4 has put the two new skills in her index', () => {
    const { memory, apply } = fresh();
    const names = () => new Set([...memory.index('owner').matchAll(/^- ([a-z0-9][a-z0-9-]*)（/gmu)].map(match => match[1]!));
    expect(pointerOf(SCOUT).length).toBe(1);
    expect(minecraftSkillPointers(situation({ ...NOON, inventory: STONE }), names())).toEqual(expect.not.arrayContaining([expect.stringContaining(SCOUT)]));
    apply('draft-4', later(3));
    expect(minecraftSkillPointers(situation({ ...NOON, inventory: STONE }), names()).map(line => line.split('（')[0])).toEqual([BED, SCOUT]);
  });
});
