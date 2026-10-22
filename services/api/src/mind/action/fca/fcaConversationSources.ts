import { conversationSecrets, type SecretCheck } from '../../inhibition/disclosurePorts.js';
import { memoryIdentifier, visibleMemoryText, type CompanionStateSnapshot, type CompanionStateStore } from '@shannon/cognition';
import { MemoryWithholding } from '../../memory/memoryVisibilityPorts.js';
import type { TaskMemoryReadSnapshot } from '../../memory/taskMemoryPorts.js';
import type { ConversationStore, ShannonExperience } from '../../memory/memoryPorts.js';
import type { TaskRuntime, TaskSource, TaskView } from '../taskRuntime/taskRuntimePorts.js';
import type { FcaSourceGuard } from './fcaConversationPorts.js';
import { observedStep } from '../../../infra/observer/observerContext.js';
import { askInSteps, createReadsMemo } from './fcaSourceReadsMemo.js';
import { FcaWalkTiming, type FcaWalkCaller } from './fcaWalkTiming.js';
import { provenanceEdits } from '../../memory/provenanceEditsPorts.js';
import { inTurns, whole, type Steps, type TurnsMeasure } from '../../memory/memoryStepsPorts.js';
import { everySourceVisible, walkInTurns } from './fcaSourceWalkSteps.js';
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
/**
 * mb-llmc r8 (run 32: `source walk` mode=full, ids about 320, 300–860 ms of the API's one thread, 780 ms and 925 ms blocks, at 12:26:40 and
 * 12:27:28 — the base had run out): a check that finds its base this old makes a new one at once in turns of the loop (`refreshBase`), so that
 * the checks that follow walk only the sources the base did not check and never the whole provenance on the thread. A step comes every 10–15 s
 * and a base lives `FCA_SOURCE_BASE_MS`, so one this old is renewed before it ends.
 */
export const FCA_SOURCE_BASE_REFRESH_MS = 15_000;
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
export type FcaSourceGuardParts = Parameters<typeof createFcaSourceGuard>[0];
export function createFcaSourceGuard(parts: {
  runtime: TaskRuntime; state: Pick<CompanionStateStore, 'snapshot'>; conversations: ConversationStore;
  ownerScope: string; ownerAlone(): boolean;
  readSourceVisible?(scopeKey: string, id: string, observedAt: string, shared?: TaskMemoryReadSnapshot): boolean;
  /**
   * r9: the inputs every answer of `readSourceVisible` is made from, as one string, at this moment (`readSourceFingerprint`), or null where
   * they cannot be told (inside a transaction), or where the receipts named hold one of a family whose answer rests on the clock or on an
   * outside store. A list of receipts found unchanged under a fingerprint is not asked again while the fingerprint is the same.
   */
  readFingerprint?(scopeKey: string, state: CompanionStateSnapshot, receiptIds: readonly string[]): string | null;
  /** Milliseconds for the verdict reuse above; `Date.now` unless a test moves it. */
  clock?(): number;
  /** The folds of recent checks (`FcaProvenanceFoldCache`); one of its own unless a test reads it. */
  provenance?: FcaProvenanceFoldCache;
  /** Milliseconds for timing a walk (`performance.now` unless a test moves it) and where the slow-walk line goes (`console.warn`). */
  monotonic?(): number;
  log?(line: string): void;
  /** `FCA_SOURCE_BASE_MS` unless a test compares it with another window. */
  baseMilliseconds?: number;
  /** `FCA_SOURCE_WALK_LOG_MS` unless a measurement wants every check above a smaller bound. */
  walkLogMilliseconds?: number;
}): FcaSourceGuard {
  const baseWindow = parts.baseMilliseconds ?? FCA_SOURCE_BASE_MS;
  const monotonic = parts.monotonic ?? (() => performance.now());
  const log = parts.log ?? ((line: string) => console.warn(line));
  const folds = parts.provenance ?? new FcaProvenanceFoldCache();
  /** A verdict, and every read receipt's availability it consulted: those can change without a new state version. */
  type Verdict = { version: number; at: number; visible: boolean; reads: ReadonlyArray<readonly [string, string, boolean]> };
  const verdicts = new Map<string, Verdict>();
  const clock = parts.clock ?? Date.now;
  type Epoch = { version: number; at: number; mark: string | null; state: CompanionStateSnapshot; candidates: readonly ShannonExperience[];
    withheld: readonly ShannonExperience[]; secrets?: SecretCheck; withholding?: MemoryWithholding;
    /**
     * The source rows' mark (`provenanceMark`) the state and the remembered turns were read under, while it is still theirs: null once a
     * source row changed and the epoch was kept (its turns are then older than the rows), or where the mark cannot be read.
     */
    rows: string | null;
    /**
     * The withholding the read receipts of the checks of this epoch are asked under (`recordedReads`). It reads rows lazily (a turn by
     * id, the knowledge documents) and keeps them, so it lives only as long as the rows it reads from are unchanged since the epoch's
     * mark: past a change of one (`epochFor`) it is dropped. No time bound is added by it; its memos end with each check (`withReadSnapshot`).
     */
    reads?: MemoryWithholding };
  const epochs = new Map<string, Epoch>();
  const rowsMark = () => parts.conversations.provenanceMark?.() ?? null;
  /** The snapshot and remembered turns of this moment: one load per state version, reused for `FCA_MEMORY_EPOCH_MS`. */
  const epochFor = (scopeKey: string): Epoch => {
    // While the database is unchanged since the epoch was made (its change mark: every write of any connection moves it) the state has the same
    // version, so the state is not read and parsed again to find that out.
    const mark = parts.conversations.changeMark?.() ?? null, known = epochs.get(scopeKey), now = clock();
    if (known && mark !== null && known.mark === mark && now >= known.at && now - known.at < FCA_MEMORY_EPOCH_MS) return known;
    const rows = rowsMark(), state = parts.state.snapshot(scopeKey), at = clock();
    if (known && known.version === state.version && at >= known.at && at - known.at < FCA_MEMORY_EPOCH_MS) {
      // The turns and the state are the epoch's (as before this reuse existed). `reads` keeps the rows it took (a knowledge document, a turn
      // it read by id) only while no row a source's visibility is read from has changed since (production run 19: every lease renewal and
      // every step's progress moved the database's own mark, and each dropped it): else it is made again, never older than its rows.
      known.mark = mark;
      if (rows === null || known.rows !== rows) {
        known.reads = undefined;
        known.rows = null;
      }
      return known;
    }
    const candidates = parts.conversations.experienceCandidates(scopeKey);
    const withheld = new MemoryWithholding(state, parts.conversations, scopeKey, candidates).withheldExperiences();
    // The rows' mark is theirs only when no source row changed while they were read.
    const fresh: Epoch = { version: state.version, at, mark, state, candidates, withheld, rows: rows !== null && rowsMark() === rows ? rows : null };
    epochs.set(scopeKey, fresh);
    return fresh;
  };
  /** Read receipts asked once per check (with the check's own snapshot), and recorded for the verdict; `own`: a walk in turns (`warm`). */
  const recordedReads = (epoch: Epoch, scopeKey: string, own = false) => {
    const { state, candidates, withheld } = epoch;
    const seen = new Map<string, readonly [string, string, boolean]>();
    // The remembered turns are put in a withholding once per epoch, not once per check; what the reader memoizes for one walk (a skill it
    // read) is kept under this check's own `walk`, so a later check asks again. A walk in turns holds its own open: no other check reads under it.
    const made = () => new MemoryWithholding(state, parts.conversations, scopeKey, candidates, undefined, withheld);
    let mine: MemoryWithholding | undefined;
    const withholding = () => own ? mine ??= made() : epoch.reads ??= made();
    const walk = {};
    // The rows the withholding's turns were read under, while still theirs: the reader then shares its answers with the next moments'.
    const rows = () => epoch.rows === null ? {} : { rows: epoch.rows };
    const check = parts.readSourceVisible ? (scope: string, id: string, observedAt: string): boolean => {
      if (scope !== scopeKey) return parts.readSourceVisible!(scope, id, observedAt);
      const key = JSON.stringify([id, observedAt]);
      if (!seen.has(key)) {
        seen.set(key, [id, observedAt, parts.readSourceVisible!(scope, id, observedAt, { state, withholding: withholding(), walk, ...rows() })]);
      }
      return seen.get(key)![2];
    } : undefined;
    /** The checks made inside `work` are one synchronous read of the receipts: they share the withholding's memos and its one look at the turns' receipts. */
    const together = <T>(work: () => T): T => parts.readSourceVisible ? withholding().withReadSnapshot(work) : work();
    const hold = (): (() => void) => parts.readSourceVisible ? withholding().hold() : () => {}; // `together` for a walk in turns
    return { check, together, hold, list: () => [...seen.values()] };
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
    // Which receipt stands for each source is a function of the list alone (a verdict's list is made once and never changed), and a walked
    // list holds a receipt for every source and every time the walk met it (thousands): found once per list, not at every use.
    let once = representatives.get(reads);
    if (!once && !every) representatives.set(reads, once = oneVisibleTimePerReceipt(reads));
    const asked = every ? reads : once!;
    return again.together(() => asked.every(([id, observedAt, visible]) => again.check?.(scopeKey, id, observedAt) === visible));
  };
  const representatives = new WeakMap<object, Array<readonly [string, string, boolean]>>();
  /** r9: the memo of lists found unchanged under a fingerprint (`fcaSourceReadsMemo.ts`). */
  const memo = createReadsMemo<CompanionStateSnapshot>(parts.readFingerprint);
  /** Every receipt of the list asked again in steps (the shape of the recall-yield walk): `false` at the first that changed. */
  function* readsUnchangedSteps(epoch: Epoch, scopeKey: string, reads: Verdict['reads'], every: boolean, timing?: FcaWalkTiming): Steps<boolean> {
    if (!reads.length) return true;
    const again = recordedReads(epoch, scopeKey, true);
    let once = representatives.get(reads);
    if (!once && !every) representatives.set(reads, once = oneVisibleTimePerReceipt(reads));
    return yield* askInSteps(every ? reads : once!, (id, observedAt) => again.check?.(scopeKey, id, observedAt), again.hold, monotonic,
      milliseconds => timing?.add('reads', milliseconds));
  }
  /** r9: whether the receipts of `reads` are unchanged: at once where the fingerprint is the one they were found unchanged under, else asked now. */
  const confirmed = (epoch: Epoch, scopeKey: string, reads: Verdict['reads'], every: boolean, timing: FcaWalkTiming): boolean => {
    const print = memo.of(epoch.state, scopeKey, reads);
    if (memo.holds(reads, print, every)) return true;
    const unchanged = timing.time('reads', () => readsUnchanged(epoch, scopeKey, reads, every));
    if (unchanged && print !== null) memo.keep(reads, print, every);
    return unchanged;
  };
  /** As `confirmed`, for a check walked in turns: what has to be asked is asked in steps; kept only if the fingerprint is the same after them. */
  function* confirmedInTurns(epoch: Epoch, scopeKey: string, reads: Verdict['reads'], every: boolean, timing: FcaWalkTiming): Steps<boolean> {
    const print = memo.of(epoch.state, scopeKey, reads);
    if (memo.holds(reads, print, every)) return true;
    const unchanged = yield* readsUnchangedSteps(epoch, scopeKey, reads, every, timing);
    if (unchanged && print !== null && memo.of(epoch.state, scopeKey, reads) === print) memo.keep(reads, print, every);
    return unchanged;
  }  const capped = new Set<string>();
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
  /** Whether the base may be used at all: same version, no provenance edit since its walk (`provenanceEdits.ts`), in its window. */
  const baseFits = (base: Base | undefined, version: number, at: number): base is Base =>
    !!base && base.version === version && base.edits === provenanceEdits() && at >= base.at && at - base.at < baseWindow;
  /** The base if still usable: it fits, and its receipts are unchanged. */
  const usableBase = (base: Base | undefined, unchanged: (reads: Verdict['reads'], every: boolean) => boolean, version: number, at: number): Base | null => {
    if (!baseFits(base, version, at)) return null;
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
   * provenance cap is still stopped first, as `sources` does); else as `sources`. With `withheld`, as `peek` read by the gates that
   * act only on its false (`peekedVisible`): false exactly where `peek` is false, true everywhere else. Timed as a whole and by part,
   * and named when slow.
   */
  const decide = (scopeKey: string, task: TaskView, rows: readonly TaskSource[], pendingStepId: string | undefined, peek: Peek,
    via: FcaWalkCaller = 'other'): boolean | undefined => {
    const timing = new FcaWalkTiming(monotonic);
    try {
      return whole(judgeSteps(scopeKey, task, rows, pendingStepId, peek, timing, false));
    } finally {
      timing.report(parts.walkLogMilliseconds ?? FCA_SOURCE_WALK_LOG_MS, via, log);
    }
  };
  /**
   * recall-yield (run 31: a body recall's 315 sources walked 862 ms at once): `sources`' walk in turns of the loop (`fcaSourceWalkSteps.ts`),
   * its verdict kept as the walk at once keeps it, only if nothing it rests on moved meanwhile (`movedSince`; else `sources` walks at once).
   */
  const warmWith = async (scopeKey: string, task: TaskView, rows: readonly TaskSource[], pendingStepId: string | undefined, via: FcaWalkCaller,
    signal: AbortSignal | undefined, forceFull: boolean) => {
    const timing = new FcaWalkTiming(monotonic), held: TurnsMeasure = { longestMs: 0, turns: 0 };
    try {
      const walk = judgeSteps(scopeKey, task, rows, pendingStepId, false, timing, true, forceFull);
      await inTurns(walk, { clock: monotonic, measure: held, ...(signal ? { signal } : {}) });
    } catch { /* nothing kept: the check that follows walks at once */ } finally {
      timing.report(parts.walkLogMilliseconds ?? FCA_SOURCE_WALK_LOG_MS, via, log, held);
    }
  };
  const warm: NonNullable<FcaSourceGuard['warm']> = (scopeKey, task, rows, pendingStepId, via = 'other', signal) =>
    warmWith(scopeKey, task, rows, pendingStepId, via, signal, false);
  /** r8: a base this old (`FCA_SOURCE_BASE_REFRESH_MS`) is made anew in turns, once at a time for a task's base, after the check in hand. */
  const refreshing = new Set<string>();
  const refreshBase = (baseKey: string, scopeKey: string, task: TaskView, rows: readonly TaskSource[], pendingStepId: string | undefined) => {
    if (refreshing.has(baseKey)) return;
    refreshing.add(baseKey);
    setImmediate(() => { void warmWith(scopeKey, task, rows, pendingStepId, 'refresh', undefined, true).finally(() => refreshing.delete(baseKey)); }).unref?.();
  };
  /**
   * `decide`'s check; `inTurns`: the walk in steps (`warm`), whose verdict is kept only if nothing it rests on changed while it walked.
   * `forceFull` (r8, the renewing of a base): the verdict and the base in hand are not used, the whole provenance is walked.
   */
  function* judgeSteps(scopeKey: string, task: TaskView, rows: readonly TaskSource[], pendingStepId: string | undefined, peek: Peek,
    timing: FcaWalkTiming, inTurns: boolean, forceFull = false): Steps<boolean | undefined> {
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
      const key = JSON.stringify([scopeKey, task.id, task.title, task.goal, task.completionCriteria, task.summary, pendingStepId ?? null, sources]);
      const known = verdicts.get(key);
      // In turns, the moment's remembered turns are read a page at a time first (kept by the store while unchanged, `epochFor` finds them).
      if (inTurns && parts.conversations.experienceCandidateSteps) yield* parts.conversations.experienceCandidateSteps(scopeKey);
      const epoch = timing.time('epoch', () => epochFor(scopeKey)), state = epoch.state, at = clock();
      // A gate that acts only on a known "withheld" (`peekedVisible`) learns nothing from a visible verdict or none: what `peek` would
      // answer there (the verdict, or undefined) is read the same by it, so the receipts are not asked again for it. Production run 18:
      // the monitor's three peeks a second, about three quarters of the guard's time on a copy of its database. The moment is still
      // taken (`epochFor`, above), as the peeks took it: the step's own checks soon after then find it made, off the decision's path.
      if (peek === 'withheld' && known?.visible !== false) {
        timing.note('peek');
        return true;
      }
      const unchanged = (reads: Verdict['reads'], every = false) => confirmed(epoch, scopeKey, reads, every, timing);
      // r9: the inputs the answers are made from as the check begins (no receipts named: those are the lists' own), to see none moved during it.
      const printStart = memo.inputs(epoch.state, scopeKey);
      // r9: a check walked in turns asks the receipts it has to in turns too (`confirmedInTurns`), and none inside the stamp's age.
      const reusable = !forceFull && known && known.version === state.version && at >= known.at && at - known.at < FCA_SOURCE_VERDICT_MS;
      if (reusable && (inTurns ? yield* confirmedInTurns(epoch, scopeKey, known!.reads, false, timing) : unchanged(known!.reads))) {
        if (!peek) counts.reused += 1;
        timing.note(peek ? 'peek' : 'reuse');
        return known!.visible;
      }
      if (peek) {
        timing.note('peek');
        return peek === 'withheld' ? true : undefined;
      }
      const baseKey = JSON.stringify([scopeKey, task.id, task.title, task.goal, task.completionCriteria, task.summary, pendingStepId ?? null]);
      const kept = forceFull ? undefined : bases.get(baseKey);
      const base = inTurns ? (baseFits(kept, state.version, at)
        && (yield* confirmedInTurns(epoch, scopeKey, kept.reads, at - kept.at >= FCA_SOURCE_VERDICT_MS, timing)) ? kept : null)
        : usableBase(kept, unchanged, state.version, at);
      // With a base, only what it did not check (`foldedProvenanceResidual`); without one, all of it.
      const walked = timing.time('provenance', () => base ? foldedProvenanceResidual(base.folded, sources) : sources);
      timing.note(base ? 'partial' : 'full', walked);
      if (base) counts.partial += 1; else counts.walked += 1;
      const edits = provenanceEdits(), mark = rowsMark(); // Before the walk: an edit during or after it makes the base stale.
      const reads = recordedReads(epoch, scopeKey, inTurns), checked = { ...parts, readSourceVisible: reads.check };
      const withholding = new MemoryWithholding(state, parts.conversations, scopeKey, epoch.candidates, reads.check, epoch.withheld);
      // One synchronous check: every source shares this snapshot and one walk of the recall graph (`withReadSnapshot`), where each
      // memory chunk used to build its own and walk the whole graph again.
      const walk = (steps: boolean) => everySourceVisible(checked, scopeKey, task, walked, pendingStepId, state, withholding, steps);
      const visible = inTurns ? yield* walkInTurns(timing, monotonic, walked, [reads.hold, () => withholding.hold()], walk(true))
        : timing.time('walk', () => !walked.length || reads.together(() => withholding.withReadSnapshot(() => whole(walk(false)))));
      if (inTurns && movedSince(scopeKey, state.version, edits, mark)) return undefined;
      // A base keeps the time of its own full walk, so it is never extended past `baseWindow`; it asks again every read it consulted
      // (each distinct receipt once: the list does not grow over the window).
      const baseAt = base?.at ?? at, allReads = distinctReads([...base?.reads ?? [], ...reads.list()]);
      // r9: the list holds the base's receipts, found unchanged just now, and those this walk consulted: all under one fingerprint when the
      // inputs are the ones the check began with (a walk in turns may have run beside a change of them: then the next check that asks sets it).
      const printNow = memo.of(epoch.state, scopeKey, allReads);
      if (printNow !== null && printStart !== null && memo.inputs(epoch.state, scopeKey) === printStart) memo.keep(allReads, printNow, true);
      // The verdict of this check is reused for `FCA_SOURCE_VERDICT_MS` from now (the same rules as any verdict), but not past the base's
      // window: a base nearly at its end gives a verdict that ends with it.
      const verdictAt = Math.max(baseAt, Math.min(at, baseAt + baseWindow - FCA_SOURCE_VERDICT_MS));
      remember(verdicts, key, { version: state.version, at: verdictAt, visible, reads: allReads }, at, FCA_SOURCE_VERDICT_MS);
      if (visible) remember(bases, baseKey, { version: state.version, at: baseAt, visible, reads: allReads, folded: sources, edits }, at, baseWindow);
      if (visible && !inTurns && at - baseAt >= FCA_SOURCE_BASE_REFRESH_MS) refreshBase(baseKey, scopeKey, task, rows, pendingStepId);
      return visible;
    } catch { return false; }
  }
  /** After a walk in turns (`warm`): whether the state's version, the provenance edits or the source rows moved since it began. */
  const movedSince = (scopeKey: string, version: number, edits: number, mark: string | null) =>
    parts.state.snapshot(scopeKey).version !== version || provenanceEdits() !== edits || mark === null || rowsMark() !== mark;
  const sourcesVisible: FcaSourceGuard['sources'] = (scopeKey, task, rows, pendingStepId, via) =>
    decide(scopeKey, task, rows, pendingStepId, false, via) === true;
  /**
   * The verdict `sources` would reuse now (same key, state version, window and receipts), or undefined when it would walk: the
   * evidence store warms the verdicts it is about to ask again between event-loop turns, so the final synchronous check is a reuse.
   */
  const peek: NonNullable<FcaSourceGuard['peek']> = (scopeKey, task, rows, pendingStepId) => decide(scopeKey, task, rows, pendingStepId, 'peek');
  /** Whether `peek` would answer false now: what the once-a-second gates act on (`peekedVisible`). */
  const withheld: NonNullable<FcaSourceGuard['withheld']> = (scopeKey, task, rows) => decide(scopeKey, task, rows, undefined, 'withheld', 'gate') === false;
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
  /** The receipts the kept bases ask again (each once per source and time), for the walk counts. */
  const baseReads = () => [...bases.values()].reduce((sum, base) => sum + base.reads.length, 0);
  return Object.assign((scopeKey: string, taskId: string, pendingStepId?: string, via: FcaWalkCaller = 'task') => {
    const task = parts.runtime.get(scopeKey, taskId);
    return Boolean(task && sourcesVisible(scopeKey, task, parts.runtime.taskSources(scopeKey, taskId), pendingStepId, via));
  }, { sources: sourcesVisible, peek, warm, withheld, progress, content, covers, residual, walks: () => ({ ...counts, baseReads: baseReads() }) });
}

/** How `decide` is asked: a whole check (false), `peek`, or `withheld` (`peek` as the gates read it). */
type Peek = false | 'peek' | 'withheld';

/** For each source, one time it was consulted at: one it was visible at if any, else its first (what a verdict still within its window asks again). */
export function oneVisibleTimePerReceipt(reads: ReadonlyArray<readonly [string, string, boolean]>): Array<readonly [string, string, boolean]> {
  const representative = new Map<string, readonly [string, string, boolean]>();
  for (const read of reads) if (!representative.has(read[0]) || (read[2] && !representative.get(read[0])![2])) representative.set(read[0], read);
  return [...representative.values()];
}

/** Every receipt once per source and time (the later answer wins), so a base's list does not grow with each extension. */
export function distinctReads(reads: ReadonlyArray<readonly [string, string, boolean]>): ReadonlyArray<readonly [string, string, boolean]> {
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

export { fcaReadReceiptSources } from './fcaReadReceiptSources.js';
