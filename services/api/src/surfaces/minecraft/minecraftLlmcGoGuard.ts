import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { BODY_RULES, HARM, mapView, readLayers, type Cell } from './minecraftLlmcPreflightMap.js';
import { movedBy, type HandStop } from './minecraftLlmcHandGuards.js';
import { carriedItemCounts } from './minecraftItems.js';
import { carried } from './minecraftConditions.js';
import { materialsOf, recipeOf } from './minecraftLlmcRecipes.js';

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
    return `canDig の ${quoted(digs)} は go では掘らない（鉱石・箱・かまど・ベッド・扉・黒曜石・スポナー・岩盤・液体・村の物は dig の手で、自分で掘る物を決める）。道に要る岩・土・砂だけを書く`;
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
  const form = formContext(world, frame, view);
  const seen: Seen = { walked: false, lost: false, producer: false, hungered: false, pickaxe: false };
  for (const [index, hand] of hands.entries()) {
    if (!hand) continue;
    const shape = form ? formStop(hand, form, here, seen) : null;
    if (shape) return { hand: index + 1, kind: String(hand.do), code: shape.code, line: shape.line };
    noteHand(seen, hand);
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

/**
 * Form checks (the 11/13 flow, "送る前の点検を広げる"): a hand that is sure to fail within a second by its shape (a dig out of reach, a go into the air with no
 * block allowed, a long dig with a pickaxe that cannot last, an eat at 20/20, a make with no materials) is not sent; the line says what to write
 * instead. Not a safety gate: what the hands BEFORE it in the same act do (a go or walk first, a make of the pickaxe, hands that bring materials
 * or use up the food bar) lifts the check.
 */
type Found = { code: string; line: string } | null;
interface Seen { walked: boolean; lost: boolean; producer: boolean; hungered: boolean; pickaxe: boolean }
interface Stack { name: string; left: number | null }
type Point = { x: number; y: number; z: number };
interface Form { world: Rec; pos: Point | null; pack: Map<string, number>; stacks: Stack[]; view: ReturnType<typeof mapView> | null }

/** Where her position stops being the frame's: a hand that takes her somewhere the act does not say. */
const LOSES_PLACE = new Set(['vertical', 'jump', 'mine', 'fight', 'hunt', 'portal', 'obsidian', 'attack', 'pickup', 'shoot', 'sleep', 'bed_burst']);
/** What makes nothing and takes nothing from the world (the hands before a make that leave the pack as it is). */
const NO_PRODUCE = new Set(['walk', 'look', 'equip', 'wait', 'sneak', 'eat', 'place', 'pillarUp', 'drop', 'jump']);
/** The hands that use up the hunger bar (an eat after one is not at 20/20 for sure). */
const HUNGERS = new Set(['go', 'vertical', 'mine', 'fight', 'hunt', 'obsidian', 'portal', 'attack', 'jump']);
const REACH = 5;
const TIERS: Readonly<Record<string, number>> = { wooden: 1, golden: 1, stone: 2, iron: 3, diamond: 4, netherite: 5 };
const list = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

function stacksOf(world: Rec): Stack[] {
  const out: Stack[] = [];
  for (const item of Array.isArray(world.inventory) ? world.inventory : []) {
    const stack = rec(item);
    if (stack && typeof stack.name === 'string') {
      const left = rec(stack.durability)?.left;
      out.push({ name: stack.name.replace(/^minecraft:/u, ''), left: typeof left === 'number' && Number.isFinite(left) ? left : null });
    } else if (typeof item === 'string') {
      const match = /^(?:minecraft:)?([a-z_]+)[^(]*\(耐久(\d+)\//u.exec(item);
      if (match) out.push({ name: match[1]!, left: Number(match[2]) });
    }
  }
  return out;
}
function formContext(world: Rec, frame: BodyObservation | null, view: ReturnType<typeof mapView> | null): Form | null {
  if (!frame) return null;
  const at = rec(world.position);
  const pos = at && typeof at.x === 'number' && typeof at.y === 'number' && typeof at.z === 'number' ? { x: at.x, y: at.y, z: at.z } : null;
  return { world, pos, pack: carriedItemCounts(world, frame.facts), stacks: stacksOf(world), view };
}
/** What the hand does to the later checks of the same act. */
function noteHand(seen: Seen, hand: Rec): void {
  const kind = String(hand.do);
  if (kind === 'go' || kind === 'walk') seen.walked = true;
  if (LOSES_PLACE.has(kind)) seen.lost = true;
  if (!NO_PRODUCE.has(kind)) seen.producer = true;
  if (HUNGERS.has(kind)) seen.hungered = true;
  if ((kind === 'make' || kind === 'craft') && /_pickaxe$/u.test(String(hand.item ?? ''))) seen.pickaxe = true;
}

function formStop(hand: Rec, form: Form, here: Cell | null, seen: Seen): Found {
  switch (hand.do) {
    case 'dig': case 'use': case 'furnace': case 'chest': return reachProblem(hand, form, seen);
    case 'go': case 'walk': return airProblem(hand, form, here) ?? (hand.do === 'go' ? longGo(hand, form, seen) : null);
    case 'vertical': return wearProblem(form, seen, verticalCost(hand, form));
    case 'mine': return wearProblem(form, seen, typeof hand.count === 'number' ? hand.count * 4 : null);
    case 'eat': return fullProblem(hand, form, seen);
    case 'make': return makeProblem(hand, form, seen);
    default: return null;
  }
}

/** A go that may dig 30 blocks or more: half of maxDig is the expected wear. */
const longGo = (hand: Rec, form: Form, seen: Seen): Found => Number(hand.maxDig) >= 30 ? wearProblem(form, seen, Number(hand.maxDig) / 2) : null;

/** A dig, use, furnace put or chest farther than 5 m from her with no go or walk before it in the act. */
function reachProblem(hand: Rec, form: Form, seen: Seen): Found {
  if (seen.walked || seen.lost || !form.pos || (hand.do === 'furnace' && hand.op !== 'put')) return null;
  // A furnace or chest with canDig is walked and dug to by the body itself (G6: the iron node's caution asks for exactly this when the furnace is far).
  if ((hand.do === 'furnace' || hand.do === 'chest') && list(hand.canDig).length) return null;
  const target = cellOf(Array.isArray(hand.at) ? hand.at[0] : null);
  if (!target) return null;
  const base = hand.rel === true ? { x: Math.floor(form.pos.x), y: Math.floor(form.pos.y), z: Math.floor(form.pos.z) } : { x: 0, y: 0, z: 0 };
  const cell = { x: target.x + base.x, y: target.y + base.y, z: target.z + base.z };
  const far = Math.hypot(cell.x + 0.5 - form.pos.x, cell.y + 0.5 - form.pos.y, cell.z + 0.5 - form.pos.z);
  if (far <= REACH) return null;
  const text = `${cell.x},${cell.y},${cell.z}`;
  return { code: 'reach_far', line: `(${text}) は ${REACH}m 超（${far.toFixed(1)}m）。先に go ${text} range=2 を同じ act に置く` };
}

const FILL = ['cobblestone', 'cobbled_deepslate', 'netherrack'];
/** A go or walk to a cell in the air (two cells or more of air under it) or more than two steps up, with no canPlace and blocks in the pack. */
function airProblem(hand: Rec, form: Form, here: Cell | null): Found {
  if (list(hand.canPlace).length || !form.view) return null;
  const goals = destinations(hand, here);
  if (!goals?.length) return null;
  const hole = (cell: Cell) => [1, 2].every(down => form.view!.symbol(cell.x, cell.y - down, cell.z) === '.');
  if (!goals.every(cell => hole(cell) || (here !== null && cell.y - here.y > 2))) return null;
  const [name, count] = FILL.map(item => [item, form.pack.get(item) ?? 0] as const).reduce((best, next) => next[1] > best[1] ? next : best);
  if (count < 10) return null;
  const room = count - 32 > 0 ? `＝${count - 32}` : '';
  const via = hand.do === 'walk' ? 'walk は置かない。go に変えて、' : '';
  return { code: 'place_missing', line: `${via}荷の ${name}×${count} を canPlace に足す（maxPlace は持つ数−32 まで${room}）` };
}

/** How many blocks a vertical is expected to dig: stairs two a step, a shaft one; from maxDig or the steps to toY. */
function verticalCost(hand: Rec, form: Form): number | null {
  if (hand.shape === 'pillar') return null;
  let steps = typeof hand.maxDig === 'number' ? hand.maxDig : null;
  if (typeof hand.toY === 'number' && form.pos) {
    const depth = hand.dir === 'up' ? hand.toY - form.pos.y : form.pos.y - hand.toY;
    if (depth > 0) steps = Math.min(steps ?? depth, depth);
  }
  return steps === null ? null : steps * (hand.shape === 'stairs' ? 2 : 1);
}
const JA: Readonly<Record<string, string>> = { planks: '板材', cobblestone: '丸石', iron_ingot: '鉄インゴット', gold_ingot: '金インゴット', diamond: 'ダイヤ', stick: '棒' };
/** The pickaxe she digs with (the best kind, the most left) and whether a spare of the same kind or better is in the pack: a stop when it cannot last. */
function wearProblem(form: Form, seen: Seen, need: number | null): Found {
  if (need === null || need <= 0 || seen.pickaxe) return null;
  const rank = (stack: Stack) => TIERS[stack.name.replace(/_pickaxe$/u, '')] ?? 0;
  const picks = form.stacks.filter(stack => /^[a-z]+_pickaxe$/u.test(stack.name) && stack.left !== null);
  if (!picks.length) return null;
  const used = picks.reduce((best, next) => rank(next) > rank(best) || (rank(next) === rank(best) && next.left! > best.left!) ? next : best);
  const spare = form.stacks.some(stack => stack !== used && /^[a-z]+_pickaxe$/u.test(stack.name) && rank(stack) >= rank(used));
  if (spare || used.left! >= need) return null;
  const parts = recipeOf(used.name)?.needs.map(part => `${JA[part.item] ?? part.item} ${part.count}`).join('・');
  const how = parts ? `先に予備を作る: make ${used.name}（${parts}、作業台の近く）を同じ act の前に` : '先に予備のツルハシを用意する';
  return { code: 'pickaxe_wear', line: `${used.name} 残り ${used.left}・見込み ${need} 回。${how}` };
}

/** An eat while the hunger bar is full (20/20), when no hand before it in the act uses the bar up. */
function fullProblem(hand: Rec, form: Form, seen: Seen): Found {
  if (seen.hungered || form.world.food !== 20 || /^(?:enchanted_)?golden_apple$|^chorus_fruit$/u.test(String(hand.item ?? ''))) return null;
  return { code: 'eat_full', line: '満腹（20/20）。eat は今は効かない。減ってから、または stopIf hungerBelow で減った時に食べる' };
}

const FROM: Readonly<Record<string, string>> = { cobblestone: '石を dig か mine で掘る', log: '木を dig で切る', planks: 'log から make', stick: 'planks から make',
  iron_ingot: 'raw_iron を smelt', gold_ingot: 'raw_gold を smelt', diamond: '深い所のダイヤ鉱石を mine', coal: '石炭鉱石を mine（木炭は log を smelt）', string: 'クモを fight',
  leather: '牛を fight', wool: '羊を fight', flint: '砂利を dig', feather: '鶏を fight', blaze_rod: 'ブレイズを fight', ender_pearl: 'エンダーマンを fight', wheat: '作物を dig' };
/** The stones the game takes for cobblestone in a furnace and the stone tools (the body counts the same three: utils/nightGate, utils/toolWear). */
const COBBLE_LIKE = ['cobbled_deepslate', 'blackstone'];
/** What the pack holds of a recipe's part: cobblestone counts cobbled deepslate and blackstone too (below y=0 the pack has mostly cobbled deepslate). */
const heldFor = (pack: ReadonlyMap<string, number>, item: string): number =>
  carried(pack, item) + (item === 'cobblestone' ? COBBLE_LIKE.reduce((sum, name) => sum + (pack.get(name) ?? 0), 0) : 0);
/** A make whose materials (the head's recipe table, with its chain planks/stick/blaze_powder) are not in the pack nor brought by a hand before it. */
function makeProblem(hand: Rec, form: Form, seen: Seen): Found {
  if (seen.producer || typeof hand.item !== 'string') return null;
  const made = materialsOf(hand.item, typeof hand.count === 'number' ? hand.count : 1, { chain: true, pack: form.pack });
  if (made.uncounted) return null;
  const lack = made.spends.map(part => ({ item: part.item, n: part.count - heldFor(form.pack, part.item) })).filter(part => part.n > 0);
  if (!lack.length) return null;
  const text = lack.map(part => `${part.item}×${part.n}（${FROM[part.item] ?? '荷に無い。周りで探す'}）`).join('・');
  return { code: 'make_short', line: `足りない: ${text}。先にそろえてから make を置く（同じ act の前の手でそろえてもよい）` };
}
