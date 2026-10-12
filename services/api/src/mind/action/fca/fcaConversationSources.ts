import { conversationSecrets } from '../../inhibition/disclosurePorts.js';
import { createTaskMemory } from '../../memory/taskMemoryPorts.js';
import { memoryIdentifier, visibleMemoryText, type CompanionStateSnapshot, type CompanionStateStore } from '@shannon/cognition';
import { MemoryWithholding } from '../../memory/memoryVisibilityPorts.js';
import type { TaskMemoryReadSnapshot } from '../../memory/taskMemoryPorts.js';
import type { ConversationStore } from '../../memory/memoryPorts.js';
import type { TaskRuntime, TaskSource, TaskView } from '../taskRuntime/taskRuntimePorts.js';
import type { FcaReadReceipt, FcaObservedSources, FcaSourceGuard } from './fcaConversationPorts.js';
import { shannonTool } from '../../tools/toolRegistryPorts.js';

/** Closed provenance covers replay and its summary lineage without copying either into the task's history. */
export function conversationFcaProvenance(state: CompanionStateSnapshot, conversations: ConversationStore,
  scopeKey: string, threadId: string, recalledMemoryIds: readonly string[]): string[] {
  const withholding = new MemoryWithholding(state, conversations, scopeKey);
  const lineage = conversations.threadSummaryLineage?.(scopeKey, threadId)?.messages
    ?? conversations.conversationHistory(scopeKey, threadId);
  // The shared-state/profile block can contain a fact even when semantic recall did not select it.
  const profile = [
    ...state.userFacts.map(item => [item.id, item.statement] as const),
    ...state.relationships.map(item => [item.id, item.statement] as const),
    ...state.activeMemories.map(item => [item.id, item.summary] as const),
    ...state.prospectiveMemories.filter(item => item.status === 'pending').map(item => [item.id, item.summary] as const),
    ...state.interests.map(item => [memoryIdentifier('interest', item), item] as const),
  ].filter(([id, text]) => visibleMemoryText(state, id, text)).map(([id]) => id);
  return [...new Set([...recalledMemoryIds, ...profile, ...lineage.filter(message => !withholding.withholdsMessage(message))
    .flatMap(message => message.sourceExperienceId ? [message.sourceExperienceId] : [])])];
}

/**
 * How long one verdict on a task's provenance is reused while the companion state keeps the same version (a forget, a correction
 * or any other state change is a new version, so it is judged afresh). One voice turn asked the same question dozens of times
 * before its model call (every task and memory tool's availability, the inbox, each child), each a full walk of the recall
 * graph on the API's one thread: 2026-10-12, ~100 s with the event loop blocked and the respond lease expired unrenewed.
 */
export const FCA_SOURCE_VERDICT_MS = 5_000;
const FCA_SOURCE_VERDICTS_KEPT = 256;

/** Re-read canonical conversation provenance under today's memory controls; native task history is never edited. */
export function createFcaSourceGuard(parts: {
  runtime: TaskRuntime; state: Pick<CompanionStateStore, 'snapshot'>; conversations: ConversationStore;
  ownerScope: string; ownerAlone(): boolean;
  readSourceVisible?(scopeKey: string, id: string, observedAt: string, shared?: TaskMemoryReadSnapshot): boolean;
  /** Milliseconds for the verdict reuse above; `Date.now` unless a test moves it. */
  clock?(): number;
}): FcaSourceGuard {
  /** A verdict, and every read receipt's availability it consulted: those can change without a new state version. */
  type Verdict = { version: number; at: number; visible: boolean; reads: ReadonlyArray<readonly [string, string, boolean]> };
  const verdicts = new Map<string, Verdict>();
  const clock = parts.clock ?? Date.now;
  /** Read receipts asked once per check (with the check's own snapshot), and recorded for the verdict. */
  const recordedReads = (state: CompanionStateSnapshot, scopeKey: string) => {
    const seen = new Map<string, readonly [string, string, boolean]>();
    let withholding: MemoryWithholding | null = null;
    const check = parts.readSourceVisible ? (scope: string, id: string, observedAt: string): boolean => {
      if (scope !== scopeKey) return parts.readSourceVisible!(scope, id, observedAt);
      const key = JSON.stringify([id, observedAt]);
      if (!seen.has(key)) {
        withholding ??= new MemoryWithholding(state, parts.conversations, scopeKey);
        seen.set(key, [id, observedAt, parts.readSourceVisible!(scope, id, observedAt, { state, withholding })]);
      }
      return seen.get(key)![2];
    } : undefined;
    return { check, list: () => [...seen.values()] };
  };
  /** Still the same answers for every receipt a stored verdict consulted, under the current snapshot. */
  const readsUnchanged = (state: CompanionStateSnapshot, scopeKey: string, reads: Verdict['reads']): boolean => {
    if (!reads.length) return true;
    const again = recordedReads(state, scopeKey);
    return reads.every(([id, observedAt, visible]) => again.check?.(scopeKey, id, observedAt) === visible);
  };
  const sourcesVisible: FcaSourceGuard['sources'] = (scopeKey, task, sources, pendingStepId) => {
    if (scopeKey !== parts.ownerScope) return false;
    try {
      // Who can hear is asked every time; only the provenance walk is reused.
      if (!parts.ownerAlone()) return false;
      if (task.scopeKey !== scopeKey) return false;
      if (!sources.length) return true; // Direct owner API tasks have no inherited conversation source.
      const state = parts.state.snapshot(scopeKey), at = clock();
      const key = JSON.stringify([scopeKey, task.id, task.title, task.goal, task.completionCriteria, task.summary, pendingStepId ?? null, sources]);
      const known = verdicts.get(key);
      if (known && known.version === state.version && at >= known.at && at - known.at < FCA_SOURCE_VERDICT_MS
        && readsUnchanged(state, scopeKey, known.reads)) return known.visible;
      const reads = recordedReads(state, scopeKey), checked = { ...parts, readSourceVisible: reads.check };
      const withholding = new MemoryWithholding(state, parts.conversations, scopeKey, undefined, reads.check);
      // One synchronous check: every source shares this snapshot and one walk of the recall graph (`withReadSnapshot`), where each
      // memory chunk used to build its own and walk the whole graph again.
      const visible = withholding.withReadSnapshot(() => everySourceVisible(checked, scopeKey, task, sources, pendingStepId, state, withholding));
      for (const [stale, verdict] of verdicts) if (at - verdict.at >= FCA_SOURCE_VERDICT_MS || at < verdict.at) verdicts.delete(stale);
      if (verdicts.size >= FCA_SOURCE_VERDICTS_KEPT) verdicts.delete(verdicts.keys().next().value!);
      verdicts.set(key, { version: state.version, at, visible, reads: reads.list() });
      return visible;
    } catch { return false; }
  };
  const everySourceVisible = (checked: typeof parts, scopeKey: string, task: TaskView, sources: readonly TaskSource[], pendingStepId: string | undefined,
    state: CompanionStateSnapshot, withholding: MemoryWithholding): boolean => {
    for (const source of sources) {
      if (source.kind === 'memory') {
        const memory = createTaskMemory({ ...checked, now: () => source.observedAt });
        const ids = [...new Set(source.recalledMemoryIds)];
        for (let offset = 0; offset < ids.length; offset += 40) if (memory.read(scopeKey, ids.slice(offset, offset + 40), { kind: 'owner' }, { state, withholding }).length !== ids.slice(offset, offset + 40).length) return false;
        if (source.readSourceIds?.some(id => !checked.readSourceVisible?.(scopeKey, id, source.observedAt))
          || withholding.withholdsReply({ text: [task.title, task.goal, task.completionCriteria, task.summary].join('\n'),
            observedAt: source.observedAt, recalledMemoryIds: source.recalledMemoryIds })) return false;
        continue;
      }
      if (!source.experienceId) { if (source.stepId !== pendingStepId) return false; continue; }
      if (source.readSourceIds?.some(id => !checked.readSourceVisible?.(scopeKey, id, source.observedAt))) return false;
      const experience = parts.conversations.experiencesById?.(scopeKey, [source.experienceId])[0];
      if (!experience || parts.conversations.threadOfTurn?.(scopeKey, source.experienceId) !== source.threadId) return false;
      if (withholding.withholdsExperience({ ...experience, recalledMemoryIds: source.recalledMemoryIds })
        || withholding.withholdsMessage({ id: source.experienceId, sourceExperienceId: source.experienceId,
          role: 'user', content: experience.userMessage, observedAt: source.observedAt })
        || withholding.withholdsReply({ experienceId: source.experienceId, observedAt: source.observedAt,
          recalledMemoryIds: source.recalledMemoryIds,
          text: [task.title, task.goal, task.completionCriteria, task.summary].join('\n') })) return false;
    }
    return true;
  };
  const content: NonNullable<FcaSourceGuard['content']> = (scopeKey, taskId, text, observedAt) => {
    try {
      if (!parts.ownerAlone() || scopeKey !== parts.ownerScope) return false;
      const state = parts.state.snapshot(scopeKey), sources = parts.runtime.taskSources(scopeKey, taskId);
      const recalledMemoryIds = [...new Set(sources.flatMap(source => [...source.experienceId ? [source.experienceId] : [], ...source.recalledMemoryIds]))];
      return !conversationSecrets(state, parts.conversations, scopeKey).carries(text) && !new MemoryWithholding(state, parts.conversations, scopeKey, undefined, parts.readSourceVisible).withholdsReply({ text, observedAt, recalledMemoryIds });
    } catch { return false; }
  };
  const progress: NonNullable<FcaSourceGuard['progress']> = (scopeKey, taskId) => {
    const task = parts.runtime.get(scopeKey, taskId), sources = parts.runtime.taskSources(scopeKey, taskId);
    if (!task || !sourcesVisible(scopeKey, task, sources)) return null;
    const observed = parts.runtime.progress?.(scopeKey, taskId); if (!observed) return null;
    const hidden = (text: string, observedAt: string) => !content(scopeKey, taskId, text, observedAt);
    const findings = observed.findings.filter(finding => !hidden([finding.text, ...finding.sources.flatMap(source => [source.title, source.url])].join('\n'), finding.updatedAt));
    const places = observed.places?.filter(place => !hidden(JSON.stringify(place), observed.updatedAt));
    const report = observed.report && !hidden(observed.report.text, observed.report.updatedAt) ? observed.report : undefined;
    return { ...observed, findings, places, report };
  };
  return Object.assign((scopeKey: string, taskId: string, pendingStepId?: string) => {
    const task = parts.runtime.get(scopeKey, taskId);
    return Boolean(task && sourcesVisible(scopeKey, task, parts.runtime.taskSources(scopeKey, taskId), pendingStepId));
  }, { sources: sourcesVisible, progress, content });
}

/** Trusted executor receipts only. Unknown or missing private read metadata is explicit, never treated as public. */
export function fcaReadReceiptSources(receipt: FcaReadReceipt): FcaObservedSources {
  if (!receipt.ok) return {};
  const tool = shannonTool(receipt.name);
  if (tool?.domain === 'task_runtime' || receipt.name === 'web.search' || receipt.name === 'places.search') return {};
  const documents = receipt.documents?.sourceIds ?? receipt.documents?.read;
  if (!documents) return tool?.effect === 'read'
    ? { readSourceIds: [`fca-unresolved://${receipt.name}`] } : {};
  const ids = documents.map(id => {
    if (typeof id !== 'string' || !id || id.length > 200) return 'fca-unresolved://invalid-receipt';
    if (/^(?:shannon-study|aether-document|notion-page|voyager-task|calendar-item|shannon-folder|shannon-skill):\/\//u.test(id)) return id;
    return receipt.name.startsWith('aether') || receipt.name.startsWith('ownerDocs.')
      ? `aether-document://${encodeURIComponent(id)}` : 'fca-unresolved://unknown-receipt';
  });
  return { readSourceIds: [...new Set(ids)] };
}
