import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TraceIds } from '../../contracts/continueContract.js';
import { estimatedAnthropicCostUsd, knownCount, tokenCount } from '../models/claude/claudeUsage.js';
import type { DecisionScopeState } from './decisionRecordScope.js';
import { tailRun } from './decisionRecordRead.js';
import { DECISION_RECORD_LIMITS, pruneRuns, RunWriter, runName, scrubSecrets, type DecisionRecordLimits } from './decisionRecordStore.js';
import { headVersion, partHash, promptVersion, type HeadVersion } from './decisionRecordVersion.js';

/** `redecide`: a decision asked again of a stronger model for one call (amendment A-10); it is a request of its own, never the step's decision (its calls and outcome are the decision's). */
export type RequestKind = 'decision' | 'summary' | 'plan' | 'redecide';
const PREFIX: Record<RequestKind, 'd' | 's' | 'p' | 'r'> = { decision: 'd', summary: 's', plan: 'p', redecide: 'r' };
const WRITERS_KEPT = 16;
/** Amendment A-12: how many of the last rows of a run a head-found hold keeps in its box. */
export const HEAD_HOLD_ROWS = 20;
type Json = Record<string, unknown>;

export interface RequestNote {
  kind: RequestKind;
  scope: DecisionScopeState;
  /** The request exactly as it goes to the provider. */
  body: Readonly<Json>;
  /** The headers of the call that matter to what the model reads (the beta list). */
  headers?: Readonly<Record<string, string>> | undefined;
}
export interface ResponseNote {
  message?: Readonly<Json>;
  error?: unknown;
  /** The signal the call ran under: an error with it aborted is an abort, and its reason is told. */
  signal?: AbortSignal | undefined;
}

/** The tokens of an answer and what they cost at the prices the budget uses (null when the provider's counts are not all there). */
function spent(model: string, usage: Json | null): Json {
  if (!usage) return { usage: null, tokens: null, costUsd: null };
  const ttl = usage.cache_creation as { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null | undefined;
  const counts = { input: knownCount(usage.input_tokens), output: knownCount(usage.output_tokens), cacheWrite: knownCount(usage.cache_creation_input_tokens),
    cacheRead: knownCount(usage.cache_read_input_tokens), searches: 0,
    ...(ttl ? { cacheWrite5m: knownCount(ttl.ephemeral_5m_input_tokens), cacheWrite1h: knownCount(ttl.ephemeral_1h_input_tokens) } : {}) };
  const complete = [usage.input_tokens, usage.output_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens].every(tokenCount);
  return { usage, tokens: { input: counts.input, cacheWrite: counts.cacheWrite, cacheRead: counts.cacheRead, output: counts.output },
    costUsd: complete ? estimatedAnthropicCostUsd(model, counts) : null };
}

/** The longest text a row of the contract (`live`'s `raw` and `shown`) keeps inline; the request itself keeps the whole text as a part. */
const ROW_TEXT_CHARS = 40_000;
/** The most commands a request's `reads` names (the newest): the history that holds more is long past what a stage is measured on. */
const READS_KEPT = 200;
const cutText = (text: unknown, size = ROW_TEXT_CHARS): string => { const value = String(text ?? ''); return value.length > size ? `${value.slice(0, size)}…(cut)` : value; };

/** What the provider says it did to the input (`input_transformations`): the thinking blocks it dropped, with the closed reason that most of them have. Null when none. */
export function thinkingDroppedOf(message: Readonly<Json> | undefined): { reason: string; count: number } | null {
  const list = message?.input_transformations;
  if (!Array.isArray(list)) return null;
  const reasons = new Map<string, number>();
  for (const item of list) {
    const entry = item && typeof item === 'object' ? item as { type?: unknown; reason?: unknown } : null;
    if (entry?.type !== 'thinking_dropped') continue;
    const reason = typeof entry.reason === 'string' && /^[a-z_]{1,40}$/u.test(entry.reason) ? entry.reason : 'other';
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  const count = [...reasons.values()].reduce((sum, n) => sum + n, 0);
  const top = [...reasons].sort((left, right) => right[1] - left[1])[0];
  return top ? { reason: top[0], count } : null;
}

/** What the body reads the request stands on (the newest frame's life and number), from the versions the step reports (`minecraftBodyVersion`'s `observed`). */
interface Observed { life?: number; obsSeq?: number; obsAt?: string; bodyBoot?: string; headBoot?: string }

/** What a failed call says of itself: its class, status and provider error type, a short message; an abort also says why. */
function failureOf(error: unknown, signal: AbortSignal | undefined): Json {
  const failure = error as { name?: unknown; status?: unknown; message?: unknown; error?: { error?: { type?: unknown } } } | null | undefined;
  const aborted = signal?.aborted === true, reason = signal?.reason as { name?: unknown; message?: unknown } | string | undefined;
  const why = typeof reason === 'string' ? reason : String(reason?.message ?? reason?.name ?? 'aborted').slice(0, 200);
  return { outcome: aborted ? 'aborted' : 'error',
    error: { name: String(failure?.name ?? 'Error'), status: typeof failure?.status === 'number' ? failure.status : null,
      type: failure?.error?.error?.type ?? null, message: String(failure?.message ?? '').slice(0, 300) },
    ...(aborted ? { reason: why } : {}) };
}

/**
 * The recorder (decision records): writes a request's whole input before it goes out, and the answer (or what became of the call) when it ends, so
 * that a decision cancelled or held in flight still has its input. Every method is safe to call at any time and never throws.
 */
export class DecisionRecorder {
  readonly root: string;
  private readonly limits: DecisionRecordLimits;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly head: HeadVersion;
  private readonly writers = new Map<string, RunWriter>();
  private readonly pending = new Map<string, { task: string; at: number; model: string; kind: RequestKind; ids: TraceIds; promptHash: string }>();
  /** Each run's name -> its task id, for the rows the recorder writes to every run (a head boot). */
  private readonly tasks = new Map<string, string>();
  /** The prompt each task's last decision was asked with (to tell a change of prompt), and the change of history the next decision was asked after. */
  private readonly prompts = new Map<string, string>();
  private readonly histories = new Map<string, 'resume' | 'summary'>();
  /** The rows of the head's boot for each body: made again for a run that opens after the boot. */
  private readonly boots = new Map<string, (run: string) => Json>();

  constructor(options: { root: string; limits?: DecisionRecordLimits; now?: () => number; log?: (line: string) => void; head?: HeadVersion }) {
    this.root = options.root;
    this.limits = options.limits ?? DECISION_RECORD_LIMITS;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (line => console.warn(line));
    this.head = options.head ?? headVersion();
  }

  /** The id of the request, or null when nothing could be written. */
  request(note: RequestNote): string | null {
    try {
      const { scope, body } = note, writer = this.run(scope.taskId), kind = PREFIX[note.kind];
      writer.counters[kind] += 1;
      const number = writer.counters[kind], id = `${kind}${String(number).padStart(4, '0')}`;
      const prompt = promptVersion(body.system, body.tools), versions = this.versions(scope), { observed, ...bodyVersion } = versions ?? {};
      const ids = this.ids(scope.taskId, id, observed as Observed | undefined);
      this.pending.set(id, { task: scope.taskId, at: this.now(), model: String(body.model ?? ''), kind: note.kind, ids, promptHash: partHash(JSON.stringify(prompt)) });
      if (this.pending.size > 256) this.pending.delete(this.pending.keys().next().value as string);
      if (note.kind === 'decision') {
        scope.attempt += 1;
        scope.lastDecisionId = id;
      } else if (note.kind === 'summary') this.histories.set(scope.taskId, this.histories.get(scope.taskId) ?? 'summary');
      const reads = note.kind === 'decision' ? this.readsOf(scope, body) : [];
      writer.line({ ev: 'request', id, kind: note.kind, at: this.iso(), taskId: scope.taskId, stepId: scope.stepId, stepIndex: scope.stepIndex,
        round: scope.round, attempt: note.kind === 'decision' ? scope.attempt : null, operationId: scope.operationId, no: number, headers: note.headers ?? {},
        ids, ...(reads.length ? { reads } : {}), ...this.input(writer, body), version: { body: versions ? bodyVersion : null, prompt } });
      if (note.kind === 'decision' && scope.liveNote) {
        const { raw, shown, dropped } = scope.liveNote;
        scope.liveNote = undefined;
        writer.line({ ev: 'live', at: this.iso(), ids, raw: cutText(raw), shown: cutText(shown), dropped, bytes: Buffer.byteLength(JSON.stringify(body)) });
      }
      return id;
    } catch (error) {
      this.told(error);
      return null;
    }
  }

  /** What the call came to: the answer with its usage and cost, or the error (an abort is told with its reason). */
  response(id: string, note: ResponseNote): void {
    try {
      const started = this.pending.get(id);
      if (!started) return;
      this.pending.delete(id);
      const writer = this.run(started.task), ms = Math.max(0, this.now() - started.at);
      const answer = note.message ? this.answer(writer, started.model, note.message) : failureOf(note.error, note.signal);
      writer.line({ ev: 'response', id, at: this.iso(), ms, ...answer });
      if (started.kind === 'decision') this.inputChange(writer, started, note.message);
    } catch (error) { this.told(error); }
  }

  /**
   * What changed in the input beside what the experiment changes (continue contract 8, `input_change`), written after a decision's answer when there is something to
   * say: the prompt differs from the task's last decision's, the provider dropped thinking blocks (run 45's `prefix_binding_mismatch`), or the history was made again
   * (a resume, a summary). The first decision of a task has nothing to differ from: its prompt's hashes are in its request's version.
   */
  private inputChange(writer: RunWriter, started: { task: string; ids: TraceIds; promptHash: string }, message: Readonly<Json> | undefined): void {
    const before = this.prompts.get(started.task), history = this.histories.get(started.task) ?? 'none', thinking = thinkingDroppedOf(message);
    this.prompts.set(started.task, started.promptHash);
    this.histories.delete(started.task);
    if (this.prompts.size > 256) this.prompts.delete(this.prompts.keys().next().value as string);
    if ((before === undefined || before === started.promptHash) && !thinking && history === 'none') return;
    writer.line({ ev: 'input_change', at: this.iso(), ids: started.ids, promptHash: started.promptHash, ...(thinking ? { thinkingDropped: thinking } : {}), historyChanged: history });
  }

  /** The history of the task's next decision was made again (`resume`: the step began from a hold; a summary request marks `summary` itself). */
  noteHistory(taskId: string, change: 'resume' | 'summary'): void {
    this.histories.set(taskId, change === 'resume' ? 'resume' : this.histories.get(taskId) ?? 'summary');
    if (this.histories.size > 256) this.histories.delete(this.histories.keys().next().value as string);
  }

  /**
   * A row of the contract's measure (`received`, `released`, `corrected`, `woke`, `live`, `input_change`, the judge's `head_boot`, `unknown_notified`, `ledger`, …) in a task's
   * record, with the time it carries (the other `append`s stamp their own). Never throws and never waits.
   */
  row(taskId: string, row: Readonly<Json>): void {
    try {
      const at = typeof row.at === 'string' ? row.at : this.iso();
      this.run(taskId).line({ ...row, at });
    } catch (error) { this.told(error); }
  }

  /**
   * The head answered a body's connection for the first time in this start: the judge reads `head_boot` in the record of the run it judges, and a head boot belongs to no
   * single task, so the row goes to every run the recorder has open, and to a run opened after it (`row` builds the row for the run).
   */
  headBooted(bodyId: string, row: (run: string) => Json): void {
    try {
      this.boots.set(bodyId, row);
      if (this.boots.size > 8) this.boots.delete(this.boots.keys().next().value as string);
      for (const [name, taskId] of this.tasks) {
        const writer = this.writers.get(name);
        if (writer) writer.line(row(taskId));
      }
    } catch (error) { this.told(error); }
  }

  /** The numbers that join this record to the body's and to the other rows (`TraceIds`); the life and the frame's number are -1 when no frame was read. */
  private ids(taskId: string, decision: string | undefined, seen: Observed | undefined): TraceIds {
    const at = this.iso();
    return { run: taskId, ...(decision ? { decision } : {}), life: Number.isSafeInteger(seen?.life) ? seen!.life! : -1,
      ...(seen?.bodyBoot ? { bodyBoot: seen.bodyBoot } : {}), ...(seen?.headBoot ? { headBoot: seen.headBoot } : {}),
      obsSeq: Number.isSafeInteger(seen?.obsSeq) ? seen!.obsSeq! : -1, obsAt: seen?.obsAt ?? at };
  }

  /** The commands whose results are in the request's input, in the order they were put there; the ones the history no longer holds are not (continue contract 8). */
  private readsOf(scope: DecisionScopeState, body: Readonly<Json>): string[] {
    if (!scope.results.length) return [];
    const text = JSON.stringify(body.messages ?? []), seen = new Set<string>(), found: string[] = [];
    for (const mark of scope.results) {
      if (seen.has(mark.command) || !text.includes(JSON.stringify(mark.probe).slice(1, -1))) continue;
      seen.add(mark.command);
      found.push(mark.command);
    }
    return found.slice(-READS_KEPT);
  }

  /** Any other line of a task's record (what the step did with a decision, a call, a command sent to the body). Never throws. */
  append(taskId: string, event: Readonly<Json>): void {
    try { this.run(taskId).line({ ...event, at: this.iso() }); } catch (error) { this.told(error); }
  }

  /** Amendment A-12: the last `rows` rows of a task's record (what a take sends the body as notes), without opening a run that has none. */
  tail(taskId: string, rows = HEAD_HOLD_ROWS): ReturnType<typeof tailRun> {
    try { return tailRun(join(this.root, runName(taskId)), rows); } catch { return []; }
  }

  /**
   * Amendment A-12: the box of a stall the head found itself (the body cannot be asked to write one: `HEAD_INCIDENT_PREFIX`). The reason and the last `rows` rows of the task's
   * `events.jsonl` (read before this row is written) go to `<run>/head-holds/<id>.json`, and one `head_hold` row names the file in the run's record. Returns the file's path below
   * the records' root (what the hold's audit line carries), or null when nothing could be written. Never throws.
   */
  headHold(taskId: string, hold: { id: string; kind: string; why: string; detail?: Readonly<Json> }, rows = HEAD_HOLD_ROWS): string | null {
    try {
      const writer = this.run(taskId), name = writer.name;
      const file = `${hold.id.replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 120)}.json`, relative = `${name}/head-holds/${file}`;
      const tail = tailRun(writer.directory, rows), at = this.iso();
      const box = { v: 1, id: hold.id, kind: hold.kind, why: hold.why, at, taskId, ...(hold.detail ? { detail: hold.detail } : {}), rows: tail.length, tail };
      mkdirSync(join(writer.directory, 'head-holds'), { recursive: true });
      writeFileSync(join(writer.directory, 'head-holds', file), scrubSecrets(JSON.stringify(box)));
      writer.line({ ev: 'head_hold', at, id: hold.id, kind: hold.kind, why: hold.why, file: relative, rows: tail.length });
      return relative;
    } catch (error) {
      this.told(error);
      return null;
    }
  }

  /** Takes the oldest runs away when there are too many or they are too big (never one written by this process). */
  prune(): Promise<string[]> { return pruneRuns(this.root, this.limits, new Set(this.writers.keys())); }

  private run(taskId: string): RunWriter {
    const name = runName(taskId), found = this.writers.get(name);
    if (found) return found;
    const writer = new RunWriter(this.root, name, this.limits.maxRunBytes, this.log);
    this.writers.set(name, writer);
    this.tasks.set(name, taskId);
    if (this.writers.size > WRITERS_KEPT) {
      const oldest = this.writers.keys().next().value as string;
      this.writers.delete(oldest);
      this.tasks.delete(oldest);
    }
    writer.line({ ev: 'run', at: this.iso(), taskId, recorder: 1, pid: process.pid, head: this.head, limits: this.limits });
    for (const boot of this.boots.values()) writer.line(boot(taskId));
    void this.prune();
    return writer;
  }
  /** The request's parts written (each once) and named: the settings inline, the system, the tools and every message by reference. */
  private input(writer: RunWriter, body: Readonly<Json>): Json {
    const { system, tools, messages, ...config } = body as { system?: unknown; tools?: unknown; messages?: unknown[] } & Json;
    const list = Array.isArray(messages) ? messages : [], parts = list.map(message => this.message(writer, message));
    const systemJson = JSON.stringify(system ?? null);
    return { model: config.model ?? null, config, system: writer.blob(systemJson), systemChars: systemJson.length,
      tools: writer.blob(JSON.stringify(tools ?? null)),
      toolNames: Array.isArray(tools) ? tools.map(tool => String((tool as { name?: unknown } | null)?.name ?? '')) : [],
      messages: parts.map(part => part.id), messageChars: parts.reduce((sum, part) => sum + part.chars, 0),
      roles: list.map(message => String((message as { role?: unknown } | null)?.role ?? '')) };
  }
  private answer(writer: RunWriter, model: string, message: Readonly<Json>): Json {
    const { content, usage, ...meta } = message as { content?: unknown; usage?: Json } & Json;
    return { outcome: 'ok', stopReason: meta.stop_reason ?? null, meta, ...spent(model, usage ?? null), content: writer.blob(JSON.stringify(content ?? null)) };
  }
  private message(writer: RunWriter, message: unknown): { id: string; chars: number } {
    const holder = message && typeof message === 'object' ? message : null, known = holder ? writer.messageIds.get(holder) : undefined;
    if (known) return known;
    const json = JSON.stringify(message), part = { id: writer.blob(json), chars: json.length };
    if (holder) writer.messageIds.set(holder, part);
    return part;
  }
  private versions(scope: DecisionScopeState): Json | null {
    try { return scope.versions ? { ...scope.versions() } : null; } catch { return null; }
  }
  private iso(): string { return new Date(this.now()).toISOString(); }
  private told(error: unknown): void {
    const code = (error as { code?: string; name?: string }).code ?? (error as { name?: string }).name ?? 'unknown';
    try { this.log(`Shannon decision records failed code=${code}`); } catch { /* a log never fails a decision */ }
  }
}

/** The directory of the records: beside the runtime database (`<dir of the database>/decision-records`); null for a database that is not a file. */
export function decisionRecordsRoot(databasePath: string | undefined): string | null {
  const path = databasePath?.trim();
  return path && path !== ':memory:' && !path.startsWith('file::memory:') ? join(dirname(path), 'decision-records') : null;
}
export function configuredDecisionRecorder(databasePath: string | undefined, log?: (line: string) => void): DecisionRecorder | null {
  const root = decisionRecordsRoot(databasePath);
  return root ? new DecisionRecorder({ root, ...(log ? { log } : {}) }) : null;
}
