/**
 * The silence window of the attention part (Syzygy ADR-0008 §6 and §10, rule `mind-via-ports`; stage 3, S3): `voiceSilence`, the
 * only silencer, moved from the voice surface into attention. Kept apart from `attentionPorts.ts` so that the voice decision loads
 * nothing more than it did (the run-time closure of every process is unchanged).
 */
export { localTurnSilence, openAIReplyInstruction, replyRequiredQuestion, routerTurnState } from './voiceSilence.js';
