import { randomUUID } from 'node:crypto';
import type { ShannonActionReceipt } from '@shannon/cognition';
import type { AgentTask } from './agentTaskStore.js';

export type ConversationActionKind = 'inspect' | 'implement' | 'update' | 'complete' | 'other';
export type ConversationActionStatus = 'pending' | 'proposed' | 'active' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface PendingConversationAction {
  kind: ConversationActionKind;
  summary: string;
  status: ConversationActionStatus;
}

export interface ConversationOrchestrationState {
  scopeKey: string;
  threadId: string;
  revision: number;
  pendingAction?: PendingConversationAction;
  awaitingConfirmation: boolean;
  approvedScope: readonly string[];
  addedRequirements: readonly string[];
  corrections: readonly string[];
  interruptedAt?: string;
  resumeToken?: string;
  sourceReferences: readonly string[];
  updatedAt: string;
}

export interface ConversationOrchestrationStore {
  read(scopeKey: string, threadId: string): ConversationOrchestrationState | null;
  save(state: ConversationOrchestrationState): ConversationOrchestrationState;
}

export class InMemoryConversationOrchestrationStore implements ConversationOrchestrationStore {
  private readonly values = new Map<string, ConversationOrchestrationState>();

  read(scopeKey: string, threadId: string): ConversationOrchestrationState | null {
    const value = this.values.get(key(scopeKey, threadId));
    return value ? freezeState(value) : null;
  }

  save(state: ConversationOrchestrationState): ConversationOrchestrationState {
    const value = freezeState(state);
    this.values.set(key(state.scopeKey, state.threadId), value);
    return value;
  }
}

export function observeConversationTurn(input: {
  previous: ConversationOrchestrationState | null;
  scopeKey: string;
  threadId: string;
  message: string;
  occurredAt: string;
  participantMode: 'owner' | 'guest';
  tasks: readonly AgentTask[];
}): ConversationOrchestrationState | null {
  if (input.participantMode === 'guest') return null;
  const message = compact(input.message, 1_000);
  const previous = reconcileTask(input.previous, input.tasks, input.threadId, input.occurredAt);
  const base = previous ?? initialState(input.scopeKey, input.threadId, input.occurredAt);
  if (!message) return base;

  const addition = /^(?:あと|それと|それも|ついでに|追加で|もう一つ)/u.test(message);
  const correction = /^(?:違う|ちがう|訂正|そうじゃなく|そうではなく|いや[、,]|ではなく|じゃなく)/u.test(message);
  const interruption = /^(?:いったん|一旦)?(?:止めて|中断して|待って|ストップ)/u.test(message);
  const resumption = /^(?:再開して|続けて|続きをお願い|続きやって)/u.test(message);
  const action = classifyAction(message);
  let next: ConversationOrchestrationState = { ...base, updatedAt: input.occurredAt };

  if (interruption && base.pendingAction) {
    next = { ...next, interruptedAt: input.occurredAt };
  } else if (resumption && base.pendingAction) {
    next = { ...next, interruptedAt: undefined };
  } else if (correction && base.pendingAction) {
    next = {
      ...next,
      corrections: appendBounded(base.corrections, message, 8),
      pendingAction: { ...base.pendingAction, summary: mergeSummary(base.pendingAction.summary, message) },
    };
  } else if (addition && base.pendingAction) {
    next = {
      ...next,
      addedRequirements: appendBounded(base.addedRequirements, message, 12),
      pendingAction: { ...base.pendingAction, summary: mergeSummary(base.pendingAction.summary, message) },
    };
  } else if (action) {
    next = {
      ...initialState(input.scopeKey, input.threadId, input.occurredAt),
      pendingAction: { kind: action, summary: message, status: 'pending' },
      approvedScope: requiresExplicitExecution(message) ? [message] : [],
      resumeToken: randomUUID(),
    };
  }
  return freezeState({ ...next, revision: base.revision + 1 });
}

export function recordConversationProposal(
  state: ConversationOrchestrationState,
  summary: string,
  occurredAt: string,
): ConversationOrchestrationState {
  return freezeState({
    ...state,
    revision: state.revision + 1,
    pendingAction: {
      kind: state.pendingAction?.kind ?? 'implement',
      summary: compact(summary, 1_200) || state.pendingAction?.summary || '作業提案',
      status: 'proposed',
    },
    awaitingConfirmation: true,
    resumeToken: state.resumeToken ?? randomUUID(),
    updatedAt: occurredAt,
  });
}

export function recordConversationReceipt(
  state: ConversationOrchestrationState,
  receipt: ShannonActionReceipt,
): ConversationOrchestrationState {
  const reference = `${receipt.capability}:${receipt.id}`;
  return freezeState({
    ...state,
    revision: state.revision + 1,
    pendingAction: state.pendingAction ? {
      ...state.pendingAction,
      status: receipt.status === 'failed' ? 'failed' : receipt.status === 'completed' ? 'completed' : state.pendingAction.status,
    } : state.pendingAction,
    sourceReferences: appendBounded(state.sourceReferences, reference, 16),
    updatedAt: receipt.occurredAt,
  });
}

export function buildConversationOrchestrationPrompt(
  state: ConversationOrchestrationState | null,
  tasks: readonly AgentTask[],
): string {
  if (!state?.pendingAction) return '';
  const receipts = tasks.filter(task => task.conversationThreadID === state.threadId
    && (task.id === state.resumeToken || `agent-task:${task.id}` === state.sourceReferences.at(-1)))
    .slice(0, 2).map(executionReceiptLine);
  return [
    '[Conversation execution state — durable coordination, not proof by itself]',
    `pendingAction=${state.pendingAction.kind}/${state.pendingAction.status}: ${state.pendingAction.summary}`,
    `awaitingConfirmation=${state.awaitingConfirmation}; approvedScope=${state.approvedScope.join(' | ') || 'none'}`,
    `addedRequirements=${state.addedRequirements.join(' | ') || 'none'}`,
    `corrections=${state.corrections.join(' | ') || 'none'}`,
    `interruptedAt=${state.interruptedAt ?? 'none'}; resumeToken=${state.resumeToken ?? 'none'}`,
    `sourceReferences=${state.sourceReferences.join(', ') || 'none'}`,
    ...receipts,
    'Treat additions and corrections as part of this same request. A correction invalidates the superseded assumption; never execute both versions.',
    'An explicit implementation request is already a request: do not ask the same conversational confirmation twice. The visible task proposal/start control remains the execution boundary.',
    'Only an executionReceipt or durable action receipt proves start, progress, failure, cancellation, or completion. Generated text and this state do not.',
    'Do not implicitly approve after a topic change, timeout, or guest-speaker turn. External sending, billing, publishing, distribution, deletion, and permission changes keep their existing approval boundaries.',
  ].join('\n');
}

function reconcileTask(
  previous: ConversationOrchestrationState | null,
  tasks: readonly AgentTask[],
  threadId: string,
  occurredAt: string,
): ConversationOrchestrationState | null {
  if (!previous) return null;
  const task = previous.resumeToken
    ? tasks.find(item => item.id === previous.resumeToken)
    : tasks.filter(item => item.conversationThreadID === threadId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (!task) return previous;
  const status: ConversationActionStatus = task.status === 'queued' || task.status === 'starting' || task.status === 'running'
    || task.status === 'waiting_approval' ? 'active' : task.status;
  return freezeState({
    ...previous,
    revision: previous.revision + 1,
    pendingAction: { kind: previous.pendingAction?.kind ?? 'implement', summary: task.goal, status },
    awaitingConfirmation: task.status === 'proposed',
    resumeToken: task.id,
    sourceReferences: appendBounded(previous.sourceReferences, `agent-task:${task.id}`, 16),
    ...(task.status === 'paused' ? { interruptedAt: task.updatedAt } : { interruptedAt: undefined }),
    updatedAt: occurredAt,
  });
}

function executionReceiptLine(task: AgentTask): string {
  const verification = task.tests.map(test => `${test.name}:${test.status}`).join(', ') || 'none';
  const artifacts = task.changes.map(change => change.path ?? change.displayName).join(', ') || 'none';
  const failure = task.status === 'failed' ? task.summary : 'none';
  const cancellation = task.status === 'cancelled' ? task.summary : 'none';
  return `executionReceipt workId=${task.id}; source=agent-host; startedAt=${task.createdAt}; target=${task.projectHint ?? 'unspecified'}; status=${task.status}; verification=${verification}; artifacts=${artifacts}; failure=${failure}; cancellation=${cancellation}`;
}

function classifyAction(message: string): ConversationActionKind | null {
  if (/(?:実装|修正|改善|変更|追加|削除|統合|構築|作成|開発).{0,80}(?:して|お願い|ほしい|やって|進めて)|(?:して|やって|進めて)(?:ください|ほしい|お願い)?$/u.test(message)) return 'implement';
  if (/(?:完了|終わり|済み).{0,40}(?:にして|更新して)/u.test(message)) return 'complete';
  if (/(?:更新|反映|書き換え).{0,60}(?:して|お願い|ほしい)/u.test(message)) return 'update';
  if (/(?:見て|確認して|調べて|読んで|探して)/u.test(message)) return 'inspect';
  return null;
}

function requiresExplicitExecution(message: string): boolean {
  return /(?:実装|修正|改善|変更|追加|削除|統合|構築|作成|開発|更新|反映).{0,80}(?:して|お願い|ほしい|やって|進めて)/u.test(message);
}

function initialState(scopeKey: string, threadId: string, occurredAt: string): ConversationOrchestrationState {
  return freezeState({ scopeKey, threadId, revision: 0, awaitingConfirmation: false,
    approvedScope: [], addedRequirements: [], corrections: [], sourceReferences: [], updatedAt: occurredAt });
}

function mergeSummary(current: string, addition: string): string {
  return compact(`${current} / ${addition}`, 1_200);
}

function appendBounded(values: readonly string[], value: string, maximum: number): readonly string[] {
  const normalized = compact(value, 1_000);
  return [...values.filter(item => item !== normalized), normalized].filter(Boolean).slice(-maximum);
}

function freezeState(state: ConversationOrchestrationState): ConversationOrchestrationState {
  return Object.freeze({ ...state,
    ...(state.pendingAction ? { pendingAction: Object.freeze({ ...state.pendingAction }) } : {}),
    approvedScope: Object.freeze([...state.approvedScope]),
    addedRequirements: Object.freeze([...state.addedRequirements]),
    corrections: Object.freeze([...state.corrections]),
    sourceReferences: Object.freeze([...state.sourceReferences]),
  });
}

function compact(value: string, maximum: number): string {
  return Array.from(value.replace(/\s+/gu, ' ').trim()).slice(0, maximum).join('');
}

function key(scopeKey: string, threadId: string): string { return `${scopeKey}\u0000${threadId}`; }
