import {
  OWNER_AUDIENCE,
  UNKNOWN_GUEST_PRESENCE,
  shannonIdentityPrompt,
  type CompanionStateSnapshot,
  type MemoryAudience,
} from '@shannon/cognition';
import type { ConversationCapabilitySelection } from './conversationCapabilities.js';
import type { ConversationStore } from './conversationStore.js';
import { DisclosureGate, sharedDailyFocus } from './memoryDisclosure.js';
import { speakTimePrivacyCheck } from './voiceCompanionPresence.js';

/** `audience` on `POST /v1/chat`: who can see or hear the reply, as the client reports it. */
export type ChatAudience = 'owner' | 'others';

/**
 * Appended to the text prompt while other people can see or hear the reply. It is the text
 * counterpart of `companionPresentInstructions`; what may be said is decided by the shared
 * `speakTimePrivacyCheck`, not by this block.
 */
export const chatOthersPresentInstructions = [
  '[Other people can see this reply — 同席者あり]',
  '- The app reported that people other than ライ氏 can see or hear this reply (a shared or streamed screen, or someone beside him). Everything you write may reach them. Do not assume that every message is ライ氏\'s.',
  '- Requests that act (tasks, notes, remembering, forgetting, promises, starting work) are not carried out while other people can see the reply. Say lightly that you will do it when you two are alone.',
].join('\n');

/**
 * What one text turn may read and store for the audience the client reported. `others` is
 * the text form of an owner call with someone listening: an unknown guest is present, so
 * every memory path receives `UNKNOWN_GUEST_PRESENCE` and applies the one disclosure gate.
 */
export interface ChatAudienceTurn {
  /** Echoed in the response so the client can verify what the server applied. */
  readonly audience: ChatAudience;
  readonly present: MemoryAudience;
  /** Only the owner reads the reply. */
  readonly alone: boolean;
  /** Orchestration state is the owner's own; with others present none is observed. */
  readonly participantMode: 'owner' | 'guest';
  /** Undefined keeps the default reads. With others present no note, task or Notion read is made. */
  readonly capabilities: ConversationCapabilitySelection | undefined;
  /** The speak-time rule text, empty when the owner is alone. */
  readonly instructions: string;
  /** How the completed turn is stored. With others present it teaches nothing about the owner. */
  readonly turnLabel: { audience?: MemoryAudience; speaker?: 'unknown' };
  /** The full owner profile is for the owner alone; otherwise the identity block without it. */
  identity(ownerProfile: () => string): string;
  /** Today's focus and her own pursuits, as the owner voice path gives them to this audience. */
  ownFocus(focus: string, pursuits: string, state: CompanionStateSnapshot, store: ConversationStore, scopeKey: string): string;
}

const OWNER_TURN: ChatAudienceTurn = Object.freeze({
  audience: 'owner', present: OWNER_AUDIENCE, alone: true, participantMode: 'owner', capabilities: undefined,
  instructions: '', turnLabel: Object.freeze({}),
  identity: (ownerProfile: () => string) => ownerProfile(),
  ownFocus: (focus: string, pursuits: string) => [focus, pursuits].filter(Boolean).join('\n\n'),
});

const OTHERS_TURN: ChatAudienceTurn = Object.freeze({
  audience: 'others', present: UNKNOWN_GUEST_PRESENCE, alone: false, participantMode: 'guest',
  capabilities: Object.freeze({ aetherNotes: false, voyagerTasks: false, notion: false }),
  instructions: [chatOthersPresentInstructions, speakTimePrivacyCheck].join('\n\n'),
  turnLabel: Object.freeze({ audience: UNKNOWN_GUEST_PRESENCE, speaker: 'unknown' as const }),
  identity: () => shannonIdentityPrompt('owner'),
  // What she does in her own time is told to the owner alone.
  ownFocus: (focus: string, _pursuits: string, state: CompanionStateSnapshot, store: ConversationStore, scopeKey: string) =>
    sharedDailyFocus(new DisclosureGate(UNKNOWN_GUEST_PRESENCE, state, store, scopeKey), focus),
});

/** The turn policy for a request value. Absent is the owner alone; anything else unknown is refused (null). */
export function chatAudienceTurn(value: unknown): ChatAudienceTurn | null {
  if (value === undefined || value === 'owner') return OWNER_TURN;
  return value === 'others' ? OTHERS_TURN : null;
}
