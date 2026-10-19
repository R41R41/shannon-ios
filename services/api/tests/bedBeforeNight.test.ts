import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { SkillMemory, fcaSkillTaskKey } from '../src/mind/memory/skillMemory.js';
import { SkillImporter, skillArtifactSha256 } from '../src/mind/memory/skillImport.js';
import type { SkillPack } from '../src/mind/memory/skillImportContract.js';
import { SKILL_GIST, SKILL_CAPACITY, skillGist } from '../src/mind/memory/skillDocument.js';
import { standardSkillPack } from '../src/infra/config/standardSkillPack.js';
import { GENERIC_BODY_TOOLS, bedSearchGivenUp, bedSearchMark, gistToolNames, minecraftSituation, minecraftSkillPointers, noSheepNearby, observeOnlyStep } from '../src/surfaces/minecraft/minecraftSkillPointers.js';
import { createMinecraftTaskBody } from '../src/surfaces/minecraft/minecraftReflexAdapter.js';
import type { TaskRuntime, TaskStep } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import type { MinecraftControl } from '../src/surfaces/minecraft/minecraftControl.js';
import { inActionExecution } from '../src/infra/context/actionExecution.js';

/** Owner 2026-10-17: before night she secures a bed, as knowledge she judges with (`mc-bed-before-night`), not behaviour code. */
const BED = 'mc-bed-before-night';
const BED_POINTER = [`${BED}（日暮れまでにベッドが要る）`];
const RETREAT_POINTER = 'mc-night-retreat（夜・暗くなる直前・敵が近い）';
const NAMES = new Set([BED, 'mc-night-retreat', 'mc-low-health', 'mc-food-and-pace', 'mc-nether-portal', 'mc-nether-travel', 'mc-blaze-rods']);
const calm = { failedStepsInARow: 0 };
const at = '2026-10-17T00:00:00.000Z';
const later = (minutes: number) => new Date(Date.parse(at) + minutes * 60_000).toISOString();
const pass = { carries: () => false };

/** The real frame's inventory: `{ name, count, durability? }` objects (body worldFrame.ts), never `name×count` strings. */
const stack = (item: string) => { const [name, count] = item.split('×'); return { name: name!, count: Number(count ?? 1), durability: 1 }; };
const framed = (world: Record<string, unknown>) => ({ ...world, ...(Array.isArray(world.inventory) ? { inventory: world.inventory.map(item => typeof item === 'string' ? stack(item) : item) } : {}) });
const observation = (world: Record<string, unknown>, facts: Record<string, unknown> = {}): BodyObservation => ({ schemaVersion: 1, bodyId: 'minecraft:world',
  sequence: 1, stateAt: at, receivedAt: at, connected: true,
  state: { world: { dimension: 'overworld', health: 20, food: 20, time: '300', margin: { darkInSeconds: 635 }, inventory: [], nearbyThreats: [], ...framed(world) } },
  facts: { dimension: 'overworld', ...facts } } as unknown as BodyObservation);
const pointers = (world: Record<string, unknown>, facts: Record<string, unknown> = {}, names: ReadonlySet<string> = NAMES) =>
  minecraftSkillPointers(minecraftSituation(observation(world, facts), calm), names);

describe('the bed pointer (when dusk is near and she carries no bed)', () => {
  it('fires between ten minutes and one minute before dark without a bed, and not earlier in the day', () => {
    expect(pointers({})).toEqual([]);
    expect(pointers({ time: '900', margin: { darkInSeconds: 601 } })).toEqual([]);
    expect(pointers({ time: '1000', margin: { darkInSeconds: 600 } })).toEqual(BED_POINTER);
    expect(pointers({ time: '7000', margin: { darkInSeconds: 300 } })).toEqual(BED_POINTER);
    expect(pointers({ time: '9000', margin: { darkInSeconds: 200 } })).toEqual(BED_POINTER);
    expect(pointers({ time: '11700', margin: { darkInSeconds: 61 } })).toEqual(BED_POINTER);
    // Without the body's margin the time of day gives the same window.
    expect(pointers({ time: '9000', margin: undefined })).toEqual(BED_POINTER);
    expect(pointers({ time: '1000', margin: undefined })).toEqual(BED_POINTER);
    expect(pointers({ time: '900', margin: undefined })).toEqual([]);
  });

  it('reads the real frame: { name, count } stacks and name×count strings say she carries a bed (any colour, even light_blue); a stack of 0 and bedrock do not', () => {
    const dusk = { time: '9000', margin: { darkInSeconds: 200 } };
    expect(pointers({ ...dusk, inventory: [{ name: 'light_blue_bed', count: 1, durability: 1 }] })).toEqual([]);
    expect(pointers({ ...dusk, inventory: [{ name: 'light_gray_bed', count: 1 }] })).toEqual([]);
    expect(pointers({ ...dusk, inventory: [{ name: 'red_bed', count: 0 }] })).toEqual(BED_POINTER);
    expect(pointers({ ...dusk, inventory: [{ name: 'bedrock', count: 1 }, { name: 'white_wool', count: 3 }] })).toEqual(BED_POINTER);
    // The string form is still read (an older body or a fixture).
    expect(minecraftSkillPointers(minecraftSituation(observation({ ...dusk }), calm), NAMES)).toEqual(BED_POINTER);
    const strings = { ...observation(dusk), state: { world: { ...(observation(dusk).state.world as object), inventory: ['light_blue_bed×1'] } } } as BodyObservation;
    expect(minecraftSkillPointers(minecraftSituation(strings, calm), NAMES)).toEqual([]);
  });

  it('does not fire when she has a bed (any colour, in the inventory or a slot fact), and bedrock is not a bed', () => {
    const dusk = { time: '9000', margin: { darkInSeconds: 200 } };
    expect(pointers({ ...dusk, inventory: ['white_bed×1'] })).toEqual([]);
    expect(pointers({ ...dusk, inventory: ['oak_planks×4', 'red_bed'] })).toEqual([]);
    expect(pointers(dusk, { 'slot:3': 'blue_bed' })).toEqual([]);
    expect(pointers({ ...dusk, inventory: ['bedrock×1', 'white_wool×3'] })).toEqual(BED_POINTER);
  });

  it('hands over to the night retreat: never both for one dusk, and the retreat alone after dark, in the last minute or with a threat near', () => {
    expect(pointers({ time: '11800', margin: { darkInSeconds: 60 } })).toEqual([RETREAT_POINTER]);
    expect(pointers({ time: '12500', margin: { darkInSeconds: 25 } })).toEqual([RETREAT_POINTER]);
    expect(pointers({ time: '18000', margin: { darkInSeconds: 0 } })).toEqual([RETREAT_POINTER]);
    expect(pointers({ time: '9000', margin: { darkInSeconds: 200 }, nearbyThreats: [{ name: 'zombie', distance: 8 }] })).toEqual([RETREAT_POINTER]);
    // Only the overworld has a day to find a bed in.
    expect(pointers({ dimension: 'the_nether', time: '9000', margin: { darkInSeconds: 200 } }, { dimension: 'the_nether' }, new Set([BED]))).toEqual([]);
  });

  it('comes after low health and before the Nether path, and is named only when she can read it (before the import: no pointer)', () => {
    const dusk = { time: '9000', margin: { darkInSeconds: 200 } };
    expect(pointers({ ...dusk, health: 6, inventory: ['iron_pickaxe×1', 'bucket×1', 'iron_chestplate×1'] })).toEqual(['mc-low-health（体力が半分以下）', ...BED_POINTER,
      'mc-nether-portal（鉄のツルハシ・バケツ・胸当てがありネザーへ向かう前）']);
    expect(pointers(dusk, {}, new Set(['mc-night-retreat', 'mc-low-health']))).toEqual([]);
  });
});

describe('the skill (legacy-minecraft draft-3), as the import consumes it', () => {
  const pack = () => standardSkillPack('legacy-minecraft', 'draft-3')!;
  const body = () => pack().skills.find(entry => entry.name === BED)!.body;
  /** The body catalog's own tool names (`backend/src/services/minebot/instantSkills`, skillName): the gist may name only these. */
  const REAL_TOOLS = new Set(['mc.find-nearest-entity', 'mc.explore-for-structure', 'mc.craft-one', 'mc.sleep-in-bed', 'mc.attack-continuously']);

  it('is one new skill with an exact hash, no revision and no coordinates', () => {
    expect(pack().skills.map(entry => entry.name)).toEqual([BED]);
    expect(skillArtifactSha256(body())).toBe(pack().skills[0]!.sha256);
    expect(pack().skills[0]).not.toHaveProperty('revises');
    expect(body()).toContain('旧Minebot実験');
    expect(body()).not.toMatch(/-?\d+\s*,\s*-?\d+\s*,\s*-?\d+/u);
  });

  it('has a gist of three lines within 90 characters, none cut, naming real body tools and the night retreat by skill name', () => {
    const gist = skillGist(body(), observeOnlyStep);
    expect(gist).toHaveLength(SKILL_GIST.lines);
    expect(gist.map(line => line.slice(0, 2))).toEqual(['2.', '3.', '4.']);
    expect(gist.every(line => [...line].length <= SKILL_GIST.width && !line.endsWith('…'))).toBe(true);
    expect(gist.join('')).not.toContain('minecraft.observe');
    const named = [...gistToolNames(gist)];
    expect(named.sort()).toEqual(['mc.explore-for-structure', 'mc.find-nearest-entity', 'mc.sleep-in-bed']);
    expect(named.every(name => REAL_TOOLS.has(name) && !GENERIC_BODY_TOOLS.has(name))).toBe(true);
    // Every `mc.` tool the whole skill names is a real one; the fallback is named as a skill, which is no tool.
    expect([...body().matchAll(/mc\.[a-z-]+/gu)].every(match => REAL_TOOLS.has(match[0]))).toBe(true);
    expect(gist.join('')).toContain('mc-night-retreat');
    expect(gist.join('')).toContain('sheep');
    expect(gist.join('')).toContain('village');
  });

  it('imports after draft-1 and draft-2 as one new trial of the legacy pack, leaving the night retreat as it is', () => {
    const memory = new SkillMemory({ database: new DatabaseSync(':memory:'), createsSchema: true, defer: task => task(), log: () => {} });
    const importer = new SkillImporter({ memory, ownerScopeKey: 'owner', check: () => pass, tools: () => [] });
    const apply = (revision: 'draft-1' | 'draft-2' | 'draft-3', when: string) => {
      const next = standardSkillPack('legacy-minecraft', revision)!;
      return importer.apply('owner', next, { planHash: importer.dryRun('owner', next).planHash, approvalReference: 'owner-form-20261017' }, when);
    };
    apply('draft-1', at); apply('draft-2', later(1));
    const plan = importer.dryRun('owner', pack());
    expect(plan.problems).toEqual([]);
    expect(plan.capacity).toEqual({ used: 9, added: 1, limit: SKILL_CAPACITY });
    const retreat = memory.store.byName('owner', 'mc-night-retreat')!;
    expect(apply('draft-3', later(2))).toHaveProperty('receipt');
    expect(memory.store.byName('owner', BED)).toMatchObject({ status: 'trial', madeBy: 'operator_authored', uses: [], successes: 0,
      provenance: { packId: 'legacy-minecraft', packRevision: 'draft-3' } });
    expect(memory.store.byName('owner', 'mc-night-retreat')).toMatchObject({ version: retreat.version, body: retreat.body });
    expect(memory.index('owner')).toContain(BED);
    // A pointer is only to a skill in the index, and a followed gist of it is a use of this trial.
    expect(memory.usedInTask('owner', fcaSkillTaskKey('task-bed'), BED, later(3), 'gist')).toEqual(expect.stringMatching(/^skill_/u));
    expect(memory.store.byName('owner', BED)!.uses).toMatchObject([{ k: 'gist' }]);
  });
});

describe('a call of a bed tool while its gist is shown records the follow (not excluded as generic)', () => {
  it('records mc.explore-for-structure and mc.sleep-in-bed; mc.find-nearest-entity (read-only) and mc.craft-one (generic) are not', async () => {
    const gist = skillGist(standardSkillPack('legacy-minecraft', 'draft-3')!.skills[0]!.body, observeOnlyStep);
    const tools = [{ name: 'find-nearest-entity', readOnly: true }, { name: 'explore-for-structure', readOnly: false }, { name: 'craft-one', readOnly: false },
      { name: 'sleep-in-bed', readOnly: false }];
    const dusk = observation({ time: '9000', margin: { darkInSeconds: 200 } });
    const control = { store: { body: () => 'minecraft:home', bind: () => true, safe: () => true }, available: () => ['minecraft:home'],
      frame: () => ({ poll: { skills: tools } }), observe: () => dusk, imagesUnavailable: () => false, settling: () => false, cancelTask() {} } as unknown as MinecraftControl;
    const step = { id: 'step', scopeKey: 'owner', taskId: 'task-bed', revision: 1, lease: { id: 'lease', holder: 'h', generation: 1 },
      snapshot: { task: { createdAt: at, summary: '' }, checkpoint: { consecutiveToolFailures: 0 }, history: [], sources: [] } } as unknown as TaskStep;
    const followed: string[] = [], lines: string[] = [];
    const made = createMinecraftTaskBody({ control, runtime: { get: () => ({ phase: 'executing' }) } as unknown as TaskRuntime, step, entry: null, selector: null,
      ownerAlone: () => true, sourcesVisible: () => true, skillNames: () => new Set([BED]), log: line => lines.push(line),
      skillGists: names => new Map(names.map(name => [name, gist] as const)), gistFollowed: name => followed.push(name) });
    // A live body task: its lease is the running execution's (the body reads the observation only while it is live).
    const lease = { id: 'lease', holder: 'h', generation: 1 }, abort = new AbortController();
    await inActionExecution({ lease, signal: abort.signal, permit: async () => true } as never, async () => {
      made.body.start(abort.signal);
      const context = made.body.context() as { skillPointers?: string[]; skillGists?: Array<{ skill: string }> };
      expect(context.skillPointers).toEqual(BED_POINTER);
      expect(context.skillGists?.map(item => item.skill)).toEqual([BED]);
      for (const name of ['mc.find-nearest-entity', 'mc.craft-one', 'mc.explore-for-structure', 'mc.sleep-in-bed']) made.body.noteCall!({ id: name, name, input: {} }, `op-${name}`);
    });
    expect(lines.filter(line => line.includes('gist follow')).map(line => line.replace(/^Shannon Minecraft gist follow task=task-bed /u, ''))).toEqual([
      'tool=mc.find-nearest-entity branch=read_only skills=-',
      'tool=mc.craft-one branch=generic_tool skills=-',
      `tool=mc.explore-for-structure branch=recorded skills=${BED}`,
      `tool=mc.sleep-in-bed branch=recorded skills=${BED}`,
    ]);
    expect(followed).toEqual([BED, BED]);
    // The content-free adoption line: only the call that matches what the pointed skill is about (the sleep), with a closed tag.
    expect(lines.filter(line => line.includes('stage adoption'))).toEqual([
      `Shannon Minecraft stage adoption task=task-bed stage=1 skill=${BED} tag=bed_sleep tool=mc.sleep-in-bed`]);
  });
});

describe('after her sheep search found none, the bed is not offered again that day', () => {
  const none = { ok: true, text: '64ブロック以内にsheepタイプのエンティティは見つかりませんでした' };
  const found = { ok: true, text: 'sheepを発見: 座標(1, 64, 2), 距離12.3m' };
  const sheep = { name: 'mc.find-nearest-entity', input: { entityType: 'sheep' } };
  const dusk = (seconds: number) => observation({ time: String(13_000 - seconds * 20), margin: { darkInSeconds: seconds } });
  const offered = (seconds: number, noSheepDarkIn?: number) => minecraftSkillPointers(minecraftSituation(dusk(seconds), { ...calm, ...(noSheepDarkIn === undefined ? {} : { noSheepDarkIn }) }), NAMES);

  it('marks only a finished search for sheep whose result says nothing was found', () => {
    expect(noSheepNearby(sheep, none)).toBe(true);
    expect(noSheepNearby({ name: 'mc.find-nearest-entity', input: { entityType: 'Sheep' } }, none)).toBe(true);
    // A short look says nothing about the day: only the default range (unspecified) or at least 32 marks it.
    expect(noSheepNearby({ ...sheep, input: { entityType: 'sheep', maxDistance: 64 } }, none)).toBe(true);
    expect(noSheepNearby({ ...sheep, input: { entityType: 'sheep', maxDistance: 32 } }, none)).toBe(true);
    expect(noSheepNearby({ ...sheep, input: { entityType: 'sheep', maxDistance: 31 } }, none)).toBe(false);
    expect(noSheepNearby({ ...sheep, input: { entityType: 'sheep', maxDistance: 8 } }, none)).toBe(false);
    expect(noSheepNearby({ ...sheep, input: { entityType: 'sheep', maxDistance: '64' } }, none)).toBe(false);
    expect(noSheepNearby(sheep, found)).toBe(false);
    expect(noSheepNearby(sheep, { ok: false, text: '検索エラー: timeout' })).toBe(false);
    expect(noSheepNearby({ name: 'mc.find-nearest-entity', input: { entityType: 'cow' } }, none)).toBe(false);
    expect(noSheepNearby({ name: 'mc.find-nearest-entity', input: {} }, none)).toBe(false);
    expect(noSheepNearby({ name: 'mc.find-blocks', input: { entityType: 'sheep' } }, none)).toBe(false);
  });

  it('keeps the mark while the countdown to dark only falls (the rest of that day), and the pointer comes back the next day', () => {
    expect(offered(400)).toEqual(BED_POINTER);
    const mark = bedSearchGivenUp(dusk(400));
    expect(mark).toBe(400);
    expect(offered(400, mark)).toEqual([]);
    expect(offered(120, mark)).toEqual([]);
    // The marked day goes on: kept. Night: kept. The next morning (the countdown rises): cleared, and the pointer is offered again.
    expect(bedSearchMark(mark, dusk(120))).toBe(400);
    expect(bedSearchMark(mark, observation({ time: '18000', margin: { darkInSeconds: 0 } }))).toBe(400);
    expect(bedSearchMark(mark, dusk(650))).toBeUndefined();
    expect(offered(500, bedSearchMark(mark, dusk(500)))).toEqual(BED_POINTER);
    // A moment without an observation changes nothing; the mark is made only inside the window.
    expect(bedSearchMark(mark, null)).toBe(400);
    // The stage-2 pointer has no window, so a search any time of the day marks it (below the full day's 650 s, so that a new morning clears it).
    expect(bedSearchGivenUp(dusk(640))).toBe(640);
    expect(bedSearchGivenUp(dusk(650))).toBeUndefined();
    expect(bedSearchMark(640, dusk(650))).toBeUndefined();
    expect(bedSearchGivenUp(null)).toBeUndefined();
  });

  it('is kept by the body task from her own search result, across steps through the checkpoint', async () => {
    const tools = [{ name: 'find-nearest-entity', readOnly: true }];
    const make = (checkpoint: unknown) => {
      const world = observation({ time: '9000', margin: { darkInSeconds: 200 } });
      const control = { store: { body: () => 'minecraft:home', bind: () => true, safe: () => true }, available: () => ['minecraft:home'],
        frame: () => ({ poll: { skills: tools } }), observe: () => world, imagesUnavailable: () => false, settling: () => false, cancelTask() {} } as unknown as MinecraftControl;
      const step = { id: 'step', scopeKey: 'owner', taskId: 'task-sheep', revision: 1, lease: { id: 'lease', holder: 'h', generation: 1 },
        snapshot: { task: { createdAt: at, summary: '' }, checkpoint, history: [], sources: [] } } as unknown as TaskStep;
      return createMinecraftTaskBody({ control, runtime: { get: () => ({ phase: 'executing' }) } as unknown as TaskRuntime, step, entry: null, selector: null,
        ownerAlone: () => true, sourcesVisible: () => true, skillNames: () => new Set([BED]), log: () => {} });
    };
    const lease = { id: 'lease', holder: 'h', generation: 1 }, abort = new AbortController();
    const run = (made: ReturnType<typeof make>, act: () => void) => inActionExecution({ lease, signal: abort.signal, permit: async () => true } as never, async () => {
      made.body.start(abort.signal); act();
    });
    const first = make(null);
    let before: { skillPointers?: string[] } = {}, after: { skillPointers?: string[] } = {};
    await run(first, () => {
      before = first.body.context() as typeof before;
      first.body.noteResult!({ id: 'a', name: 'mc.find-nearest-entity', input: { entityType: 'sheep' } }, none as never);
      after = first.body.context() as typeof after;
    });
    expect(before.skillPointers).toEqual(BED_POINTER);
    expect(after.skillPointers).toBeUndefined();
    const checkpoint = first.tools.checkpoint!();
    expect(checkpoint).toMatchObject({ minecraftNoSheepDarkIn: 200 });
    // The next step of the task starts from the checkpoint: still no pointer at the same dusk.
    const next = make(checkpoint);
    let again: { skillPointers?: string[] } = {};
    await run(next, () => { again = next.body.context() as typeof again; });
    expect(again.skillPointers).toBeUndefined();
  });
});

describe('the skill (legacy-minecraft draft-4): the bed gist rewritten as a revision of draft-3, with the two opening skills', () => {
  const pack = () => standardSkillPack('legacy-minecraft', 'draft-4')!;
  const body = () => pack().skills.find(entry => entry.name === BED)!.body;
  const REAL_TOOLS = new Set(['mc.find-nearest-entity', 'mc.craft-one', 'mc.sleep-in-bed', 'mc.attack-continuously', 'mc.find-structure', 'mc.recall-places']);

  it('revises the bed skill of draft-3 (its exact body), with exact hashes, and adds two new skills', () => {
    expect(pack().skills.map(entry => entry.name)).toEqual([BED, 'mc-opening-scout', 'mc-iron-and-bucket']);
    for (const entry of pack().skills) expect(skillArtifactSha256(entry.body)).toBe(entry.sha256);
    const previous = standardSkillPack('legacy-minecraft', 'draft-3')!.skills[0]!;
    expect(pack().skills[0]!.revises).toEqual({ bodySha256: previous.sha256 });
    expect(pack().skills[1]).not.toHaveProperty('revises');
    expect(pack().skills[2]).not.toHaveProperty('revises');
    expect(skillArtifactSha256(previous.body)).toBe(previous.sha256);
    for (const entry of pack().skills) expect(entry.body).not.toMatch(/-?\d+\s*,\s*-?\d+\s*,\s*-?\d+/u);
  });

  it('has the gist the owner chose: the benefit and the village shortcut, the search order and its limit, then giving up to the night retreat', () => {
    const gist = skillGist(body(), observeOnlyStep);
    expect(gist).toHaveLength(SKILL_GIST.lines);
    expect(gist.map(line => line.slice(0, 2))).toEqual(['2.', '3.', '4.']);
    expect(gist.every(line => [...line].length <= SKILL_GIST.width && !line.endsWith('…'))).toBe(true);
    expect(gist.join('')).not.toContain('minecraft.observe');
    expect(gist[0]).toMatch(/夜を丸ごと飛ばせる.*村の家のベッド.*mc\.sleep-in-bed/u);
    expect(gist[1]).toMatch(/村が分かれば村へ.*mc\.find-nearest-entity（sheep）.*3頭倒し.*羊毛3＋板材3.*mc\.craft-one.*6分か12決定まで/u);
    expect(gist[2]).toMatch(/羊も村も無い.*敵が近い.*暗くなる1分前.*諦め.*mc-night-retreat/u);
    // The discouraging wording is gone from the whole skill.
    expect(body()).not.toContain('地下で過ごす方針は変えない');
    // `mc.find-nearest-entity` and `mc.sleep-in-bed` are named as tools; `mc.craft-one` is generic and `mc-night-retreat` is a skill.
    expect([...gistToolNames(gist)].sort()).toEqual(['mc.find-nearest-entity', 'mc.sleep-in-bed']);
    // Every `mc.` tool the whole skill names is a real one of the body catalog.
    expect([...body().matchAll(/mc\.[a-z-]+/gu)].every(match => REAL_TOOLS.has(match[0]))).toBe(true);
  });

  it('imports after draft-3: problems empty, two new skills of capacity, hashes as in the manifest, other skills untouched', () => {
    const memory = new SkillMemory({ database: new DatabaseSync(':memory:'), createsSchema: true, defer: task => task(), log: () => {} });
    const importer = new SkillImporter({ memory, ownerScopeKey: 'owner', check: () => pass, tools: () => [] });
    const apply = (revision: 'draft-1' | 'draft-2' | 'draft-3' | 'draft-4', when: string) => {
      const next = standardSkillPack('legacy-minecraft', revision)!;
      return importer.apply('owner', next, { planHash: importer.dryRun('owner', next).planHash, approvalReference: 'owner-form-20261017' }, when);
    };
    apply('draft-1', at); apply('draft-2', later(1)); apply('draft-3', later(2));
    const plan = importer.dryRun('owner', pack());
    expect(plan.problems).toEqual([]);
    expect(plan.capacity).toEqual({ used: 10, added: 2, limit: SKILL_CAPACITY });
    expect(plan.skills[0]).toMatchObject({ name: BED, sha256: pack().skills[0]!.sha256, revises: { bodySha256: standardSkillPack('legacy-minecraft', 'draft-3')!.skills[0]!.sha256 } });
    expect(plan.skills.map(skill => skill.sha256)).toEqual(pack().skills.map(entry => entry.sha256));
    const retreat = memory.store.byName('owner', 'mc-night-retreat')!, before = memory.store.byName('owner', BED)!;
    expect(apply('draft-4', later(3))).toHaveProperty('receipt');
    const revised = memory.store.byName('owner', BED)!;
    expect(revised.skillId).toBe(before.skillId);
    expect(revised.version).toBe(before.version + 1);
    expect(skillArtifactSha256(revised.body)).toBe(pack().skills[0]!.sha256);
    expect(revised).toMatchObject({ status: 'trial', madeBy: 'operator_authored' });
    for (const name of ['mc-opening-scout', 'mc-iron-and-bucket']) {
      expect(memory.store.byName('owner', name)).toMatchObject({ status: 'trial', madeBy: 'operator_authored', uses: [], successes: 0,
        provenance: { packId: 'legacy-minecraft', packRevision: 'draft-4' } });
    }
    expect(memory.store.byName('owner', 'mc-night-retreat')).toMatchObject({ version: retreat.version, body: retreat.body });
    expect(memory.index('owner').split('\n').filter(line => line.includes(BED))).toHaveLength(1);
    expect(memory.index('owner')).toContain('mc-opening-scout');
  });

  it('would take a production of 22 skills to 24 of 25, and one more skill over the limit (a full pack is refused)', () => {
    const memory = new SkillMemory({ database: new DatabaseSync(':memory:'), createsSchema: true, defer: task => task(), log: () => {} });
    const importer = new SkillImporter({ memory, ownerScopeKey: 'owner', check: () => pass, tools: () => [] });
    for (const [revision, when] of [['draft-1', at], ['draft-2', later(1)], ['draft-3', later(2)]] as const) {
      const next = standardSkillPack('legacy-minecraft', revision)!;
      importer.apply('owner', next, { planHash: importer.dryRun('owner', next).planHash, approvalReference: 'owner-form-20261017' }, when);
    }
    // 12 more stand-ins (one pack of other skills) make the 22 of production; the plan's capacity then reads 22 + 2 = 24 of 25.
    const bodies = Array.from({ length: 12 }, (_, index) => ({ name: `filler-${index}`,
      body: `---\nname: filler-${index}\ndescription: 場を埋める\n---\n\n## 手順\n1. 何もしない。\n\n## 補助\nなし\n\n## 参考\nなし\n` }));
    const fillers: SkillPack = { schemaVersion: 1, packId: 'filler', revision: 'draft-1', sourceAuthor: 'test', sourceReference: 'test://filler', referenceRevision: 'abcdef1',
      validatorRevision: 'skill-import-v1', skills: bodies.map(entry => ({ ...entry, sha256: skillArtifactSha256(entry.body), tools: [] })) };
    expect(importer.apply('owner', fillers, { planHash: importer.dryRun('owner', fillers).planHash, approvalReference: 'owner-form-20261017' }, later(3))).toHaveProperty('receipt');    expect(importer.dryRun('owner', pack()).capacity).toEqual({ used: 22, added: 2, limit: SKILL_CAPACITY });
    expect(importer.dryRun('owner', pack()).problems).toEqual([]);
  });

  it('cannot revise once the current version has been used (then a new skill name is the way)', () => {
    const memory = new SkillMemory({ database: new DatabaseSync(':memory:'), createsSchema: true, defer: task => task(), log: () => {} });
    const importer = new SkillImporter({ memory, ownerScopeKey: 'owner', check: () => pass, tools: () => [] });
    const apply = (revision: 'draft-1' | 'draft-2' | 'draft-3', when: string) => {
      const next = standardSkillPack('legacy-minecraft', revision)!;
      return importer.apply('owner', next, { planHash: importer.dryRun('owner', next).planHash, approvalReference: 'owner-form-20261017' }, when);
    };
    apply('draft-1', at); apply('draft-2', later(1)); apply('draft-3', later(2));
    memory.usedInTask('owner', fcaSkillTaskKey('task-bed'), BED, later(3), 'gist');
    expect(importer.dryRun('owner', pack()).problems).toEqual([{ name: BED, code: 'on_trial' }]);
  });
});