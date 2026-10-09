import { isOwnerOnly, type CompanionStateStore } from '@shannon/cognition';
import { prepareTurnCognitiveContext } from '../workspace/contextPorts.js';
import type { ConversationStore } from '../memory/memoryPorts.js';
import type { TaskMemory } from '../memory/taskMemoryPorts.js';
import type { TurnMemoryRecall } from './turnMemoryRecall.js';
import type { TaskRecall, TaskRecallInput, TaskRecallPacket } from './taskRecallPorts.js';
interface Entry { version: string; cue: string; ids: string[]; done: Promise<void>; controller: AbortController; status: TaskRecallPacket['status'] }
export function createTaskRecall(parts: {
  state: Pick<CompanionStateStore, 'snapshot'>; conversations: ConversationStore; memory: TaskMemory;
  enrich: Pick<TurnMemoryRecall, 'enrich'> | null; now(): string;
}): TaskRecall {
  const entries = new Map<string, Entry>();
  // Paid work remains tracked after its cache entry is invalidated, until its actual promise unwinds.
  const pending = new Map<string, Set<Entry>>();
  const keyOf = (input: Pick<TaskRecallInput, 'scopeKey' | 'taskId'>) => `${input.scopeKey}\u0000${input.taskId}`;
  const cancel = (scopeKey: string, taskId: string) => {
    const key = keyOf({ scopeKey, taskId }); entries.get(key)?.controller.abort(); entries.delete(key);
    for (const entry of pending.get(key) ?? []) entry.controller.abort();
  };
  const start = (input: TaskRecallInput) => {
    if (input.cue.length > 4000 || input.contextVersion.length > 240) throw new Error('TASK_RECALL_INPUT');
    if (input.signal?.aborted || !isOwnerOnly(input.present) || !parts.memory.available(input.scopeKey, input.present)) return;
    const key = keyOf(input), prior = entries.get(key);
    if (prior?.version === input.contextVersion && prior.cue === input.cue) {
      input.signal?.addEventListener('abort', () => { prior.controller.abort(); if (entries.get(key) === prior) entries.delete(key); }, { once: true });
      return;
    }
    cancel(input.scopeKey, input.taskId);
    if (entries.size >= 256) { const first = entries.keys().next().value!; entries.get(first)?.controller.abort(); entries.delete(first); }
    const entry: Entry = { version: input.contextVersion, cue: input.cue, ids: [], done: Promise.resolve(), controller: new AbortController(), status: 'searching' };
    entries.set(key, entry);
    input.signal?.addEventListener('abort', () => { entry.controller.abort(); if (entries.get(key) === entry) entries.delete(key); }, { once: true });
    try {
      const snapshot = parts.state.snapshot(input.scopeKey);
      const context = prepareTurnCognitiveContext(snapshot, parts.conversations, { scopeKey: input.scopeKey, message: input.cue,
        occurredAt: parts.now(), channel: 'system', present: input.present, currentGoal: input.cue });
      entry.ids = [...new Set([...parts.memory.search(input.scopeKey, input.cue, input.present).map(item => item.id), ...context.memories.map(item => item.id)])];
      if (!parts.enrich) { entry.status = entry.ids.length ? 'ready' : 'no_match'; return; }
      const running = pending.get(key) ?? new Set<Entry>(); running.add(entry); pending.set(key, running);
      entry.done = parts.enrich.enrich(context, { scopeKey: input.scopeKey, message: input.cue, snapshot, memoryTurn: true, signal: entry.controller.signal })
        .then(result => {
          if (entry.controller.signal.aborted || entries.get(key) !== entry) return;
          entry.ids = [...new Set([...entry.ids, ...result.memories.map(item => item.id), ...result.frame.recalledMemoryIDs])];
          entry.status = ['failed', 'timeout'].includes(result.memoryRecall.status) ? 'failed' : entry.ids.length ? 'ready' : 'no_match';
        }).catch(() => { if (!entry.controller.signal.aborted && entries.get(key) === entry) entry.status = 'failed'; })
        .finally(() => { running.delete(entry); if (!running.size && pending.get(key) === running) pending.delete(key); });
    } catch { entry.status = 'failed'; pending.get(key)?.delete(entry); if (!pending.get(key)?.size) pending.delete(key); }
  };
  return { start, cancel, async finishSegment(scopeKey, taskId) {
    const key = keyOf({ scopeKey, taskId }), current = entries.get(key);
    const running = [...pending.get(key) ?? []];
    for (const entry of running) entry.controller.abort();
    await Promise.all(running.map(entry => entry.done));
    if (current?.status === 'searching') current.status = 'failed';
  }, async cancelAll() {
    const running = [...new Set([...entries.values(), ...[...pending.values()].flatMap(rows => [...rows])])];
    for (const entry of running) entry.controller.abort(); entries.clear();
    await Promise.all(running.map(entry => entry.done));
  }, async packet(input, options = {}) {
    const empty = (status: TaskRecallPacket['status']): TaskRecallPacket => ({ contextVersion: input.contextVersion, observedAt: parts.now(), status, items: [], sourceIds: [] });
    if (input.signal?.aborted) return empty('cancelled');
    if (!parts.memory.available(input.scopeKey, input.present)) { cancel(input.scopeKey, input.taskId); return empty('withheld'); }
    start(input);
    const entry = entries.get(keyOf(input)); if (!entry) return empty('cancelled');
    const milliseconds = Math.min(4000, Math.max(0, options.waitMilliseconds ?? 0));
    if (milliseconds && entry.status === 'searching') {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([entry.done, new Promise<void>(resolve => { timer = setTimeout(resolve, milliseconds); })]);
      if (timer) clearTimeout(timer);
    }
    if (input.signal?.aborted || entries.get(keyOf(input)) !== entry) return empty('cancelled');
    if (!parts.memory.available(input.scopeKey, input.present)) { cancel(input.scopeKey, input.taskId); return empty('withheld'); }
    const items = parts.memory.read(input.scopeKey, entry.ids, input.present).slice(0, 8).map(item => Object.freeze({ ...item, summary: item.summary.slice(0, 500) }));
    const status = entry.status === 'ready' && !items.length ? 'no_match' : entry.status;
    return Object.freeze({ contextVersion: input.contextVersion, observedAt: parts.now(), status, items: Object.freeze(items), sourceIds: Object.freeze(parts.memory.sources(input.scopeKey, items.map(item => item.id))) });
  } };
}
