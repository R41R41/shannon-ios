import { conversationSecrets, type SecretCheck } from '../../inhibition/disclosurePorts.js';
import { createTaskMemory } from '../../memory/taskMemoryPorts.js';
import { memoryIdentifier, visibleMemoryText, type CompanionStateSnapshot, type CompanionStateStore } from '@shannon/cognition';
import { MemoryWithholding } from '../../memory/memoryVisibilityPorts.js';
import type { TaskMemoryReadSnapshot } from '../../memory/taskMemoryPorts.js';
import type { ConversationStore, ShannonExperience } from '../../memory/memoryPorts.js';
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
  const visibleLineage = withholding.withReadSnapshot(() => lineage.filter(message => !withholding.withholdsMessage(message)));
  return [...new Set([...recalledMemoryIds, ...profile, ...visibleLineage
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
/**
 * How long the owner's remembered turns, as every check of one moment needs them (what is withheld is derived from them, and
 * what he keeps secret), are loaded once and shared while his companion state keeps the same version. 2026-10-12, after the
 * first fix: each check, each inbox report and each finding still loaded and parsed every remembered turn again.
 */
export const FCA_MEMORY_EPOCH_MS = 2_000;
/**
 * The most provenance one check walks for a piece of work (`research` or `generic`, not maintenance). Such a task carrying more
 * is not shown and does not run (closed: its content is dropped, not checked piecemeal), logged as `fca_provenance_capped`; it
 * is stopped and its parent is told in a fixed report, so the owner hears it. The root, a conversation and the sleep task are
 * never capped (never hidden, never stopped by this): their provenance accumulates by design, a conversation's check walks its
 * current step and at most `FCA_CONTEXT_ITEMS` inbox reports, and a turn's own budget bounds its time.
 * Production on 2026-10-12 carried at most 14 sources and ~500 ids.
 */
export const FCA_PROVENANCE_LIMITS = Object.freeze({ sources: 64, recalledIds: 2_000 });
/** What the parent of a capped task is told: fixed words, carrying nothing of what the task read. */
export const FCA_CAPPED_REPORT = '調べものの一つは、調べた記録が多すぎて最後まで進められませんでした。';
const cappable = (task: TaskView) => (task.kind === 'research' || task.kind === 'generic') && task.origin !== 'maintenance';
let cappedLoggedAt = -Infinity;

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
  type Epoch = { version: number; at: number; state: CompanionStateSnapshot; candidates: readonly ShannonExperience[];
    withheld: readonly ShannonExperience[]; secrets?: SecretCheck; withholding?: MemoryWithholding };
  const epochs = new Map<string, Epoch>();
  /** The snapshot and remembered turns of this moment: one load per state version, reused for `FCA_MEMORY_EPOCH_MS`. */
  const epochFor = (scopeKey: string): Epoch => {
    const state = parts.state.snapshot(scopeKey), at = clock(), known = epochs.get(scopeKey);
    if (known && known.version === state.version && at >= known.at && at - known.at < FCA_MEMORY_EPOCH_MS) return known;
    const candidates = parts.conversations.experienceCandidates(scopeKey);
    const withheld = new MemoryWithholding(state, parts.conversations, scopeKey, candidates).withheldExperiences();
    const fresh: Epoch = { version: state.version, at, state, candidates, withheld };
    epochs.set(scopeKey, fresh);
    return fresh;
  };
  /** Read receipts asked once per check (with the check's own snapshot), and recorded for the verdict. */
  const recordedReads = (epoch: Epoch, scopeKey: string) => {
    const { state, candidates, withheld } = epoch;
    const seen = new Map<string, readonly [string, string, boolean]>();
    let withholding: MemoryWithholding | null = null;
    const check = parts.readSourceVisible ? (scope: string, id: string, observedAt: string): boolean => {
      if (scope !== scopeKey) return parts.readSourceVisible!(scope, id, observedAt);
      const key = JSON.stringify([id, observedAt]);
      if (!seen.has(key)) {
        withholding ??= new MemoryWithholding(state, parts.conversations, scopeKey, candidates, undefined, withheld);
        seen.set(key, [id, observedAt, parts.readSourceVisible!(scope, id, observedAt, { state, withholding })]);
      }
      return seen.get(key)![2];
    } : undefined;
    return { check, list: () => [...seen.values()] };
  };
  /** Still the same answers for every receipt a stored verdict consulted, under the current snapshot. */
  const readsUnchanged = (epoch: Epoch, scopeKey: string, reads: Verdict['reads']): boolean => {
    if (!reads.length) return true;
    const again = recordedReads(epoch, scopeKey);
    // Under the same state version a receipt's answer differs by its time only through memory controls, which did not change; what
    // can change is whether the source still exists. One time per receipt is asked again: one it was visible at, if any, so that a
    // source that went away is seen at once. (A receipt that was invisible at every time stays so until the verdict expires: closed.)
    const representative = new Map<string, readonly [string, string, boolean]>();
    for (const read of reads) if (!representative.has(read[0]) || (read[2] && !representative.get(read[0])![2])) representative.set(read[0], read);
    return [...representative.values()].every(([id, observedAt, visible]) => again.check?.(scopeKey, id, observedAt) === visible);
  };
  const capped = new Set<string>();
  /** Once per task, after the current check (never inside a caller's transaction): its parent is told, then it is stopped. */
  const stopCapped = (scopeKey: string, task: TaskView) => {
    if (capped.has(task.id)) return;
    capped.add(task.id);
    setImmediate(() => {
      // The stop first, on its own: a report that cannot be delivered (a maintenance parent refuses input) never keeps it running.
      try { parts.runtime.stop(scopeKey, task.id, 'fca_provenance_capped'); } catch {
        console.warn('Shannon FCA capped task not stopped code=fca_capped_stop_failed');
      }
      try {
        const root = parts.runtime.ensureRoot(scopeKey);
        if (task.parentId && task.parentId !== root.id) parts.runtime.send(scopeKey, root.id, task.parentId, FCA_CAPPED_REPORT, `fca-capped:${task.id}`);
      } catch { console.warn('Shannon FCA capped task not reported code=fca_capped_report_failed'); }
    }).unref?.();
  };
  const sourcesVisible: FcaSourceGuard['sources'] = (scopeKey, task, sources, pendingStepId) => {
    if (scopeKey !== parts.ownerScope) return false;
    try {
      // Who can hear is asked every time; only the provenance walk is reused.
      if (!parts.ownerAlone()) return false;
      if (task.scopeKey !== scopeKey) return false;
      if (!sources.length) return true; // Direct owner API tasks have no inherited conversation source.
      const recalledIds = new Set(sources.flatMap(source => source.recalledMemoryIds)).size;
      if (cappable(task) && (sources.length > FCA_PROVENANCE_LIMITS.sources || recalledIds > FCA_PROVENANCE_LIMITS.recalledIds)) {
        if (clock() - cappedLoggedAt >= 60_000) {
          cappedLoggedAt = clock();
          console.warn(`Shannon FCA provenance capped code=fca_provenance_capped sources=${sources.length} ids=${recalledIds}`);
        }
        stopCapped(scopeKey, task);
        return false;
      }
      const epoch = epochFor(scopeKey), state = epoch.state, at = clock();
      const key = JSON.stringify([scopeKey, task.id, task.title, task.goal, task.completionCriteria, task.summary, pendingStepId ?? null, sources]);
      const known = verdicts.get(key);
      if (known && known.version === state.version && at >= known.at && at - known.at < FCA_SOURCE_VERDICT_MS
        && readsUnchanged(epoch, scopeKey, known.reads)) return known.visible;
      const reads = recordedReads(epoch, scopeKey), checked = { ...parts, readSourceVisible: reads.check };
      const withholding = new MemoryWithholding(state, parts.conversations, scopeKey, epoch.candidates, reads.check, epoch.withheld);
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
      const epoch = epochFor(scopeKey), sources = parts.runtime.taskSources(scopeKey, taskId);
      const recalledMemoryIds = [...new Set(sources.flatMap(source => [...source.experienceId ? [source.experienceId] : [], ...source.recalledMemoryIds]))];
      // One secret check and one withholding per moment, over the moment's remembered turns (not one per report or finding).
      epoch.secrets ??= conversationSecrets(epoch.state, { experienceCandidates: () => epoch.candidates }, scopeKey);
      epoch.withholding ??= new MemoryWithholding(epoch.state, parts.conversations, scopeKey, epoch.candidates, parts.readSourceVisible, epoch.withheld);
      return !epoch.secrets.carries(text) && !epoch.withholding.withholdsReply({ text, observedAt, recalledMemoryIds });
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
    return { ...observed, findings, places, report: report?.spoken && hidden(report.spoken, report.updatedAt) ? { ...report, spoken: undefined } : report };
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
  // Public reads: the web, places, the weather and a rough route carry nothing of the owner's.
  if (tool?.domain === 'task_runtime' || ['web.search', 'web.read', 'places.search', 'weather.forecast', 'route.estimate'].includes(receipt.name)) return {};
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
