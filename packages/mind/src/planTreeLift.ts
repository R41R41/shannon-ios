import type { PlanNode } from './planTreeTypes.js';

/** A line as it is compared for a lift: width and spaces unified, the ends a model adds or drops (「…」, a full stop) left out. */
const squashed = (line: string): string => line.normalize('NFKC').replace(/\s+/gu, '').replace(/^[…・\-]+|[…。.]+$/gu, '').toLowerCase();
/**
 * r4: takes `text` off a node's forbid and caution: the same line, or else the one line that contains it (or, with the spaces, the dots at the
 * ends and the width of the letters left out, the one line that starts with it or contains it), or says why not. A miss names the node's lines,
 * so that the next try can copy one (a lift that named a line from memory, or from another node's, failed again and again).
 */
function liftMatches(node: PlanNode, text: string) {
  const all = [...(node.forbid ?? []), ...(node.caution ?? [])];
  const exact = all.filter(line => line === text), within = all.filter(line => line.includes(text));
  const needle = squashed(text), loose = needle ? all.filter(line => squashed(line).includes(needle) || needle.includes(squashed(line))) : [];
  const gone = exact.length ? exact : within.length === 1 ? within : within.length === 0 && loose.length === 1 ? loose : [];
  return { all, within, gone };
}
/** The lines of a node that a lift of `text` would take off. */
export const ruleLinesOf = (node: PlanNode, text: string): string[] => liftMatches(node, text).gone;
export function liftRule(node: PlanNode, id: string, text: string): string | null {
  const { all, within, gone } = liftMatches(node, text);
  if (!gone.length) {
    if (within.length > 1) return `${id} に「${text}」を含む行が ${within.length} つある（全文で書く）`;
    const lines = all.map(line => `「${line.slice(0, 40)}」`).join('');
    return `${id} に「${text}」の禁止・注意は無い${lines ? `。この節の行: ${lines}（そのまま写して書く）` : '（この節に禁止・注意の行は無い）'}`;
  }
  for (const key of ['forbid', 'caution'] as const) {
    const kept = (node[key] ?? []).filter(line => !gone.includes(line));
    if (kept.length) node[key] = kept;
    else delete node[key];
  }
  return null;
}
