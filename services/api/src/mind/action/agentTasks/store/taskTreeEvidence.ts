import { taskNodeVerdict, type TaskProofEvidence, type TaskTree } from '@shannon/mind';
import type { HostAgentEvent } from '../agentTaskStore.js';
import type { TaskResultProof } from '../taskTreePorts.js';
import type { TaskTreeStore } from './taskTreeStore.js';
import { queueTaskTreeLearning } from './taskTreeCallbacks.js';
import { createHash } from 'node:crypto';
import type { AgentTestResult } from '../agentTaskStore.js';

export function recordTreeHostEvent(store: TaskTreeStore, scopeKey: string, event: HostAgentEvent, at: string): void {
  const tree = store.get(scopeKey, event.taskId), attempt = tree && store.currentAttempt(tree);
  if (!tree || !attempt || !store.acceptsEvent(scopeKey, event)) return;
  if (store.database.prepare('SELECT 1 FROM agent_task_tree_receipts WHERE event_id=?').get(event.eventId)) return;
  if (event.type === 'progress' && event.payload?.executionUncertain === true) attempt.outcome = 'unknown';
  else if (event.type === 'completed') attempt.outcome = 'completed';
  else if (event.type === 'failed') attempt.outcome = 'failed';
  else if (event.type === 'paused') attempt.outcome = 'cancelled';
  else if (event.type !== 'started' && event.type !== 'progress') return;
  // Test facts are the Host's commandExecution projection, never model plan status or summary.
  const tests = Array.isArray(event.payload?.tests) ? event.payload.tests as AgentTestResult[] : [];
  const evidence: TaskProofEvidence[] = [];
  if (attempt.lease && attempt.outcome === 'completed') for (const node of tree.nodes) {
    for (const check of node.contract?.checks ?? []) {
      const commandHash = createHash('sha256').update(check.target.trim()).digest('hex');
      const test = tests.find(value => value?.status === 'passed' && typeof value.id === 'string'
        && typeof event.payload?.executionTurnId === 'string' && event.payload.executionTurnId.length > 0
        && value.execution?.exitCode === 0 && value.execution.commandHash === commandHash
        && value.execution.turnId === event.payload?.executionTurnId
        && !!value.execution.actionLease
        && value.execution.actionLease.id === attempt.lease!.id && value.execution.actionLease.generation === attempt.lease!.generation
        && value.execution.actionLease.holder === attempt.lease!.holder);
      if (check.kind === 'test' && test) evidence.push({ id: `host:${event.eventId}:${test.id}`, checkId: check.id, kind: 'test', target: check.target, verifiedBy: 'deterministic' });
    }
  }
  attempt.evidence = uniqueEvidence([...attempt.evidence, ...evidence]);
  store.putAttempt(scopeKey, attempt);
  store.database.prepare('INSERT INTO agent_task_tree_receipts VALUES (?,?,?)').run(tree.taskId, event.eventId, attempt.id);
  const nodes = [...tree.nodes];
  // Legacy host plans remain advisory. Carry their real persisted items into the tree without accepting "completed" prose.
  if (tree.legacy && event.type === 'progress' && Array.isArray(event.payload?.plan)) {
    for (const item of event.payload.plan as { id?: unknown; title?: unknown }[]) {
      if (typeof item?.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,159}$/u.test(item.id)
        || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 160 || nodes.length >= 100) continue;
      if (!nodes.some(node => node.id === item.id)) nodes.push({ id: item.id, parentId: tree.rootId,
        order: nodes.length - 1, dependsOn: [], title: item.title, contract: null, state: 'wait', attemptId: attempt.id });
    }
  }
  const next: TaskTree = { ...tree, revision: tree.revision + 1, nodes: nodes.map(node => ({ ...node,
    state: node.attemptId === attempt.id ? taskNodeVerdict(node.contract, attempt.outcome, attempt.evidence) : node.state })) };
  // An attempt started against different conditions cannot close their later replacement.
  store.save(scopeKey, next, 'canonical_event', at);
  if (['unknown', 'failed', 'cancelled'].includes(attempt.outcome)) queueTaskTreeLearning(store.database, {
    id: `unusable:${attempt.id}:${attempt.outcome}`, kind: 'unusable', scopeKey, taskId: tree.taskId, attemptId: attempt.id, at,
    reason: attempt.outcome as 'unknown' | 'failed' | 'cancelled' });
  else store.queueVerified(scopeKey, tree.taskId, at);
}
export function verifyTreeEvidence(store: TaskTreeStore, scope: string, taskId: string, nodeId: string, attemptId: string,
  evidence: readonly TaskProofEvidence[], at: string): boolean {
  const tree = store.get(scope, taskId), attempt = tree && store.currentAttempt(tree);
  const node = tree?.nodes.find(value => value.id === nodeId);
  if (!tree || !node || !attempt?.lease || attempt.id !== attemptId || node.attemptId !== attemptId || attempt.outcome !== 'completed'
    || !Array.isArray(evidence) || evidence.length > 64 || evidence.some(value => !validEvidence(value))) return false;
  const combined = uniqueEvidence([...attempt.evidence, ...evidence]);
  if (taskNodeVerdict(node.contract, attempt.outcome, combined) !== 'done') return false;
  attempt.evidence = combined; store.putAttempt(scope, attempt);
  store.save(scope, { ...tree, revision: tree.revision + 1, nodes: tree.nodes.map(value => value.id === nodeId ? { ...value, state: 'done' } : value) }, 'verified', at);
  return true;
}
export function treeProofForTask(store: TaskTreeStore, scope: string, taskId: string): TaskResultProof | null {
  const tree = store.get(scope, taskId), attempt = tree && store.currentAttempt(tree);
  if (!tree || !tree.permissionId || tree.origin === 'unknown' || tree.budgetLane === 'unknown'
    || !attempt?.lease || attempt.outcome !== 'completed' || tree.nodes.some(node => node.state !== 'done' || node.attemptId !== attempt.id)) return null;
  const row = store.database.prepare('SELECT conversation_thread_id FROM agent_tasks WHERE scope_key=? AND task_id=?').get(scope, taskId) as { conversation_thread_id: string } | undefined;
  if (!row) return null;
  return { taskId, nodeId: tree.rootId, treeRevision: tree.revision, attemptId: attempt.id, actionId: attempt.lease.id,
    generation: attempt.lease.generation, holder: attempt.lease.holder, threadId: row.conversation_thread_id,
    status: 'verified', evidenceIds: attempt.evidence.map(value => value.id) };
}
function uniqueEvidence(values: readonly TaskProofEvidence[]): TaskProofEvidence[] { return [...new Map(values.map(value => [value.id, value])).values()]; }
function validEvidence(value: TaskProofEvidence): boolean {
  return !!value && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 500
    && typeof value.checkId === 'string' && typeof value.target === 'string' && value.target.length <= 1024
    && ['test', 'file', 'receipt', 'owner_acceptance'].includes(value.kind) && ['deterministic', 'independent', 'owner'].includes(value.verifiedBy);
}
