import type { PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { carried, doneFacts, type DoneFacts } from './minecraftConditions.js';
import { BODY_RULES, mapView, readLayers, type MapView } from './minecraftLlmcPreflightMap.js';
import { mapObsidian, obsidianTally } from './minecraftLlmcObsidianWays.js';
import { offer, pending, withdraw, type OnceFact } from './minecraftLlmcOnceFacts.js';
import { GATE_OBSIDIAN, OBSIDIAN_AT_FIRST_LAVA } from './minecraftLlmcPrepRules.js';
import { kindOf } from './minecraftPlanFacts.js';

/**
 * Run 8 (11/13: with a diamond pickaxe, no obsidian in the pack and obsidian standing in the world, the strong model's replan decided
 * 「水入りバケツが無く黒曜石を作れない」 and made a node to fetch water; 252 s of walking and a fight before the head gave the water up): water is
 * needed only to pour on lava. While a node that asks only a water bucket is open, the bucket is not carried, an obsidian node is open, a diamond
 * pickaxe is carried and the obsidian in view covers what the gate still lacks, the head says so once. The node's state is the model's: nothing
 * is closed here, and with too little obsidian in view, no water node or a full bucket nothing is said.
 */
export const WATER_FACT_KEY = 'water_node_unneeded:';
const WATER_ONLY = /^\s*have:water_bucket(?:>=1)?\s*$/u;
const DIAMOND_PICK = /^(?:diamond|netherite)_pickaxe$/u;

const viewOf = (observation: BodyObservation | null): MapView | null => {
  const map = (observation?.state.world as { localMap?: unknown } | undefined)?.localMap;
  const layers = typeof map === 'string' ? readLayers(map, BODY_RULES) : null;
  return layers ? mapView(layers) : null;
};
/** The nearest obsidian of the map from her feet (metres), or null. */
function nearestObsidian(view: MapView, feet: DoneFacts['feet']): number | null {
  if (!feet) return null;
  let best: number | null = null;
  for (const [y, layer] of view.layers.layers) {
    for (const [key, symbol] of layer) {
      if (symbol !== 'O') continue;
      const [x, z] = key.split(',').map(Number) as [number, number];
      const meters = Math.hypot(x - feet.x, y - feet.y, z - feet.z);
      if (best === null || meters < best) best = meters;
    }
  }
  return best;
}

/** The facts as drafts (`key`, `text`), from the plan, the frame's facts and the map. */
export function waterNodeUnneeded(tree: PlanTree, facts: DoneFacts, view: MapView | null): Array<{ key: string; text: string }> {
  if (facts.dimension !== 'overworld' || !view || carried(facts.counts, 'water_bucket') > 0) return [];
  if (![...facts.counts].some(([name, count]) => count > 0 && DIAMOND_PICK.test(name.replace(/^minecraft:/u, '')))) return [];
  const open = (state: string) => state !== 'done' && state !== 'blocked';
  if (!tree.nodes.some(node => open(node.state) && kindOf(node) === 'obsidian')) return [];
  const held = carried(facts.counts, 'obsidian');
  const lack = Math.max(0, GATE_OBSIDIAN - held), goalLack = Math.max(0, OBSIDIAN_AT_FIRST_LAVA - held);
  const need = lack > 0 ? lack : goalLack, visible = mapObsidian(view);
  if (need <= 0 || visible < need) return [];
  const near = nearestObsidian(view, facts.feet);
  return tree.nodes.filter(node => open(node.state) && WATER_ONLY.test(node.doneWhen ?? '')).map(node => ({
    key: `${WATER_FACT_KEY}${node.id}`,
    text: `水入りバケツの節 ${node.id}「${node.title.slice(0, 24)}」: 黒曜石の不足はゲートの最低 ${GATE_OBSIDIAN} まで ${lack}・目標 ${OBSIDIAN_AT_FIRST_LAVA} まで ${goalLack}、`
      + `見えている黒曜石は ${visible} マス${near !== null ? `（最寄り ${Math.round(near)}m）` : ''}。水は溶岩に注いで作る時だけ要る。見えている黒曜石を掘るだけなら要らない`,
  }));
}

/** Offers the facts that hold now and takes back those that no longer do (none taken back with no frame). Returns the task's pending facts. */
export function waterNodeFacts(taskId: string, tree: PlanTree | null, observation: BodyObservation | null): OnceFact[] {
  const frame = doneFacts(observation);
  if (!tree || !frame) return pending(taskId);
  const now = waterNodeUnneeded(tree, frame, viewOf(observation));
  for (const fact of now) offer(taskId, fact.key, fact.text);
  for (const old of pending(taskId)) if (old.key.startsWith(WATER_FACT_KEY) && !now.some(fact => fact.key === old.key)) withdraw(taskId, old.key);
  return pending(taskId);
}

/**
 * The obsidian line of the strong model's replan (`obsidianTally`: the pack, the gate's least, the aim and the obsidian the map shows), from a frame
 * in the overworld; null elsewhere or with no frame. Run 8's replan had no count of the obsidian in view and made the water node.
 */
export function obsidianTallyLine(observation: BodyObservation | null): string | null {
  const facts = doneFacts(observation);
  if (!facts || facts.dimension !== 'overworld') return null;
  const view = viewOf(observation), near = view ? nearestObsidian(view, facts.feet) : null;
  return obsidianTally(carried(facts.counts, 'obsidian'), mapObsidian(view), near !== null ? `${Math.round(near)}m（地図）` : null);
}
