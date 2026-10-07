/**
 * The lineage of a skill (Syzygy ADR-0008 §14, after the Darwin Gödel Machine; `docs/skill-and-routing-contract.md`, 「系譜」).
 * Core: memory. Pure: no store, no clock; the randomness is handed in.
 *
 * Every version of a skill is a node of its tree: its parent is the version it was derived from, and a version restored after a
 * failed trial is the same node again (`variantOf`), so its uses count for the version it restores and it is not a child. Nothing
 * is deleted: a reverted or retired branch stays and may be chosen again.
 *
 * The next patch starts from a node chosen with p ∝ σ(10(s − 0.5)) / (1 + children) (DGM's parent selection), where s is the node's
 * success rate with an informed prior for small n: s = (successes + k·m) / (uses + k), k = 3 (one trial), m = its parent's s, and
 * for the first version the skill's pooled rate over all its versions under Beta(1, 1). An older branch that did better than the
 * current version is therefore chosen more often, and a node that already has many children less.
 *
 * Three bugs of DGM's own code are avoided (`docs/knowledge/external-agent-architectures.md` in the Syzygy hub): the ranking is
 * best first (`rankedNodes`, descending weight), there is no unused threshold, and a trial is judged against its parent, never
 * against the first version (`skillMemory.revise`: the baseline is the base node's own rate).
 */

/** The lineage node of one version of a skill (`skillId:vN`). Kept here, beside the tree, so the memory window need not reach the store. */
export function versionRevisionId(skillId: string, version: number): string {
  return `${skillId}:v${version}`;
}
export interface LineageNode {
  revisionId: string;
  version: number;
  parentRevisionId: string | null;
  /** The node this version restores (a revert), or null for a new body. */
  variantOf: string | null;
  madeBy: 'sleep' | 'owner_edit';
  uses: number;
  successes: number;
}

export const SKILL_LINEAGE = Object.freeze({ sharpness: 10, midpoint: 0.5, priorStrength: 3 });

export interface ScoredNode { node: LineageNode; s: number; children: number; weight: number }

/** The nodes of the tree (a restored version is folded into the node it restores), each with s, its children and its weight. */
export function scoredLineage(nodes: readonly LineageNode[]): ScoredNode[] {
  const own = nodes.filter(node => node.variantOf === null);
  const byId = new Map(own.map(node => [node.revisionId, node]));
  const pooled = (1 + own.reduce((sum, node) => sum + Math.max(0, node.successes), 0)) / (2 + own.reduce((sum, node) => sum + Math.max(0, node.uses), 0));
  const s = new Map<string, number>();
  const rate = (node: LineageNode, depth = 0): number => {
    const known = s.get(node.revisionId);
    if (known !== undefined) return known;
    const parent = node.parentRevisionId ? byId.get(node.parentRevisionId) : undefined;
    const prior = parent && depth < 64 ? rate(parent, depth + 1) : pooled;
    const uses = Math.max(0, node.uses);
    const value = (Math.min(uses, Math.max(0, node.successes)) + SKILL_LINEAGE.priorStrength * prior) / (uses + SKILL_LINEAGE.priorStrength);
    s.set(node.revisionId, value);
    return value;
  };
  return own.map(node => {
    const children = own.filter(other => other.parentRevisionId === node.revisionId).length;
    const value = rate(node);
    return { node, s: value, children, weight: sigmoid(SKILL_LINEAGE.sharpness * (value - SKILL_LINEAGE.midpoint)) / (1 + children) };
  });
}

/** The nodes a patch may start from, best first (descending weight; then the higher s, then the newer version). Never the owner's. */
export function rankedNodes(nodes: readonly LineageNode[]): ScoredNode[] {
  return scoredLineage(nodes).filter(item => item.node.madeBy === 'sleep')
    .sort((left, right) => right.weight - left.weight || right.s - left.s || right.node.version - left.node.version);
}

/** One node drawn with p ∝ weight (`random` in [0, 1)); null when there is none. */
export function chosenBase(nodes: readonly LineageNode[], random: () => number): ScoredNode | null {
  const ranked = rankedNodes(nodes);
  const total = ranked.reduce((sum, item) => sum + item.weight, 0);
  if (!ranked.length || !(total > 0)) return ranked[0] ?? null;
  let draw = Math.min(Math.max(random(), 0), 1 - Number.EPSILON) * total;
  for (const item of ranked) {
    draw -= item.weight;
    if (draw < 0) return item;
  }
  return ranked.at(-1)!;
}

/** The rate a trial must reach: its parent's observed success over at least three uses, else ⅔ (the new-skill rule). */
export function parentBaseline(parent: Pick<LineageNode, 'uses' | 'successes'>): number {
  return parent.uses >= SKILL_LINEAGE.priorStrength ? Math.min(parent.uses, Math.max(0, parent.successes)) / parent.uses : 2 / 3;
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}
