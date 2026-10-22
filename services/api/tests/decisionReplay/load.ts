import { readFileSync } from 'node:fs';
import type { FcaToolDefinition } from '../../src/mind/action/fca/fcaPorts.js';

/**
 * 判断の再現台（decision replay）が読む、本番 DB と journal の控え。
 * `vm/export-history.sh`（DB を mode=ro で読む）と `vm/export-journal.sh`（journalctl を読む）の出力を `data/` に置く（data/ は git に入らない）。
 */
export type Entry = Record<string, unknown> & { role: string };
export interface HistoryRow { seq: number; step: string; at: string; status: string; entries: Entry[] }
export interface BodyOp { id: string; cmd: Record<string, unknown>; phase: string; receipt: Record<string, unknown> | null; at: string }
export interface Metrics { task: string; d: number; t: number; llmMs: number; stepMs: number; out: number; urgent: boolean;
  in: { new: number; read: number; write: number; uncached: number; live: number; hit: number }; ts: string }
export interface Summary { rev: number; from: number; through: number; reset: number; template: Record<string, unknown>; bootstrap: string; at: string }
export interface Run {
  key: string; p: string; taskId: string; createdAt: string; title: string;
  rows: HistoryRow[]; ops: BodyOp[]; core: FcaToolDefinition[]; summary: Summary | null; metrics: Metrics[]; tree: unknown;
}

export function loadRuns(exportFile: string, journalFile?: string): Map<string, Run> {
  const by: Record<string, any[]> = {};
  for (const line of readFileSync(exportFile, 'utf8').split('\n')) {
    if (!line.startsWith('@@')) continue;
    const tab = line.indexOf('\t');
    (by[line.slice(2, tab)] ??= []).push(JSON.parse(line.slice(tab + 1)));
  }
  const metrics = journalFile ? loadMetrics(journalFile) : new Map<string, Metrics[]>();
  const runs = new Map<string, Run>();
  const keys: Record<string, string> = { d1f3d2d4: 'r32', ca976e03: 'r33', ae935fa1: 'r34' };
  for (const task of by.task ?? []) {
    const p: string = task.p, [taskId, createdAt, , , title] = task.task as string[];
    const rows = (by.hist ?? []).filter(h => h.p === p).sort((a, b) => a.seq - b.seq)
      .map(h => ({ seq: h.seq, step: h.step, at: h.at, status: h.status, entries: h.entries as Entry[] }));
    const summaryRaw = (by.summary ?? []).find(s => s.p === p);
    const summary: Summary | null = summaryRaw ? { rev: summaryRaw.rev, from: summaryRaw.from, through: summaryRaw.through, reset: summaryRaw.reset,
      template: JSON.parse(summaryRaw.template), bootstrap: summaryRaw.bootstrap, at: summaryRaw.at } : null;
    runs.set(keys[p] ?? p, { key: keys[p] ?? p, p, taskId: taskId!, createdAt: createdAt!, title: title!, rows,
      ops: (by.op ?? []).filter(o => o.p === p).map(o => ({ id: o.id, cmd: o.cmd, phase: o.phase, receipt: o.receipt, at: o.at })),
      core: ((by.core ?? []).find(c => c.p === p)?.tools ?? []) as FcaToolDefinition[], summary,
      metrics: metrics.get(taskId!) ?? [], tree: (by.plantree ?? []).find(t => t.p === p)?.tree });
  }
  return runs;
}

/** `fca_decision_metrics` lines of the journal, by task, in the order they were written (one a committed step). */
export function loadMetrics(journalFile: string): Map<string, Metrics[]> {
  const result = new Map<string, Metrics[]>();
  for (const line of readFileSync(journalFile, 'utf8').split('\n')) {
    if (!line.includes('"event":"fca_decision_metrics"')) continue;
    const value = JSON.parse(line.slice(line.indexOf('{'))) as Metrics;
    value.ts = line.slice(0, 24);
    if (!result.has(value.task)) result.set(value.task, []);
    result.get(value.task)!.push(value);
  }
  return result;
}

/** `fca_request_size` lines (requestCharacters), by task, in order. */
export function loadRequestSizes(journalFile: string): Map<string, Array<{ requestCharacters: number; historyCharacters: number; estimatedInputTokens: number }>> {
  const result = new Map<string, Array<{ requestCharacters: number; historyCharacters: number; estimatedInputTokens: number }>>();
  for (const line of readFileSync(journalFile, 'utf8').split('\n')) {
    if (!line.includes('"event":"fca_request_size"')) continue;
    const value = JSON.parse(line.slice(line.indexOf('{'))) as { taskId: string; requestCharacters: number; historyCharacters: number; estimatedInputTokens: number };
    if (!result.has(value.taskId)) result.set(value.taskId, []);
    result.get(value.taskId)!.push(value);
  }
  return result;
}

const asText = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value);

/** A decision of a run: the row that stored it, its epoch, the live state it was given and what it answered. */
export interface Decision {
  run: Run; index: number; row: HistoryRow; epoch: number; epochStart: number;
  /** The entries given to the model for this decision after the history: the state message (when the epoch's step carried one) and the live state. */
  turn: Entry[]; live: Record<string, any>; assistant: Entry | null; call: { id: string; name: string; input: any } | null;
  resultText: string; metrics: Metrics | null;
}

export function decisions(run: Run): Decision[] {
  let epoch = 0, epochStart = 0;
  return run.rows.map((row, index) => {
    const first = row.entries[0]!;
    const text = asText(first.content);
    const starts = first.role === 'user' && (text.includes('"stateUpdate\\":\\"full') || text.includes('"stateUpdate":"full'));
    if (index > 0 && starts) { epoch += 1; epochStart = index; }
    const at = row.entries.findIndex(entry => entry.role === 'assistant');
    const turn = row.entries.slice(0, at);
    const liveEntry = turn.find(entry => entry.role === 'system');
    const assistant = row.entries[at] ?? null;
    const blocks = (assistant && Array.isArray(assistant.content) ? assistant.content : []) as Array<Record<string, any>>;
    const use = blocks.find(block => block.type === 'tool_use');
    const resultEntry = [...row.entries].reverse().find(entry => entry.role === 'user');
    const resultBlock = resultEntry && Array.isArray(resultEntry.content)
      ? (resultEntry.content as Array<Record<string, any>>).find(block => block.type === 'tool_result') : undefined;
    return { run, index, row, epoch, epochStart, turn, live: liveEntry ? JSON.parse(String(liveEntry.content)) : {}, assistant,
      call: use ? { id: use.id, name: use.name, input: use.input } : null, resultText: resultBlock ? asText(resultBlock.content) : '',
      metrics: run.metrics[index] ?? null };
  });
}
