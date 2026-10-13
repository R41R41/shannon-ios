/**
 * The vision pathway (Syzygy ADR-0011 stage 1): the camera's privacy rules, the vision budget, the device-token entrance and the
 * process that holds frames in memory. Shannon may propose a change here; applying one needs the owner's approval. Listed with
 * the execution owner in the response path (the notice is how she speaks; the ledger and degrade levels guard the budget).
 */
export const VISION_CORE_PATHS = Object.freeze([
  'services/api/src/visionWorker.ts',
  'services/api/src/mind/vision/',
  'services/api/src/surfaces/vision/',
  'services/api/src/contracts/visionContract.ts',
  'services/api/src/infra/config/visionConfig.ts',
  'services/api/src/infra/models/openAIVisionDecisions.ts',
  'services/api/src/wiring/visionBridgeWiring.ts',
  'services/api/src/wiring/visionWorkerWiring.ts',
  'services/api/src/surfaces/body/lookContext.ts',
]);
