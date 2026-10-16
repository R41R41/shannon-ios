/**
 * Walks of the recall graph (what a remembered turn recalled, and what that recalled) are recursive, and a game chat that goes on for
 * days makes one long chain of turns that each recalled the one before. 2026-10-17: at a few thousand turns the recursion overflowed
 * the stack, every `surface=platform` turn failed with a bare `RangeError` before its model call, and none had ever succeeded.
 *
 * The walks stay as they are. Only when one overflows (`deepWalk`) are the nodes below the overflow settled first, deepest first, so
 * that each later call has memoized children and recurses a few hundred levels at most; the walk is then run again. A walk that
 * does not overflow is exactly what it was. A chain of `MAXIMUM_WALK_DEPTH` nodes or more is what the walks' own bound already
 * answers with their cautious result (withheld, unavailable, not visible), so it is answered with `cautious` without a walk.
 */
export const MAXIMUM_WALK_DEPTH = 5000;
/** Nodes whose longest chain below them is longer than this are settled beforehand; shorter ones recurse on their own. */
const SETTLE_ABOVE = 200;

export function isStackOverflow(error: unknown): boolean {
  return error instanceof RangeError && /call stack/iu.test(error.message);
}

/**
 * `walk` as it is; if it overflowed the stack, `settle` (below) and `walk` again. `settle` says `'too_deep'` for a chain that is
 * at the walks' bound, which is answered with `cautious`.
 */
export function deepWalk<T>(walk: () => T, settle: () => 'ok' | 'too_deep', cautious: T): T {
  try { return walk(); } catch (error) { if (!isStackOverflow(error)) throw error; }
  return settle() === 'too_deep' ? cautious : walk();
}

/**
 * Calls `warm` on every node below `roots` that has a long chain under it, children before parents (`children` lists a node's
 * edges). Iterative: it never recurses. A cycle below such a chain, like a chain at `maximum`, is `'too_deep'`.
 */
export function settleDeepChains(roots: readonly string[], children: (id: string) => readonly string[], warm: (id: string) => void,
  maximum = MAXIMUM_WALK_DEPTH): 'ok' | 'too_deep' {
  const height = new Map<string, number>();
  const onPath = new Set<string>();
  const order: string[] = [];
  const stack: { id: string; kids: readonly string[]; next: number; height: number }[] = [];
  const enter = (id: string) => { onPath.add(id); stack.push({ id, kids: children(id), next: 0, height: 1 }); };
  for (const root of roots) {
    if (height.has(root)) continue;
    enter(root);
    while (stack.length) {
      if (stack.length >= maximum) return 'too_deep';
      const top = stack[stack.length - 1]!;
      if (top.next < top.kids.length) {
        const child = top.kids[top.next++]!;
        if (onPath.has(child)) return 'too_deep'; // a cycle below a chain this deep: what the walks answer a cycle with
        const known = height.get(child);
        if (known !== undefined) top.height = Math.max(top.height, known + 1); else enter(child);
        continue;
      }
      stack.pop(); onPath.delete(top.id); height.set(top.id, top.height); order.push(top.id);
      const parent = stack[stack.length - 1];
      if (parent) parent.height = Math.max(parent.height, top.height + 1);
    }
  }
  for (const id of order) if (height.get(id)! > SETTLE_ABOVE) warm(id);
  return 'ok';
}
