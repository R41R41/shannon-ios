/** Stage 5 planning is data, never another executor or an execution permission. */
export const TASK_TREE_SCHEMA = 'shannon.task-tree.v1' as const;
export type TaskNodeState = 'done' | 'blocked' | 'continue' | 'wait';
export interface TaskFinishCheck { id: string; kind: 'test' | 'file' | 'receipt' | 'owner_acceptance'; target: string; }
export interface TaskFinishContract {
  result: string; checks: readonly TaskFinishCheck[]; constraints: readonly string[];
  boundary: readonly string[]; stop: readonly string[];
}
export interface TaskNodeDraft {
  id: string; parentId: string | null; order: number; dependsOn: readonly string[];
  title: string; contract: TaskFinishContract | null;
}
export interface TaskTreeNode extends TaskNodeDraft { state: TaskNodeState; attemptId: string | null; }
/** Set only by authenticated server creation; planning data never grants authority. */
export interface TaskTreeAuthority {
  origin: 'owner_request' | 'own_time'; budgetLane: 'owner' | 'autonomy';
  ownerInformed: boolean; permissionId: string;
}
export interface TaskTree {
  schema: typeof TASK_TREE_SCHEMA; taskId: string; revision: number; rootId: string;
  goal: string; content: string; deadline: string | null;
  origin: TaskTreeAuthority['origin'] | 'unknown'; budgetLane: TaskTreeAuthority['budgetLane'] | 'unknown';
  ownerInformed: boolean; permissionId: string | null; legacy: boolean;
  nodes: readonly TaskTreeNode[];
}
export function taskTreeAuthority(value: unknown): TaskTreeAuthority | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as TaskTreeAuthority;
  if (Object.keys(value).some(key => !['origin', 'budgetLane', 'ownerInformed', 'permissionId'].includes(key))
    || !(item.origin === 'owner_request' && item.budgetLane === 'owner' || item.origin === 'own_time' && item.budgetLane === 'autonomy')
    || typeof item.ownerInformed !== 'boolean' || !id(item.permissionId)) return null;
  return { origin: item.origin, budgetLane: item.budgetLane, ownerInformed: item.ownerInformed, permissionId: item.permissionId };
}
export interface TaskProofEvidence {
  id: string; checkId: string; kind: TaskFinishCheck['kind']; target: string;
  verifiedBy: 'deterministic' | 'independent' | 'owner';
}
export function taskTreeNodesProblem(rootId: string, nodes: readonly TaskNodeDraft[]): string | null {
  if (!id(rootId) || !Array.isArray(nodes) || nodes.length < 1 || nodes.length > 100) return 'TREE_SHAPE';
  try { if (JSON.stringify(nodes).length > 48_000) return 'TREE_LIMIT'; } catch { return 'TREE_SHAPE'; }
  const byId = new Map<string, TaskNodeDraft>();
  for (const node of nodes) {
    if (!node || !id(node.id) || byId.has(node.id) || !text(node.title, 160)
      || !Number.isSafeInteger(node.order) || node.order < 0 || node.order > 100
      || !Array.isArray(node.dependsOn) || node.dependsOn.length > 100
      || new Set(node.dependsOn).size !== node.dependsOn.length
      || node.dependsOn.some((value: string) => !id(value))
      || node.contract !== null && finishContractProblem(node.contract)) return 'TREE_SHAPE';
    if (Object.keys(node).some(key => !['id', 'parentId', 'order', 'dependsOn', 'title', 'contract', 'state', 'attemptId'].includes(key))) return 'TREE_AUTHORITY';
    byId.set(node.id, node);
  }
  if (byId.get(rootId)?.parentId !== null || nodes.filter(node => node.parentId === null).length !== 1) return 'TREE_ROOT';
  for (const node of nodes) {
    const parent = node.parentId === null ? null : byId.get(node.parentId);
    if (node.id !== rootId && !parent || node.dependsOn.some((value: string) => value === node.id || !byId.has(value))) return 'TREE_LINK';
    if (parent && !inheritsContract(parent.contract, node.contract)) return 'TREE_BOUNDARY';
  }
  // Parentage and dependencies share one graph: a dependency on one's descendant cannot run.
  const active = new Set<string>(), done = new Set<string>();
  const visit = (key: string): boolean => {
    if (active.has(key)) return false;
    if (done.has(key)) return true;
    active.add(key);
    const node = byId.get(key)!;
    const edges = [...node.dependsOn, ...(node.parentId ? [node.parentId] : [])];
    if (edges.some(edge => !visit(edge))) return false;
    active.delete(key); done.add(key); return true;
  };
  return nodes.every(node => visit(node.id)) ? null : 'TREE_CYCLE';
}
export function finishContractProblem(value: TaskFinishContract): string | null {
  if (!value || !text(value.result, 2000) || !Array.isArray(value.checks) || value.checks.length > 32
    || new Set(value.checks.map(check => check?.id)).size !== value.checks.length
    || value.checks.some(check => !check || !id(check.id) || !['test', 'file', 'receipt', 'owner_acceptance'].includes(check.kind) || !text(check.target, 1024))) return 'TREE_CONTRACT';
  return [value.constraints, value.boundary, value.stop].every(items => Array.isArray(items) && items.length <= 32
    && items.every(item => text(item, 500)) && new Set(items).size === items.length) ? null : 'TREE_CONTRACT';
}
export function inheritsContract(parent: TaskFinishContract | null, child: TaskFinishContract | null): boolean {
  if (!parent) return child === null;
  if (!child || child.result !== parent.result) return false;
  return (['constraints', 'boundary', 'stop'] as const).every(key => parent[key].every(value => child[key].includes(value)))
    && parent.checks.every(check => child.checks.some(value => sameCheck(check, value)));
}
export function taskNodeVerdict(contract: TaskFinishContract | null, outcome: 'completed' | 'failed' | 'cancelled' | 'unknown' | 'running', evidence: readonly TaskProofEvidence[]): TaskNodeState {
  if (outcome === 'failed' || outcome === 'cancelled') return 'blocked';
  if (outcome === 'unknown') return 'wait';
  if (outcome === 'running') return 'continue';
  if (!contract || contract.checks.length === 0) return 'wait';
  return contract.checks.every(check => evidence.some(item => item.checkId === check.id && item.kind === check.kind && item.target === check.target
    && (check.kind !== 'owner_acceptance' || item.verifiedBy === 'owner'))) ? 'done' : 'wait';
}
export function taskTreeReplanProblem(current: TaskTree, nodes: readonly TaskNodeDraft[], protectedIds: readonly string[]): string | null {
  const shape = taskTreeNodesProblem(current.rootId, nodes);
  if (shape) return shape;
  const oldRoot = current.nodes.find(node => node.id === current.rootId)!;
  const newRoot = nodes.find(node => node.id === current.rootId)!;
  if (JSON.stringify(oldRoot.contract) !== JSON.stringify(newRoot.contract)) return 'TREE_OWNER_CHANGE_REQUIRED';
  for (const node of current.nodes) {
    const next = nodes.find(item => item.id === node.id);
    if (protectedIds.includes(node.id) && (!next || next.parentId !== node.parentId || JSON.stringify(next.contract) !== JSON.stringify(node.contract))) return 'TREE_ATTEMPT_HELD';
    if (next && JSON.stringify(node.contract) !== JSON.stringify(next.contract)) return 'TREE_OWNER_CHANGE_REQUIRED';
  }
  return null;
}
function sameCheck(left: TaskFinishCheck, right: TaskFinishCheck): boolean {
  return left.id === right.id && left.kind === right.kind && left.target === right.target;
}
function id(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,159}$/u.test(value); }
function text(value: unknown, maximum: number): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !value.includes('\0'); }
