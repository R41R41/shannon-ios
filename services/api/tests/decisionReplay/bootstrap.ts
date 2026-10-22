import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { anthropicFcaHistoryCodec } from '../../src/infra/models/anthropic/anthropicFcaHistory.js';
import { createAnthropicFcaSummarizer } from '../../src/infra/models/anthropic/anthropicFcaSummary.js';
import { DEFAULT_HAIKU_MODEL } from '../../src/infra/models/anthropic/haikuConfig.js';
import type { FcaHistorySummaryInput } from '../../src/mind/action/fca/fcaHistoryPorts.js';
import { decisions, type Run } from './load.js';
import { guard, recordCost } from './ledger.js';

/**
 * 第 2 以降の epoch の始まり（bootstrap）。本番は要約を最新の版しか残さないので、最後の epoch だけが本物。
 * ほかは、本番と同じ要約器（Haiku、body: true）と同じ形（要約 + 直近 8 ラウンドの公開記録）で作り直す。
 * 8 ラウンドは 3 つの本物の bootstrap が全部そうだった数。
 */
export const RETAINED_ROUNDS = 8;
const SUMMARY_INPUT_CHARACTERS = 64_000;
const dataDir = new URL('./data/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
export const bootstrapFile = (run: Run) => `${dataDir}bootstrap-${run.key}.json`;

type Projected = { sequence: number; stepId: string; messages: unknown[] };
function projected(run: Run, from: number, to: number): Projected[] {
  return run.rows.slice(from, to).map(row => {
    const messages = anthropicFcaHistoryCodec.project({ sequence: row.seq, stepId: row.step, entries: row.entries, status: row.status } as never);
    if (!messages) throw new Error(`DECISION_REPLAY_PROJECT ${row.seq}`);
    return { sequence: row.seq, stepId: row.step, messages: [...messages, { id: `fca-round:${row.seq}:status`, role: 'assistant',
      content: `Committed task status after this round: ${row.status}. A requested completion is not proof of completion.` }] };
  });
}

export interface BootstrapSet { generated: Record<string, string>; real: Record<string, string>; notes: Record<string, string> }
/** epoch number → bootstrap text; the last epoch of a run uses the one the database still holds when it has it. */
export async function bootstraps(run: Run, apiKey: string, force = false): Promise<Record<number, string>> {
  const file = bootstrapFile(run);
  if (!force && existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as Record<number, string>;
  const all = decisions(run);
  const starts = [...new Set(all.map(item => item.epochStart))].filter(start => start > 0);
  const summarizer = createAnthropicFcaSummarizer({ model: DEFAULT_HAIKU_MODEL, apiKey, body: true, maximumOutputTokens: 8_000,
    recordUsage: usage => { recordCost('summary', DEFAULT_HAIKU_MODEL, usage.estimatedCostUsd, run.key); } });
  const result: Record<number, string> = {};
  let previous: Record<string, unknown> | null = null, covered = 0;
  for (const start of starts) {
    const epoch = all[start]!.epoch;
    const real = run.summary && run.summary.reset + 1 === run.rows[start]!.seq ? run.summary.bootstrap : null;
    const coverTo = Math.max(covered, start - RETAINED_ROUNDS);
    // The rounds not yet covered, in as many calls as the summary input needs (64,000 characters, as production).
    let from = covered;
    while (from < coverTo) {
      let to = from;
      const input: FcaHistorySummaryInput = { previous: previous as never, rounds: [] };
      const rounds = projected(run, from, coverTo);
      for (const round of rounds) {
        if (JSON.stringify({ ...input, rounds: [...input.rounds, round] }).length > SUMMARY_INPUT_CHARACTERS && input.rounds.length) break;
        (input.rounds as Projected[]).push(round as never); to += 1;
      }
      guard(0.05);
      previous = await summarizer.summarize(input, new AbortController().signal) as Record<string, unknown>;
      from = to;
    }
    covered = coverTo;
    const template = { ...previous!, coversFromId: `fca-round:${run.rows[0]!.seq}`, coversToId: `fca-round:${run.rows[coverTo - 1]!.seq}` };
    const made = JSON.stringify({ kind: 'fca_public_history', summary: template, rounds: projected(run, coverTo, start) });
    result[epoch] = real ?? made;
    if (real) writeFileSync(`${file}.regenerated-epoch${epoch}.json`, made);
  }
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, JSON.stringify(result));
  return result;
}
