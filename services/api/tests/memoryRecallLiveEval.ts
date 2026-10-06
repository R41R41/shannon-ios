import { OWNER_AUDIENCE } from '@shannon/cognition';
/**
 * Opt-in, billable comparison of the current deterministic recall and Memory
 * V2 (full-text + semantic) on synthetic data. Run deliberately with
 * `pnpm --filter @shannon/api test:llm-memory-recall`. Output is content-free:
 * case IDs, hit/miss, latency, and cost only. Passing is evidence, not an
 * approval to promote or ship.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryEmbeddingWorker } from '../src/mind/memory/memoryEmbeddingWorker.js';
import { SemanticMemoryRecall, configuredSemanticMemoryConfig } from '../src/mind/recall/semanticMemoryRecall.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { prepareTurnCognitiveContext } from '../src/turnCognitiveContext.js';
import { ShannonTurnMemoryRecall, configuredMemoryModelGateway } from '../src/mind/recall/turnMemoryRecall.js';
import { memoryRecallEvaluationCases, syntheticHistory } from './memoryRecallEvaluationCases.js';

if (!process.env.OPENAI_API_KEY?.trim()) throw new Error('OPENAI_API_KEY is required for the live memory-recall evaluation');
const directory = mkdtempSync(join(tmpdir(), 'shannon-memory-eval-'));
const now = '2026-09-30T00:00:00.000Z';
const scopeKey = 'synthetic:memory-eval';
const store = new SQLiteShannonStore({ path: join(directory, 'eval.sqlite'), now: () => now });
try {
  const threads = new Map<string, string>();
  const idByKey = new Map<string, string>();
  for (const item of syntheticHistory) {
    const thread = threads.get(item.thread) ?? store.createThread(scopeKey, item.thread);
    threads.set(item.thread, thread);
    idByKey.set(item.key, store.appendTurn(scopeKey, thread, item.user, item.reply, item.observedAt).id);
  }
  const keyById = new Map([...idByKey].map(([key, id]) => [id, key]));
  const gateway = configuredMemoryModelGateway(process.env, store)!;
  const embedder = new MemoryEmbeddingWorker(store, store, gateway, store, { backgroundBudgetUsd: 5 });
  while ((await embedder.runOnce()) === 'worked') { /* embed all synthetic summaries */ }
  const indexingCostUsd = cost(store, 'memory_background');
  const recall = new ShannonTurnMemoryRecall(new SemanticMemoryRecall(gateway, store, configuredSemanticMemoryConfig(process.env)), store);
  const rows: EvalRow[] = [];
  for (const testCase of memoryRecallEvaluationCases) {
    const snapshot = store.snapshot(scopeKey);
    const startedAt = performance.now();
    const baseline = prepareTurnCognitiveContext(snapshot, store, { present: OWNER_AUDIENCE, scopeKey, message: testCase.question, occurredAt: now, channel: 'text', threadId: 'eval-new-thread' });
    const baselineMilliseconds = performance.now() - startedAt;
    const before = cost(store, 'memory');
    const enriched = await recall.enrich(baseline, { scopeKey, message: testCase.question, snapshot, threadId: 'eval-new-thread', memoryTurn: true });
    const score = (ids: readonly string[]) => {
      const keys = ids.map(id => keyById.get(id)).filter(Boolean) as string[];
      return { hit: testCase.expected.some(key => keys.includes(key)), clean: !(testCase.forbidden ?? []).some(key => keys.includes(key)) };
    };
    rows.push({
      id: testCase.id, category: testCase.category,
      baseline: { ...score(baseline.frame.recalledMemoryIDs), milliseconds: Math.round(baselineMilliseconds) },
      v2: { ...score(enriched.frame.recalledMemoryIDs), status: enriched.memoryRecall.status, modelCalls: enriched.memoryRecall.modelCalls,
        milliseconds: Math.round(baselineMilliseconds + enriched.memoryRecall.elapsedMilliseconds), costUsd: cost(store, 'memory') - before },
    });
  }
  const rate = (pick: (row: typeof rows[number]) => boolean) => Math.round(rows.filter(pick).length / rows.length * 1000) / 10;
  const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0;
  console.log(JSON.stringify({
    cases: rows.length,
    baseline: { recallRate: rate(row => row.baseline.hit), sourceCleanRate: rate(row => row.baseline.clean) },
    v2: {
      recallRate: rate(row => row.v2.hit), sourceCleanRate: rate(row => row.v2.clean),
      p50Milliseconds: percentile(rows.map(row => row.v2.milliseconds), 0.5), p95Milliseconds: percentile(rows.map(row => row.v2.milliseconds), 0.95),
      responsePathCostUsd: Math.round(rows.reduce((sum, row) => sum + row.v2.costUsd, 0) * 1e6) / 1e6, indexingCostUsd,
    },
    byCategory: Object.fromEntries([...new Set(rows.map(row => row.category))].map(category => {
      const subset = rows.filter(row => row.category === category);
      return [category, { baseline: subset.filter(row => row.baseline.hit && row.baseline.clean).length, v2: subset.filter(row => row.v2.hit && row.v2.clean).length, total: subset.length }];
    })),
    misses: rows.filter(row => !row.v2.hit || !row.v2.clean).map(row => row.id),
  }, null, 2));
} finally {
  store.close();
  rmSync(directory, { recursive: true, force: true });
}

interface EvalRow {
  id: string; category: string;
  baseline: { hit: boolean; clean: boolean; milliseconds: number };
  v2: { hit: boolean; clean: boolean; status: string; modelCalls: number; milliseconds: number; costUsd: number };
}

function cost(persistent: SQLiteShannonStore, lane: string): number {
  // Usage rows carry the real call time, so read the current UTC month.
  return persistent.llmUsageSummary(scopeKey, new Date().toISOString().slice(0, 7))
    .filter(row => row.lane === lane).reduce((sum, row) => sum + row.estimatedCostUsd, 0);
}
