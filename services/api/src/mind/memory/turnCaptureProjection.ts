import { isMemoryEvidenceVisible, visibleMemoryText, type CompanionStateSnapshot, type CompanionStateStore, type ProspectiveMemory, type ShannonIntent } from '@shannon/cognition';
import type { ConversationStore, StoredConversationMessage } from './conversationContract.js';
import type { TurnCaptureRecord, TurnCaptureView, ReminderReference, ReminderView } from './store/turnCaptures.js';
import { intentCaptureKey, ownerFacingStatement } from './turnCaptureKeys.js';

function visibleCommitment(state: CompanionStateSnapshot, id: string): { memory: ProspectiveMemory; text: string } | null {
  const memory = state.prospectiveMemories.find(item => item.id === id);
  if (!memory || memory.status === 'dismissed') return null;
  const text = visibleMemoryText(state, memory.id, memory.summary);
  if (!text || (memory.sourceExperienceId && !visibleMemoryText(state, memory.sourceExperienceId, memory.summary))) return null;
  return { memory, text };
}

/** Applies the current forget/cancel/dismiss state. Hidden items yield no line. */
export function resolveTurnCaptures(
  records: readonly TurnCaptureRecord[], state: CompanionStateSnapshot, intents: readonly ShannonIntent[],
): Map<string, TurnCaptureView[]> {
  const byTurn = new Map<string, TurnCaptureView[]>();
  const sourceVisible = (turnId: string) => !state.memoryControls.some(control => control.memoryId === turnId && control.status !== 'active');
  for (const record of records) {
    if (!sourceVisible(record.turnId)) continue;
    const { turnId, ...base } = record;
    let view: TurnCaptureView | null = null;
    if (record.kind === 'commitment' && record.itemId) {
      const current = visibleCommitment(state, record.itemId);
      const corrected = state.memoryControls.find(control => control.memoryId === record.itemId)?.overrideText;
      const { dueDate: _date, dueAt: _at, dueHint: _hint, timeZone: _zone, ...undated } = base;
      if (current) view = { ...undated, text: corrected ? current.text : record.text,
        ...(current.memory.dueDate ? { dueDate: current.memory.dueDate } : {}),
        ...(current.memory.dueAt ? { dueAt: current.memory.dueAt } : {}),
        ...(current.memory.dueHint ? { dueHint: current.memory.dueHint } : {}),
        ...(current.memory.timeZone ? { timeZone: current.memory.timeZone } : {}),
        status: current.memory.status === 'completed' ? 'completed' : 'active' };
    } else if (record.kind === 'knowledge' && record.itemId) {
      const stored = state.userFacts.find(item => item.id === record.itemId) ?? state.relationships.find(item => item.id === record.itemId);
      const text = stored ? visibleMemoryText(state, stored.id, stored.statement) : null;
      const { previousText, ...withoutPrevious } = base;
      if (text) view = { ...withoutPrevious, text: ownerFacingStatement(text),
        ...(previousText && isMemoryEvidenceVisible(state, previousText) ? { previousText: ownerFacingStatement(previousText) } : {}),
        status: 'active' };
    } else if (record.kind === 'intent' && record.itemId) {
      const matching = intents.filter(item => intentCaptureKey(item.title) === record.itemId);
      const intent = matching.find(item => item.status === 'active') ?? matching.find(item => item.status !== 'dismissed');
      if (intent && !matching.some(item => item.status === 'dismissed' && item.updatedAt > intent.updatedAt)) {
        view = { ...base, itemId: intent.id, text: intent.title, status: intent.status === 'completed' ? 'completed' : 'active' };
      }
    } else if (record.kind === 'notice') {
      view = { ...base, status: 'active' };
    }
    if (view) byTurn.set(turnId, [...byTurn.get(turnId) ?? [], view]);
  }
  return byTurn;
}

/** Only the newest reminder about a promise offers actions; older ones are plain history. */
export function resolveReminders(
  messages: readonly { id: string; reminder?: ReminderReference }[], state: CompanionStateSnapshot,
): Map<string, ReminderView> {
  const views = new Map<string, ReminderView>();
  const newest = new Map<string, string>();
  for (const message of messages) if (message.reminder) newest.set(message.reminder.commitmentId, message.id);
  for (const message of messages) {
    if (!message.reminder) continue;
    const memory = state.prospectiveMemories.find(item => item.id === message.reminder!.commitmentId);
    const text = memory ? visibleMemoryText(state, memory.id, memory.summary) : null;
    if (!memory || !text || (memory.sourceExperienceId && !visibleMemoryText(state, memory.sourceExperienceId, memory.summary))) continue;
    const reminderState: ReminderView['state'] = newest.get(memory.id) !== message.id ? 'superseded'
      : memory.status === 'completed' ? 'completed' : memory.status === 'dismissed' ? 'dismissed'
        : memory.remindAfter && memory.updatedAt !== message.reminder.revision ? 'snoozed' : 'pending';
    views.set(message.id, { commitmentId: memory.id, state: reminderState, text });
  }
  return views;
}

export interface ConversationCaptureDependencies {
  conversationStore: ConversationStore;
  stateStore: CompanionStateStore;
  cognitiveIntents: { list(scopeKey: string): readonly ShannonIntent[] };
}

/** The Talk history as clients read it: each reply carries what it captured, each reminder its promise. */
export function conversationWithCaptures(
  dependencies: ConversationCaptureDependencies, scopeKey: string, threadId: string,
): readonly StoredConversationMessage[] {
  const messages = dependencies.conversationStore.conversationHistory(scopeKey, threadId);
  const state = dependencies.stateStore.snapshot(scopeKey);
  const turnIds = [...new Set(messages.flatMap(message => message.role === 'assistant' && message.sourceExperienceId
    ? [message.sourceExperienceId] : []))];
  const records = turnIds.length ? dependencies.conversationStore.turnCaptures?.(scopeKey, turnIds) ?? [] : [];
  const captures = records.length ? resolveTurnCaptures(records, state, dependencies.cognitiveIntents.list(scopeKey)) : null;
  const reminders = resolveReminders(messages.map(message => ({ id: message.id,
    ...(message.reminder && 'revision' in message.reminder ? { reminder: message.reminder } : {}) })), state);
  return Object.freeze(messages.map(message => {
    const { reminder: _reference, captures: _stale, recalledMemoryIds: _provenance, ...plain } = message;
    const captured = message.role === 'assistant' && message.sourceExperienceId ? captures?.get(message.sourceExperienceId) : undefined;
    const reminder = reminders.get(message.id);
    return Object.freeze({ ...plain, ...(captured?.length ? { captures: Object.freeze(captured) } : {}), ...(reminder ? { reminder } : {}) });
  }));
}
