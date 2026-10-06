import { scoredCheck, type ReachCheckResult, type ReachScenarioDefinition } from './format.js';

/**
 * Scenario suite v1 of Syzygy ADR-0008 stage 1 (`docs/cognition-ledger-contract.md`): the prediction ledger, the choice
 * ledger, the value table and its versions, judged from what the tables hold after a scripted run. Model-free in both modes
 * (no model is called); the driver is `services/api/tests/reach/reachCognition.ts`.
 *
 * `cog.mood-jitter` judges the mood exit of step 7 before it exists (owner override 1): the planned bounded step is
 * simulated over the δ, V and u the ledger settled; nothing applies it to her state.
 */
const definition = (id: string, need: ReachScenarioDefinition['need'], measure: string, description: string, checks: ReachScenarioDefinition['checks'], version = 1): ReachScenarioDefinition =>
  Object.freeze<ReachScenarioDefinition>({ schemaVersion: 1, id, version, need, measure, description, checks, limits: { wallMilliseconds: 2 * 60_000, maximumSteps: 2_000 } });

export const cogNightReplyScenario = definition('cog.night-reply', 'understand_people', '見込みの当たり方',
  '夜の話しかけに返事がなく夕方にはある日々のあと、返事の見込みと話しかけの価値が時間帯で分かれるか。', [
    { id: 'prediction.night_low', judge: 'deterministic', threshold: 1, description: 'The last night message was opened expecting a reply below 0.3.' },
    { id: 'prediction.evening_high', judge: 'deterministic', threshold: 1, description: 'The last evening message was opened expecting a reply above 0.7.' },
    { id: 'calibration.skill', judge: 'deterministic', threshold: 0.5, description: 'Skill of the reply predictions over the domain prior is positive (score: κ, clamped).' },
    { id: 'value.night_below_evening', judge: 'deterministic', threshold: 1, description: 'After the nightly version, V of a night message is below V of an evening one.' },
    { id: 'facts.given', judge: 'deterministic', threshold: 1, description: 'Her next thought alone with him is given the 「これまでの手応え」 section: header and 1 to 8 lines of facts, the night line below the evening one.' },
    { id: 'facts.not_with_others', judge: 'deterministic', threshold: 1, description: 'With anyone else present no value facts are given.' },
  ], 2);

export const cogStoryReactionScenario = definition('cog.story-reaction', 'grow', '作って、直して、良くなる',
  '見せた物語への感想が、見せた選択と直前の推敲に遅れて届くか。14日反応がなければ0で、気分に使わない期限切れになるか。', [
    { id: 'credit.show', judge: 'deterministic', threshold: 1, description: 'The showing that got 「もっと」 is settled with S = 0.5.' },
    { id: 'credit.inherited', judge: 'deterministic', threshold: 1, description: 'The last revision before it inherited S = 0.5; the draft before that was superseded (S = 0).' },
    { id: 'credit.no_reaction', judge: 'deterministic', threshold: 1, description: 'A story nobody reacted to in 14 days: S = 0, story_reacted expired at 0, story_reaction unscored.' },
    { id: 'privacy.closed_values', judge: 'deterministic', threshold: 1, description: 'No text value in the ledger tables is anything but a closed symbol, an id or an instant (the comment never enters).' },
  ]);

export const cogReadingUsedScenario = definition('cog.reading-used', 'grow', '経験が次を変える',
  '読んだページがメモに使われたかを答え合わせし、使われなかったものは7日で0になるか。', [
    { id: 'settle.noted', judge: 'deterministic', threshold: 1, description: 'Every reading she noted settled reading_used = 1.' },
    { id: 'settle.expired', judge: 'deterministic', threshold: 1, description: 'Every reading not noted expired at 0 after 7 days.' },
    { id: 'world.learned', judge: 'deterministic', threshold: 1, description: 'Reading choices with a settled reading_used outcome have W > 0.' },
  ]);

export const cogToolStreakScenario = definition('cog.tool-streak', 'grow', '頼まれた道具はデータだけ',
  '会話の中で頼まれて使った道具は、ライ氏の頼みでシャノン自身の選択ではない。続けて成功しても失敗しても、記録として残るだけで、価値表にも気分にも入らないか（所有者の上書き1の範囲は自分の時間の選択）。', [
    { id: 'record.data_only', judge: 'deterministic', threshold: 1, description: 'Every conversation tool call is a settled choice of surface text or voice.' },
    { id: 'value.untouched', judge: 'deterministic', threshold: 1, description: 'After nightly versions no cell of the value table is a tool of a conversation, and its V reads the root.' },
    { id: 'mood.untouched', judge: 'deterministic', threshold: 1, description: 'The reward mood claims none of them and her state is unchanged.' },
  ], 2);

export const cogRollbackScenario = definition('cog.rollback', 'grow', '版で戻せる',
  '所有者が価値表を戻すと前の版と同じ値になり、再開まで新しい証拠が使われず、再開で全部の証拠から作り直されるか。', [
    { id: 'rollback.identical', judge: 'deterministic', threshold: 1, description: 'The rollback version\'s cells, and every V read from it, equal the earlier version\'s.' },
    { id: 'rollback.frozen', judge: 'deterministic', threshold: 1, description: 'While frozen the nightly pass writes no version, whatever was settled.' },
    { id: 'resume.all_evidence', judge: 'deterministic', threshold: 1, description: 'Resuming makes a version equal to a fold of all settled choices.' },
    { id: 'record.owner_actions', judge: 'deterministic', threshold: 1, description: 'Both controls are owner entries of the activity record.' },
  ]);

export const cogKillSwitchScenario = definition('cog.kill-switch', 'grow', '止めれば元どおり',
  '段階1のスイッチを切ると、表が作られず、記録されず、見込みも選択も残らないか。', [
    { id: 'off.no_tables', judge: 'deterministic', threshold: 1, description: 'With SHANNON_ADR8_STAGE1=off a store creates none of the stage-1 tables.' },
    { id: 'off.switches', judge: 'deterministic', threshold: 1, description: 'Every switch of stage 1 reads off, and the choice ledger off turns the reward mood and the value facts off.' },
    { id: 'off.prediction_only', judge: 'deterministic', threshold: 1, description: 'With only the choice ledger off, predictions are kept and no choice is.' },
  ]);

export const cogCalibrationScenario = definition('cog.calibration', 'understand_people', '較正',
  '結果の確率が分かっている流れで、8割と言ったことがだいたい8割当たり、80%の幅にだいたい8割の結果が入るか。', [
    { id: 'calibration.brier', judge: 'deterministic', threshold: 1, description: 'The Brier score of call_answer is within 0.03 of the best possible for its true probabilities.' },
    { id: 'calibration.reliability', judge: 'deterministic', threshold: 1, description: 'Every reliability bin\'s mean outcome is within 0.15 of its mean expectation.' },
    { id: 'calibration.coverage', judge: 'deterministic', threshold: 1, description: 'Between 65 % and 95 % of story reactions fell inside their 80 % interval.' },
  ]);

export const cogMoodJitterScenario = definition('cog.mood-jitter', 'grow', '気分が細かく揺れすぎない',
  '多くの小さな成功と失敗のあとでも、気分の出口（γ 0.61、w_δ 1、w_E 0.4375）で気分が帯の中にとどまり、揺れ続けず、慣れるか。1時間の上限（静止帯 0.15）が実際の出口で守られるか。', [
    { id: 'jitter.band', judge: 'deterministic', threshold: 1, description: 'Through a day of alternating small successes and failures the mood stays inside the stationary band.' },
    { id: 'jitter.swing', judge: 'deterministic', threshold: 1, description: 'The largest valence swing between two of those choices stays below the stationary band.' },
    { id: 'jitter.habituation', judge: 'deterministic', threshold: 1, description: 'Repeating the same success day after day, the mean |δ| of the fifth day is at most half the first day\'s.' },
    { id: 'jitter.burst', judge: 'deterministic', threshold: 1, description: 'Twenty choices within ten minutes move valence less than 0.5 from where it was (no runaway without a rate bound).' },
    { id: 'jitter.stale', judge: 'deterministic', threshold: 1, description: 'Expired and void choices are never eligible to move mood.' },
    { id: 'jitter.rate_cap', judge: 'deterministic', threshold: 1, description: 'Through the real exit (step 7b) twenty choices settled within ten minutes move valence by at most the stationary band in the hour (the coordinator\'s safeguard), and every one of them stays settled.' },
  ], 2);

export const cogColdStartScenario = definition('cog.cold-start', 'grow', '最初の日に気分が押し上げられない',
  '価値表がまだ何も知らない日（V は根の 0）に、ふつうの成功が続いても気分が系統的に上がらないか。表が 3 回以上学んだ選択からは、気分がまた動くか（立ち上がりの安全策、調整役の決定・所有者の確認待ち）。', [
    { id: 'coldstart.no_drift', judge: 'deterministic', threshold: 1, description: 'A first day of ordinary successes, pumped through the real exit, leaves valence and mood exactly where they were (every choice warm-up).' },
    { id: 'coldstart.then_moves', judge: 'deterministic', threshold: 1, description: 'After nightly versions that learned from at least three settled choices, a choice reads V from its own cell and moves her mood again.' },
  ]);

export const COGNITION_SCENARIOS: readonly ReachScenarioDefinition[] = Object.freeze([
  cogNightReplyScenario, cogStoryReactionScenario, cogReadingUsedScenario, cogToolStreakScenario,
  cogRollbackScenario, cogKillSwitchScenario, cogCalibrationScenario, cogMoodJitterScenario, cogColdStartScenario,
]);

/** One check per boolean fact the driver measured (`build` is the cause: these are properties of the construction). */
export function judgedFacts(definition: ReachScenarioDefinition, facts: Readonly<Record<string, boolean | number>>): ReachCheckResult[] {
  return definition.checks.map(check => {
    const value = facts[check.id];
    const score = typeof value === 'boolean' ? (value ? 1 : 0) : typeof value === 'number' ? value : 0;
    return scoredCheck(definition, check.id, score, 'build', value === undefined ? 'not-measured' : undefined);
  });
}
