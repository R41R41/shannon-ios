/**
 * The window of the selectors part (Syzygy ADR-0008 §6 and §10, rule `mind-via-ports`): what another part of the mind may import
 * of it. The turn's routing (`mind/action/respond/turnRouting.ts`) reaches the verifier here; since stage 3 (S1) the voice
 * decision's type too.
 */
export {
  TURN_CHECKER_MINIMUM_MILLISECONDS, WRITE_CLAIM_CORRECTION, verifiedReply, verifyWriteClaims, writeClaims,
  type TurnChecker, type TurnToolResult, type TurnVerdict,
} from './turnVerifier.js';
export { type VoiceTurnDecision } from './voiceDecision.js';
export { JevFcaToolSelector, type FcaToolSelector, type FcaToolSelectionRequest, type FcaToolSelectionResult } from './fcaToolSelection.js';
