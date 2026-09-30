import type { CognitiveEvaluationScenario } from '../../src/scenario.js';

/**
 * Synthetic Memory V2 characterization (TI-REQ-SHANNON-MEMORY-V2).
 * Every document is invented for evaluation; nothing is copied from a real
 * conversation. These scenarios are deterministic and make no model call.
 */
const now = '2026-09-30T00:00:00.000Z';

function scenario(
  id: string,
  category: CognitiveEvaluationScenario['category'],
  input: Omit<CognitiveEvaluationScenario['input'], 'now'>,
  expected: CognitiveEvaluationScenario['expected'],
): CognitiveEvaluationScenario {
  return { schemaVersion: 1, id, category, description: `Synthetic Memory V2: ${id}`, input: { now, ...input }, expected };
}

const documents = [
  { id: 'exp-voice', text: 'ユーザー: 音声待機文を短くしたい / シャノン: 三秒を超える時だけ流す', observedAt: '2026-09-20T00:00:00.000Z' },
  { id: 'exp-photo', text: 'ユーザー: 写真を整理する手順 / シャノン: アルバムごとに分ける', observedAt: '2026-09-21T00:00:00.000Z' },
  { id: 'exp-bread', text: 'ユーザー: 朝食にパンを食べた / シャノン: いいね', observedAt: '2026-09-22T00:00:00.000Z' },
  { id: 'thread:trip', text: '旅行計画 沖縄旅行に変更した', observedAt: '2026-09-23T00:00:00.000Z' },
] as const;

export const memoryV2Scenarios: readonly CognitiveEvaluationScenario[] = [
  scenario('memory-search-long-japanese-term', 'memory-search',
    { memorySearch: { query: '音声待機文ってどう決めたっけ', documents } },
    [{ type: 'selected-memory-ids', value: ['exp-voice'] }]),
  scenario('memory-search-short-japanese-term', 'memory-search',
    { memorySearch: { query: '写真', documents } },
    [{ type: 'selected-memory-ids', value: ['exp-photo'] }]),
  scenario('memory-search-compound-splits-into-short-terms', 'memory-search',
    { memorySearch: { query: '写真整理', documents } },
    [{ type: 'selected-memory-ids', value: ['exp-photo'] }]),
  scenario('memory-search-thread-summary', 'memory-search',
    { memorySearch: { query: '沖縄旅行の件', documents } },
    [{ type: 'selected-memory-ids', value: ['thread:trip'] }]),
  scenario('memory-search-particles-only-return-nothing', 'memory-search',
    { memorySearch: { query: 'のをにはが', documents } },
    [{ type: 'selected-memory-ids', value: [] }]),
  scenario('memory-search-unrelated-excluded', 'memory-search',
    { memorySearch: { query: 'ペンギン', documents } },
    [{ type: 'selected-memory-ids', value: [] }]),
];
