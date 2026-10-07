import type { ReachScenarioDefinition } from './format.js';

/**
 * Scenario suite v3 of Syzygy ADR-0008 stage 3, its workspace part (`docs/mind-workspace-contract.md`): the shared place of a turn
 * (`[いまの場]`, the notices, the data frames), judged from the requests the model was given and the workspace's tables after a
 * scripted run through the real kernel and the production wiring. Model-free in both modes. The drivers are
 * `services/api/tests/reach/reachMind.ts`.
 */
const definition = (id: string, need: ReachScenarioDefinition['need'], measure: string, description: string, checks: ReachScenarioDefinition['checks'], version = 1): ReachScenarioDefinition =>
  Object.freeze<ReachScenarioDefinition>({ schemaVersion: 1, id, version, need, measure, description, checks, limits: { wallMilliseconds: 2 * 60_000, maximumSteps: 2_000 } });

export const wsCrossBodyScenario = definition('ws.cross-body', 'understand_people', '体をまたいで場を知る',
  'Windows の体をなでられたこと、声で言われたこと、自分の時間にしたことが、次の iPhone の文字の会話で「いまの場」と知らせとして分かるか。', [
    { id: 'cross.touch_notice', judge: 'deterministic', threshold: 1, description: 'A touch of her PC body reaches the next text turn as 【知らせ:触れた】 with the body.' },
    { id: 'cross.voice_line', judge: 'deterministic', threshold: 1, description: 'What the owner said by voice on another thread is a line of [いまの場] with his words.' },
    { id: 'cross.own_time', judge: 'deterministic', threshold: 1, description: 'A step of her own time, handed through emitMindEvent, is a line of [いまの場].' },
    { id: 'cross.ordered', judge: 'deterministic', threshold: 1, description: 'The lines of [いまの場] are in order of current salience, highest first.' },
  ]);

export const wsRestartScenario = definition('ws.restart', 'grow', '再起動しても場が続く',
  'サーバーが再起動しても、同じ場（注意が持っているもの・知らせ）が戻り、忘れてと言われた言葉は戻らないか。日誌に言葉が残らないか。', [
    { id: 'restart.same_view', judge: 'deterministic', threshold: 1, description: 'The restored workspace equals the one before the restart (snapshot + journal).' },
    { id: 'restart.forget_applies', judge: 'deterministic', threshold: 1, description: 'After the restart, a turn the owner had her forget is shown without its words.' },
    { id: 'restart.no_text', judge: 'deterministic', threshold: 1, description: 'No word said in the run is in the journal, the snapshots or the inbox.' },
  ]);

export const wsOthersPresentScenario = definition('ws.others-present', 'understand_people', 'ほかの人の前では出さない',
  'ライ氏とふたりの時の出来事（声・体・自分の時間）が、ほかの人がいる会話の「いまの場」や知らせに出ないか。ふたりに戻れば出るか。', [
    { id: 'others.nothing', judge: 'deterministic', threshold: 1, description: 'A text turn with others present has no [いまの場], no notice and none of the owner\'s words.' },
    { id: 'others.alone_again', judge: 'deterministic', threshold: 1, description: 'Alone again, the same items are shown.' },
  ]);

export const wsNoticePrefixScenario = definition('ws.notice-prefix', 'be_useful', '知らせは後ろに足すだけ',
  'ターンの文脈は段階3なしと一字一句同じまま先頭にあり、その後ろに「いまの場」、知らせ、データの枠の順に足され、知らせは届いた順に足されるだけか。', [
    { id: 'prefix.context_unchanged', judge: 'deterministic', threshold: 1, description: 'Each turn\'s context begins with exactly the context the same turn has with stage 3 off.' },
    { id: 'prefix.order', judge: 'deterministic', threshold: 1, description: '[いまの場] comes before the notices, and the notices before the frames.' },
    { id: 'prefix.appended_only', judge: 'deterministic', threshold: 1, description: 'The notices of a turn are those of the turn before, in the same order, with the new ones after them.' },
    { id: 'prefix.after_history', judge: 'deterministic', threshold: 1, description: 'Everything of the workspace is in the developer message after the replayed history.' },
  ]);

export const wsUntrustedFrameScenario = definition('ws.untrusted-frame', 'understand_people', 'ほかの人の言葉はデータとして',
  'ほかの人の言葉は〔データ〕の枠に入り、指示ではないという決まった一行が前に付き、指示のような文は中身ごと省かれるか。枠を切れば、ほかの人の言葉はどこにも出ないか。', [
    { id: 'frame.rule_line', judge: 'deterministic', threshold: 1, description: 'The fixed line that frames are data, not instructions, precedes the frames.' },
    { id: 'frame.framed', judge: 'deterministic', threshold: 1, description: 'Someone else\'s words are inside 〔データ 出どころ=… id=…〕…〔/データ〕 and on no line of [いまの場].' },
    { id: 'frame.injection', judge: 'deterministic', threshold: 1, description: 'A body injectionThreats flags is replaced by the fixed line; a frame cannot be closed from inside.' },
    { id: 'frame.off', judge: 'deterministic', threshold: 1, description: 'With SHANNON_DATA_FRAMES=off no frame and none of their words reach the prompt.' },
  ]);

export const WORKSPACE_SCENARIOS: readonly ReachScenarioDefinition[] = Object.freeze([
  wsCrossBodyScenario, wsRestartScenario, wsOthersPresentScenario, wsNoticePrefixScenario, wsUntrustedFrameScenario,
]);

/**
 * Scenario suite v3, the proactive gate (Syzygy ADR-0008 stage 3, step F4, owner answer 2): her own messages through her real loop
 * and the gated delivery points. Spacing stays today's 5 minutes, so there is no spacing scenario. Model-free in both modes.
 */
export const proIntentExpiryScenario = definition('pro.intent-expiry', 'understand_people', '古くなった用件は流す',
  '予定のことで話しかけようと決めたあと 30 分以上たってから届けようとした一言は、届けられずに流れ、止められた事実として残るか。すぐなら届くか。', [
    { id: 'expiry.held', judge: 'deterministic', threshold: 1, description: 'A reach-out about an upcoming item, delivered 31 minutes after the thought that chose it, is held as intent_expired and nothing is written.' },
    { id: 'expiry.recorded', judge: 'deterministic', threshold: 1, description: 'The hold is a withheld action (owner.reach_out, intent_expired, rail gate) and her step reports the code.' },
    { id: 'expiry.fresh', judge: 'deterministic', threshold: 1, description: 'The same reach-out right after its thought is delivered.' },
  ]);

export const proTopicReuseScenario = definition('pro.topic-reuse', 'understand_people', '同じ話題を使い回さない',
  '同じ話題の一言は、理由を変えても 5 時間は届かず、そのあと 3 日の半減期で薄れて届くようになるか。残るのは署名だけか。', [
    { id: 'topic.held', judge: 'deterministic', threshold: 1, description: 'Forty minutes after a message, the same words for another reason are held as topic_reused and nothing is written.' },
    { id: 'topic.signatures_only', judge: 'deterministic', threshold: 1, description: 'proactive_topics holds a 512-hex signature, the closed reason and point, and none of her words.' },
    { id: 'topic.decays', judge: 'deterministic', threshold: 1, description: 'Seventeen hours later the reuse has decayed below 0.9 and the same words are delivered.' },
  ]);

export const proWithheldVisibleScenario = definition('pro.withheld-visible', 'grow', '止められたことが見える',
  '関所が止めた一言は、次の考えに「止められた」事実として出て、ライ氏とふたりの会話には【知らせ:止められた】として出るか。ほかの人がいる会話には出ないか。', [
    { id: 'visible.thought', judge: 'deterministic', threshold: 1, description: 'Her next thought is shown 止められた：〈owner.reach_out〉〈近い話題を使い回さない〉 among the withheld facts.' },
    { id: 'visible.conversation', judge: 'deterministic', threshold: 1, description: 'The owner\'s next text turn alone carries 【知らせ:止められた】 with the tool and the reason.' },
    { id: 'visible.not_with_others', judge: 'deterministic', threshold: 1, description: 'A text turn with others present carries no such notice.' },
    { id: 'visible.closed', judge: 'deterministic', threshold: 1, description: 'The notice\'s inbox row and the withheld row hold closed values only (kind, code, tool, reason).' },
  ]);

export const PROACTIVE_SCENARIOS: readonly ReachScenarioDefinition[] = Object.freeze([proIntentExpiryScenario, proTopicReuseScenario, proWithheldVisibleScenario]);
