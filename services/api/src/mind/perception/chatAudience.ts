import {
  OWNER_AUDIENCE,
  UNKNOWN_GUEST_PRESENCE,
  guardedShannonSeenPrompt,
  messageEmotionForOthers,
  shannonIdentityPrompt,
  type CompanionStateSnapshot,
  type MemoryAudience,
} from '@shannon/cognition';
import type { PresentedCompanionState } from '../emotion/emotionPorts.js';
import type { ChatResponse } from '../../contracts/contracts.js';
import type { ConversationCapabilitySelection } from '../action/respond/respondPorts.js';
import type { ConversationStore } from '../memory/memoryPorts.js';
import { identityOnly, type LayeredIdentityPrompt } from '../memory/identityPorts.js';
import { DisclosureGate, sharedDailyFocus } from '../inhibition/disclosurePorts.js';
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
  /** `speaker: 'owner'` only where the server verified him (her Minecraft body's shared chat, `platformSurface.ts`). */
  readonly turnLabel: { audience?: MemoryAudience; speaker?: 'owner' | 'unknown' };
  /** The full owner profile is for the owner alone; otherwise the identity block without it. */
  identity(ownerProfile: () => LayeredIdentityPrompt): LayeredIdentityPrompt;
  /** Today's focus and her own pursuits, as the owner voice path gives them to this audience. */
  ownFocus(focus: string, pursuits: string, state: CompanionStateSnapshot, store: ConversationStore, scopeKey: string): string;
  /** The response body as this audience may receive it. The owner's is returned untouched. */
  visible(response: ChatResponse): ChatResponse;
}

/**
 * The response of a turn other people can see. No guest projection of the companion state
 * existed (guest voice returns none), so only what renders the reply is kept: her traits,
 * emotion values and present face. Collections keep their keys, empty, because deployed
 * decoders require them. The prompt and the thread row (title, rolling summary, sections)
 * are owner material and are not returned. The face is sent as before; the reply's emotion `kind`
 * is the owner's alone (coordinator decision 2026-10-05) and is left out, though it is stored.
 */
function sharedChatResponse(response: ChatResponse): ChatResponse {
  const { thread: _thread, state, ...rest } = response;
  const presence = (state as PresentedCompanionState).presence;
  const reduced: PresentedCompanionState = {
    scopeKey: state.scopeKey, version: state.version, updatedAt: state.updatedAt,
    temperament: state.temperament, emotion: state.emotion,
    interests: [], userFacts: [], activeMemories: [], relationships: [], prospectiveMemories: [], memoryControls: [],
    // The cause of a feeling may quote an earlier one-to-one turn; the face itself stays.
    presence: { mood: { ...presence.mood, cause: '' }, temperamentReasons: { closeness: '', curiosity: '', confidenceAboutUser: '' } },
  };
  return { ...rest, messageEmotion: messageEmotionForOthers(rest.messageEmotion), systemPrompt: '', state: reduced };
}

const OWNER_TURN: ChatAudienceTurn = Object.freeze({
  audience: 'owner', present: OWNER_AUDIENCE, alone: true, participantMode: 'owner', capabilities: undefined,
  instructions: '', turnLabel: Object.freeze({}),
  identity: (ownerProfile: () => LayeredIdentityPrompt) => ownerProfile(),
  ownFocus: (focus: string, pursuits: string) => [focus, pursuits].filter(Boolean).join('\n\n'),
  visible: (response: ChatResponse) => response,
});

const OTHERS_TURN: ChatAudienceTurn = Object.freeze({
  audience: 'others', present: UNKNOWN_GUEST_PRESENCE, alone: false, participantMode: 'guest',
  // The owner's upcoming items stay readable, guarded like the rest of what is his alone.
  capabilities: Object.freeze({ aetherNotes: false, voyagerTasks: false, notion: false, upcoming: 'guarded' as const }),
  instructions: [chatOthersPresentInstructions, speakTimePrivacyCheck].join('\n\n'),
  turnLabel: Object.freeze({ audience: UNKNOWN_GUEST_PRESENCE, speaker: 'unknown' as const }),
  // The owner's identity, its temperament worded for whoever is there (scope (a), 2026-10-06).
  identity: () => identityOnly(shannonIdentityPrompt('owner', { othersPresent: true })),
  // What she does in her own time is told to the owner alone. What she saw of his room stays, guarded: each
  // line carries the marker of unlabelled personal information, and the speak-time check decides what is said.
  ownFocus: (focus: string, pursuits: string, state: CompanionStateSnapshot, store: ConversationStore, scopeKey: string) => {
    const gate = new DisclosureGate(UNKNOWN_GUEST_PRESENCE, state, store, scopeKey);
    return [sharedDailyFocus(gate, focus), guardedShannonSeenPrompt(pursuits, gate.unlabelledMarker)].filter(Boolean).join('\n\n');
  },
  visible: sharedChatResponse,
});

/** The turn policy for a request value. Absent is the owner alone; anything else unknown is refused (null). */
export function chatAudienceTurn(value: unknown): ChatAudienceTurn | null {
  if (value === undefined || value === 'owner') return OWNER_TURN;
  return value === 'others' ? OTHERS_TURN : null;
}
