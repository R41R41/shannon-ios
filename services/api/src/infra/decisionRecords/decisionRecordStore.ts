import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

/**
 * The files of the decision records (2026-10-28, run 45's review: every decision's whole input, output, the act it sent and the versions it
 * ran on, kept as one set). One directory for each task under the root, which sits beside the runtime database:
 *
 *   <root>/<task>/events.jsonl      one JSON line for each event, in order (a request, its response, what the step did with it, the calls, the acts sent)
 *   <root>/<task>/blobs/<id>.json.gz  a part of a request or a response (a message, the system blocks, the tools, the answer's blocks), gzip of its JSON,
 *                                     named by the first 20 hex digits of the SHA-256 of that JSON: a part that comes again (the same message of the
 *                                     replay, in every request after it; the same system and tools, in every request) is written once
 *
 * A file store, not a table: the database's schema step would make an older head refuse the database on a rollback (SHANNON_DATABASE_SCHEMA_TOO_NEW),
 * and a run's records are removed by deleting its directory. Nothing here ever throws into a decision: a write that fails is counted and told once.
 */
export interface DecisionRecordLimits {
  /** The most runs (task directories) kept; the oldest go first. */
  maxRuns: number;
  /** The most bytes all runs together keep. */
  maxTotalBytes: number;
  /** The most bytes one run writes; past it only one line saying so is written. */
  maxRunBytes: number;
}
export const DECISION_RECORD_LIMITS: DecisionRecordLimits = Object.freeze({ maxRuns: 60, maxTotalBytes: 3 * 1024 ** 3, maxRunBytes: 256 * 1024 ** 2 });
export const EVENTS_FILE = 'events.jsonl';
export const BLOBS_DIRECTORY = 'blobs';

/** The name of a part: the first 20 hex digits of the SHA-256 of its JSON text. */
export function blobId(text: string): string { return createHash('sha256').update(text).digest('hex').slice(0, 20); }
/** A directory name for a task id (the id itself when it is plain, else a hash of it). */
export function runName(taskId: string): string { return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(taskId) ? taskId : `x${blobId(taskId)}`; }

/** What no record may keep: a provider key, a bearer token, another service's token. The request itself carries none; this is the last guard. */
const SECRETS = [/sk-ant-[A-Za-z0-9_-]{8,}/gu, /\bsk-[A-Za-z0-9_-]{20,}/gu, /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gu, /\bAIza[0-9A-Za-z_-]{30,}/gu,
  /\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{30,}/gu, /\bxox[abprs]-[A-Za-z0-9-]{10,}/gu];
export function scrubSecrets(text: string): string { return SECRETS.reduce((value, pattern) => value.replace(pattern, '[redacted]'), text); }

/** The directory sizes below `directory` in bytes (files only; a missing directory is 0). */
export async function directoryBytes(directory: string): Promise<number> {
  let total = 0;
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      total += entry.isDirectory() ? await directoryBytes(path) : (await stat(path)).size;
    }
  } catch { /* a directory that goes away meanwhile counts what it had */ }
  return total;
}

/**
 * Takes the oldest runs away while there are more than `maxRuns` or they hold more than `maxTotalBytes`. A run in `protect` (one this process is
 * writing) is never taken. Returns the names removed. Never throws.
 */
export async function pruneRuns(root: string, limits: DecisionRecordLimits = DECISION_RECORD_LIMITS,
  protect: ReadonlySet<string> = new Set()): Promise<string[]> {
  const removed: string[] = [];
  try {
    const runs: Array<{ name: string; at: number; bytes: number }> = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(root, entry.name);
      const at = await stat(join(path, EVENTS_FILE)).then(file => file.mtimeMs, () => 0) || (await stat(path)).mtimeMs;
      runs.push({ name: entry.name, at, bytes: await directoryBytes(path) });
    }
    runs.sort((left, right) => left.at - right.at);
    let total = runs.reduce((sum, run) => sum + run.bytes, 0), count = runs.length;
    for (const run of runs) {
      if (count <= limits.maxRuns && total <= limits.maxTotalBytes) break;
      if (protect.has(run.name)) continue;
      await rm(join(root, run.name), { recursive: true, force: true });
      removed.push(run.name);
      total -= run.bytes;
      count -= 1;
    }
  } catch { /* a root that is not there has nothing to take away */ }
  return removed;
}

/** One run's directory, written through. */
export class RunWriter {
  readonly directory: string;
  private bytes = 0;
  private capped = false;
  private told = false;
  private readonly known = new Set<string>();
  /** The ids already given to the requests of this run, by kind, so that a restart goes on counting. */
  readonly counters = { d: 0, s: 0, p: 0 };
  /** The id each message object had in this run: the same object (a replay message) is not stringified and hashed again. */
  readonly messageIds = new WeakMap<object, { id: string; chars: number }>();

  constructor(root: string, readonly name: string, private readonly limit: number, private readonly log: (line: string) => void) {
    this.directory = join(root, name);
    mkdirSync(join(this.directory, BLOBS_DIRECTORY), { recursive: true });
    this.guard(() => {
      for (const file of readdirSync(join(this.directory, BLOBS_DIRECTORY))) {
        this.known.add(file.replace(/\.json\.gz$/u, ''));
        this.bytes += statSync(join(this.directory, BLOBS_DIRECTORY, file)).size;
      }
      const events = join(this.directory, EVENTS_FILE);
      if (!existsSync(events)) return;
      this.bytes += statSync(events).size;
      for (const found of readFileSync(events, 'utf8').matchAll(/"id":"([dsp])(\d+)"/gu)) {
        const kind = found[1] as 'd' | 's' | 'p';
        this.counters[kind] = Math.max(this.counters[kind], Number(found[2]));
      }
    });
  }

  /** Writes a part once (by the id of its secret-free JSON text) and returns its id. A run past its limit writes no more parts. */
  blob(json: string): string {
    const text = scrubSecrets(json), id = blobId(text);
    if (this.known.has(id) || this.over()) return id;
    this.guard(() => {
      const packed = gzipSync(text);
      writeFileSync(join(this.directory, BLOBS_DIRECTORY, `${id}.json.gz`), packed, { flag: 'wx' });
      this.bytes += packed.length;
    });
    this.known.add(id);
    return id;
  }

  /** Appends one event line. Past the limit only the line that says so is written (once). */
  line(event: Readonly<Record<string, unknown>>): void {
    if (this.over()) {
      if (this.capped) return;
      this.capped = true;
      this.append({ ev: 'capped', at: event.at, maxRunBytes: this.limit });
      return;
    }
    this.append(event);
  }
  get size(): number { return this.bytes; }
  private over(): boolean { return this.bytes >= this.limit; }
  private append(event: Readonly<Record<string, unknown>>): void {
    this.guard(() => {
      const text = `${scrubSecrets(JSON.stringify(event))}\n`;
      appendFileSync(join(this.directory, EVENTS_FILE), text);
      this.bytes += Buffer.byteLength(text);
    });
  }
  private guard(work: () => void): void {
    try { work(); } catch (error) {
      // A part another process (or an earlier run of this one) wrote first is the same part: not a failure.
      if (this.told || (error as { code?: string }).code === 'EEXIST') return;
      this.told = true;
      const code = (error as { code?: string }).code ?? 'unknown';
      try { this.log(`Shannon decision records write failed run=${this.name} code=${code}`); } catch { /* a log never fails a decision */ }
    }
  }
}
