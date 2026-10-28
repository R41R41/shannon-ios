import { dirname, join } from 'node:path';
import { estimatedAnthropicCostUsd, knownCount, tokenCount } from '../models/claude/claudeUsage.js';
import type { DecisionScopeState } from './decisionRecordScope.js';
import { DECISION_RECORD_LIMITS, pruneRuns, RunWriter, runName, type DecisionRecordLimits } from './decisionRecordStore.js';
import { headVersion, promptVersion, type HeadVersion } from './decisionRecordVersion.js';

export type RequestKind = 'decision' | 'summary' | 'plan';
const PREFIX: Record<RequestKind, 'd' | 's' | 'p'> = { decision: 'd', summary: 's', plan: 'p' };
const WRITERS_KEPT = 16;
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
  private readonly pending = new Map<string, { task: string; at: number; model: string }>();

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
      this.pending.set(id, { task: scope.taskId, at: this.now(), model: String(body.model ?? '') });
      if (this.pending.size > 256) this.pending.delete(this.pending.keys().next().value as string);
      if (note.kind === 'decision') {
        scope.attempt += 1;
        scope.lastDecisionId = id;
      }
      writer.line({ ev: 'request', id, kind: note.kind, at: this.iso(), taskId: scope.taskId, stepId: scope.stepId, stepIndex: scope.stepIndex,
        round: scope.round, attempt: note.kind === 'decision' ? scope.attempt : null, operationId: scope.operationId, no: number, headers: note.headers ?? {},
        ...this.input(writer, body), version: { body: this.versions(scope), prompt: promptVersion(body.system, body.tools) } });
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
    } catch (error) { this.told(error); }
  }

  /** Any other line of a task's record (what the step did with a decision, a call, a command sent to the body). Never throws. */
  append(taskId: string, event: Readonly<Json>): void {
    try { this.run(taskId).line({ ...event, at: this.iso() }); } catch (error) { this.told(error); }
  }

  /** Takes the oldest runs away when there are too many or they are too big (never one written by this process). */
  prune(): Promise<string[]> { return pruneRuns(this.root, this.limits, new Set(this.writers.keys())); }

  private run(taskId: string): RunWriter {
    const name = runName(taskId), found = this.writers.get(name);
    if (found) return found;
    const writer = new RunWriter(this.root, name, this.limits.maxRunBytes, this.log);
    this.writers.set(name, writer);
    if (this.writers.size > WRITERS_KEPT) this.writers.delete(this.writers.keys().next().value as string);
    writer.line({ ev: 'run', at: this.iso(), taskId, recorder: 1, pid: process.pid, head: this.head, limits: this.limits });
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
