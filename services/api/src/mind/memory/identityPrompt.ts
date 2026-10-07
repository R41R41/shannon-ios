/** Her identity block in its three layers, and its forms without a knowledge store (Syzygy ADR-0008 stage 3, S2: moved unchanged out of `store/knowledgeStore.ts`, so the surfaces and perception read it without reaching a store). */
import { buildCompanionStatePrompt, type CompanionStateSnapshot, SHANNON_CORE_PROMPT } from '@shannon/cognition';

/**
 * Her identity block split by how often each part changes (Syzygy ADR-0003 principle 4: fixed instructions first,
 * changing state at the end, so the provider's prompt cache holds the start of every request): `identity` (persona,
 * suite roles, capabilities) is fixed; `profile` (what she knows of the owner, the personality analysis) changes when
 * background work learns something; `state` (the shared state) changes every turn. The model request puts `identity`
 * first and `state` with the turn's context (`chatModelTurn.ts`).
 */
export interface LayeredIdentityPrompt {
  identity: string;
  profile: string;
  state: string;
}

/** The identity block in the order it had before it was split, and still has where one string is shown. */
export function joinedIdentityPrompt(parts: LayeredIdentityPrompt): string {
  return [parts.identity, parts.state, parts.profile].filter(Boolean).join('\n\n');
}

/** An identity without the owner's profile or state (another audience). */
export function identityOnly(identity: string): LayeredIdentityPrompt {
  return { identity, profile: '', state: '' };
}

/** Without a knowledge store: the core identity and the shared state, as `assembleShannonSystemPrompt` joins them. */
export function companionIdentityPrompt(snapshot: CompanionStateSnapshot): LayeredIdentityPrompt {
  return { identity: SHANNON_CORE_PROMPT, profile: '', state: buildCompanionStatePrompt(snapshot) };
}
