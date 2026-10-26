import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { BODY_RULES, HARM, mapView, readLayers, type Cell } from './minecraftLlmcPreflightMap.js';
import { movedBy, type HandStop } from './minecraftLlmcHandGuards.js';

/**
 * The guards of the `go` hand (run 39, 2026-10-26: 「LLM が行き先と許す手を決め、体が道を歩き切る」). They read what the model decided, never the way: the
 * way is the body's, so the map between the feet and the destination is not walked here. Two things only:
 * - the destination: a cell the map shows as lava, fire, magma or a web (or with lava under it) is not a place to go to;
 * - the allowed hands: what `canDig` and `canPlace` may name. The body digs a way, not what is worth keeping (ore, containers, beds, doors, bedrock, a
 *   village's
 *   things: those are `dig` hands the model writes itself), and it does not put down what falls, flows or burns.
 * A hand the guards hold is held whole, as any other (the hands before it go, the ones from it on do not).
 */
type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Rec : null;
const cellOf = (value: unknown): Cell | null => {
  const at = rec(value);
  return at && typeof at.x === 'number' && typeof at.y === 'number' && typeof at.z === 'number'
    ? { x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) } : null;
};

/** Blocks a go never digs, whatever `canDig` says (the body ignores them too): they are for the `dig` hand. */
const NO_DIG = new RegExp('^(?:bedrock|obsidian|crying_obsidian|end_portal_frame|end_portal|nether_portal|spawner|ancient_debris|hay_block|farmland|tnt|beacon'
  + '|lava|water|barrier|command_block|ender_chest)$', 'u');
const NO_DIG_KIND = new RegExp('(?:_ore|_bed|_door|_chest|_barrel|_furnace|_shulker_box|_sign|_banner|_portal)$'
  + '|^(?:chest|barrel|furnace|bed|crafting_table|smoker|blast_furnace)$', 'u');
/** Blocks a go never puts down: they fall, flow, burn, slow or hurt. */
const NO_PLACE = new RegExp('^(?:lava|water|fire|soul_fire|tnt|sand|red_sand|gravel|suspicious_sand|suspicious_gravel|anvil|cactus|magma_block|soul_sand'
  + '|cobweb|powder_snow|dragon_egg)$', 'u');
const NO_PLACE_KIND = /(?:_bucket|_concrete_powder|_sapling|_torch|_sign|_banner|_bed|_door)$|^(?:torch|bucket)$/u;
/** The words canDig takes besides ids (the body reads them as a group). */
const DIG_WORDS = new Set(['stone', 'dirt', 'sand', 'wood']);

const quoted = (names: readonly string[]) => names.map(name => `「${name}」`).join('');

/** What is wrong with the blocks a go may dig or place, as one sentence, or null. */
export function goBlocksProblem(hand: { canDig?: readonly string[]; canPlace?: readonly string[] }): string | null {
  const digs = (hand.canDig ?? []).filter(name => !DIG_WORDS.has(name) && (NO_DIG.test(name) || NO_DIG_KIND.test(name)));
  if (digs.length) {
    return `canDig の ${quoted(digs)} は go では掘らない（鉱石・箱・かまど・ベッド・扉・黒曜石・岩盤・液体・村の物は dig の手で、自分で掘る物を決める）。道に要る岩・土・砂だけを書く`;
  }
  const places = (hand.canPlace ?? []).filter(name => NO_PLACE.test(name) || NO_PLACE_KIND.test(name));
  return places.length ? `canPlace の ${quoted(places)} は go では置かない（落ちる・流れる・燃える・足を取る・燃料や道具の物）。丸石・土・深層岩の丸石・ネザーラックなどの固い物を書く` : null;
}

/** The first hand a go hand's destination or allowed blocks hold, as a stop for the guards' list (closed code `go_blocks` or `go_unsafe`). */
export function goStop(input: unknown, frame: BodyObservation | null): HandStop | null {
  const hands = Array.isArray(rec(input)?.hands) ? (rec(input)!.hands as unknown[]).map(rec) : [];
  const world = rec(frame?.state.world) ?? {};
  const layers = typeof world.localMap === 'string' ? readLayers(world.localMap, BODY_RULES) : null;
  const view = layers ? mapView(layers) : null;
  const feet = cellOf(world.position);
  let here: Cell | null = feet;
  for (const [index, hand] of hands.entries()) {
    if (!hand) continue;
    if (hand.do === 'go') {
      const problem = goBlocksProblem(hand as { canDig?: readonly string[]; canPlace?: readonly string[] });
      if (problem) return { hand: index + 1, kind: 'go', code: 'go_blocks', line: problem };
      const unsafe = view ? unsafeDestination(hand, here, view) : null;
      if (unsafe) return { hand: index + 1, kind: 'go', code: 'go_unsafe', line: unsafe };
    }
    here = movedBy(hand, here);
  }
  return null;
}

/** The destination cells of a go (`to` or all of `goals`, from her feet when `rel`): null when the hand is relative and she is not known to be anywhere. */
function destinations(hand: Rec, here: Cell | null): Cell[] | null {
  const raw = [...(hand.to ? [hand.to] : []), ...(Array.isArray(hand.goals) ? hand.goals : [])].map(cellOf).filter((cell): cell is Cell => cell !== null);
  if (hand.rel !== true) return raw;
  return here ? raw.map(cell => ({ x: here.x + cell.x, y: here.y + cell.y, z: here.z + cell.z })) : null;
}
/** The destination when every cell of it is lava, fire, magma or a web in the map (or has lava under it), as a sentence; null when one may be gone to. */
function unsafeDestination(hand: Rec, here: Cell | null, view: ReturnType<typeof mapView>): string | null {
  const cells = destinations(hand, here);
  if (!cells?.length) return null;
  const bad = cells.filter(cell => [0, -1].some(dy => {
    const symbol = view.symbol(cell.x, cell.y + dy, cell.z);
    return symbol !== undefined && HARM.has(symbol) && (dy === 0 || symbol === 'L' || symbol === 'l');
  }));
  if (bad.length !== cells.length) return null;
  const first = bad[0]!;
  return `行き先 (${first.x},${first.y},${first.z}) ${cells.length > 1 ? 'など全部が' : 'は'}溶岩・火・マグマ・クモの巣のマス（地図）。そこへは行かない: 隣の立てるマスを行き先にする`;
}
