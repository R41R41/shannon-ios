/**
 * The size of one decision's Minecraft skill part, before and after legacy-minecraft draft-6 (2026-10-19): for each stage, the
 * pointer fields (`skillPointers`, `skillGists`, `skillPointerNote`) as JSON characters, with the old skills (draft-1..4) and with
 * draft-6 beside them, and the skill index (the cached part) at 24 and 31 skills. Run with tsx; prints a table, changes nothing.
 */
import type { BodyObservation } from '../../src/contracts/bodyControlContract.js';
import { skillGist, skillIndex } from '../../src/mind/memory/skillDocument.js';
import { standardSkillPack } from '../../src/infra/config/standardSkillPack.js';
import { minecraftSituation, minecraftSkillContext, observeOnlyStep } from '../../src/surfaces/minecraft/minecraftSkillPointers.js';

const packs = ['draft-1', 'draft-2', 'draft-3', 'draft-4', 'draft-5', 'draft-6'].map(revision => standardSkillPack('legacy-minecraft', revision)!);
const bodies = new Map<string, string>();
for (const pack of packs) for (const skill of pack.skills) if (pack.revision !== 'draft-5') bodies.set(skill.name, skill.body);
const oldNames = new Set([...bodies.keys()].filter(name => !packs[5]!.skills.some(skill => skill.name === name)));
const allNames = new Set(bodies.keys());
const gists = (names: readonly string[]) => new Map(names.map(name => [name, skillGist(bodies.get(name)!, observeOnlyStep)] as const));
const observation = (world: Record<string, unknown>): BodyObservation => {
  const dimension = (world.dimension as string | undefined) ?? 'overworld';
  const inventory = ((world.inventory as string[] | undefined) ?? []).map(item => { const [name, count] = item.split('×'); return { name, count: Number(count ?? 1) }; });
  return { schemaVersion: 1, bodyId: 'minecraft:w', sequence: 1, stateAt: '', receivedAt: '', connected: true,
    state: { world: { dimension, health: 20, food: 20, time: '100', margin: { darkInSeconds: 645 }, nearbyThreats: [], ...world, inventory } }, facts: { dimension } } as unknown as BodyObservation;
};
const cases: Array<[string, Record<string, unknown>]> = [
  ['1 first day', { inventory: ['oak_log×3'] }],
  ['2 food and bed', { inventory: ['stone_pickaxe×1'] }],
  ['2 dusk, no bed', { inventory: ['stone_pickaxe×1'], time: '9000', margin: { darkInSeconds: 200 } }],
  ['3 iron', { inventory: ['stone_pickaxe×1', 'white_bed×1', 'cooked_beef×6'] }],
  ['5 diamonds', { inventory: ['iron_pickaxe×1', 'bucket×1', 'white_bed×1'] }],
  ['6 obsidian + kit', { inventory: ['diamond_pickaxe×1', 'white_bed×1'] }],
  ['night', { inventory: ['stone_pickaxe×1'], time: '18000', margin: { darkInSeconds: 0 } }],
  ['nether + rods', { dimension: 'the_nether', inventory: ['blaze_rod×7'] }],
  ['end', { dimension: 'the_end' }],
];
const size = (names: ReadonlySet<string>, world: Record<string, unknown>) => {
  const context = minecraftSkillContext(minecraftSituation(observation(world), { failedStepsInARow: 0 }), names, gists);
  return { chars: context.fields.skillPointers ? JSON.stringify(context.fields).length : 0, pointed: context.pointed.join(',') || '-' };
};
console.log('| case | before (chars, skills) | after (chars, skills) |\n|---|---|---|');
for (const [label, world] of cases) {
  const before = size(oldNames, world), after = size(allNames, world);
  console.log(`| ${label} | ${before.chars} (${before.pointed}) | ${after.chars} (${after.pointed}) |`);
}
const entries = (names: readonly string[]) => names.map((name, index) => ({ name, description: /description: (.*)/u.exec(bodies.get(name)!)![1]!, status: 'trial' as const,
  createdAt: String(index).padStart(3, '0'), origin: 'operator_authored' as const }));
const filler = Array.from({ length: 12 }, (_, index) => ({ name: `standard-${index}`, description: 'ほかのスキルの説明（平均的な長さの一行）', status: 'active' as const, createdAt: '000' }));
const before = skillIndex([...filler, ...entries([...oldNames])]), after = skillIndex([...filler, ...entries([...allNames])]);
console.log(`index: ${oldNames.size + 12} skills ${before.length} chars → ${allNames.size + 12} skills ${after.length} chars (+${after.length - before.length})`);
