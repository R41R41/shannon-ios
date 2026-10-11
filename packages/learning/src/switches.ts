import { switchOn, switchedOn, switchedOnExplicitly, type SwitchName, type SwitchValues } from '@shannon/switches';

/**
 * The switches of Syzygy ADR-0008 stage 1 (`docs/cognition-ledger-contract.md`). Pure: the caller hands the values in
 * (the services read their environment; this package reads none).
 *
 * Every switch is on unless it says `off`, `false`, `0`, `disabled`, `no` or `none`. Off restores the behaviour of the
 * commit before stage 1 exactly. The implications are fixed here, in one place:
 * - `SHANNON_ADR8_STAGE1` off: everything below is off.
 * - `SHANNON_PREDICTION_SHADOW` off (the ADR-0006 record is not kept): the prediction ledger is off too.
 * - `SHANNON_CHOICE_LEDGER` off: no choices and no values, so the reward mood and the value facts are off too.
 */
export interface CognitionLedgerSwitches {
  /** `SHANNON_ADR8_STAGE1`: the master switch. */
  stage1: boolean;
  /** `SHANNON_PREDICTION_LEDGER`: predictions with an id, opened before the outcome and settled against it. Core: emotion, memory. */
  predictionLedger: boolean;
  /** `SHANNON_CHOICE_LEDGER`: her choices, their reward and the value table. Core: guard, emotion. */
  choiceLedger: boolean;
  /** `SHANNON_REWARD_MOOD`: a settled choice moves her mood (`choice-appraised`). Core: emotion source. */
  rewardMood: boolean;
  /** `SHANNON_VALUE_FACTS`: the 「これまでの手応え」 lines in her thinking prompt. Core: purpose. */
  valueFacts: boolean;
  /** `SHANNON_DECISION_TRACES`: one content-free trace per decision (voice routing, a thought of her own), and the Jev call count. Core: response path, record. */
  decisionTraces: boolean;
}

// One reader of every switch (`@shannon/switches`, Syzygy ADR-0009 stage 1); the words are re-exported for existing callers.
export { switchedOn, switchedOnExplicitly, type SwitchValues };

export function cognitionLedgerSwitches(values: SwitchValues): CognitionLedgerSwitches {
  const on = (name: SwitchName) => switchOn(values, name);
  const stage1 = on('SHANNON_ADR8_STAGE1');
  const predictionLedger = stage1 && on('SHANNON_PREDICTION_SHADOW') && on('SHANNON_PREDICTION_LEDGER');
  const choiceLedger = stage1 && on('SHANNON_CHOICE_LEDGER');
  return Object.freeze({
    stage1,
    predictionLedger,
    choiceLedger,
    rewardMood: choiceLedger && on('SHANNON_REWARD_MOOD'),
    valueFacts: choiceLedger && on('SHANNON_VALUE_FACTS'),
    decisionTraces: stage1 && on('SHANNON_DECISION_TRACES'),
  });
}

/**
 * The switches of Syzygy ADR-0008 stage 2 (`docs/skill-and-routing-contract.md`). Pure, like the stage-1 switches.
 *
 * Every switch is on unless it says off (the same words as above), except `SHANNON_SONNET_ROUTING`, which is off unless it
 * says `on`, `true`, `1` or `yes` (owner decision I-1: Sonnet goes live only after the owner has seen the `tier.*` report).
 * **`SHANNON_ADR8_STAGE2=off` restores the behaviour of ca7cf519 byte for byte**: no Jev call beyond the voice router, no
 * table, every request, prompt and reply as it was. The implications are fixed here, in one place:
 * - `SHANNON_ADR8_STAGE2` off: everything below is off.
 * - `SHANNON_DIFFICULTY` off: no tiers, so the verifier's luna checker and Sonnet routing are off too (the deterministic
 *   check of `SHANNON_TURN_VERIFY` stays).
 * - `SHANNON_SKILLS` off: no skill memory, so nothing is exported to Aether (`SHANNON_SKILL_EXPORT`) and tree recall does
 *   not walk skill sections (it still walks knowledge headings and the Aether folder).
 */
export interface SkillRoutingSwitches {
  /** `SHANNON_ADR8_STAGE2`: the master switch. */
  stage2: boolean;
  /** `SHANNON_TOOL_MENU`: Jev chooses the tools whose schemas the model gets (`tool_open` for the rest). Core: response path. */
  toolMenu: boolean;
  /** `SHANNON_READ_TOOLS`: Notion, Voyager tasks, the schedule and place search as gated registry tools. Core: guard, response path. */
  readTools: boolean;
  /** `SHANNON_DIFFICULTY`: Jev's difficulty questions, the tier policy and the competence table. Core: response path. */
  difficulty: boolean;
  /** `SHANNON_TURN_VERIFY`: the turn verifier (write claims against write results; the luna checker with `difficulty`). Core: response path. */
  turnVerify: boolean;
  /** `SHANNON_SKILLS`: skill memory (stage-2 step 6). Core: memory. */
  skills: boolean;
  /** `SHANNON_SKILL_EXPORT`: readable copies of her skills in Aether's シャノン用フォルダ (step 7). Core: memory. */
  skillExport: boolean;
  /** `SHANNON_TREE_RECALL`: Jev's beam search over headings (step 8). Core: memory, response path. */
  treeRecall: boolean;
  /** `SHANNON_SONNET_ROUTING`: the `sonnet` tier may leave for Anthropic (step 5; also needs the key). Default off. Core: response path. */
  sonnetRouting: boolean;
  /**
   * `SHANNON_CONVERSATION_REWARD` (owner answer I-3 「報酬にも入れる」): her tool calls and tier choices in a conversation are scored
   * by closed outcome signals and go into reward, mood (warm-up and hourly cap unchanged) and the value table. Needs the stage-1
   * choice ledger to have anywhere to go. Core: emotion.
   */
  conversationReward: boolean;
}

export function skillRoutingSwitches(values: SwitchValues): SkillRoutingSwitches {
  const on = (name: SwitchName) => switchOn(values, name);
  const stage2 = on('SHANNON_ADR8_STAGE2');
  const difficulty = stage2 && on('SHANNON_DIFFICULTY');
  const skills = stage2 && on('SHANNON_SKILLS');
  return Object.freeze({
    stage2,
    toolMenu: stage2 && on('SHANNON_TOOL_MENU'),
    readTools: stage2 && on('SHANNON_READ_TOOLS'),
    difficulty,
    turnVerify: stage2 && on('SHANNON_TURN_VERIFY'),
    skills,
    skillExport: skills && on('SHANNON_SKILL_EXPORT'),
    treeRecall: stage2 && on('SHANNON_TREE_RECALL'),
    sonnetRouting: difficulty && on('SHANNON_SONNET_ROUTING'),
    conversationReward: stage2 && on('SHANNON_CONVERSATION_REWARD'),
  });
}
