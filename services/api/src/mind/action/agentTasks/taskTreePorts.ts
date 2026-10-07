import type { TaskNodeDraft, TaskProofEvidence, TaskTree } from '@shannon/mind';
import type { ActionLease } from '../../../contracts/actionThreadContract.js';
import type { ValueRead } from '@shannon/learning';
export type { TaskFinishCheck, TaskFinishContract, TaskNodeDraft, TaskTree, TaskTreeNode, TaskProofEvidence, TaskTreeAuthority } from '@shannon/mind';
export interface TaskResultProof {
  taskId: string; nodeId: string; treeRevision: number; attemptId: string;
  actionId: string; generation: number; holder: string; threadId: string;
  status: 'verified'; evidenceIds: readonly string[];
}
export interface TaskTreeOwnerChange {
  goal: string; content: string; deadline: string | null; nodes: readonly TaskNodeDraft[];
}
export interface TaskTreeProposal {
  id: string; taskId: string; expectedRevision: number; diffHash: string;
  operationId?: string;
  change: TaskTreeOwnerChange; state: 'proposed' | 'approved';
}
/** Only wiring's canonical task/claim/event paths call mutation and evidence methods. */
export interface TaskTreeOperations {
  flushLearning(): void;
  /** Original IDs only, from the same bounded undelivered window that flushLearning processes. */
  pendingLearningActions(scopeKey: string): readonly { taskId: string; actionId: string }[];
  get(scopeKey: string, taskId: string): TaskTree | null;
  proposals(scopeKey: string, taskId: string): readonly TaskTreeProposal[];
  replan(scopeKey: string, taskId: string, expectedRevision: number, nodes: readonly TaskNodeDraft[], at: string): TaskTree;
  propose(scopeKey: string, taskId: string, expectedRevision: number, change: TaskTreeOwnerChange, at: string, operationId?: string): TaskTreeProposal;
  approve(scopeKey: string, taskId: string, proposalId: string, expectedRevision: number, diffHash: string, at: string): TaskTree;
  bindLease(commandId: string, lease: ActionLease): void;
  verify(scopeKey: string, taskId: string, nodeId: string, attemptId: string, evidence: readonly TaskProofEvidence[], at: string): boolean;
  proofForTask(scopeKey: string, taskId: string): TaskResultProof | null;
  proofStatus(scopeKey: string, taskId: string): { status: 'verified'; proof: TaskResultProof } | { status: 'invalid' } | { status: 'unknown' };
}
export interface TaskTreeLearningCallbacks {
  /** Read-only original dispatch snapshot. Failure stores unknown/null instead of borrowing a later value version. */
  dispatchContext?(scopeKey: string, input: { taskId: string; attemptId: string; at: string }): TaskDispatchExpectation;
  taskDispatched(scopeKey: string, input: { taskId: string; attemptId: string; actionId?: string; at: string; expectation?: TaskDispatchExpectation }): void | boolean;
  taskVerified(scopeKey: string, proof: TaskResultProof, at: string): void | boolean;
  taskUnusable(scopeKey: string, input: { taskId: string; attemptId: string; at: string; reason: 'failed' | 'cancelled' | 'unknown' }): void | boolean;
}
export interface TaskDispatchExpectation { presence: 'alone' | 'others' | 'away' | 'unknown'; value: ValueRead | null; }
