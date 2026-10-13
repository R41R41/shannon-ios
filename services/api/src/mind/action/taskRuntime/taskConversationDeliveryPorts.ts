import type { ActionLease } from '@shannon/mind';
import type { TaskConversationSource, TaskStep } from './taskRuntimePorts.js';

/** Confirmed voice input identity; only a digest of the original input is retained here. */
export interface TaskConversationDeliveryInput { utteranceId: string; deviceId: string; inputDigest: string }
export interface TaskConversationDelivery extends TaskConversationDeliveryInput {
  scopeKey: string; threadId: string; taskId: string; stepId: string;
  state: 'generating' | 'staged' | 'bound' | 'failed'; experienceId: string | null;
  /** When the delivery began (absent from a store that does not say). */
  createdAt?: string;
}
export type TaskConversationDeliveryBegin = { status: 'started'; step: TaskStep } | { status: 'duplicate' | 'conflict' | 'unavailable' };
export interface TaskConversationDeliveryStage {
  source: Omit<TaskConversationSource, 'experienceId'>;
  consumedMessageIds: readonly string[];
}
export interface TaskConversationDeliveryRuntime {
  conversationDelivery(scopeKey: string, threadId: string, utteranceId: string): TaskConversationDelivery | null;
  beginConversationDelivery(scopeKey: string, threadId: string, lease: ActionLease, input: TaskConversationDeliveryInput): TaskConversationDeliveryBegin;
  stageConversationDelivery(step: TaskStep, input: TaskConversationDeliveryStage): boolean;
  bindConversationDelivery(scopeKey: string, input: TaskConversationDeliveryInput & { threadId: string; experienceId: string }): boolean;
}
