import { memoryControlFor, type CompanionStateSnapshot } from '@shannon/cognition';
/**
 * Walks of the recall graph (what a remembered turn recalled, and what that recalled) are recursive, and a game chat that goes on for
 * days makes one long chain of turns that each recalled the one before. 2026-10-17: at a few thousand turns the recursion overflowed
 * the stack, every `surface=platform` turn failed with a bare `RangeError` before its model call, and none had ever succeeded.
 *
 * The walks stay as they are. Only when one overflows (`deepWalk`) are the nodes below the overflow settled first, deepest first, so
 * that each later call has memoized children and recurses a few hundred levels at most; the walk is then run again. A walk that
 * does not overflow is exactly what it was. A chain of more than `MAXIMUM_WALK_DEPTH` nodes is what the walks' own bound already
 * answers with their cautious result (withheld, unavailable, not visible), so it is answered with `cautious` without a walk.
 */
export const MAXIMUM_WALK_DEPTH = 5000;
/** Nodes whose longest chain below them is longer than this are settled beforehand; shorter ones recurse on their own. */
const SETTLE_ABOVE = 200;

/**
 * Whether `error` is the stack running out. It is asked from catch blocks that may themselves be at the very end of the stack, so it
 * uses no regular expression: V8 reports a regular expression that has no stack left to run (any `exec`, `test`, `replace` in the
 * walks) not as a RangeError but as `SyntaxError: Invalid regular expression: /.../: Stack overflow`, and that is a stack overflow
 * too. An error raised while asking is itself the answer.
 */
export function isStackOverflow(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  try {
    const { name, message } = error as { name?: unknown; message?: unknown };
    if (typeof message !== 'string') return false;
    return (name === 'RangeError' && message.includes('call stack'))
      || (name === 'SyntaxError' && message.startsWith('Invalid regular expression') && message.endsWith('Stack overflow'));
  } catch {
    return true;
  }
}

/**
 * What one query scope (one synchronous read) has learned about chains past the bound, so that the cautious answer is not found
 * again, by a walk that overflows and a search of up to `MAXIMUM_WALK_DEPTH` nodes, for every turn that leads into the same chain.
 * `bounds`: a node -> how many nodes there are at least on a chain that starts at it. The first chain found too deep is logged
 * once per scope, as closed words (which walk, the bound), never the nodes. `reset` at the start of the next scope.
 */
export class DeepChains {
  readonly bounds = new Map<string, number>();
  private warned = false;
  constructor(private readonly walk: string, readonly maximum = MAXIMUM_WALK_DEPTH) {}
  reset(): void {
    this.bounds.clear();
    this.warned = false;
  }
  /** A chain of more than `maximum` nodes starts at `node` (found before in this scope). */
  tooDeep(node: string): boolean { return (this.bounds.get(node) ?? 0) > this.maximum; }
  note(node: string, atLeast: number): void {
    if (atLeast > (this.bounds.get(node) ?? 0)) this.bounds.set(node, atLeast);
  }
  warn(): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(`Shannon recall chain too deep walk=${this.walk} links>${this.maximum}`);
  }
}

/**
 * What one query scope of a `MemoryWithholding` (one synchronous read) has decided. All of it ends with the scope, so the next read asks the
 * native readers again. `timeless`: a recalled id's verdict where the time of the reply that recalled it cannot matter (no control names it,
 * no fact stands on it). `lineages`: what a task memory read found visible, with the earliest time each was visible at; what is visible at one
 * time is visible at every later one (every rule that depends on the time withholds an earlier reading whenever it withholds a later one).
 */
export class ScopeMemos {
  readonly recalled = new Map<string, boolean>();
  readonly timeless = new Map<string, boolean>();
  /** The part of a recalled id's verdict that does not depend on the time of the reply that recalled it (one walk per id). */
  readonly provenance = new Map<string, boolean>();
  readonly reads = new Map<string, boolean>();
  /** What the native reader answered for a read receipt (source and time). */
  readonly sources = new Map<string, boolean>();
  readonly lineages = new Map<string, string>();
  clear(): void { for (const memo of [this.recalled, this.timeless, this.provenance, this.reads, this.sources, this.lineages]) memo.clear(); }
  /** Keeps a recalled id's verdict as the one for any time where it is (nswersAtAnyTime). */
  keepTimeless(state: CompanionStateSnapshot, id: string, verdict: boolean): void { if (answersAtAnyTime(state, id)) this.timeless.set(id, verdict); }
}

/**
 * Whether a recalled id's verdict (`MemoryWithholding.computeRecalled`) is the same for a reply of any time: no memory control names it and no
 * fact, relationship or promise stands on it, so the verdict is the walk of what it read and recalled alone (`ScopeMemos.timeless`).
 */
export function answersAtAnyTime(state: CompanionStateSnapshot, id: string): boolean {
  const stands = (items: ReadonlyArray<{ id: string }>) => items.some(item => item.id === id);
  return !id.startsWith('thread:') && !id.startsWith('knowledge:') && !memoryControlFor(state, id)
    && !stands(state.userFacts) && !stands(state.relationships) && !stands(state.prospectiveMemories);
}

/** How many `deepWalk`s are running (all synchronous). Inside one an overflow goes up to it; outside every one it is answered at once. */
let walking = 0;

/**
 * `walk` as it is; if it overflowed the stack, `settle` (below) and `walk` again. `settle` says `'too_deep'` for a chain that is
 * past the walks' bound, which is answered with `cautious`. `chains` and `root`: a root already found too deep in this scope is
 * answered with `cautious` without walking.
 */
export function deepWalk<T>(walk: () => T, settle: () => 'ok' | 'too_deep', cautious: T, chains?: DeepChains, root?: string): T {
  if (chains && root !== undefined && chains.tooDeep(root)) return cautious;
  const outermost = walking === 0;
  walking += 1;
  try {
    try {
      return walk();
    } catch (error) {
      if (!isStackOverflow(error)) throw error;
    }
    try {
      return settle() === 'too_deep' ? cautious : walk();
    } catch (error) {
      // Still out of stack once the chain is settled: the read check itself runs the stack out (a reader that recurses without end),
      // which is what 5e086d7 answered "not visible", that is, with `cautious`. Inside another walk it goes up to that one instead:
      // the stack here is deep already, and the outer walk settles from a shallow one.
      if (outermost && isStackOverflow(error)) return cautious;
      throw error;
    }
  } finally {
    walking -= 1;
  }
}

export function insideDeepWalk(): boolean { return walking > 0; }

/** `ask()`, or `cautious` when it runs the stack out outside every `deepWalk` (inside one the overflow goes up to that walk). */
export function cautiousOutsideWalks<T>(cautious: T, ask: () => T): T {
  try {
    return ask();
  } catch (error) {
    if (walking === 0 && isStackOverflow(error)) return cautious;
    throw error;
  }
}

/**
 * Calls `warm` on every node below `roots` that has a long chain under it, children before parents (`children` lists a node's
 * edges; `settleAbove` is the height above which a node is warmed). Iterative: it never recurses. A chain of more than `maximum`
 * nodes, like a cycle below such a chain, is `'too_deep'` (the walks cut a node that has `maximum` nodes above it on its path).
 * `chains`: what the scope knows already about chains past the bound is used, and what this search finds is added to it.
 */
export function settleDeepChains(roots: readonly string[], children: (id: string) => readonly string[], warm: (id: string) => void,
  maximum = MAXIMUM_WALK_DEPTH, settleAbove = SETTLE_ABOVE, chains?: DeepChains): 'ok' | 'too_deep' {
  const height = new Map<string, number>();
  const onPath = new Set<string>();
  const order: string[] = [];
  const stack: { id: string; kids: readonly string[]; next: number; height: number }[] = [];
  const enter = (id: string) => {
    onPath.add(id);
    stack.push({ id, kids: children(id), next: 0, height: 1 });
  };
  const tooDeep = (): 'too_deep' => {
    if (chains) {
      chains.warn();
      // Each node of this path has the rest of it below it (a lower bound: the search stops here); the roots count as too deep.
      stack.forEach((entry, index) => chains.note(entry.id, stack.length - index));
      for (const root of roots) chains.note(root, maximum + 1);
    }
    return 'too_deep';
  };
  /** A node already known to have a chain below it that is too long for the nodes above it on this path. */
  const knownDeep = (id: string) => (chains?.bounds.get(id) ?? 0) + stack.length > maximum;
  for (const root of roots) {
    if (height.has(root)) continue;
    if (knownDeep(root)) return tooDeep();
    enter(root);
    while (stack.length) {
      if (stack.length > maximum) return tooDeep();
      const top = stack[stack.length - 1]!;
      if (top.next < top.kids.length) {
        const child = top.kids[top.next++]!;
        if (onPath.has(child)) return tooDeep(); // a cycle below a chain this deep: what the walks answer a cycle with
        const known = height.get(child);
        if (known !== undefined) top.height = Math.max(top.height, known + 1);
        else if (knownDeep(child)) return tooDeep();
        else enter(child);
        continue;
      }
      stack.pop();
      onPath.delete(top.id);
      height.set(top.id, top.height);
      order.push(top.id);
      const parent = stack[stack.length - 1];
      if (parent) parent.height = Math.max(parent.height, top.height + 1);
    }
  }
  for (const id of order) if (height.get(id)! > settleAbove) warm(id);
  return 'ok';
}

/** What the walks can ask of the store: a remembered turn, and the turns a knowledge document was made from. */
export interface RecallLookups {
  experience(id: string): { observedAt: string; recalledMemoryIds?: readonly string[] } | null | undefined;
  knowledgeSources(id: string): readonly string[];
}

/** A key of `recalledWithheld`'s walk is `[id, observedAt]`; the edges it goes on to ask about, as keys. */
export function recalledKeyEdges(key: string, lookups: RecallLookups): readonly string[] {
  const [id, observedAt] = JSON.parse(key) as [string, string];
  if (id.startsWith('thread:')) return [];
  if (id.startsWith('knowledge:')) return lookups.knowledgeSources(id).map(source => JSON.stringify([source, observedAt]));
  const experience = lookups.experience(id);
  return (experience?.recalledMemoryIds ?? []).map(source => JSON.stringify([source, experience!.observedAt]));
}

/** The edges `unavailableRead`'s walk goes on to ask about. */
export function readEdges(id: string, lookups: RecallLookups): readonly string[] {
  return id.startsWith('knowledge:') ? lookups.knowledgeSources(id) : lookups.experience(id)?.recalledMemoryIds ?? [];
}

/** The settling of `recalledWithheld`'s walk from `root` (a key), warming each node with `within(id, observedAt)`. */
export function settleRecalled(root: string, lookups: RecallLookups, chains: DeepChains,
  within: (id: string, observedAt: string) => void): () => 'ok' | 'too_deep' {
  const warm = (key: string) => {
    const [id, observedAt] = JSON.parse(key) as [string, string];
    within(id, observedAt);
  };
  return () => settleDeepChains([root], key => recalledKeyEdges(key, lookups), warm, undefined, undefined, chains);
}