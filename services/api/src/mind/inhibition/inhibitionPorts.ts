/**
 * The window of the inhibition part (Syzygy ADR-0008 §6 and §10; `scripts/api-layers.json` rule `mind-via-ports`): what another
 * part of the mind may import of it. Her own time and the tools reach the gate and the budget here; since stage 3 (S1) also the
 * types of the tool gate, the activity record and the day's log (types only, so nothing more runs in her process). The disclosure
 * gate and the conversation's secrets are deliberately not in it: they are `disclosurePorts.ts`, which her own time must not open
 * (rule `own-time-without-private-stores`).
 */
export * from './autonomyBudget.js';
export * from './autonomyPolicy.js';
export * from './withheldRules.js';
export * from './reachOutPace.js';
export { type ToolCallContext } from './shannonToolGate.js';
export { type AutonomyActivityDay, type AutonomyActivityEntry } from './store/autonomyActivity.js';
export { type AutonomyLoopStatus } from './autonomyDayLog.js';
