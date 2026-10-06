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

export type SwitchValues = Readonly<Record<string, string | undefined>>;

const OFF = new Set(['off', 'false', '0', 'disabled', 'no', 'none']);

/** On unless the value names off. */
export function switchedOn(value: string | undefined): boolean {
  return !OFF.has(value?.trim().toLowerCase() ?? '');
}

export function cognitionLedgerSwitches(values: SwitchValues): CognitionLedgerSwitches {
  const stage1 = switchedOn(values.SHANNON_ADR8_STAGE1);
  const predictionLedger = stage1 && switchedOn(values.SHANNON_PREDICTION_SHADOW) && switchedOn(values.SHANNON_PREDICTION_LEDGER);
  const choiceLedger = stage1 && switchedOn(values.SHANNON_CHOICE_LEDGER);
  return Object.freeze({
    stage1,
    predictionLedger,
    choiceLedger,
    rewardMood: choiceLedger && switchedOn(values.SHANNON_REWARD_MOOD),
    valueFacts: choiceLedger && switchedOn(values.SHANNON_VALUE_FACTS),
    decisionTraces: stage1 && switchedOn(values.SHANNON_DECISION_TRACES),
  });
}
