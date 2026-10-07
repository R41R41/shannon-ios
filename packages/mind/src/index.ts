/**
 * `@shannon/mind`: the pure parts of Syzygy ADR-0008 stage 3 (知覚・注意・共有の場・記憶の書き手・人の事実). Core: response path
 * (files listed by name in `autonomyCore.ts` keep the area that lists them).
 *
 * Like `@shannon/cognition` and `@shannon/learning` it holds no database, no network, no environment and no timer: the services
 * hand it events, rows and the time, and store what it returns. The contract is `docs/mind-workspace-contract.md`.
 */
export {
  MIND_SWITCH_NAMES,
  mindSwitches,
  switchedOn,
  switchedOnExplicitly,
  type MindSwitches,
  type SwitchValues,
} from './switches.js';
