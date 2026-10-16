import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { SkillMemory, fcaSkillTaskKey } from '../src/mind/memory/skillMemory.js';
import { SkillImporter, skillArtifactSha256 } from '../src/mind/memory/skillImport.js';
import { SKILL_GIST, SKILL_CAPACITY, skillGist } from '../src/mind/memory/skillDocument.js';
import { standardSkillPack } from '../src/infra/config/standardSkillPack.js';
import { GENERIC_BODY_TOOLS, gistToolNames, minecraftSituation, minecraftSkillPointers, observeOnlyStep } from '../src/surfaces/minecraft/minecraftSkillPointers.js';
import { createMinecraftTaskBody } from '../src/surfaces/minecraft/minecraftReflexAdapter.js';
import type { TaskRuntime, TaskStep } from '../src/mind/action/taskRuntime/taskRuntimePorts.js';
import type { MinecraftControl } from '../src/surfaces/minecraft/minecraftControl.js';
import { inActionExecution } from '../src/infra/context/actionExecution.js';

/** Owner 2026-10-17: before night she secures a bed, as knowledge she judges with (`mc-bed-before-night`), not behaviour code. */
const BED = 'mc-bed-before-night';
const BED_POINTER = [`${BED}（日暮れが近いのにベッドが無い）`];
const RETREAT_POINTER = 'mc-night-retreat（夜・暗くなる直前・敵が近い）';
const NAMES = new Set([BED, 'mc-night-retreat', 'mc-low-health', 'mc-food-and-pace', 'mc-nether-portal', 'mc-nether-travel', 'mc-blaze-rods']);
const calm = { failedStepsInARow: 0 };
const at = '2026-10-17T00:00:00.000Z';
const later = (minutes: number) => new Date(Date.parse(at) + minutes * 60_000).toISOString();
const pass = { carries: () => false };

const observation = (world: Record<string, unknown>, facts: Record<string, unknown> = {}): BodyObservation => ({ schemaVersion: 1, bodyId: 'minecraft:world',
  sequence: 1, stateAt: at, receivedAt: at, connected: true,
  state: { world: { dimension: 'overworld', health: 20, food: 20, time: '4900', margin: { darkInSeconds: 405 }, inventory: [], nearbyThreats: [], ...world } },
  facts: { dimension: 'overworld', ...facts } } as unknown as BodyObservation);
const pointers = (world: Record<string, unknown>, facts: Record<string, unknown> = {}, names: ReadonlySet<string> = NAMES) =>
  minecraftSkillPointers(minecraftSituation(observation(world, facts), calm), names);

describe('the bed pointer (when dusk is near and she carries no bed)', () => {
  it('fires between five minutes and one minute before dark without a bed, and not in daytime', () => {
    expect(pointers({})).toEqual([]);
    expect(pointers({ time: '6900', margin: { darkInSeconds: 305 } })).toEqual([]);
    expect(pointers({ time: '7000', margin: { darkInSeconds: 300 } })).toEqual(BED_POINTER);
    expect(pointers({ time: '9000', margin: { darkInSeconds: 200 } })).toEqual(BED_POINTER);
    expect(pointers({ time: '11700', margin: { darkInSeconds: 61 } })).toEqual(BED_POINTER);
    // Without the body's margin the time of day gives the same window.
    expect(pointers({ time: '9000', margin: undefined })).toEqual(BED_POINTER);
    expect(pointers({ time: '1000', margin: undefined })).toEqual([]);
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
    expect(pointers({ ...dusk, health: 6, inventory: ['iron_pickaxe×1'] })).toEqual(['mc-low-health（体力が半分以下）', ...BED_POINTER,
      'mc-nether-portal（鉄のツルハシがありネザーへ向かう前）']);
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
    expect(lines.map(line => line.replace(/^Shannon Minecraft gist follow task=task-bed /u, ''))).toEqual([
      'tool=mc.find-nearest-entity branch=read_only skills=-',
      'tool=mc.craft-one branch=generic_tool skills=-',
      `tool=mc.explore-for-structure branch=recorded skills=${BED}`,
      `tool=mc.sleep-in-bed branch=recorded skills=${BED}`,
    ]);
    expect(followed).toEqual([BED, BED]);
  });
});
