import type { PlanNode } from '@shannon/mind';
import { countMatching, type ItemCounts } from './minecraftItems.js';
import { crossingOfWorld, crossingWords } from './minecraftEyeLedger.js';
import { kindOf } from './minecraftPlanFacts.js';

/**
 * Run 6 (2026-11-11, 「焼いてる際にも結局 wait を使って待ってしまっている」): 5 stands at the furnace, 270 s of 1,564, with the ledger's words
 * 「別の作業を足す」 in the frame every time. 5 m away stood iron ×3 and coal ×13 and nobody turned them into an act: the words said "other work" and named none.
 * The pattern that is proven here is the night's choice line (`nightChoiceLine`: choices A/B with the hands as written and what waiting costs; the replay moved
 * 3/6 to 6/6): the furnace gets the same. While a furnace works the live body (the plan's now) says its seconds, that waiting stops everything for that long,
 * and the hands to take instead: the nearest iron and coal the map shows, and the plan's next open section that does not need the furnace's output.
 * The same choices go into the hold of a long wait (`furnaceStandHold`), which the plan part below keeps per task (the hold has no plan tree).
 */
type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Rec : null;
const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const IRON_MARK = /鉄鉱石\[(?:deepslate_)?iron_ore\] \((-?\d+),(-?\d+),(-?\d+)\)/u;
const COAL_MARK = /石炭\[(?:deepslate_)?coal_ore\] \((-?\d+),(-?\d+),(-?\d+)\)/u;
const STONE_PICK = /(?:^|:)(?:stone|iron|diamond|netherite)_pickaxe$/u;
const ANY_PICK = /(?:^|:)(?:wooden|stone|iron|diamond|netherite)_pickaxe$/u;
/** A mark farther than this (blocks) is not "while it burns" work. */
export const MEANWHILE_NEAR = 24;
/**
 * Run of 11/26 (a chestplate's make stopped 4 ingots short with the furnace 30 s from done; 25 s later she went to mine coal, the way back was a dead end and about
 * 3 minutes went, the chestplate unmade): with this little left waiting is the cheap hand, and a hand that takes her away costs its walk back too. Said with the line
 * (a fact and its reason; the hand is still hers).
 */
export const SHORT_LEFT_SECONDS = 45;
const IRON_COUNT = 3;
const COAL_COUNT = 4;

/** The furnaces that still work, soonest first (seconds left, where, what). */
export function workingFurnaces(world: Rec | null): Array<{ cell: string; what: string; left: number; input: string; expects: string }> {
  const jobs = world?.jobs;
  return (Array.isArray(jobs) ? jobs : []).flatMap(item => {
    const job = rec(item), at = rec(job?.position), ms = num(job?.remainingEstimateMs);
    if (!job || !at || ms === null || ms <= 0 || job.status !== 'waiting_external') return [];
    return [{ cell: `${String(at.x)},${String(at.y)},${String(at.z)}`, what: `${String(job.input ?? '')}×${String(job.count ?? '')}`, left: Math.round(ms / 1000),
      input: String(job.input ?? ''), expects: String(job.expects ?? '') }];
  }).sort((a, b) => a.left - b.left);
}

function nearestMark(world: Rec, pattern: RegExp): { x: number; y: number; z: number; d: number } | null {
  const at = rec(world.position);
  const feet = [at?.x, at?.y, at?.z].map(value => num(value));
  const marks = (Array.isArray(world.mapLandmarks) ? world.mapLandmarks : []).flatMap(line => {
    const m = typeof line === 'string' ? pattern.exec(line) : null;
    if (!m) return [];
    const [x, y, z] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return [{ x, y, z, d: feet.every(value => value !== null) ? Math.hypot(x - feet[0]!, y - feet[1]!, z - feet[2]!) : 0 }];
  });
  return marks.sort((a, b) => a.d - b.d).find(mark => mark.d <= MEANWHILE_NEAR) ?? null;
}

/** The iron and the coal the map shows within reach, as hands as written (the pickaxe that takes them is carried). */
export function markChoices(world: Rec, counts: ItemCounts): string[] {
  const iron = countMatching(counts, STONE_PICK) > 0 ? nearestMark(world, IRON_MARK) : null;
  const coal = countMatching(counts, ANY_PICK) > 0 ? nearestMark(world, COAL_MARK) : null;
  return [
    ...(iron ? [`鉄鉱石 (${iron.x},${iron.y},${iron.z})（${Math.round(iron.d)}m）: mc_act ["mine iron_ore ${iron.x},${iron.y},${iron.z} count=${IRON_COUNT} seconds=60"]（次の鉄になる）`] : []),
    ...(coal ? [`石炭 (${coal.x},${coal.y},${coal.z})（${Math.round(coal.d)}m）: mc_act ["mine coal_ore ${coal.x},${coal.y},${coal.z} count=${COAL_COUNT} seconds=45"]（燃料。次に焼く時にも使う）`] : []),
  ];
}

/** Does a section need what the furnace is making (its words name the output or its input, or the iron/food things it becomes)? */
function needsOutput(node: PlanNode, furnace: { input: string; expects: string }): boolean {
  const text = `${node.title ?? ''} ${node.doneWhen ?? ''} ${node.note ?? ''}`;
  const words = [furnace.input, furnace.expects].filter(Boolean);
  if (words.some(word => text.includes(word))) return true;
  const iron = /iron|ingot/u.test(`${furnace.input} ${furnace.expects}`);
  if (iron) return /鉄(?!鉱石|ゴーレム)|インゴット|iron|バケツ|bucket|防具|armor|armour|盾|shield|ヘルメット|チェストプレート/u.test(text);
  const food = /beef|porkchop|mutton|chicken|cod|salmon|potato|cooked|bread/u.test(`${furnace.input} ${furnace.expects}`);
  return food ? /食料|food|焼|調理|cooked/u.test(text) : false;
}

/** A walk to the point the eyes give is a go of its own, sent as written (run 9 of 11/27: the choice was a coal hand as a string and the walk 「その節の手を足す」, and the string won). */
export interface MeanwhileGo { x: number; y: number; z: number; meters: number }
/** The distance from which the walk to the point is a go of its own (blocks). */
const GO_FROM = 100;
const goHand = (go: MeanwhileGo): string => `mc_act ["go ${Math.round(go.x)},${Math.round(go.y)},${Math.round(go.z)} waterOk dig=dirt,gravel,sand maxDig=20 seconds=120"]`;

/** The plan's now, else the next open leaf, that does not need the furnace's output: `[id] title`, or null. */
export function planChoice(nodes: readonly PlanNode[], currentId: string | null, furnace: { input: string; expects: string }, go: MeanwhileGo | null = null): string | null {
  const open = (node: PlanNode) => node.state !== 'done' && node.state !== 'blocked' && node.prep?.state !== 'skipped'
    && !nodes.some(kid => kid.parentId === node.id && kid.state !== 'done');
  const current = nodes.find(node => node.id === currentId);
  const order = [...(current ? [current] : []), ...nodes.filter(node => node !== current)];
  const node = order.find(item => open(item) && !needsOutput(item, furnace));
  if (!node) return null;
  const walk = go && go.meters >= GO_FROM && kindOf(node) === 'stronghold';
  return `次の節 [${node.id}] ${String(node.title ?? '').slice(0, 40)}${node.where ? `（${String(node.where).slice(0, 30)}）` : ''}（かまどの出力に頼らない）: `
    + (walk ? `${goHand(go)}（${crossingWords(go.meters)}。長い go は 1 手で出してよい）` : 'その節の手を足す');
}

/** What the hold (which has no plan tree) says of the plan: the last choice the live body computed for the task. */
const planChoices = new Map<string, { text: string | null; at: number }>();
const PLAN_CHOICE_MS = 3 * 60_000;
export function rememberPlanChoice(taskId: string | undefined, text: string | null, now = Date.now()): void {
  if (!taskId) return;
  planChoices.set(taskId, { text, at: now });
  if (planChoices.size > 32) planChoices.delete(planChoices.keys().next().value as string);
}
export function rememberedPlanChoice(taskId: string, now = Date.now()): string | null {
  const kept = planChoices.get(taskId);
  return kept && now - kept.at < PLAN_CHOICE_MS ? kept.text : null;
}
/** For tests. */
export function forgetPlanChoices(): void { planChoices.clear(); }

/** The choices as the lines the live body and the hold say: the marks' hands first, the plan's section last (three at most). */
export function meanwhileChoices(world: Rec, counts: ItemCounts, plan: string | null): string[] {
  return [...markChoices(world, counts), ...(plan ? [plan] : [])].slice(0, 3);
}

export const letteredChoices = (choices: readonly string[]): string => choices.map((text, index) => `${'ABC'[index]}) ${text}`).join(' ');

/**
 * The line for the live body while a furnace works (null: no furnace works, or nothing to do beside it). `take` is sent early without harm: the body waits a
 * short remainder (15 s or less) and takes, and says 「まだ」 for a longer one; the furnace's own `furnace.done` wakes the decision.
 */
export function furnaceMeanwhileLine(world: Rec | null, counts: ItemCounts, nodes: readonly PlanNode[], currentId: string | null, taskId?: string): string | null {
  if (!world) return null;
  const first = workingFurnaces(world)[0];
  if (!first) { rememberPlanChoice(taskId, null); return null; }
  const crossing = crossingOfWorld(world, Date.now()), feetY = num(rec(world.position)?.y);
  const plan = planChoice(nodes, currentId, first, crossing?.meters != null && feetY !== null ? { x: crossing.x, y: feetY, z: crossing.z, meters: crossing.meters } : null);
  rememberPlanChoice(taskId, plan);
  const choices = meanwhileChoices(world, counts, plan);
  if (!choices.length) return null;
  const letters = choices.map((_text, index) => 'ABC'[index]).join('・');
  if (first.left <= SHORT_LEFT_SECONDS) return `かまど (${first.cell}) の ${first.what} は あと約 ${first.left} 秒。残りが短いので wait（${Math.max(5, first.left)} 秒）して take するのが最も確実で、`
    + `その鉄で次の節（作る手）が進む。離れる手を足すなら、残りの内に戻れる近さ（行き 10m 以内の目安）だけ。洞窟・行き止まりの先へは行かない（戻りの歩きが残りを超え、`
    + `実走では 30 秒待つ所を 3 分失った）。離れた手: ${letteredChoices(choices)}。時間が来たら furnace ${first.cell} take`;
  return `かまど (${first.cell}) の ${first.what} は あと約 ${first.left} 秒。ここで待てば ${first.left} 秒 なにも進まない。その間の次の 1 手はどれか: ${letteredChoices(choices)}。`
    + `時間が来たら furnace ${first.cell} take（早めに足してもよい。残りが短ければ体が待って取り、長ければ「まだ」と返る）。wait は ${letters} のどれもできない時だけ`;
}

/** The hold's choices: the marks read from the frame now, the plan's from the live body's last reading. */
export function holdChoices(world: Rec, counts: ItemCounts, taskId: string): string[] {
  return meanwhileChoices(world, counts, rememberedPlanChoice(taskId));
}
