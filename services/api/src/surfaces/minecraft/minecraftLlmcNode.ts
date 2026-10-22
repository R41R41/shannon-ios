import type { BodyPlanView } from '../../contracts/bodyControlContract.js';

/**
 * mb-llmc r6 (run 29: the plan's "now" was 「p1.1 作業台と板を作る」 from 36 s to the end, and Sonnet went for the blazes from the first act;
 * plan.update 0). A hypothesis, measured by comparing Sonnet and Opus from the same start: an act says which plan node it is for.
 *
 * - The model writes the node first in the act's `why` (`[p1.2] …`; another node than the current one with 「理由: …」; `[急ぎ]` for an
 *   urgent hand). A why without a tag gets the current node's put first by the head (`tagActWhy`), said in the result as a form fixed.
 * - Each act sent is counted per task (`noteActNode`): how many were for the current node (or a node on its path), how many for another,
 *   how many of those said why, how many urgent, how many the head tagged. The log line carries the share on the plan.
 */
export const URGENT_TAG = '急ぎ';
const TAG = /^\s*\[([A-Za-z0-9][A-Za-z0-9_.-]{0,31}|急ぎ)\]\s*/u;
const REASON = /理由\s*[:：]/u;
const WHY_LIMIT = 120;

export interface ActNodeMark {
  /** The node the act is for (`急ぎ` for an urgent one). */
  node: string;
  current: string | null;
  by: 'model' | 'head';
  /** For the current node, a node above it or one under it. */
  on: boolean;
  urgent: boolean;
  /** Another node's act with its reason written. */
  reason: boolean;
}

/** Whether `id` is the current node, one of its parents or one under it. */
export function onCurrentPath(plan: Pick<BodyPlanView, 'current' | 'nodes'>, id: string): boolean {
  const current = plan.current;
  if (!current) return false;
  const parent = new Map(plan.nodes.map(node => [node.id, node.parentId]));
  const up = (from: string | null, target: string): boolean => {
    for (let at = from, guard = 0; at && guard < 16; at = parent.get(at) ?? null, guard += 1) if (at === target) return true;
    return false;
  };
  return id === current || up(current, id) || up(id, current);
}

/** The act with its why tagged by the node it is for: the model's own tag kept; none, the current node's put first. */
export function tagActWhy(input: unknown, plan: BodyPlanView | undefined): { input: unknown; fix: string | null; mark: ActNodeMark | null } {
  const act = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null;
  if (!act || !plan?.current) return { input, fix: null, mark: null };
  const why = typeof act.why === 'string' ? act.why : '';
  const tag = TAG.exec(why)?.[1];
  if (tag) {
    const urgent = tag === URGENT_TAG, on = !urgent && onCurrentPath(plan, tag);
    return { input, fix: null, mark: { node: tag, current: plan.current, by: 'model', on, urgent, reason: !on && !urgent && REASON.test(why) } };
  }
  const tagged = `[${plan.current}] ${why.trim()}`.trim().slice(0, WHY_LIMIT);
  return { input: { ...act, why: tagged }, fix: `why に今の節 [${plan.current}] を付けた`,
    mark: { node: plan.current, current: plan.current, by: 'head', on: true, urgent: false, reason: false } };
}

interface Tally { acts: number; on: number; off: number; offReason: number; urgent: number; head: number }
const tallies = new Map<string, Tally>();
/** Counts one act sent for the task and says it in the log (its node, the current one, and the task's share on the plan so far). */
export function noteActNode(taskId: string, mark: ActNodeMark | null, log: (line: string) => void): Tally | null {
  if (!mark) return null;
  let tally = tallies.get(taskId);
  if (!tally) {
    tally = { acts: 0, on: 0, off: 0, offReason: 0, urgent: 0, head: 0 };
    tallies.set(taskId, tally);
    if (tallies.size > 32) tallies.delete(tallies.keys().next().value as string);
  }
  tally.acts += 1;
  if (mark.by === 'head') tally.head += 1;
  else if (mark.urgent) tally.urgent += 1;
  else if (mark.on) tally.on += 1;
  else {
    tally.off += 1;
    if (mark.reason) tally.offReason += 1;
  }
  const share = (tally.on / tally.acts).toFixed(2);
  try {
    log(`Shannon Minecraft act node task=${taskId} node=${mark.node} current=${mark.current ?? '-'} by=${mark.by} on=${mark.on ? 1 : 0}`
      + ` reason=${mark.reason ? 1 : 0} acts=${tally.acts} onPlan=${tally.on} off=${tally.off} offReason=${tally.offReason} urgent=${tally.urgent}`
      + ` head=${tally.head} share=${share}`);
  } catch { /* a log never fails a step */ }
  return { ...tally };
}

/** The current node as the live state shows it before the map: `[p1.1] 作業台と板を作る＠…（済み: …）` and the path above it. */
export function planNowLine(view: { now?: unknown; path?: unknown } | null): string | null {
  const now = typeof view?.now === 'string' ? view.now : '';
  const match = /^(\S+) (.+)$/u.exec(now);
  if (!match) return null;
  const path = Array.isArray(view?.path) ? (view!.path as unknown[]).filter(item => typeof item === 'string').slice(-2) : [];
  return `[${match[1]}] ${match[2]}${path.length ? `（道: ${path.join(' › ')}）` : ''}`.slice(0, 200);
}

/** For tests: no task holds a tally. */
export function forgetActNodes(): void { tallies.clear(); }
