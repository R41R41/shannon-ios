import { orderedPlan, type PlanNode, type PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../../contracts/bodyControlContract.js';
import { carriedFood, llmcTokens, stacks } from './minecraftLlmcLive.js';
import { kindOf } from './minecraftPlanFacts.js';
import { REPLAN, type ReplanRecord } from './minecraftLlmcReplan.js';

/**
 * The brief the strong model makes the plan again from (no history of the talk: the head's own record of the task, in order of how much it
 * matters, cut to `REPLAN.briefTokens` by dropping the last sections first). The facts are the head's and the body's as they are; the brief
 * adds no advice of its own.
 */
export interface BriefInput {
  goal: string;
  /** The task's running seconds. */
  seconds: number;
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
}

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Rec : null;
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

/** The plan: the done top-level nodes on one line; the open ones, the one she is in with its whole subtree and its rules; the promises still open. */
export function planLines(tree: PlanTree): string[] {
  const order = orderedPlan(tree.nodes);
  const top = order.filter(node => node.parentId === null);
  const here = topOf(tree);
  const done = top.filter(node => node.state === 'done');
  const out: string[] = done.length ? [`済み: ${done.map(node => `${node.id} ${node.title.slice(0, 14)}`).join('・')}`] : [];
  for (const node of top.filter(item => item.state !== 'done')) {
    out.push(nodeLine(node, tree));
    if (node.id !== here) continue;
    for (const line of [...(node.forbid ?? []).map(text => `  禁止: ${text}`), ...(node.caution ?? []).map(text => `  注意: ${text}`)]) out.push(line);
    for (const child of order.filter(item => item.id.startsWith(`${node.id}.`))) out.push(`  ${nodeLine(child, tree)}`);
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

const stalledWords = (input: BriefInput): string => `止まった節: ${input.stall.node}。${input.doneStatus ? `その条件の今: ${input.doneStatus}。` : ''}`
  + `この節で立て直しは ${input.sameNode} 回目まで済み`;
const minutes = (seconds: number): string => `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`;
const OUTCOME_WORDS: Readonly<Record<ReplanRecord['outcome'], string>> = { changed: '計画を直した', unchanged: '直さなかった', refused: '直しが通らなかった',
  failed: '答えが来なかった' };

function sections(input: BriefInput, cut: number): string[] {
  const { stall } = input;
  const earlier = input.earlier.map(item => `- 節 ${item.node}（${item.kind}）: ${OUTCOME_WORDS[item.outcome]}。${item.why}`);
  const parts: Array<[string, readonly string[]]> = [
    ['依頼', [`${input.goal}（開始から ${minutes(input.seconds)}）`]],
    ['止まり', [`${stall.why}（種類 ${stall.kind}）`, ...(stall.node ? [stalledWords(input)] : [])]],
    ['計画', planLines(input.tree)],
    ['今の様子', input.now],
    ['事実', input.facts.slice(0, cut > 1 ? 14 : 6)],
    ['直近の結果', input.results.slice(-(cut > 2 ? 4 : 2))],
    ['体の列', input.queue.slice(0, 4)],
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
