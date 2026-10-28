import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { goBlocksProblem } from './minecraftLlmcGoGuard.js';
import type { HandStop } from './minecraftLlmcHandGuards.js';
import { BODY_RULES, mapView, readLayers, type Cell } from './minecraftLlmcPreflightMap.js';

/**
 * The guards of the hands that take a range from the model (run 39, 2026-10-26: `obsidian`, `fight`, `mine`, `make`, `portal`, `smelt`;
 * `go` is `minecraftLlmcGoGuard.ts`).
 * They read what the model decided, never what the body will do: whether the range and the allowed hands go against the rules (a block that may not be dug or
 * placed, a target that is no enemy, a lava cell the map shows is none, a retreat that is already on, a batch that cannot be split as asked). The body's small
 * moves are not looked at. A hand held here is held whole, as any other (the hands before it go, the ones from it on do not).
 */
type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Rec : null;
const cellOf = (value: unknown): Cell | null => {
  const at = rec(value);
  return at && typeof at.x === 'number' && typeof at.y === 'number' && typeof at.z === 'number'
    ? { x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) } : null;
};
const list = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** What a fight is never asked against: the villagers, the golem that keeps them, the trader, other players, the animals that are kept. */
const NOT_ENEMIES = new RegExp('^(?:villager|wandering_trader|iron_golem|snow_golem|player|cat|horse|donkey|mule|llama|parrot|allay|axolotl|fox|sniffer'
  + '|camel|armadillo)$', 'u');
/** What `mine` never digs: what is kept or ends the world (the village's, containers, beds, the spawner, bedrock, liquids). Ore is what it is for. */
const NOT_MINED = new RegExp('^(?:bedrock|barrier|end_portal_frame|end_portal|nether_portal|spawner|hay_block|farmland|tnt|beacon|lava|water|command_block'
  + '|ender_chest|obsidian)$', 'u');
const NOT_MINED_KIND = new RegExp('(?:_bed|_door|_chest|_barrel|_furnace|_shulker_box|_sign|_banner|_portal)$'
  + '|^(?:chest|barrel|furnace|bed|crafting_table|smoker|blast_furnace)$', 'u');
/** What a frame can be built of. */
const FRAME_BLOCKS = new Set(['obsidian', 'crying_obsidian']);

/** The frame's lava: the cells the map shows that are no lava (known and something else), or null when the map does not show them. */
function notLava(cells: readonly Cell[], world: Rec): Cell | null {
  const layers = typeof world.localMap === 'string' ? readLayers(world.localMap, BODY_RULES) : null;
  if (!layers) return null;
  const view = mapView(layers);
  return cells.find(cell => {
    const symbol = view.symbol(cell.x, cell.y, cell.z);
    return symbol !== undefined && symbol !== 'L' && symbol !== 'l';
  }) ?? null;
}

type Found = { code: string; line: string } | null;
const reason = (code: string, line: string): Found => ({ code, line });

/** An obsidian hand: the blocks it may place, and the cells it names must be lava on the map (when the map shows them). */
function obsidianProblem(hand: Rec, world: Rec, here: Cell | null): Found {
  const blocks = goBlocksProblem({ canPlace: list(hand.canPlace) });
  if (blocks) return reason('range_blocks', blocks);
  const cells = (Array.isArray(hand.at) ? hand.at : []).map(cellOf).filter((cell): cell is Cell => cell !== null);
  const base = hand.rel === true ? here : { x: 0, y: 0, z: 0 };
  const found = base ? notLava(cells.map(cell => ({ x: cell.x + base.x, y: cell.y + base.y, z: cell.z + base.z })), world) : null;
  return found ? reason('not_lava', `at の (${found.x},${found.y},${found.z}) は地図で溶岩のマスではない。溶岩の源のマス（地図の L）を挙げる`) : null;
}
function portalProblem(hand: Rec): Found {
  const blocks = goBlocksProblem({ canPlace: list(hand.canPlace) });
  if (blocks) return reason('range_blocks', blocks);
  return typeof hand.block === 'string' && !FRAME_BLOCKS.has(hand.block) ? reason('frame_block', 'ポータルの枠は黒曜石（obsidian か crying_obsidian）だけで組める') : null;
}
function mineProblem(hand: Rec): Found {
  const block = String(hand.block ?? '');
  if (NOT_MINED.test(block) || NOT_MINED_KIND.test(block)) {
    return reason('range_blocks', `block の「${block}」は mine では掘らない（村の物・箱・ベッド・扉・スポナー・岩盤・液体・黒曜石）。掘る物は dig の手で、自分で決める`);
  }
  const way = goBlocksProblem({ canDig: list(hand.canDig) });
  return way ? reason('range_blocks', way) : null;
}
function smeltProblem(hand: Rec): Found {
  const kinds = Array.isArray(hand.items) ? hand.items.length : 0;
  return typeof hand.furnaces === 'number' && hand.furnaces < kinds
    ? reason('furnaces', `furnaces は入れる物の種類数（${kinds}）以上。1 基に入るのは 1 種類で、足りなければ体は何も入れない`) : null;
}
function fightProblem(hand: Rec, world: Rec): Found {
  const target = String(hand.target ?? '');
  if (!target.startsWith('#') && NOT_ENEMIES.test(target)) return reason('not_enemy', `target の「${target}」は敵ではない（村人・ゴーレム・商人・人・飼える動物とは戦わない）`);
  const health = typeof world.health === 'number' ? world.health : null;
  if (typeof hand.retreatHp === 'number' && health !== null && hand.retreatHp >= health && hand.stance !== 'flee') {
    // GPT's review 2026-10-28: a fact only. It no longer tells to lower retreatHp (at health 8 or under that would push a fight through;
    // system: 「体力 8 以下では戦わない」).
    return reason('retreat_on', health <= 8
      ? `retreatHp ${hand.retreatHp} は今の体力 ${Math.round(health)} 以上で、始める前に退く値。体力 ${Math.round(health)} は 8 以下で、fight は送っていない`
      : `retreatHp ${hand.retreatHp} は今の体力 ${Math.round(health)} 以上で、始める前に退く値。fight は送っていない`);
  }
  return null;
}
/** One hand's problem as a sentence, or null. */
function problemOf(hand: Rec, world: Rec, here: Cell | null): Found {
  switch (hand.do) {
    case 'obsidian': return obsidianProblem(hand, world, here);
    case 'portal': return portalProblem(hand);
    case 'mine': return mineProblem(hand);
    case 'fight': return fightProblem(hand, world);
    case 'smelt': return smeltProblem(hand);
    default: return null;
  }
}

/** The first of the hands (obsidian, fight, mine, make, portal, smelt) that goes against the rules, as a stop in the guards' list. */
export function rangeStop(input: unknown, frame: BodyObservation | null): HandStop | null {
  const hands = Array.isArray(rec(input)?.hands) ? (rec(input)!.hands as unknown[]).map(rec) : [];
  const world = rec(frame?.state.world) ?? {};
  const feet = cellOf(world.position);
  // A relative obsidian is read from the feet only while nothing before it has moved her.
  let here: Cell | null = feet;
  for (const [index, hand] of hands.entries()) {
    if (!hand) continue;
    const found = problemOf(hand, world, index === 0 ? here : null);
    if (found) return { hand: index + 1, kind: String(hand.do), code: found.code, line: found.line };
    here = hand.do === 'wait' || hand.do === 'look' || hand.do === 'equip' || hand.do === 'eat' ? here : null;
  }
  return null;
}
