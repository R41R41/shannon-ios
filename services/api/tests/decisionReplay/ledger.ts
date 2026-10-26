import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { estimatedAnthropicCostUsd } from '../../src/infra/models/claude/claudeUsage.js';

/**
 * API の費用の帳簿（data/ledger.jsonl）。台が API を呼ぶたびに 1 行足し、上限（既定 8 ドル、環境変数 DECISION_REPLAY_CAP）を超える前に止める。
 * 帳簿は「作るのと最初の比べを合わせて 8 ドル以内」の数え方の元になる。
 */
export const LEDGER_FILE = process.env.DECISION_REPLAY_LEDGER ?? new URL('./data/ledger.jsonl', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
export interface Usage { input: number; output: number; cacheWrite: number; cacheRead: number; cacheWrite5m?: number; cacheWrite1h?: number }
export interface LedgerRow { at: string; kind: string; model: string; usage: Usage; costUsd: number; note?: string }

export function costOf(model: string, usage: Usage): number {
  return estimatedAnthropicCostUsd(model, { input: usage.input, output: usage.output, cacheWrite: usage.cacheWrite, cacheRead: usage.cacheRead, searches: 0,
    ...(usage.cacheWrite5m !== undefined && usage.cacheWrite1h !== undefined ? { cacheWrite5m: usage.cacheWrite5m, cacheWrite1h: usage.cacheWrite1h } : {}) });
}
export function spent(): number {
  if (!existsSync(LEDGER_FILE)) return 0;
  return readFileSync(LEDGER_FILE, 'utf8').split('\n').filter(Boolean).reduce((sum, line) => sum + (JSON.parse(line) as LedgerRow).costUsd, 0);
}
export const CAP = Number(process.env.DECISION_REPLAY_CAP ?? 8);
export function record(kind: string, model: string, usage: Usage, note?: string): number {
  const costUsd = costOf(model, usage);
  appendFileSync(LEDGER_FILE, `${JSON.stringify({ at: new Date().toISOString(), kind, model, usage, costUsd, ...(note ? { note } : {}) } satisfies LedgerRow)}\n`);
  return costUsd;
}
/** Throws before a call when the ledger plus the call's most likely cost would pass the cap. */
export function guard(expectedUsd: number, cap = CAP): void {
  const total = spent();
  if (total + expectedUsd > cap) throw new Error(`DECISION_REPLAY_CAP: spent $${total.toFixed(3)} + next $${expectedUsd.toFixed(3)} > $${cap}`);
}
/** A cost already worked out by production code (a summary made by the production summarizer). */
export function recordCost(kind: string, model: string, costUsd: number, note?: string): void {
  appendFileSync(LEDGER_FILE, `${JSON.stringify({ at: new Date().toISOString(), kind, model, usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, costUsd, ...(note ? { note } : {}) } satisfies LedgerRow)}\n`);
}
