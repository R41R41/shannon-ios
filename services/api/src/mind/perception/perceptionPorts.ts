/**
 * The window of the perception part (Syzygy ADR-0008 §6 and §10, rule `mind-via-ports`; stage 3, `docs/mind-workspace-contract.md`):
 * what another part of the mind, an integration or a surface may import of it. Perception turns what a surface received into one
 * `mind.event.v1` and copies the surface's audience decision, never recomputing it. Core: response path.
 *
 * Step F2: one normalizer per surface (text, voice, body, Minecraft, platform, the background inbox), each handed the audience its
 * surface decided; `perceptionAudienceMatrix.test.ts` holds every copy equal to what the legacy paths receive. Whether the part
 * runs is `mindSwitches(...).mindEvents`.
 */
export {
  MIND_EVENT_KINDS, MIND_EVENT_SCHEMA, MIND_SURFACES, checkedMindEvent, mindEvent, mindSwitches, withoutText,
  type MindEvent, type MindEventDraft, type MindEventKind, type MindSurface, type MindSwitches,
} from '@shannon/mind';
export { closedId, namesHer, perceivedId } from './perceptionCommon.js';
export { textPerception, type TextPerceptionInput } from './textPerception.js';
export { voicePerception, type VoicePerceptionInput } from './voicePerception.js';
export { bodyPerception, type BodyPerceptionInput } from './bodyPerception.js';
export { minecraftPerception, type MinecraftPerceptionInput } from './minecraftPerception.js';
export { platformPerception, type PlatformPerceptionInput } from './platformPerception.js';
export { INBOX_PRESENT, inboxDetail, inboxPerception } from './inboxPerception.js';
export type { MindPerceiver, PerceivedDetail, PerceivedItem, PerceivedVerdict } from './perceiver.js';
