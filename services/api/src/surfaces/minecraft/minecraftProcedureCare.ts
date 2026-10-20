import type { ProcedureMemory } from '@shannon/mind';
import { carried, type Cell, type MinecraftProcedureFacts } from './minecraftProcedureFacts.js';
import { COBBLE, cobbleFor, doing, stuck, toolOf, type McDo, type McMove } from './minecraftProcedureMoves.js';
import type { ProcedureTaskStore } from './minecraftProceduresIron.js';
import { FOOD_ORDER } from './minecraftProcedureUpkeep.js';

/**
 * What she looks to before she goes under ground or far (mb-r20, run 20): the pack not so full of rock that the next dig is refused
 * (a stair of 99 steps and a tunnel left tuff, andesite and diorite for 135 s of drops, fills and refusals), a pickaxe that is about to
 * break replaced before it breaks (a stone pickaxe went with 1 of 131 uses left in the middle of the iron), health and hunger made up
 * before the dig (13 of 20 and no armour went down a cliff and died to two zombies), and no new way out with an enemy near and health
 * low. Each is one move of the procedure, never a stop of the run.
 */
const JUNK = /^(?:tuff|andesite|diorite|granite|dirt|coarse_dirt|deepslate|calcite|smooth_basalt|dripstone_block|sand|rooted_dirt|mud)$/u;
/**
 * Blocks of any of these kinds kept for building (a stair up from the depth is a block a step, 120 and more, and `stair-mine` builds
 * with cobblestone first and then with any of them): only what is beyond this is dropped. The pack counts as full at `PACK_FULL`
 * stacks of the 36, and then the smallest stack of rock is let go to bring the number of stacks down.
 */
const KEEP_BLOCKS = 128, PACK_FULL = 26, LEAST_DROP = 16;
/** A pickaxe with fewer uses left than this is not trusted for the dig ahead. */
const LOW_USES = 40;

/**
 * The rock to drop before a dig, one kind and how many: what is beyond `KEEP_BLOCKS` (the biggest stack of junk first), else the
 * smallest stack when the pack is full.
 */
function junkToDrop(facts: MinecraftProcedureFacts): { name: string; count: number } | null {
  const blocks = [...facts.pack].filter(([name]) => COBBLE.test(name) || JUNK.test(name));
  const total = blocks.reduce((sum, [, count]) => sum + count, 0);
  const junk = blocks.filter(([name]) => JUNK.test(name)).sort((a, b) => b[1] - a[1]);
  if (total - KEEP_BLOCKS >= LEAST_DROP) {
    const heaviest = junk[0] ?? blocks.filter(([name]) => COBBLE.test(name)).sort((a, b) => b[1] - a[1])[0];
    if (heaviest) return { name: heaviest[0], count: Math.min(heaviest[1], total - KEEP_BLOCKS) };
  }
  const full = facts.stacks !== null && facts.stacks >= PACK_FULL;
  const smallest = junk.at(-1);
  return full && smallest ? { name: smallest[0], count: smallest[1] } : null;
}

/** The junk dropped before a dig, one kind a move. A drop the body refused (a narrow place) is not asked again at the same count. */
export function dropJunk(facts: MinecraftProcedureFacts, memory: ProcedureMemory): McDo | null {
  const junk = junkToDrop(facts);
  if (!junk) return null;
  const key = `junk:${junk.name}:${junk.count}`;
  if (memory.failed(key) > 0) return null;
  return doing({ tool: 'mc.drop-item', input: { itemName: junk.name, count: junk.count }, why: `掘る前に要らない石（${junk.name}）を捨てる`, expectMs: 8_000, key });
}

/** A stone pickaxe made when every pickaxe she carries has fewer than `LOW_USES` left (the stone, sticks and a table by the usual moves). */
export function pickaxeReserve(facts: MinecraftProcedureFacts): McMove | null {
  const pickaxes = facts.tools.filter(tool => /^(?:stone|iron|diamond|netherite)_pickaxe$/u.test(tool.name));
  if (!pickaxes.length || pickaxes.some(tool => tool.left >= LOW_USES)) return null;
  if (carried(facts, /^(?:stone|iron|diamond|netherite)_pickaxe$/u) > pickaxes.length) return null;
  return toolOf(facts, 'stone_pickaxe', cobbleFor(facts, 3));
}

/** The health she makes up before a dig: armoured below 12 of 20, bare below 16 (a bare body at 13 died to two zombies). */
const healthWanted = (facts: MinecraftProcedureFacts) => facts.armorPieces >= 2 ? 12 : 16;

/**
 * Eat and wait for the health to come back before a dig under ground, with no enemy near (that is the planner's and the floor's):
 * a meal when hunger stops it regenerating (food under 18), then a wait of what the rest takes (a heart in about eight seconds). At
 * most three times in a run, and the wait is a wait the executor fills with small work.
 */
export function healFirst(facts: MinecraftProcedureFacts, memory: ProcedureMemory): McMove | null {
  const health = facts.health;
  if (health === null || facts.dimension !== 'overworld' || health >= healthWanted(facts)) return null;
  if (facts.threats.some(threat => threat.canReachMe && threat.distance <= 24)) return null;
  const tries = Number(memory.notes.get('heal:tries') ?? 0);
  if (tries >= 3) return null;
  const again = () => {
    memory.notes.set('heal:tries', tries + 1);
    return null;
  };
  const hungry = facts.food !== null && facts.food < 18;
  const food = hungry ? FOOD_ORDER.find(name => (facts.pack.get(name) ?? 0) > 0) : undefined;
  if (food) {
    return doing({ tool: 'mc.use-item', input: { itemName: food }, why: `体力（${health}）を戻すために${food}を食べる`, expectMs: 3_000,
      key: `heal:eat:${tries}:${facts.food}`, then: again });
  }
  // Hunger without food, the night, and a furnace at work are no time to wait (the body refuses a wait of more than five seconds there).
  if (hungry || facts.night || facts.jobs.length > 0) return null;
  const seconds = Math.min(30, Math.max(6, Math.round((healthWanted(facts) - health) * 4)));
  return doing({ tool: 'mc.wait-time', input: { milliseconds: seconds * 1_000 }, why: `体力（${health}）が戻るのを待つ`, expectMs: seconds * 1_000,
    key: `heal:wait:${tries}:${health}`, then: again });
}

/** Moves that take her under ground or far from where she stands. */
const OUTWARD = new Set(['mc.stair-mine', 'mc.mine-block', 'mc.move-to', 'mc.withdraw-from-furnace', 'mc.dig-block-at']);
/** The stops for health with an enemy near that one task makes at most: after them the planner has had its say and the dig goes on. */
const CARE_STOPS = 3;
const FAR = 16;

/**
 * With health at 14 or less and an enemy that can reach her within 24 m, the way under ground and the far trips wait for the planner
 * (run 20: a stair dug beside a cliff with 13 of 20, two zombies, no armour). Returns the move itself when it is not such a one.
 */
export function guardOutward(facts: MinecraftProcedureFacts, store: Pick<ProcedureTaskStore, 'careStops'>, move: McMove): McMove {
  if (move.kind !== 'do' || !OUTWARD.has(move.item.tool) || facts.health === null || facts.health > 14 || facts.dimension !== 'overworld') return move;
  const input = move.item.input;
  const far = typeof input.x === 'number' && typeof input.z === 'number' && facts.at
    ? Math.hypot(input.x - facts.at.x, input.z - facts.at.z) > FAR : true;
  const near = facts.threats.filter(threat => threat.canReachMe && threat.distance <= 24).sort((a, b) => a.distance - b.distance)[0];
  if (!near || !far || (store.careStops ?? 0) >= CARE_STOPS) return move;
  store.careStops = (store.careStops ?? 0) + 1;
  return stuck(`体力が少なく（${facts.health}）敵が近い（${near.name} ${Math.round(near.distance)}m）ので、地下へ入る・遠くへ行く手は先に決めてもらう（戦う・囲う・食べて待つ）`);
}

/** Where a descent began (the surface of the shaft she digs), kept once for the way back up. */
export function noteSurface(facts: MinecraftProcedureFacts, store: Pick<ProcedureTaskStore, 'surface'>): void {
  if (!store.surface && facts.at && facts.dimension === 'overworld' && facts.at.y >= 50) {
    const at: Cell = { x: Math.floor(facts.at.x), y: Math.floor(facts.at.y), z: Math.floor(facts.at.z) };
    store.surface = at;
  }
}
