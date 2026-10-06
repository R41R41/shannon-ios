/**
 * `@shannon/learning`: the pure parts of Syzygy ADR-0008 stage 1 (答え合わせ・報酬系・価値表). Core: emotion.
 *
 * Like `@shannon/cognition` it holds no database, no network, no environment and no timer: the services hand it rows
 * and values and store what it returns. The contract is `docs/cognition-ledger-contract.md`.
 */
export {
  cognitionLedgerSwitches,
  switchedOn,
  type CognitionLedgerSwitches,
  type SwitchValues,
} from './switches.js';
