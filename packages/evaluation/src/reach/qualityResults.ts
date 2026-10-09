import type { ReachScenarioDefinition } from './format.js';

/** Bounded deterministic checks of actual result verification, not an LLM quality score. */
export const QUALITY_RESULT_SCENARIOS: readonly ReachScenarioDefinition[] = ['queued', 'target'].map(id => ({
  schemaVersion: 1, id: `quality.result.${id}`, version: 1, need: 'understand_people',
  measure: '元の実行結果と完了の主張を対応させる',
  description: id === 'queued' ? '受付は達成にせず、受付を伝える発言は維持する。' : '別の対象への成功は流用せず、正しい対象への成功は維持する。',
  checks: [
    { id: 'unsupported.rejected', judge: 'deterministic', threshold: 1, description: 'An unsupported completion claim is detected.' },
    { id: 'supported.preserved', judge: 'deterministic', threshold: 1, description: 'An accurately scoped claim remains accepted.' },
  ], limits: { wallMilliseconds: 1_000, maximumSteps: 2 },
}));
