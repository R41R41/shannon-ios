import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { TASK_TREE_SCHEMA, taskTreeAuthority, taskTreeNodesProblem, taskTreeReplanProblem, type TaskNodeDraft, type TaskProofEvidence, type TaskTree, type TaskTreeAuthority } from '@shannon/mind';
import type { ActionLease } from '../../../../contracts/actionThreadContract.js';
import type { AgentTask, ClaimedAgentCommand, HostAgentEvent } from '../agentTaskStore.js';
import type { TaskTreeOperations, TaskTreeOwnerChange, TaskTreeProposal, TaskResultProof, TaskTreeLearningCallbacks, TaskDispatchExpectation } from '../taskTreePorts.js';
import { recordTreeHostEvent, verifyTreeEvidence, treeProofForTask } from './taskTreeEvidence.js';
import { migrateTaskTreeCallbacks, queueTaskTreeLearning, flushTaskTreeLearning, type TaskTreeLearningEvent } from './taskTreeCallbacks.js';
import { withAgentTaskRequest } from './agentTaskRequestWindow.js';

export interface TreeAttempt {
  id: string; taskId: string; commandId: string; lease: ActionLease | null;
  startedAt: string;
  outcome: 'running' | 'unknown' | 'completed' | 'failed' | 'cancelled';
  treeRevision: number; evidence: readonly TaskProofEvidence[];
}
/** Shares the task store connection and transaction. It never queues or claims execution. */
export class TaskTreeStore implements TaskTreeOperations {
  constructor(readonly database: DatabaseSync, private readonly callbacks?: TaskTreeLearningCallbacks, createSchema = true) {
    if (!createSchema) return;
    database.exec(`
      CREATE TABLE IF NOT EXISTS agent_task_trees (
        scope_key TEXT NOT NULL, task_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, tree_json TEXT NOT NULL,
        updated_at TEXT NOT NULL, FOREIGN KEY(task_id) REFERENCES agent_tasks(task_id));
      CREATE TABLE IF NOT EXISTS agent_task_tree_versions (
        scope_key TEXT NOT NULL, task_id TEXT NOT NULL, revision INTEGER NOT NULL, tree_json TEXT NOT NULL,
        made_by TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(task_id,revision));
      CREATE TABLE IF NOT EXISTS agent_task_tree_attempts (
        scope_key TEXT NOT NULL, task_id TEXT NOT NULL, attempt_id TEXT PRIMARY KEY,
        command_id TEXT NOT NULL, attempt_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_task_tree_proposals (
        scope_key TEXT NOT NULL, task_id TEXT NOT NULL, proposal_id TEXT PRIMARY KEY, proposal_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_task_tree_proposal_ops (
        scope_key TEXT NOT NULL,task_id TEXT NOT NULL,operation_id TEXT NOT NULL,proposal_id TEXT NOT NULL,request_hash TEXT NOT NULL,
        PRIMARY KEY(scope_key,task_id,operation_id));
      CREATE TABLE IF NOT EXISTS agent_task_tree_receipts (
        task_id TEXT NOT NULL, event_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL);
    `);
    migrateTaskTreeCallbacks(database);
  }
  ensure(task: Pick<AgentTask, 'id' | 'goal' | 'plan' | 'createdAt'>, scopeKey: string, at: string, authority?: TaskTreeAuthority): void {
    if (this.get(scopeKey, task.id)) return;
    const rootId = `root:${task.id}`;
    const tree: TaskTree = { schema: TASK_TREE_SCHEMA, taskId: task.id, revision: 1, rootId,
      goal: task.goal, content: task.goal, deadline: null,
      ...(taskTreeAuthority(authority) ?? { origin: 'unknown' as const, budgetLane: 'unknown' as const, ownerInformed: false, permissionId: null }), legacy: true,
      nodes: [{ id: rootId, parentId: null, order: 0, dependsOn: [], title: task.goal.slice(0, 160), contract: null, state: 'wait', attemptId: null },
        ...task.plan.map((item, order) => ({ id: item.id, parentId: rootId, order, dependsOn: [], title: item.title,
          contract: null, state: 'wait' as const, attemptId: null }))],
    };
    // Old plans were not required to have stable/unique IDs. Preserve every item with a safe migration key.
    const used = new Set([rootId]);
    tree.nodes.slice(1).forEach((node, index) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,159}$/u.test(node.id) || used.has(node.id)) node.id = `legacy:${task.id}:${index}`;
      used.add(node.id);
    });
    this.write(() => this.save(scopeKey, tree, 'migration', at));
  }
  get(scopeKey: string, taskId: string): TaskTree | null {
    const row = this.database.prepare('SELECT tree_json FROM agent_task_trees WHERE scope_key=? AND task_id=?').get(scopeKey, taskId) as { tree_json: string } | undefined;
    return row ? JSON.parse(row.tree_json) as TaskTree : null;
  }
  withRequestTaskId<T>(scopeKey: string, requestTaskId: string, operation: (storedTaskId: string) => T): T {
    try { return withAgentTaskRequest(this.database, scopeKey, requestTaskId, operation); }
    catch (error) {
      if (error instanceof Error && error.message === 'AGENT_TASK_NOT_FOUND') throw new Error('TREE_NOT_FOUND');
      throw error;
    }
  }
  proposals(scopeKey: string, taskId: string): readonly TaskTreeProposal[] {
    const rows = this.database.prepare('SELECT proposal_json FROM agent_task_tree_proposals WHERE scope_key=? AND task_id=? ORDER BY rowid DESC LIMIT 32')
      .all(scopeKey, taskId) as { proposal_json: string }[];
    return rows.map(row => JSON.parse(row.proposal_json) as TaskTreeProposal);
  }
  replan(scopeKey: string, taskId: string, expectedRevision: number, nodes: readonly TaskNodeDraft[], at: string): TaskTree {
    return this.write(() => {
      const current = this.required(scopeKey, taskId, expectedRevision);
      const problem = taskTreeReplanProblem(current, nodes, this.heldNodes(current));
      if (problem) throw new Error(problem);
      const next = this.replaceNodes(current, nodes);
      this.save(scopeKey, next, 'decomposition', at); return next;
    });
  }
  propose(scopeKey: string, taskId: string, expectedRevision: number, change: TaskTreeOwnerChange, at: string, operationId?: string): TaskTreeProposal {
    return this.write(() => {
      if (operationId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,159}$/u.test(operationId)) throw new Error('TREE_OPERATION_INVALID');
      const requestHash = createHash('sha256').update(JSON.stringify({ expectedRevision, change })).digest('hex');
      if (operationId) {
        const previous = this.database.prepare('SELECT p.proposal_json,o.request_hash FROM agent_task_tree_proposal_ops o JOIN agent_task_tree_proposals p ON p.proposal_id=o.proposal_id WHERE o.scope_key=? AND o.task_id=? AND o.operation_id=?')
          .get(scopeKey, taskId, operationId) as { proposal_json: string; request_hash: string } | undefined;
        if (previous) { if (previous.request_hash !== requestHash) throw new Error('TREE_OPERATION_CONFLICT'); return JSON.parse(previous.proposal_json) as TaskTreeProposal; }
      }
      const current = this.required(scopeKey, taskId, expectedRevision);
      this.checkOwnerChange(current, change);
      const proposal: TaskTreeProposal = { id: randomUUID(), taskId, expectedRevision,
        diffHash: createHash('sha256').update(JSON.stringify(change)).digest('hex'), change, state: 'proposed', ...(operationId ? { operationId } : {}) };
      this.database.prepare('INSERT INTO agent_task_tree_proposals VALUES (?,?,?,?)').run(scopeKey, taskId, proposal.id, JSON.stringify(proposal));
      if (operationId) this.database.prepare('INSERT INTO agent_task_tree_proposal_ops VALUES(?,?,?,?,?)').run(scopeKey, taskId, operationId, proposal.id, requestHash);
      return proposal;
    });
  }
  approve(scopeKey: string, taskId: string, proposalId: string, expectedRevision: number, diffHash: string, at: string): TaskTree {
    return this.write(() => {
      const row = this.database.prepare('SELECT proposal_json FROM agent_task_tree_proposals WHERE scope_key=? AND task_id=? AND proposal_id=?').get(scopeKey, taskId, proposalId) as { proposal_json: string } | undefined;
      if (!row) throw new Error('TREE_PROPOSAL_NOT_FOUND');
      const proposal = JSON.parse(row.proposal_json) as TaskTreeProposal;
      const current = this.required(scopeKey, taskId, expectedRevision);
      if (proposal.state !== 'proposed' || proposal.expectedRevision !== expectedRevision || proposal.diffHash !== diffHash) throw new Error('TREE_STALE_APPROVAL');
      this.checkOwnerChange(current, proposal.change);
      const next = { ...this.replaceNodes(current, proposal.change.nodes), goal: proposal.change.goal,
        content: proposal.change.content, deadline: proposal.change.deadline, legacy: false };
      next.nodes = next.nodes.map(node => ({ ...node, state: 'wait', attemptId: null }));
      this.save(scopeKey, next, 'owner_approval', at);
      this.database.prepare('UPDATE agent_task_tree_proposals SET proposal_json=? WHERE proposal_id=?').run(JSON.stringify({ ...proposal, state: 'approved' }), proposalId);
      this.database.prepare('UPDATE agent_tasks SET goal=?,updated_at=? WHERE scope_key=? AND task_id=?').run(next.content, at, scopeKey, taskId);
      return next;
    });
  }
  bindCommand(command: ClaimedAgentCommand, at: string): void {
    if (!['start', 'resume', 'steer'].includes(command.type)) return;
    const tree = this.get(command.scopeKey, command.taskId); if (!tree) return;
    const held = this.currentAttempt(tree);
    // A delivered command or a live turn is the same execution, not a new attempt.
    if (held && ['running', 'unknown'].includes(held.outcome)) return;
    const previous = this.database.prepare('SELECT attempt_id FROM agent_task_tree_attempts WHERE command_id=?').get(command.id);
    if (previous) return;
    const attempt: TreeAttempt = { id: command.id, commandId: command.id, taskId: command.taskId, lease: null,
      outcome: 'running', treeRevision: tree.revision, evidence: [], startedAt: at };
    this.putAttempt(command.scopeKey, attempt);
    const next = { ...tree, revision: tree.revision + 1, nodes: tree.nodes.map(node => ({ ...node, attemptId: attempt.id, state: 'continue' as const })) };
    attempt.treeRevision = next.revision; this.putAttempt(command.scopeKey, attempt);
    this.save(command.scopeKey, next, 'claim', at);
  }
  bindLease(commandId: string, lease: ActionLease): void {
    this.write(() => {
      const row = this.database.prepare('SELECT task_id,scope_key,lease_owner,created_at FROM agent_task_commands WHERE command_id=? AND status=\'leased\'').get(commandId) as { task_id: string; scope_key: string; lease_owner: string | null; created_at: string } | undefined;
      if (!row?.lease_owner) throw new Error('TREE_COMMAND_NOT_LEASED');
      const tree = this.get(row.scope_key, row.task_id); if (!tree) return;
      const attempt = this.currentAttempt(tree); if (!attempt) throw new Error('TREE_ATTEMPT_NOT_FOUND');
      if (attempt.lease && JSON.stringify(attempt.lease) !== JSON.stringify(lease)) throw new Error('TREE_ATTEMPT_HELD');
      attempt.lease = { ...lease }; this.putAttempt(row.scope_key, attempt);
      if (tree.permissionId && tree.origin !== 'unknown' && tree.budgetLane !== 'unknown'
        && !this.database.prepare('SELECT 1 FROM agent_task_tree_learning WHERE id=?').get(`dispatch:${attempt.id}`)) {
        let expectation: TaskDispatchExpectation | undefined;
        if (this.callbacks?.dispatchContext) {
          try { expectation = this.callbacks.dispatchContext(row.scope_key, { taskId: row.task_id, attemptId: attempt.id, at: attempt.startedAt }); }
          catch { expectation = { presence: 'unknown', value: null }; }
        }
        queueTaskTreeLearning(this.database, { id: `dispatch:${attempt.id}`, kind: 'dispatched', scopeKey: row.scope_key,
          taskId: row.task_id, attemptId: attempt.id, actionId: lease.id, at: attempt.startedAt, ...(expectation ? { expectation } : {}) });
      }
    });
    this.flushLearning();
  }
  allowsCommand(command: ClaimedAgentCommand): boolean {
    if (!['start', 'resume', 'steer'].includes(command.type)) return true;
    const tree = this.get(command.scopeKey, command.taskId);
    return !tree || this.currentAttempt(tree)?.outcome !== 'unknown';
  }
  acceptsEvent(scopeKey: string, event: HostAgentEvent): boolean {
    const tree = this.get(scopeKey, event.taskId), attempt = tree && this.currentAttempt(tree);
    if (!attempt?.lease) return true; // Grandfathered pre-Stage4 work continues; it gains no canonical proof.
    const lease = event.payload?.actionLease as ActionLease | undefined;
    return !!lease && lease.id === attempt.lease.id && lease.holder === attempt.lease.holder && lease.generation === attempt.lease.generation;
  }
  recordEvent(scopeKey: string, event: HostAgentEvent, at: string): void { recordTreeHostEvent(this, scopeKey, event, at); }
  verify(scopeKey: string, taskId: string, nodeId: string, attemptId: string, evidence: readonly TaskProofEvidence[], at: string): boolean {
    const result = this.write(() => {
      const verified = verifyTreeEvidence(this, scopeKey, taskId, nodeId, attemptId, evidence, at);
      this.queueVerified(scopeKey, taskId, at); return verified;
    });
    this.flushLearning(); return result;
  }
  flushLearning(): void { flushTaskTreeLearning(this.database, this.callbacks); }
  pendingLearningActions(scopeKey: string): readonly { taskId: string; actionId: string }[] {
    const rows = this.database.prepare('SELECT event_json FROM agent_task_tree_learning WHERE delivered=0 ORDER BY rowid LIMIT 128').all() as { event_json: string }[];
    return rows.flatMap(row => {
      const event = JSON.parse(row.event_json) as TaskTreeLearningEvent;
      const actionId = event.kind === 'verified' ? event.proof?.actionId : event.kind === 'dispatched' ? event.actionId : undefined;
      return event.scopeKey === scopeKey && typeof actionId === 'string' && actionId && typeof event.taskId === 'string'
        ? [{ taskId: event.taskId, actionId }] : [];
    });
  }
  queueVerified(scope: string, taskId: string, at: string): void {
    const proof = this.proofForTask(scope, taskId);
    if (proof) queueTaskTreeLearning(this.database, { id: `verified:${proof.attemptId}`, kind: 'verified', scopeKey: scope,
      taskId, attemptId: proof.attemptId, at, proof });
  }
  proofForTask(scopeKey: string, taskId: string): TaskResultProof | null { return treeProofForTask(this, scopeKey, taskId); }
  proofStatus(scopeKey: string, taskId: string): { status: 'verified'; proof: TaskResultProof } | { status: 'invalid' } | { status: 'unknown' } {
    try { const proof = this.proofForTask(scopeKey, taskId); return proof ? { status: 'verified', proof } : { status: 'invalid' }; }
    catch { return { status: 'unknown' }; }
  }
  currentAttempt(tree: TaskTree): TreeAttempt | null {
    const id = tree.nodes.find(node => node.id === tree.rootId)?.attemptId;
    if (!id) return null;
    const row = this.database.prepare('SELECT attempt_json FROM agent_task_tree_attempts WHERE attempt_id=? AND task_id=?').get(id, tree.taskId) as { attempt_json: string } | undefined;
    return row ? JSON.parse(row.attempt_json) as TreeAttempt : null;
  }
  putAttempt(scopeKey: string, attempt: TreeAttempt): void {
    this.database.prepare('INSERT INTO agent_task_tree_attempts VALUES (?,?,?,?,?) ON CONFLICT(attempt_id) DO UPDATE SET attempt_json=excluded.attempt_json')
      .run(scopeKey, attempt.taskId, attempt.id, attempt.commandId, JSON.stringify(attempt));
  }
  save(scopeKey: string, tree: TaskTree, madeBy: string, at: string): void {
    this.database.prepare('INSERT INTO agent_task_trees VALUES (?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET revision=excluded.revision,tree_json=excluded.tree_json,updated_at=excluded.updated_at')
      .run(scopeKey, tree.taskId, tree.revision, JSON.stringify(tree), at);
    this.database.prepare('INSERT INTO agent_task_tree_versions VALUES (?,?,?,?,?,?)').run(scopeKey, tree.taskId, tree.revision, JSON.stringify(tree), madeBy, at);
  }
  private required(scope: string, task: string, revision: number): TaskTree {
    const current = this.get(scope, task); if (!current) throw new Error('TREE_NOT_FOUND');
    if (!Number.isSafeInteger(revision) || current.revision !== revision) throw new Error('TREE_CONFLICT'); return current;
  }
  private heldNodes(tree: TaskTree): readonly string[] {
    const attempt = this.currentAttempt(tree);
    return attempt && ['running', 'unknown'].includes(attempt.outcome) ? tree.nodes.filter(node => node.attemptId === attempt.id).map(node => node.id) : [];
  }
  private checkOwnerChange(current: TaskTree, change: TaskTreeOwnerChange): void {
    if (!change || typeof change.goal !== 'string' || !change.goal.trim() || change.goal.length > 2000
      || Object.keys(change).some(key => !['goal', 'content', 'deadline', 'nodes'].includes(key))
      || typeof change.content !== 'string' || !change.content.trim() || change.content.length > 2000
      || change.deadline !== null && (typeof change.deadline !== 'string' || !Number.isFinite(Date.parse(change.deadline)))) throw new Error('TREE_CHANGE_INVALID');
    const problem = taskTreeNodesProblem(current.rootId, change.nodes); if (problem) throw new Error(problem);
    if (this.heldNodes(current).length) throw new Error('TREE_ATTEMPT_HELD');
  }
  private replaceNodes(current: TaskTree, nodes: readonly TaskNodeDraft[]): TaskTree {
    return { ...current, revision: current.revision + 1, nodes: nodes.map(node => {
      const old = current.nodes.find(value => value.id === node.id);
      return { id: node.id, parentId: node.parentId, order: node.order, dependsOn: [...node.dependsOn], title: node.title,
        contract: node.contract, state: old?.state ?? 'wait', attemptId: old?.attemptId
          ?? (this.heldNodes(current).length ? current.nodes.find(value => value.id === current.rootId)?.attemptId ?? null : null) };
    }) };
  }
  private write<T>(operation: () => T): T {
    if (this.database.isTransaction) return operation();
    this.database.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.database.exec('COMMIT'); return result; }
    catch (error) { if (this.database.isTransaction) this.database.exec('ROLLBACK'); throw error; }
  }
}
