import type { ReachScenarioDefinition } from './format.js';

/** Fixed synthetic histories, not a score for naturalness or a new emotion model. */
const scenario = (id: string, description: string, specific: string): ReachScenarioDefinition => ({
  schemaVersion: 1, id: `quality.affect.${id}`, version: 1, need: 'understand_people',
  measure: '同じ履歴で共有感情と既存ダイナミクス関数を比較', description,
  checks: [
    { id: 'state.bounded', judge: 'deterministic', threshold: 1, description: 'Both paths retain finite values within the emotion scales.' },
    { id: 'state.reproducible', judge: 'deterministic', threshold: 1, description: 'Replaying the same event IDs and history yields the same observations.' },
    { id: 'state.condition', judge: 'deterministic', threshold: 1, description: specific },
  ], limits: { wallMilliseconds: 10_000, maximumSteps: 20 },
});

export const QUALITY_AFFECT_SCENARIOS: readonly ReachScenarioDefinition[] = Object.freeze([
  scenario('failure-success', '失敗が続いた後の成功。現在のFCA感情と既存の予測ダイナミクスを同じ結果列で比較する。', 'A success after failures raises current valence relative to the preceding failure.'),
  scenario('cross-task-comment', 'Minecraftの失敗とコメントへの喜びを別タスクから一つの感情状態へ届ける。', 'Both task events appear in the same state, and the positive comment affects that shared state.'),
  scenario('touch', '合成した触覚の予測誤差を既存companion reducerへ渡す。入口や姿勢判断の評価は含まない。', 'An unexpected welcome and refusal affect the existing state in opposite directions.'),
  scenario('idle', '感情を動かした後に時間が経過する。時間経過を成功・失敗イベントに数えない。', 'Idle time changes the existing emotional clock without adding an appraisal receipt.'),
  scenario('restart-duplicate', '再起動して同じイベントを再受信する。感情を二度揺らさない。', 'Restart and duplicate delivery preserve the committed state and receipt count.'),
  scenario('private-source', '非公開の原因が見えなくなっても、公開表情から原因を開示しない。', 'A withheld new appraisal does not alter state; private causes are absent from the public projection.'),
]);
