import { conversationSecrets, type SecretCheck } from '../../inhibition/disclosurePorts.js';
import { createTaskMemory } from '../../memory/taskMemoryPorts.js';
import { memoryIdentifier, visibleMemoryText, type CompanionStateSnapshot, type CompanionStateStore } from '@shannon/cognition';
import { MemoryWithholding } from '../../memory/memoryVisibilityPorts.js';
import type { TaskMemoryReadSnapshot } from '../../memory/taskMemoryPorts.js';
import type { ConversationStore, ShannonExperience } from '../../memory/memoryPorts.js';
import type { TaskRuntime, TaskSource, TaskView } from '../taskRuntime/taskRuntimePorts.js';
import type { FcaReadReceipt, FcaObservedSources, FcaSourceGuard } from './fcaConversationPorts.js';
import { shannonTool } from '../../tools/toolRegistryPorts.js';
import { observedStep } from '../../../infra/observer/observerContext.js';
import { FcaWalkTiming, type FcaWalkCaller } from './fcaWalkTiming.js';
import { provenanceEdits } from '../../memory/provenanceEdits.js';
import { FcaProvenanceFoldCache, foldFcaProvenance, foldedProvenanceCovers, foldedProvenanceResidual } from './fcaProvenanceFold.js';

/** Closed provenance covers replay and its summary lineage without copying either into the task's history. */
export function conversationFcaProvenance(state: CompanionStateSnapshot, conversations: ConversationStore,
  scopeKey: string, threadId: string, recalledMemoryIds: readonly string[]): string[] {
  return observedStep('provenance', () => { // Timed for the turn's steps line (`turnSteps.ts`).
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
  });
}

/**
 * How long one verdict on a task's provenance is reused while the companion state keeps the same version (a forget, a correction
 * or any other state change is a new version, so it is judged afresh). One voice turn asked the same question dozens of times
 * before its model call (every task and memory tool's availability, the inbox, each child), each a full walk of the recall
 * graph on the API's one thread: 2026-10-12, ~100 s with the event loop blocked and the respond lease expired unrenewed.
 */
export const FCA_SOURCE_VERDICT_MS = 5_000;
/**
 * How long a walked base (the folded provenance of an earlier walk, see `bases` below) may still be extended by a partial walk of
 * what it did not check. Production run 14 (2026-10-17, Sonnet): `event loop blocked` 204 times in 30 min (median 3.3 s) while a
 * task ran, growing with its provenance; every 5 s the base expired and the whole provenance was walked again.
 *
 * Why longer is as safe as 5 s: a base is used only while three things are unchanged since its walk, and each is checked in code.
 * (1) The companion state version. A forget, a rejection or a correction is a memory-control-upserted event, which is a new
 * version (state.ts); what it withholds is derived from the controls at each check ("nothing is deleted and nothing is stored",
 * MemoryWithholding), so every withheld source follows a version change. (2) The provenance edit count (provenanceEdits.ts):
 * the writes that change what a remembered id stands for without a version (a task's or a touch's experience row rewritten in
 * place with more sources, a knowledge document grown or retired, a voice summary replaced or dropped) each bump it, so a base
 * never rests on rows edited after its walk. Conversation turns are otherwise only appended, never deleted. (3) The read
 * receipts the walk consulted (a document or skill that went away): asked again at every use, every distinct receipt once the base
 * is older than a verdict (eadsUnchanged). Who can hear is asked on every call, and a base keeps the time of its own full walk,
 * so it is never extended past this window.
 */
export const FCA_SOURCE_BASE_MS = 30_000;
/** A walk of at least this long is named, content-free, in the journal (`Shannon FCA source walk`). */
export const FCA_SOURCE_WALK_LOG_MS = 100;
const FCA_SOURCE_VERDICTS_KEPT = 256;
export type { FcaWalkCaller } from './fcaWalkTiming.js';
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
 *
 * `sources` bounds the walk's sources after `foldFcaProvenance`: a task's memory observations (one recall and one skill index
 * per step) are folded to at most this many, so only conversation turns can reach it. `recalledIds` bounds its distinct ids,
 * which nothing folds. 2026-10-14 (task 788da00a, Minecraft): 23 steps left 65 memory rows over 64 distinct ids, and the row
 * count alone stopped the task as `fca_provenance_capped`, its step closing unknown.
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
  /** The folds of recent checks (`FcaProvenanceFoldCache`); one of its own unless a test reads it. */
  provenance?: FcaProvenanceFoldCache;
  /** Milliseconds for timing a walk (`performance.now` unless a test moves it) and where the slow-walk line goes (`console.warn`). */
  monotonic?(): number;
  log?(line: string): void;
  /** `FCA_SOURCE_BASE_MS` unless a test compares it with another window. */
  baseMilliseconds?: number;
}): FcaSourceGuard {
  const baseWindow = parts.baseMilliseconds ?? FCA_SOURCE_BASE_MS;
  const monotonic = parts.monotonic ?? (() => performance.now());
  const log = parts.log ?? ((line: string) => console.warn(line));
  const folds = parts.provenance ?? new FcaProvenanceFoldCache();
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
  const readsUnchanged = (epoch: Epoch, scopeKey: string, reads: Verdict['reads'], every = false): boolean => {
    if (!reads.length) return true;
    const again = recordedReads(epoch, scopeKey);
    // Under the same state version a receipt's answer differs by its time only through memory controls, which did not change; what
    // can change is whether the source still exists. One time per receipt is asked again: one it was visible at, if any, so that a
    // source that went away is seen at once. (A receipt that was invisible at every time stays so until the verdict expires: closed.)
    // A base older than a verdict (`every`) asks every distinct receipt at every time it was consulted: the longer window must not
    // widen the gap of one representative time.
    if (every) return reads.every(([id, observedAt, visible]) => again.check?.(scopeKey, id, observedAt) === visible);
    const representative = new Map<string, readonly [string, string, boolean]>();
    for (const read of reads) if (!representative.has(read[0]) || (read[2] && !representative.get(read[0])![2])) representative.set(read[0], read);
    return [...representative.values()].every(([id, observedAt, visible]) => again.check?.(scopeKey, id, observedAt) === visible);
  };
  const capped = new Set<string>();
  const counts = { walked: 0, reused: 0, partial: 0 };
  /**
   * Per task (its words and pending step): the latest provenance found visible, folded, with the receipts its walk consulted.
   * Minecraft runs 7, 9 and 10 (2026-10-14): each step adds a recall and a skill-index row, so every check keyed by the new sources
   * walked the whole provenance (~300 memory rows, 1–5 s of the API's thread on the VM). A check whose base is still usable under
   * the same rules as a stored verdict (same state version, within `FCA_SOURCE_BASE_MS` of the base's own walk, every receipt
   * it consulted unchanged, who can hear asked again) walks only what the base did not check. Every check of the new provenance is
   * then either made now or was passed by the base's walk, at the same or an earlier time, under the same state.
   */
  type Base = Verdict & { folded: readonly TaskSource[]; edits: number };
  const bases = new Map<string, Base>();
  /** The base if still usable: same version, no provenance edit since its walk (`provenanceEdits.ts`), in its window, receipts unchanged. */
  const usableBase = (base: Base | undefined, unchanged: (reads: Verdict['reads'], every: boolean) => boolean, version: number, at: number): Base | null => {
    if (!base || base.version !== version || base.edits !== provenanceEdits() || at < base.at || at - base.at >= baseWindow) return null;
    return unchanged(base.reads, at - base.at >= FCA_SOURCE_VERDICT_MS) ? base : null;
  };
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
  /**
   * With `peek`, undefined where the answer would need a walk: no walk is made and no verdict remembered or counted (a task over the
   * provenance cap is still stopped first, as `sources` does); else as `sources`. Timed as a whole and by part, and named when slow.
   */
  const decide = (scopeKey: string, task: TaskView, rows: readonly TaskSource[], pendingStepId: string | undefined, peek: boolean,
    via: FcaWalkCaller = 'other'): boolean | undefined => {
    const timing = new FcaWalkTiming(monotonic);
    try {
      return judge(scopeKey, task, rows, pendingStepId, peek, timing);
    } finally {
      timing.report(FCA_SOURCE_WALK_LOG_MS, via, log);
    }
  };
  const judge = (scopeKey: string, task: TaskView, rows: readonly TaskSource[], pendingStepId: string | undefined, peek: boolean,
    timing: FcaWalkTiming): boolean | undefined => {
    if (scopeKey !== parts.ownerScope) return false;
    try {
      // Who can hear is asked every time; only the provenance walk is reused.
      if (!parts.ownerAlone()) return false;
      if (task.scopeKey !== scopeKey) return false;
      if (!rows.length) return true; // Direct owner API tasks have no inherited conversation source.
      // The same verdict over fewer sources: every memory id once, at the earliest time it was observed (`foldFcaProvenance`).
      // Only a task the cap applies to is folded to the limit; the root, a conversation and the sleep task are never hidden by it.
      const sources = timing.time('provenance', () => fcaProvenanceForCheck(rows, cappable(task) ? FCA_PROVENANCE_LIMITS.sources : Infinity, folds));
      const recalledIds = new Set(sources.flatMap(source => source.recalledMemoryIds)).size;
      if (cappable(task) && (sources.length > FCA_PROVENANCE_LIMITS.sources || recalledIds > FCA_PROVENANCE_LIMITS.recalledIds)) {
        if (clock() - cappedLoggedAt >= 60_000) {
          cappedLoggedAt = clock();
          console.warn(`Shannon FCA provenance capped code=fca_provenance_capped sources=${sources.length} rows=${rows.length} ids=${recalledIds}`);
        }
        stopCapped(scopeKey, task);
        return false;
      }
      const epoch = timing.time('epoch', () => epochFor(scopeKey)), state = epoch.state, at = clock();
      const unchanged = (reads: Verdict['reads'], every = false) => timing.time('reads', () => readsUnchanged(epoch, scopeKey, reads, every));
      const key = JSON.stringify([scopeKey, task.id, task.title, task.goal, task.completionCriteria, task.summary, pendingStepId ?? null, sources]);
      const known = verdicts.get(key);
      if (known && known.version === state.version && at >= known.at && at - known.at < FCA_SOURCE_VERDICT_MS && unchanged(known.reads)) {
        if (!peek) counts.reused += 1;
        timing.note(peek ? 'peek' : 'reuse');
        return known.visible;
      }
      if (peek) {
        timing.note('peek');
        return undefined;
      }
      const baseKey = JSON.stringify([scopeKey, task.id, task.title, task.goal, task.completionCriteria, task.summary, pendingStepId ?? null]);
      const base = usableBase(bases.get(baseKey), unchanged, state.version, at);
      // With a base, only what it did not check (`foldedProvenanceResidual`); without one, all of it.
      const walked = timing.time('provenance', () => base ? foldedProvenanceResidual(base.folded, sources) : sources);
      timing.note(base ? 'partial' : 'full', walked);
      if (base) counts.partial += 1; else counts.walked += 1;
      const edits = provenanceEdits(); // Before the walk: an edit during or after it makes the base stale.
      const reads = recordedReads(epoch, scopeKey), checked = { ...parts, readSourceVisible: reads.check };
      const withholding = new MemoryWithholding(state, parts.conversations, scopeKey, epoch.candidates, reads.check, epoch.withheld);
      // One synchronous check: every source shares this snapshot and one walk of the recall graph (`withReadSnapshot`), where each
      // memory chunk used to build its own and walk the whole graph again.
      const visible = timing.time('walk', () => !walked.length
        || withholding.withReadSnapshot(() => everySourceVisible(checked, scopeKey, task, walked, pendingStepId, state, withholding)));
      // A base keeps the time of its own full walk, so it is never extended past `baseWindow`; it asks again every read it consulted
      // (each distinct receipt once: the list does not grow over the window).
      const baseAt = base?.at ?? at, allReads = distinctReads([...base?.reads ?? [], ...reads.list()]);
      // The verdict of this check is reused for `FCA_SOURCE_VERDICT_MS` from now (the same rules as any verdict), but not past the base's
      // window: a base nearly at its end gives a verdict that ends with it.
      const verdictAt = Math.max(baseAt, Math.min(at, baseAt + baseWindow - FCA_SOURCE_VERDICT_MS));
      remember(verdicts, key, { version: state.version, at: verdictAt, visible, reads: allReads }, at, FCA_SOURCE_VERDICT_MS);
      if (visible) remember(bases, baseKey, { version: state.version, at: baseAt, visible, reads: allReads, folded: sources, edits }, at, baseWindow);
      return visible;
    } catch { return false; }
  };
  const sourcesVisible: FcaSourceGuard['sources'] = (scopeKey, task, rows, pendingStepId, via) =>
    decide(scopeKey, task, rows, pendingStepId, false, via) === true;
  /**
   * The verdict `sources` would reuse now (same key, state version, window and receipts), or undefined when it would walk: the
   * evidence store warms the verdicts it is about to ask again between event-loop turns, so the final synchronous check is a reuse.
   */
  const peek: NonNullable<FcaSourceGuard['peek']> = (scopeKey, task, rows, pendingStepId) => decide(scopeKey, task, rows, pendingStepId, true);
  const everySourceVisible = (checked: typeof parts, scopeKey: string, task: TaskView, sources: readonly TaskSource[], pendingStepId: string | undefined,
    state: CompanionStateSnapshot, withholding: MemoryWithholding): boolean => {
    // One fresh read of each remembered turn for the whole walk: each 40-id read used to fetch every turn of its lineage again, one
    // query and one parse each. Minecraft run 10 (2026-10-14), profiled on a copy of the production database: 5,366 fetches of
    // 190 distinct turns, 0.9–1.5 s a walk; with one read each, 0.4–0.6 s. The rows are read now, as before, only not again.
    const turns = new Map<string, ShannonExperience | null>();
    const experience = (id: string) => {
      if (!turns.has(id)) turns.set(id, parts.conversations.experiencesById?.(scopeKey, [id])[0] ?? null);
      return turns.get(id)!;
    };
    const shared = { state, withholding, experience };
    for (const source of sources) {
      if (source.kind === 'memory') {
        const memory = createTaskMemory({ ...checked, now: () => source.observedAt });
        const ids = [...new Set(source.recalledMemoryIds)];
        for (let offset = 0; offset < ids.length; offset += 40) if (memory.read(scopeKey, ids.slice(offset, offset + 40), { kind: 'owner' }, shared).length !== ids.slice(offset, offset + 40).length) return false;
        if (source.readSourceIds?.some(id => !checked.readSourceVisible?.(scopeKey, id, source.observedAt))
          || withholding.withholdsReply({ text: [task.title, task.goal, task.completionCriteria, task.summary].join('\n'),
            observedAt: source.observedAt, recalledMemoryIds: source.recalledMemoryIds })) return false;
        continue;
      }
      if (!source.experienceId) { if (!unboundSourceVisible(source, task, pendingStepId, withholding)) return false; continue; }
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
    if (!task || !sourcesVisible(scopeKey, task, sources, undefined, 'progress')) return null;
    const observed = parts.runtime.progress?.(scopeKey, taskId); if (!observed) return null;
    const hidden = (text: string, observedAt: string) => !content(scopeKey, taskId, text, observedAt);
    const findings = observed.findings.filter(finding => !hidden([finding.text, ...finding.sources.flatMap(source => [source.title, source.url])].join('\n'), finding.updatedAt));
    const places = observed.places?.filter(place => !hidden(JSON.stringify(place), observed.updatedAt));
    const report = observed.report && !hidden(observed.report.text, observed.report.updatedAt) ? observed.report : undefined;
    return { ...observed, findings, places, report: report?.spoken && hidden(report.spoken, report.updatedAt) ? { ...report, spoken: undefined } : report };
  };
  /**
   * The evidence store's question (`fcaEvidenceStore.ts`): a row of the task's own outcomes stored the task's sources of an earlier
   * step, and the current step's sources were just found visible. Who can hear, the scope and the cap are asked again; the rest is
   * `foldedProvenanceCovers` over the same folds the walk uses.
   */
  const covers: NonNullable<FcaSourceGuard['covers']> = (scopeKey, task, verified, candidate) => {
    try {
      if (scopeKey !== parts.ownerScope || !parts.ownerAlone() || task.scopeKey !== scopeKey) return false;
      const limit = cappable(task) ? FCA_PROVENANCE_LIMITS.sources : Infinity;
      const folded = fcaProvenanceForCheck(candidate, limit, folds);
      const ids = new Set(folded.flatMap(source => source.recalledMemoryIds)).size;
      if (cappable(task) && (folded.length > limit || ids > FCA_PROVENANCE_LIMITS.recalledIds)) return false;
      return foldedProvenanceCovers(fcaProvenanceForCheck(verified, limit, folds), folded);
    } catch { return false; }
  };
  /** The part of `candidate` a walk still has to check after `verified` was found visible (`foldedProvenanceResidual`); null: walk it whole. */
  const residual: NonNullable<FcaSourceGuard['residual']> = (scopeKey, task, verified, candidate) => {
    try {
      if (scopeKey !== parts.ownerScope || !parts.ownerAlone() || task.scopeKey !== scopeKey) return null;
      const limit = cappable(task) ? FCA_PROVENANCE_LIMITS.sources : Infinity;
      const folded = fcaProvenanceForCheck(candidate, limit, folds);
      const ids = new Set(folded.flatMap(source => source.recalledMemoryIds)).size;
      if (cappable(task) && (folded.length > limit || ids > FCA_PROVENANCE_LIMITS.recalledIds)) return null;
      return foldedProvenanceResidual(fcaProvenanceForCheck(verified, limit, folds), folded);
    } catch { return null; }
  };
  return Object.assign((scopeKey: string, taskId: string, pendingStepId?: string, via: FcaWalkCaller = 'task') => {
    const task = parts.runtime.get(scopeKey, taskId);
    return Boolean(task && sourcesVisible(scopeKey, task, parts.runtime.taskSources(scopeKey, taskId), pendingStepId, via));
  }, { sources: sourcesVisible, peek, progress, content, covers, residual, walks: () => ({ ...counts }) });
}

/** Every receipt once per source and time (the later answer wins), so a base's list does not grow with each extension. */
function distinctReads(reads: ReadonlyArray<readonly [string, string, boolean]>): ReadonlyArray<readonly [string, string, boolean]> {
  return [...new Map(reads.map(read => [JSON.stringify([read[0], read[1]]), read] as const)).values()];
}

/** Keeps an entry, dropping those past `window` (or from a later clock) and the oldest past `FCA_SOURCE_VERDICTS_KEPT`. */
function remember<T extends { at: number }>(entries: Map<string, T>, key: string, entry: T, at: number, window: number): void {
  for (const [stale, value] of entries) if (at - value.at >= window || at < value.at) entries.delete(stale);
  if (entries.size >= FCA_SOURCE_VERDICTS_KEPT) entries.delete(entries.keys().next().value!);
  entries.set(key, entry);
}

/**
 * The provenance one check of a task the cap applies to walks (`foldFcaProvenance`): memory rows at most `limit` sources. A
 * task the cap does not apply to is folded with no limit (each id at its earliest time, never moved earlier).
 */
export function fcaProvenanceForCheck(rows: readonly TaskSource[], limit: number = FCA_PROVENANCE_LIMITS.sources,
  cache?: FcaProvenanceFoldCache): TaskSource[] {
  return foldFcaProvenance(rows, limit, cache);
}

/**
 * Conversation work made in a turn still in progress runs at once (owner decision 2026-10-13): until the turn binds, the task's
 * own words are judged like any reply, and the bound turn is judged in full on the next check (the verdict key holds the sources).
 */
function unboundSourceVisible(source: TaskSource, task: TaskView, pendingStepId: string | undefined, withholding: MemoryWithholding): boolean {
  if (source.stepId === pendingStepId) return true; // the turn that is asking
  return source.kind !== 'memory' && source.pending === true && !withholding.withholdsReply({ observedAt: source.observedAt,
    recalledMemoryIds: source.recalledMemoryIds, text: [task.title, task.goal, task.completionCriteria, task.summary].join('\n') });
}

/** Trusted executor receipts only. Unknown or missing private read metadata is explicit, never treated as public. */
export function fcaReadReceiptSources(receipt: FcaReadReceipt): FcaObservedSources {
  if (!receipt.ok) return {};
  const tool = shannonTool(receipt.name);
  // Public reads: the web, places, the weather and a rough route carry nothing of the owner's; nor does the Minecraft servers' state
  // (`minecraft.lifecycle_status`: Minecraft run 11, 2026-10-14, its first FCA call was read as an unresolved private receipt, the
  // task's sources were held after the call and the step closed unknown), as her body's own observations carry none.
  if (tool?.domain === 'task_runtime' || tool?.domain === 'minecraft_lifecycle'
    || ['web.search', 'web.read', 'places.search', 'weather.forecast', 'route.estimate'].includes(receipt.name)) return {};
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
