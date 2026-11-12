import type { PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { carried, doneFacts, type DoneFacts } from './minecraftConditions.js';
import { BODY_RULES, mapView, readLayers, type MapView } from './minecraftLlmcPreflightMap.js';
import { litGate, litGateLine, naturalObsidian, obsidianTally, ruinsIn } from './minecraftLlmcObsidianWays.js';
import { lavaRightUnder } from './minecraftLlmcLiquid.js';
import { offer, pending, withdraw, type OnceFact } from './minecraftLlmcOnceFacts.js';
import { GATE_OBSIDIAN, OBSIDIAN_AT_FIRST_LAVA } from './minecraftLlmcPrepRules.js';
import { kindOf } from './minecraftPlanFacts.js';

/**
 * Run 8 (11/13: with a diamond pickaxe, no obsidian in the pack and obsidian standing in the world, the strong model's replan decided
 * 「水入りバケツが無く黒曜石を作れない」 and made a node to fetch water; 252 s of walking and a fight before the head gave the water up): water is
 * needed only to pour on lava. While a node that asks only a water bucket is open, the bucket is not carried, an obsidian node is open, a diamond
 * pickaxe is carried and the obsidian in view covers what the gate still lacks, the head says so once. The node's state is the model's: nothing
 * is closed here, and with too little obsidian in view, no water node or a full bucket nothing is said. The obsidian in view is the natural
 * obsidian of the map (`naturalObsidian`: no frame, built or ruined, and none near a ruined portal, where crying obsidian is O too) that is
 * not right over lava: the body digs that one only after water is poured on top (dropGuard), so it needs the bucket.
 */
export const WATER_FACT_KEY = 'water_node_unneeded:';
const WATER_ONLY = /^\s*have:water_bucket(?:>=1)?\s*$/u;
const DIAMOND_PICK = /^(?:diamond|netherite)_pickaxe$/u;

type World = { localMap?: unknown; mapLandmarks?: unknown; scan?: { rows?: unknown; text?: unknown } };
const worldOf = (observation: BodyObservation | null): World => (observation?.state.world ?? {}) as World;
const viewOf = (observation: BodyObservation | null): MapView | null => {
  const map = worldOf(observation).localMap;
  const layers = typeof map === 'string' ? readLayers(map, BODY_RULES) : null;
  return layers ? mapView(layers) : null;
};
const stringList = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
/** The ruined portals of the body's last scan (its rows and its text). */
const ruinsOf = (observation: BodyObservation | null) => {
  const scan = worldOf(observation).scan;
  return ruinsIn([...stringList(scan?.rows), ...typeof scan?.text === 'string' ? [scan.text] : []]);
};
/** The nearest of the cells from her feet (metres), or null. */
function nearestOf(cells: ReadonlyArray<{ x: number; y: number; z: number }>, feet: DoneFacts['feet']): number | null {
  if (!feet) return null;
  let best: number | null = null;
  for (const cell of cells) {
    const meters = Math.hypot(cell.x - feet.x, cell.y - feet.y, cell.z - feet.z);
    if (best === null || meters < best) best = meters;
  }
  return best;
}

/** The facts as drafts (`key`, `text`), from the plan, the frame's facts and the map (`ruins`: the ruined portals the scan named). */
export function waterNodeUnneeded(tree: PlanTree, facts: DoneFacts, view: MapView | null, ruins: ReadonlyArray<{ x: number; y: number; z: number }> = []): Array<{ key: string; text: string }> {
  if (facts.dimension !== 'overworld' || !view || carried(facts.counts, 'water_bucket') > 0) return [];
  if (![...facts.counts].some(([name, count]) => count > 0 && DIAMOND_PICK.test(name.replace(/^minecraft:/u, '')))) return [];
  const open = (state: string) => state !== 'done' && state !== 'blocked';
  if (!tree.nodes.some(node => open(node.state) && kindOf(node) === 'obsidian')) return [];
  const held = carried(facts.counts, 'obsidian');
  const lack = Math.max(0, GATE_OBSIDIAN - held), goalLack = Math.max(0, OBSIDIAN_AT_FIRST_LAVA - held);
  // Review of the run-8 fixes (11/13): five of run 8's six burnt had lava right under them, which only water keeps from the drop.
  const cells = naturalObsidian(view, ruins).cells.filter(cell => !lavaRightUnder(view, cell));
  const need = lack > 0 ? lack : goalLack, visible = cells.length;
  if (need <= 0 || visible < need) return [];
  const near = nearestOf(cells, facts.feet);
  return tree.nodes.filter(node => open(node.state) && WATER_ONLY.test(node.doneWhen ?? '')).map(node => ({
    key: `${WATER_FACT_KEY}${node.id}`,
    text: `水入りバケツの節 ${node.id}「${node.title.slice(0, 24)}」: 黒曜石の不足はゲートの最低 ${GATE_OBSIDIAN} まで ${lack}・目標 ${OBSIDIAN_AT_FIRST_LAVA} まで ${goalLack}、`
      + `見えている黒曜石は ${visible} マス${near !== null ? `（最寄り ${Math.round(near)}m。真下が溶岩の O・枠・壊れたポータルの近くは数えない）` : ''}。`
      + '水は溶岩に注いで作る時と、真下が溶岩の O を掘る時だけ要る。見えている黒曜石を掘るだけなら要らない',
  }));
}

/** Offers the facts that hold now and takes back those that no longer do (none taken back with no frame). Returns the task's pending facts. */
export function waterNodeFacts(taskId: string, tree: PlanTree | null, observation: BodyObservation | null): OnceFact[] {
  const frame = doneFacts(observation);
  if (!tree || !frame) return pending(taskId);
  const now = waterNodeUnneeded(tree, frame, viewOf(observation), ruinsOf(observation));
  for (const fact of now) offer(taskId, fact.key, fact.text);
  for (const old of pending(taskId)) if (old.key.startsWith(WATER_FACT_KEY) && !now.some(fact => fact.key === old.key)) withdraw(taskId, old.key);
  return pending(taskId);
}

/**
 * The obsidian line of the strong model's replan (`obsidianTally`: the pack, the gate's least, the aim and the obsidian the map shows), from a frame
 * in the overworld; null elsewhere or with no frame. Run 8's replan had no count of the obsidian in view and made the water node. Once the gate
 * is lit, only that (`litGateLine`): its frame is not obsidian lacking.
 */
export function obsidianTallyLine(observation: BodyObservation | null): string | null {
  const facts = doneFacts(observation);
  if (!facts || facts.dimension !== 'overworld') return null;
  const view = viewOf(observation);
  if (facts.feet) {
    const gate = litGate(view, facts.feet, stringList(worldOf(observation).mapLandmarks));
    if (gate) return litGateLine(gate);
  }
  const natural = naturalObsidian(view, ruinsOf(observation)), near = nearestOf(natural.cells, facts.feet);
  return obsidianTally(carried(facts.counts, 'obsidian'), natural.cells.length, near !== null ? `${Math.round(near)}m（地図）` : null, natural);
}
