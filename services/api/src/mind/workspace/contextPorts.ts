/**
 * The turn-context window of the workspace part (Syzygy ADR-0008 §6 and §10, rule `mind-via-ports`; stage 3, S3): a turn's
 * cognitive context (`turnCognitiveContext.ts`, moved from the respond action into the workspace), for recall and for the one reader
 * of the owner's context in her own time (`autonomyOwnerContext.ts`, the rule's exception). Kept apart from `workspacePorts.ts` so
 * that nothing loads more than it did. Her own time may not import it otherwise (rule `own-time-without-private-stores`).
 */
export { prepareTurnCognitiveContext, withRecalledMemories, type LabelledRecallCandidate, type TurnCognitiveContext } from './turnCognitiveContext.js';
