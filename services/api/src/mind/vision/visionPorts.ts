/**
 * The window of the vision part (Syzygy ADR-0011, stage 1; rule `mind-via-ports`): what wiring, the worker's routes and another
 * part of the mind may import of it. The part runs in the vision worker (`visionWorker.ts`); the API only answers its bridge.
 * Nothing exported here can carry or keep a picture: frames live in `VisionFrameHolder` memory, records are `vision.*.v1`.
 */
export {
  VisionBudget, VISION_BUDGET_DEFAULTS, p95, visionDegradeLevel, type VisionBudgetLedger, type VisionDegradeLevel, type VisionReservation,
} from './visionBudget.js';
export type { SQLiteVisionBudgetStore, VisionBudgetPurpose, VisionDayTotals } from './store/visionBudgetStore.js';
export { VisionFrameHolder, type HeldFrame } from './visionFrames.js';
export { VISION_NOTICE_THRESHOLDS, visionNoticeCandidates, visionNoticeVerdict } from './visionCandidates.js';
export {
  VisionWatch, visionFrameBodyError, type VisionAudienceNow, type VisionBridge, type VisionFrameResult, type VisionPerceptWire, type VisionPrincipal,
  type VisionWatchOptions,
} from './visionWatch.js';
export { createVisionReflexHost, type VisionReflexHost, type VisionReflexProviders, type VisionReflexSource } from './visionReflex.js';
