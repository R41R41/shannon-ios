import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { anthropicFcaHistoryCodec } from '../../src/infra/models/anthropic/anthropicFcaHistory.js';
import { createAnthropicFcaSummarizer } from '../../src/infra/models/anthropic/anthropicFcaSummary.js';
import { DEFAULT_HAIKU_MODEL } from '../../src/infra/models/anthropic/haikuConfig.js';
import type { FcaHistorySummaryInput } from '../../src/mind/action/fca/fcaHistoryPorts.js';
import { decisions, type Run } from './load.js';
import { guard, recordCost } from './ledger.js';
import { claudeClient } from '../../src/infra/models/claude/claudeClient.js';

/**
 * 第 2 以降の epoch の始まり（bootstrap）。本番は要約を最新の版しか残さないので、最後の epoch だけが本物。
 * ほかは、本番と同じ要約器（Haiku、body: true）と同じ形（要約 + 直近 8 ラウンドの公開記録）で作り直す。
 * 8 ラウンドは 3 つの本物の bootstrap が全部そうだった数。
 */
export const RETAINED_ROUNDS = 8;
const SUMMARY_INPUT_CHARACTERS = 64_000;
const dataDir = new URL('./data/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
/** B の直しの比べ: DECISION_REPLAY_BOOTSTRAP_TAG=base|fix で要約を本番の頭の設定（minecraftOwnPrompt、修正の版は minecraftV2Facts も）で作り直し、bootstrap-<run>.<tag>.json に置く。 */
export const BOOTSTRAP_TAG = process.env.DECISION_REPLAY_BOOTSTRAP_TAG ?? '';
export const bootstrapFile = (run: Run) => {
  const tagged = `${dataDir}bootstrap-${run.key}${BOOTSTRAP_TAG ? `.${BOOTSTRAP_TAG}` : ''}.json`;
  // 作り直しの無い run（実走27〜34）は、タグ付きが無ければ前の（タグ無しの）作り直しを使う。
  return BOOTSTRAP_TAG && !existsSync(tagged) ? `${dataDir}bootstrap-${run.key}.json` : tagged;
};

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
    ...(BOOTSTRAP_TAG ? { minecraftOwnPrompt: true, minecraftV2Facts: BOOTSTRAP_TAG.startsWith('fix') } : {}),
    ...(process.env.DECISION_REPLAY_SUMMARY_DEBUG ? { client: debugClient(apiKey) } : {}),
    recordUsage: (usage: { estimatedCostUsd: number }) => { recordCost('summary', DEFAULT_HAIKU_MODEL, usage.estimatedCostUsd, `${run.key}${BOOTSTRAP_TAG ? `.${BOOTSTRAP_TAG}` : ''}`); } } as never);
  const result: Record<number, string> = {};
  let previous: Record<string, unknown> | null = null, covered = 0;
  for (const start of starts) {
    const epoch = all[start]!.epoch;
    const real = process.env.DECISION_REPLAY_BOOTSTRAP_REAL !== 'off' && run.summary && run.summary.reset + 1 === run.rows[start]!.seq ? run.summary.bootstrap : null;
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
      // 失敗（道具の呼び出しが 1 つでない等）は数えて、3 回まで同じ入力で取り直す（本番の要約の失敗の頻度を見る。data/summary-calls-<tag>.log に 1 呼び出し 1 行）。
      for (let attempt = 1; ; attempt += 1) {
        try {
          previous = await summarizer.summarize(input, new AbortController().signal) as Record<string, unknown>;
          appendFileSync(`${dataDir}summary-calls${BOOTSTRAP_TAG ? `-${BOOTSTRAP_TAG}` : ''}.log`, `${run.key} ok attempt=${attempt}
`);
          break;
        } catch (error) {
          appendFileSync(`${dataDir}summary-calls${BOOTSTRAP_TAG ? `-${BOOTSTRAP_TAG}` : ''}.log`, `${run.key} FAIL attempt=${attempt} ${String(error).slice(0, 120)}
`);
          if (attempt >= 3) throw error;
        }
      }
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

/** 要約の呼び出しの答えのうち、道具の呼び出しが 1 つでない物を data/summary-debug-<tag>.jsonl に残す（鍵は書かない）。 */
function debugClient(apiKey: string) {
  const real = claudeClient({ apiKey, timeoutMilliseconds: 120_000 });
  return { messages: { async create(request: unknown, options: unknown) {
    const message = await (real.messages as unknown as { create(r: unknown, o: unknown): Promise<{ content: Array<Record<string, any>>; stop_reason: string; usage: unknown }> }).create(request, options);
    const calls = message.content.filter(block => block.type === 'tool_use');
    if (calls.length !== 1) appendFileSync(`${dataDir}summary-debug${BOOTSTRAP_TAG ? `-${BOOTSTRAP_TAG}` : ''}.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), stop: message.stop_reason, content: message.content, usage: message.usage })}
`);
    return message;
  } } } as never;
}
