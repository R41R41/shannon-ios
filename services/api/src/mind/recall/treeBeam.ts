/**
 * The beam search of tree recall (Syzygy ADR-0008 stage 2, step 8, §3 「想起とスキル探し：フォルダや見出しの木を Jev でたどる（ビーム幅
 * 4 程度）。拾った断片の役立ち度を採点し、十分な断片が出たら止める」; `docs/skill-and-routing-contract.md`). Core: memory. Pure: the
 * scorer (Jev) and the audience are handed in; no clock, store or network here. Child ids extend their parent's (`<parent>:<child>`).
 *
 * Level by level, the scorer gives each candidate node a usefulness in [0, 1]. A leaf (a node without children, or any node at
 * the last level) that scores is a passage; of the others, the `width` best scoring at least `expandAt` are opened and their
 * children are the next level's candidates. The search stops when two passages reach 0.8 (`enough`), when the useful passages
 * sum to 1.6 (`sum`), when the scorer runs out of time or calls (`budget`), when it fails (`failed`), or when nothing is left
 * (`exhausted`). An opened node none of whose children were useful stands as a passage of its own.
 *
 * The audience is checked before and after each call: a node only the owner may see (`ownerOnly`) is never put to the scorer
 * unless the owner is alone before the call, and is dropped from the results if he is not alone after it.
 */
export interface TreeNode {
  id: string;
  /** Heading path, from the root (document or skill title) to this node. */
  path: readonly string[];
  /** At most `TREE_PREVIEW_CHARACTERS` of the node's own text. */
  preview: string;
  children: readonly TreeNode[];
  /** Only while the owner alone can see or hear the reply (her skills, her folder). */
  ownerOnly: boolean;
}

export const TREE_PREVIEW_CHARACTERS = 200;

export const TREE_BEAM = Object.freeze({
  width: 4,
  depth: 3,
  /** A passage this useful counts towards `enoughCount`. */
  enough: 0.8,
  enoughCount: 2,
  /** Useful passages summing to this stop the search. */
  sum: 1.6,
  /** What counts as useful at all (a passage kept, a summand). */
  useful: 0.5,
  /** A node scoring this much may be opened. */
  expandAt: 0.3,
  /** Candidates a call scores (Jev's menu limit, one entry left for the state). */
  candidates: 63,
  passages: 6,
});

export type BeamStop = 'enough' | 'sum' | 'budget' | 'failed' | 'exhausted';

export type BeamScorer = (candidates: readonly TreeNode[], level: number) => Promise<ReadonlyMap<string, number> | 'budget' | 'failed'>;

export interface BeamResult {
  passages: Array<{ node: TreeNode; score: number }>;
  stop: BeamStop;
  /** Levels scored, and candidates scored in all. */
  levels: number;
  scored: number;
}

/** Whether what has been found is enough to stop. */
export function beamStop(scores: readonly number[], options: Pick<typeof TREE_BEAM, 'enough' | 'enoughCount' | 'sum' | 'useful'> = TREE_BEAM): 'enough' | 'sum' | null {
  if (scores.filter(score => score >= options.enough).length >= options.enoughCount) return 'enough';
  return scores.filter(score => score >= options.useful).reduce((sum, score) => sum + score, 0) >= options.sum ? 'sum' : null;
}

export async function beamSearch(
  roots: readonly TreeNode[], score: BeamScorer,
  options: { depth?: number; width?: number; ownerAlone: () => boolean } & Partial<Omit<typeof TREE_BEAM, 'width' | 'depth'>>,
): Promise<BeamResult> {
  const settings = { ...TREE_BEAM, ...options };
  const depth = Math.max(1, Math.min(TREE_BEAM.depth, options.depth ?? TREE_BEAM.depth));
  const passages = new Map<string, { node: TreeNode; score: number }>();
  let candidates = [...roots];
  let opened: Array<{ node: TreeNode; score: number }> = [];
  let levels = 0;
  let scored = 0;
  const finish = (stop: BeamStop): BeamResult => {
    // An opened node none of whose children were useful stands as a passage of its own.
    // Deepest first, so a parent stands only when none of its descendants (an opened child included) was useful.
    for (const parent of [...opened].reverse()) {
      const covered = [...passages.values()].some(item => item.node.id.startsWith(`${parent.node.id}:`) && item.score >= settings.useful);
      if (!covered && parent.score >= settings.useful) passages.set(parent.node.id, parent);
    }
    const alone = safe(options.ownerAlone);
    const kept = [...passages.values()].filter(item => item.score >= settings.useful && (alone || !item.node.ownerOnly))
      .sort((left, right) => right.score - left.score || left.node.id.localeCompare(right.node.id)).slice(0, settings.passages);
    return { passages: kept, stop, levels, scored };
  };
  for (let level = 1; level <= depth; level += 1) {
    // Before the call: what may be shown now.
    const alone = safe(options.ownerAlone);
    const shown = candidates.filter(node => alone || !node.ownerOnly).slice(0, settings.candidates);
    if (!shown.length) return finish('exhausted');
    const scores = await score(shown, level);
    if (scores === 'budget' || scores === 'failed') return finish(scores);
    levels = level;
    scored += shown.length;
    // After the call: someone else may have arrived meanwhile.
    const stillAlone = safe(options.ownerAlone);
    const results = shown.filter(node => stillAlone || !node.ownerOnly).map(node => ({ node, score: clamp(scores.get(node.id) ?? 0) }));
    const next: Array<{ node: TreeNode; score: number }> = [];
    for (const item of results) {
      if (!item.node.children.length || level === depth) passages.set(item.node.id, item);
      else if (item.score >= settings.expandAt) next.push(item);
    }
    const stop = beamStop([...passages.values()].map(item => item.score), settings);
    if (stop) return finish(stop);
    const expand = next.sort((left, right) => right.score - left.score).slice(0, settings.width);
    opened = [...opened, ...expand];
    candidates = expand.flatMap(item => item.node.children);
    if (!candidates.length) return finish('exhausted');
  }
  return finish('exhausted');
}

function clamp(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function safe(read: () => boolean): boolean {
  try { return read(); } catch { return false; }
}
