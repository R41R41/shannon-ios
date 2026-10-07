/**
 * The disclosure window of the inhibition part (Syzygy ADR-0008 §6 and §10, rule `mind-via-ports`; stage 3, S1): the disclosure
 * gate, the conversation's secrets, what may be shown to others of Aether, and who is present for a tool. Kept apart from
 * `inhibitionPorts.ts` because her own time must not open it (rule `own-time-without-private-stores`, `autonomyLoopPrivacy.test.ts`).
 */
export { type OthersTextCheck } from './aetherShownText.js';
export { type SecretCheck } from './conversationSecrets.js';
export { DisclosureGate, sharedProfilePrompt } from './memoryDisclosure.js';
