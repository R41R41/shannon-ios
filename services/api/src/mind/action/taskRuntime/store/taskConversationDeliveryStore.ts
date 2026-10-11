import type { DatabaseSync } from 'node:sqlite';
import type { ActionLease } from '@shannon/mind';
import type { TaskAuthority, TaskStep } from '../taskRuntimePorts.js';
import type { TaskConversationDelivery, TaskConversationDeliveryBegin, TaskConversationDeliveryInput, TaskConversationDeliveryStage } from '../taskConversationDeliveryPorts.js';
import type { TaskSourceStore } from './taskSourceStore.js';

/** A visible-history receipt, never proof that generated speech was played. All children retain the pending source. */
export class TaskConversationDeliveryStore {
  constructor(private readonly db: DatabaseSync, private readonly parts: {
    authority: TaskAuthority; sources: TaskSourceStore; now(): string;
    begin(scope: string, thread: string, lease: ActionLease, claim: (step: TaskStep) => void): TaskStep | null;
    matches(step: TaskStep): boolean;
    observed(step: TaskStep): readonly string[];
    staged(step: TaskStep): void;
    bound(scope: string, stepId: string, taskId: string): void;
  }) {
  }
  get(scope: string, thread: string, utterance: string): TaskConversationDelivery | null {
    const row = this.db.prepare('SELECT * FROM fca_conversation_deliveries WHERE scope_key=? AND thread_id=? AND utterance_id=?').get(scope, thread, utterance);
    return row ? { scopeKey: scope, threadId: thread, utteranceId: utterance, deviceId: String(row.device_id), inputDigest: String(row.input_digest),
      taskId: String(row.task_id), stepId: String(row.step_id), state: row.state as TaskConversationDelivery['state'], experienceId: row.experience_id as string | null } : null;
  }
  begin(scope: string, thread: string, lease: ActionLease, input: TaskConversationDeliveryInput): TaskConversationDeliveryBegin {
    identity(input); bounded(scope, 160); bounded(thread, 160);
    const prior = () => {
      const existing = this.get(scope, thread, input.utteranceId);
      return existing ? { status: existing.deviceId === input.deviceId && existing.inputDigest === input.inputDigest ? 'duplicate' as const : 'conflict' as const } : null;
    };
    const known = prior(); if (known) return known;
    const raced = new Error('FCA_VOICE_INPUT_ALREADY_CLAIMED');
    try {
      // The callback runs inside beginConversation's own transaction, so receipt and source exist together.
      const step = this.parts.begin(scope, thread, lease, step => {
        if (prior()) throw raced;
        this.db.prepare(`INSERT INTO fca_conversation_deliveries(scope_key,thread_id,utterance_id,device_id,input_digest,task_id,step_id,state,created_at)
          VALUES(?,?,?,?,?,?,?,'generating',?)`).run(scope, thread, input.utteranceId, input.deviceId, input.inputDigest, step.taskId, step.id, this.parts.now());
      });
      return step ? { status: 'started', step } : prior() ?? { status: 'unavailable' };
    } catch (error) { if (error === raced) return prior()!; throw error; }
  }

  stage(step: TaskStep, input: TaskConversationDeliveryStage): boolean {
    bounded(input.source.threadId, 160);
    if (!Number.isFinite(Date.parse(input.source.observedAt))) throw new Error('FCA_SOURCE');
    for (const ids of [input.source.recalledMemoryIds, input.source.readSourceIds ?? []]) {
      if (!Array.isArray(ids) || ids.length > 5000 || ids.some(id => typeof id !== 'string' || !id || id.length > 240)) throw new Error('FCA_SOURCE');
    }
    return this.parts.authority.transaction(() => {
      const row = this.db.prepare('SELECT * FROM fca_conversation_deliveries WHERE scope_key=? AND step_id=? AND task_id=?').get(step.scopeKey, step.id, step.taskId);
      if (!row || row.state !== 'generating' || row.thread_id !== input.source.threadId || !this.parts.matches(step)) return false;
      const observed = this.parts.observed(step);
      if (input.consumedMessageIds.some(id => !step.messageIds.includes(id) || !observed.includes(id))) throw new Error('FCA_MESSAGE_NOT_OBSERVED');
      this.db.prepare("UPDATE fca_conversation_deliveries SET state='staged',source_json=?,messages_json=? WHERE step_id=?")
        .run(JSON.stringify(input.source), JSON.stringify([...new Set(input.consumedMessageIds)]), step.id);
      this.parts.staged(step);
      return true;
    });
  }
  bind(scope: string, input: TaskConversationDeliveryInput & { threadId: string; experienceId: string }): boolean {
    identity(input); bounded(input.threadId, 160); bounded(input.experienceId, 160);
    return this.parts.authority.transaction(() => {
      const row = this.db.prepare('SELECT * FROM fca_conversation_deliveries WHERE scope_key=? AND thread_id=? AND utterance_id=?')
        .get(scope, input.threadId, input.utteranceId);
      if (!row || row.device_id !== input.deviceId || row.input_digest !== input.inputDigest) return false;
      if (row.state === 'bound') return row.experience_id === input.experienceId;
      if (row.state !== 'staged') return false;
      const source = JSON.parse(String(row.source_json)) as TaskConversationDeliveryStage['source'];
      if (!this.parts.sources.bind(scope, String(row.step_id), { ...source, experienceId: input.experienceId })) return false;
      for (const id of JSON.parse(String(row.messages_json)) as string[]) {
        this.db.prepare('UPDATE fca_task_messages SET consumed_by=? WHERE scope_key=? AND target_task_id=? AND message_id=? AND consumed_by IS NULL')
          .run(String(row.step_id), scope, String(row.task_id), id);
      }
      this.db.prepare("UPDATE fca_conversation_deliveries SET state='bound',experience_id=? WHERE step_id=?").run(input.experienceId, String(row.step_id));
      this.parts.bound(scope, String(row.step_id), String(row.task_id));
      return true;
    });
  }
  /** Reserved inbox reports were rendered once; they wait for canonical history and are not rendered by another turn. */
  reserved(taskId: string, messageId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM fca_conversation_deliveries d,json_each(d.messages_json) m
      WHERE d.task_id=? AND d.state='staged' AND m.value=? LIMIT 1`).get(taskId, messageId));
  }
  fail(step: TaskStep): void {
    this.db.prepare("UPDATE fca_conversation_deliveries SET state='failed' WHERE scope_key=? AND task_id=? AND step_id=? AND state='generating'")
      .run(step.scopeKey, step.taskId, step.id);
  }
}
function bounded(value: string, maximum: number): void {
  if (typeof value !== 'string' || !value || value.length > maximum) throw new Error('FCA_DELIVERY_ID');
}
function identity(input: TaskConversationDeliveryInput): void {
  bounded(input.utteranceId, 120); bounded(input.deviceId, 160);
  if (!/^[a-f0-9]{64}$/u.test(input.inputDigest)) throw new Error('FCA_DELIVERY_INPUT');
}
