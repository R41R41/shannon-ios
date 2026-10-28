import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { BLOBS_DIRECTORY, EVENTS_FILE } from './decisionRecordStore.js';

/** One line of a run's `events.jsonl` (`decisionRecordStore.ts`). */
export interface RecordEvent { ev: string; at?: string; id?: string; [key: string]: any }
export interface RunRecord { directory: string; name: string; events: RecordEvent[]; run: RecordEvent | null }

/** Reads a run's events; a last line cut short by a crash is left out. */
export function readRun(directory: string): RunRecord {
  const file = join(directory, EVENTS_FILE), events: RecordEvent[] = [];
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { events.push(JSON.parse(line) as RecordEvent); } catch { /* a cut line */ }
  }
  return { directory, name: directory.split(/[\\/]/u).filter(Boolean).at(-1) ?? '', events, run: events.find(event => event.ev === 'run') ?? null };
}

/** A part of a request or an answer, by its id; null when it was never written (a run past its limit) or cannot be read. */
export function readBlob(directory: string, id: string): unknown {
  try { return JSON.parse(gunzipSync(readFileSync(join(directory, BLOBS_DIRECTORY, `${id}.json.gz`))).toString('utf8')); } catch { return null; }
}

export interface RunSummary {
  name: string; taskId: string | null; startedAt: string | null; lastAt: string | null;
  decisions: number; summaries: number; plans: number; sent: number; bytes: number;
}
function bytesBelow(directory: string): number {
  let total = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    total += entry.isDirectory() ? bytesBelow(path) : statSync(path).size;
  }
  return total;
}
function summaryOf(root: string, name: string): RunSummary {
  const run = readRun(join(root, name)), count = (kind: string) => run.events.filter(event => event.ev === 'request' && event.kind === kind).length;
  return { name, taskId: run.run?.taskId ?? null, startedAt: run.events[0]?.at ?? null, lastAt: run.events.at(-1)?.at ?? null, decisions: count('decision'),
    summaries: count('summary'), plans: count('plan'), sent: run.events.filter(event => event.ev === 'sent').length, bytes: bytesBelow(run.directory) };
}
/** The runs below a root, the newest first. */
export function listRuns(root: string): RunSummary[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => summaryOf(root, entry.name))
    .sort((left, right) => String(right.lastAt).localeCompare(String(left.lastAt)));
}

/**
 * Which decision: its id (`d0015`), its number in the task, the step it was made in (`d` of the metrics line), a time, or the queue item an act
 * became (`q15`). `kind` picks the requests to count from (default: decisions; `summary` for the history summaries).
 */
export interface Selector { id?: string; no?: number; step?: number; at?: string; item?: string; kind?: string }
export function selectRequests(run: RunRecord, selector: Selector): RecordEvent[] {
  const requests = run.events.filter(event => event.ev === 'request');
  const decisions = requests.filter(event => event.kind === (selector.kind ?? 'decision'));
  if (selector.id) return requests.filter(event => event.id === selector.id);
  if (selector.no !== undefined) return decisions.filter(event => event.no === selector.no);
  if (selector.step !== undefined) return decisions.filter(event => event.stepIndex === selector.step);
  if (selector.item) {
    const made = new Set(run.events.filter(event => event.ev === 'sent' && event.queue?.item === selector.item).map(event => event.decisionId));
    return decisions.filter(event => made.has(event.id));
  }
  if (selector.at) {
    const time = Date.parse(selector.at);
    if (!Number.isFinite(time) || !decisions.length) return [];
    return [decisions.filter(event => Date.parse(String(event.at)) <= time).at(-1) ?? decisions[0]!];
  }
  return [];
}

export interface CallRecord {
  toolUseId: string; name: string; operationId: string; modelInput: unknown; input: unknown; skipped: boolean; ms: number;
  result: { ok: boolean; failure: string | null; retryable: boolean | null; text: string };
  sent: RecordEvent[]; sentToBody: boolean; notSentReason: string | null;
}
export interface ResponseRecord {
  outcome: string; at: string | null; ms: number | null; stopReason: unknown; meta: unknown; usage: unknown; tokens: unknown; costUsd: unknown;
  content: unknown; error: unknown; reason: unknown;
}
export interface DecisionDocument {
  id: string; kind: string; no: number; taskId: string; stepId: string; stepIndex: number | null; round: number; attempt: number | null;
  operationId: string | null; requestedAt: string;
  version: { head: unknown; body: unknown; prompt: unknown; runStartedAt: string | null };
  request: { model: unknown; headers: unknown; config: unknown; system: unknown; tools: unknown; toolNames: string[];
    messages: Array<{ index: number; role: string; content: unknown }>; omittedMessages: number };
  response: ResponseRecord | null;
  outcome: RecordEvent[];
  calls: CallRecord[];
}
export interface DocumentOptions { keepSignatures?: boolean; lastMessages?: number }

const SIGNED = new Set(['signature', 'data']);
/** A thinking block's signature (and a redacted block's data) is base64 of no use to a reader: told by its length unless asked for. */
function withoutSignatures(value: unknown, keep: boolean): unknown {
  if (keep || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => withoutSignatures(item, keep));
  const block = value as Record<string, unknown>, signed = block.type === 'thinking' || block.type === 'redacted_thinking';
  const elide = (key: string, item: unknown) => signed && SIGNED.has(key) && typeof item === 'string';
  const entry = (key: string, item: unknown) => [key, elide(key, item) ? `<${key} ${String(item).length} chars>` : withoutSignatures(item, keep)];
  return Object.fromEntries(Object.entries(block).map(([key, item]) => entry(key, item)));
}

function callOf(run: RunRecord, request: RecordEvent, event: RecordEvent, raw: Map<string, unknown>): CallRecord {
  const sent = run.events.filter(item => item.ev === 'sent' && item.decisionId === request.id && item.toolUseId === event.toolUseId);
  const bodyTool = /^(mc|minecraft)\./u.test(String(event.name)), result = event.result ?? {}, text = String(result.text ?? '');
  return { toolUseId: String(event.toolUseId), name: String(event.name), operationId: String(event.operationId),
    modelInput: raw.get(String(event.toolUseId)) ?? null, input: event.input ?? null, skipped: event.skipped === true, ms: Number(event.ms ?? 0),
    result: { ok: result.ok === true, failure: result.failure ?? null, retryable: result.retryable ?? null, text },
    sent, sentToBody: sent.length > 0, notSentReason: bodyTool && !sent.length ? text || 'no result text' : null };
}
function callsOf(run: RunRecord, request: RecordEvent, blocks: unknown): CallRecord[] {
  const raw = new Map((Array.isArray(blocks) ? blocks : []).filter(block => block?.type === 'tool_use').map(block => [String(block.id), block.input]));
  return run.events.filter(event => event.ev === 'call' && event.decisionId === request.id).map(event => callOf(run, request, event, raw));
}

function responseOf(run: RunRecord, request: RecordEvent, keep: boolean): ResponseRecord | null {
  const answer = run.events.find(event => event.ev === 'response' && event.id === request.id);
  if (!answer) return null;
  const content = answer.content ? withoutSignatures(readBlob(run.directory, String(answer.content)), keep) : null;
  return { outcome: String(answer.outcome), at: answer.at ?? null, ms: answer.ms ?? null, stopReason: answer.stopReason ?? null, meta: answer.meta ?? null,
    usage: answer.usage ?? null, tokens: answer.tokens ?? null, costUsd: answer.costUsd ?? null, content, error: answer.error ?? null,
    reason: answer.reason ?? null };
}
function requestOf(run: RunRecord, request: RecordEvent, options: DocumentOptions): DecisionDocument['request'] {
  const keep = options.keepSignatures === true, ids = (request.messages ?? []) as string[];
  const first = options.lastMessages && options.lastMessages < ids.length ? ids.length - options.lastMessages : 0;
  const messages = ids.slice(first).map((id, offset) => ({ index: first + offset, role: String(request.roles?.[first + offset] ?? ''),
    content: withoutSignatures(readBlob(run.directory, id), keep) }));
  const system = withoutSignatures(readBlob(run.directory, String(request.system)), keep);
  return { model: request.model, headers: request.headers, config: request.config, system,
    tools: readBlob(run.directory, String(request.tools)), toolNames: request.toolNames ?? [], messages, omittedMessages: first };
}

/** One request with everything recorded around it: its parts read back, its answer, what the step did with it, its calls and the commands they sent. */
export function decisionDocument(run: RunRecord, request: RecordEvent, options: DocumentOptions = {}): DecisionDocument {
  const response = responseOf(run, request, options.keepSignatures === true);
  return { id: String(request.id), kind: String(request.kind), no: Number(request.no), taskId: String(request.taskId), stepId: String(request.stepId),
    stepIndex: request.stepIndex ?? null, round: Number(request.round ?? 0), attempt: request.attempt ?? null, operationId: request.operationId ?? null,
    requestedAt: String(request.at),
    version: { head: run.run?.head ?? null, body: request.version?.body ?? null, prompt: request.version?.prompt ?? null, runStartedAt: run.run?.at ?? null },
    request: requestOf(run, request, options), response,
    outcome: run.events.filter(event => ['applied', 'discarded', 'failed'].includes(event.ev) && event.id === request.id),
    calls: callsOf(run, request, response?.content) };
}

/**
 * The last `count` rows of a run's `events.jsonl` (amendment A-12: the head's box of a stall it found holds the rows the decision record ended with), read from the end of the file
 * (at most `maxBytes` of it), so a run of hundreds of megabytes costs the same as a small one. A row cut short, at the start of the window or at the end by a crash, is left out.
 */
export function tailRun(directory: string, count: number, maxBytes = 1024 * 1024): RecordEvent[] {
  const file = join(directory, EVENTS_FILE);
  let descriptor: number | null = null;
  try {
    if (!existsSync(file) || count <= 0) return [];
    const size = statSync(file).size, from = Math.max(0, size - maxBytes), buffer = Buffer.alloc(size - from);
    descriptor = openSync(file, 'r');
    readSync(descriptor, buffer, 0, buffer.length, from);
    const lines = buffer.toString('utf8').split('\n');
    if (from > 0) lines.shift();
    const rows: RecordEvent[] = [];
    for (const line of lines) {
      if (!line) continue;
      try { rows.push(JSON.parse(line) as RecordEvent); } catch { /* a cut line */ }
    }
    return rows.slice(-count);
  } catch { return []; } finally {
    if (descriptor !== null) try { closeSync(descriptor); } catch { /* closed */ }
  }
}
