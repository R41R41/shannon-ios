/**
 * The window of the prediction part (Syzygy ADR-0008 §6 and §10, rule `mind-via-ports`; stage 3, S1): what another part of the mind
 * may import of it (a touch's predictions and the type of the shadow).
 */
export { TouchPredictions, stanceOutcome, touchPredictionEnabled, type TouchPrediction, type TouchPredictionRecord } from './bodyTouchPrediction.js';
export { type PredictionShadow } from './store/predictionShadow.js';
