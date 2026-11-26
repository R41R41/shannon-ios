import { orderedPlan, type PlanNode, type PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { carriedFood, llmcTokens, stacks } from './minecraftLlmcLive.js';
import { kindOf } from './minecraftPlanFacts.js';
import { REPLAN, type ReplanRecord } from './minecraftLlmcReplan.js';
import type { PaceDelay } from './minecraftLlmcPace.js';
import { nearbyLines, nearbyResourcesOf } from './minecraftLlmcNearby.js';
import { HOPS_LINE_HEAD } from './minecraftLlmcQueueWords.js';

/**
 * The brief the strong model makes the plan again from (no history of the talk: the head's own record of the task, in order of how much it
 * matters, cut to `REPLAN.briefTokens` by dropping the last sections first). The facts are the head's and the body's as they are; the brief
 * adds no advice of its own.
 */
export interface BriefInput {
  goal: string;
  /** The task's running seconds. */
  seconds: number;
  /** The meter's current overdue milestone, as facts alone. */
  pace?: PaceDelay | null;
  stall: { kind: string; why: string; node: string | null };
  tree: PlanTree;
  /** What the stalled node's condition lacks now (`doneStatusWords`), or null. */
  doneStatus: string | null;
  /** Where she is, how she is, what she carries. */
  now: readonly string[];
  /** The shortage, the recovery, the way to the dragon (`minecraftEndgame.ts`), the recent stops. */
  facts: readonly string[];
  /** The last acts' results, newest last. */
  results: readonly string[];
  queue: readonly string[];
  /** The plans made before, newest last, and how many for this node. */
  earlier: readonly ReplanRecord[];
  sameNode: number;
  /** The knowledge of the stage the node is in (`V2_STAGES`). */
  knowledge: string;
  /** What people said to the task, oldest first, each with the time it was received and who said it (`heardLines`): the request and the words after it. */
  words?: readonly string[];
}

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Rec : null;
/** How many of the last acts' results the brief keeps (the newest are shown; `cut` shortens them). */
export const RESULTS_KEPT = 4;
/**
 * One result of the body, as a line for the brief: the first two lines of its text (what stopped and the hand's own words) and the first line that
 * names the reason's code (「穴の手が止まった理由 enderman_not_visible」), which sits after them and was cut off by a plain slice of the text
 * (the third run of 11/26: the brief of a replan held no result at all, and its why named a hit that never came).
 */
export function resultDigest(text: string): string {
  const lines = text.split('\n').map(line => line.replace(/\s+/gu, ' ').trim()).filter(Boolean);
  const head = lines.slice(0, 2).join(' ').slice(0, 260);
  const code = lines.slice(2).find(line => /理由 [a-z][a-z0-9_]+/u.test(line));
  return code ? `${head} ／ ${code.slice(0, 100)}` : head;
}
/** The results a checkpoint held, read with care (a step is made anew, and the stall waits in the checkpoint for the next step). */
export function readSavedResults(raw: unknown): string[] {
  return (Array.isArray(raw) ? raw : []).filter((item): item is string => typeof item === 'string' && item.length > 0).map(item => item.slice(0, 400)).slice(-RESULTS_KEPT);
}
/**
 * The body's queue lines for the brief. The head's line about short moves (「直近の go は …移動の go は 15 m 以上…」) is advice to the head for how to move;
 * the plan made again copied it into a caution for a node that had stopped for a hidden eye (11/26), so it is kept only for a stall made by stops in one
 * spot, where short moves can be the cause.
 */
export function queueBriefLines(queue: readonly string[], stallKind: string): string[] {
  return queue.filter(line => stallKind === 'same_spot_stops' || !line.startsWith(HOPS_LINE_HEAD));
}

const MARK: Readonly<Record<string, string>> = { done: '✓', blocked: '止', wait: '待', continue: '・' };

/** One node: its mark, id, kind and title, what shows it done, its target, its place, its note and (when blocked) why. */
export function nodeLine(node: PlanNode, tree: PlanTree): string {
  const mark = node.id === tree.current ? '▶' : MARK[node.state] ?? '・';
  const head = `${mark}${node.id} [${kindOf(node)}] ${node.title}`;
  const detail = [node.doneWhen ? `済む条件: ${node.doneWhen}` : '', node.target ? `目標: ${node.target.item}×${node.target.count}` : '',
    node.where ? `＠${node.where}` : '', node.state === 'blocked' && node.reason ? `止めた理由: ${node.reason}` : '',
    node.note ? `注: ${node.note}` : ''].filter(Boolean);
  return detail.length ? `${head}（${detail.join('・')}）` : head;
}

const topOf = (tree: PlanTree): string | null => {
  const byId = new Map(tree.nodes.map(node => [node.id, node] as const));
  let at = tree.current ? byId.get(tree.current) : undefined;
  while (at?.parentId) at = byId.get(at.parentId);
  return at?.id ?? null;
};

/**
 * A caution that is a stopped hand's own line copied onto the node (`cautionFact`'s last form: 「fight: 届かない（元: …」, with the place first at times).
 * It says what one stop was, not what is known; the plan made again read it as the cause of a different stop (11/26: a roof-lid line stood as the reason
 * for a walled one 5 below).
 */
export const isFailureCopy = (text: string): boolean => /^(?:\(-?\d+,-?\d+,-?\d+\) の )?[a-z_]+: /u.test(text);

/**
 * The plan: the done top-level nodes on one line; the open ones, the one she is in with its whole subtree and its rules; the promises still open.
 * Cautions that are a stop's own line are shown only when the stall is stops in one spot (the kind they were written for); for any other stall they are old words.
 */
export function planLines(tree: PlanTree, stallKind = 'same_spot_stops'): string[] {
  const order = orderedPlan(tree.nodes);
  const top = order.filter(node => node.parentId === null);
  const here = topOf(tree);
  const done = top.filter(node => node.state === 'done');
  const out: string[] = done.length ? [`済み: ${done.map(node => `${node.id} ${node.title.slice(0, 14)}`).join('・')}`] : [];
  for (const node of top.filter(item => item.state !== 'done')) {
    out.push(nodeLine(node, tree));
    if (node.id !== here) continue;
    for (const line of [...(node.forbid ?? []).map(text => `  禁止: ${text}`), ...(node.caution ?? []).filter(text => stallKind === 'same_spot_stops' || !isFailureCopy(text)).map(text => `  注意: ${text}`)]) out.push(line);
    const descendants = new Set([node.id]);
    for (const child of order) {
      if (child.parentId && descendants.has(child.parentId)) {
        descendants.add(child.id);
        out.push(`  ${nodeLine(child, tree)}`);
      }
    }
  }
  const promises = tree.promises.filter(item => item.state === 'open').slice(0, 6);
  return [...out, ...promises.map(item => `約束 #${item.id}: ${item.item}×${item.count}（${item.use}）`)];
}

/** Where she is and how: place and dimension, health, hunger, the food she carries, what she wears and carries. */
export function nowLines(observation: BodyObservation | null): string[] {
  const world = rec(observation?.state.world);
  if (!world || !observation) return ['体の観測が取れていない'];
  const at = rec(world.position);
  const whole = (value: unknown) => Math.floor(Number(value));
  const place = at && [at.x, at.y, at.z].every(value => typeof value === 'number') ? `(${whole(at.x)},${whole(at.y)},${whole(at.z)})` : '不明';
  const dimension = typeof world.dimension === 'string' ? world.dimension.replace(/^minecraft:/u, '') : '不明';
  const food = carriedFood(world, observation.facts);
  const pack = stacks(world.inventory).slice(0, 40).join('・');
  const worn = typeof world.worn === 'string' ? `・着ている物 ${world.worn}` : '';
  return [`場所: ${dimension} ${place}・体力 ${world.health ?? '?'}/20・満腹 ${world.food ?? '?'}/20・食料の点 ${food.points}${worn}`,
    `持ち物: ${pack || '空'}`];
}

/**
 * The plants of a request's materials that stand near her (the body's `nearbyResources`, as the decision reads them: kind, count, place, 育った or 育ち中).
 * The plan made again for a request is shown them: in bn4 it read only the pack, took the wheat she had planted for no wheat, and added the crafting table and
 * the seeds again. A kind with none near is left out here (the decision's own line says 「なし」).
 */
export function plantLines(observation: BodyObservation | null): string[] {
  const world = rec(observation?.state.world), at = rec(world?.position);
  const feet = at && [at.x, at.y, at.z].every(value => typeof value === 'number') ? { x: Math.floor(Number(at.x)), y: Math.floor(Number(at.y)), z: Math.floor(Number(at.z)) } : null;
  return nearbyLines(nearbyResourcesOf(world?.nearbyResources).filter(item => item.purpose === 'plant' && item.count > 0), feet, '小麦');
}

const stalledWords = (input: BriefInput): string => `止まった節: ${input.stall.node}。${input.doneStatus ? `その条件の今: ${input.doneStatus}。` : ''}`
  + `この節で立て直しは ${input.sameNode} 回目まで済み${input.sameNode + 1 >= REPLAN.perNode ? `。これがこの節の最後（上限 ${REPLAN.perNode} 回）: `
    + 'この後は止まっても新しい計画は来ない。前と同じ形の小さな直しにせず、節を割り直す・別の手段の節に替える・blocked にして別の道を書く' : ''}`;
const minutes = (seconds: number): string => `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`;
const OUTCOME_WORDS: Readonly<Record<ReplanRecord['outcome'], string>> = { changed: '計画を直した', unchanged: '直さなかった', refused: '直しが通らなかった',
  failed: '答えが来なかった' };

function sections(input: BriefInput, cut: number): string[] {
  const { stall } = input;
  const earlier = input.earlier.map(item => `- 節 ${item.node}（${item.kind}）: ${OUTCOME_WORDS[item.outcome]}。${item.why}`);
  const parts: Array<[string, readonly string[]]> = [
    ['依頼', [`${input.goal}（開始から ${minutes(input.seconds)}）`]],
    ['止まり', [`${stall.why}（種類 ${stall.kind}）`, ...(stall.node ? [stalledWords(input)] : [])]],
    ['人の言葉（依頼と、あとから届いた言葉。原文・話者・時刻つき）', input.words ?? []],
    ['時間の物差し', input.pace ? [`節目 ${input.pace.milestone}・目安 ${input.pace.targetSeconds} 秒・遅れ ${input.pace.secondsBehind} 秒`] : []],
    ['計画', planLines(input.tree, stall.kind)],
    ['今の様子', input.now],
    ['事実', input.facts.slice(0, cut > 1 ? 14 : 6)],
    ['直近の結果', input.results.slice(-(cut > 2 ? 4 : 2))],
    ['体の列', queueBriefLines(input.queue, stall.kind).slice(0, 4)],
    ['前の立て直し', earlier],
    ...(cut > 0 ? [['この段の知識', [input.knowledge]] as [string, readonly string[]]] : []),
  ];
  return parts.filter(([, lines]) => lines.length).map(([title, lines]) => `## ${title}\n${lines.join('\n')}`);
}

/** The brief, cut to the token bound: the knowledge of the stage goes first, then the facts and results are shortened. */
export function replanBrief(input: BriefInput): string {
  for (const cut of [3, 2, 1, 0]) {
    const text = sections(input, cut).join('\n\n');
    if (llmcTokens(text) <= REPLAN.briefTokens) return text;
  }
  // Still too long (a node's lines alone): the text itself is cut until it fits, by the same count
  // (Japanese is about a token a character, so a cut by characters is no bound).
  let text = sections(input, 0).join('\n\n');
  while (llmcTokens(text) > REPLAN.briefTokens && text.length > 400) text = text.slice(0, Math.floor(text.length * 0.9));
  return text;
}
