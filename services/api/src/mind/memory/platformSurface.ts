import { shannonIdentityPrompt, guardedShannonSeenPrompt, type CompanionStateSnapshot } from '@shannon/cognition';
import { turnPersistenceContext, type CompletedTurn } from '../sleep/sleepPorts.js';
import type { TextTurnInput, TextTurnSurface } from '../../infra/http/apiKernel.js';
import { chatAudienceTurn, type ChatAudienceTurn } from '../perception/perceptionPorts.js';
import type { ChatResponse } from '../../contracts/contracts.js';
import type { ConversationStore, ShannonExperience } from './memoryPorts.js';
import { identityOnly } from './identityPrompt.js';
import { DisclosureGate, sharedDailyFocus } from '../inhibition/disclosurePorts.js';
import {
  PlatformBridgeError,
  type PlatformAudiencePolicy, type PlatformBridgeService, type PlatformTurnRequest, type ShannonPlatform,
} from './platformBridge.js';
import { speakTimePrivacyCheck } from '../perception/perceptionPorts.js';
import { sharedAudienceHeader } from './platformBridgeBindings.js';

/** The speak-time check of a turn someone other than the owner wrote: nobody there may release a protected line of his. */
const OTHERS_SPEAK_TIME_CHECK = speakTimePrivacyCheck.split('\n').filter(line => !line.startsWith('- When ライ氏 himself')).join('\n');

/**
 * One platform surface of the conversation kernel (`ShannonApiKernel.textTurn`), shared by every place where a bound
 * platform conversation is answered by her one mind: her Minecraft body's game chat (`minecraftBody.ts`) and the platform
 * reply route (`platformReply.ts`, Discord first). Who is present comes from the platform bridge's own policy
 * (`PlatformBridgeService.audiencePolicy`, which `POST /v1/platform/context` uses too):
 *
 * - the owner in a conversation bound `owner-private` is the owner alone: exactly the app's owner turn (his profile,
 *   tools by the app's owner-alone rule, his feeling moves);
 * - the owner in a shared conversation: everyone there is present (the conversation's group audience); her identity
 *   without his profile, the speak-time check, no owner reads (notes, tasks, Notion, calendar); his turn is kept in the
 *   platform thread as his (`speaker: owner`) with that audience. Where the surface asks for it (`othersFolderReading`,
 *   the platform reply route) it is offered her Aether reading tools inside 「シャノン用フォルダ」 and nothing else, what she
 *   reads without his secrets and personal matters and marked as a whole for the speak-time check (owner decision
 *   2026-10-06); otherwise no tools;
 * - anyone else: their audience (the conversation as a whole, or that person alone in a DM), her guest identity, what
 *   she remembers of the people there. In a DM or a shared conversation alike (owner decision 2026-10-06), only what may
 *   be shown to anyone: no protected line of his, none of her pursuits, and no rule that he may release one (`openOnly`).
 *   Where the surface asks for it (`othersFolderReading`) such a turn is offered her Aether reading tools inside
 *   「シャノン用フォルダ」 and nothing else (owner decision 2026-10-06), with his secrets and personal matters left out of what she
 *   reads; her Minecraft body's game chat does not ask for it.
 */
export function platformAudienceTurn(policy: PlatformAudiencePolicy): ChatAudienceTurn {
  if (policy.gate.ownerOnly) return chatAudienceTurn('owner')!;
  const { present } = policy;
  return Object.freeze({
    audience: 'others' as const,
    present,
    alone: false,
    participantMode: 'guest' as const,
    // Nothing of his notes, tasks, Notion or calendar is read for a conversation others can read.
    capabilities: Object.freeze({ aetherNotes: false, voyagerTasks: false, notion: false, upcoming: false }),
    // The owner's own turn keeps the rule that he may release a protected line by asking; anyone else's has neither that rule nor such a line.
    instructions: [sharedAudienceHeader(policy.ownerWrote), ...policy.peopleLines, ...policy.impressionLines,
      policy.ownerWrote ? speakTimePrivacyCheck : OTHERS_SPEAK_TIME_CHECK].join('\n'),
    // The verified owner's own turn in a shared conversation: his words, heard by everyone there (as the bridge stores it).
    turnLabel: Object.freeze({ audience: present, speaker: policy.ownerWrote ? 'owner' as const : 'unknown' as const }),
    identity: () => identityOnly(policy.ownerWrote ? shannonIdentityPrompt('owner', { othersPresent: true }) : shannonIdentityPrompt('guest')),
    // Today's focus as this audience may hear it; her pursuits, guarded, only where the owner is present. Both carry no label of
    // their own, so a turn someone else wrote (only open items) gets neither.
    ownFocus: (focus: string, pursuits: string, state: CompanionStateSnapshot, store: ConversationStore, scopeKey: string) => {
      if (!policy.ownerPresent) return '';
      const gate = new DisclosureGate(present, state, store, scopeKey);
      return [sharedDailyFocus(gate, focus), policy.ownerPresent ? guardedShannonSeenPrompt(pursuits, gate.unlabelledMarker) : '']
        .filter(Boolean).join('\n\n');
    },
    visible: (response: ChatResponse) => response,
  });
}

/** What a platform surface hands the kernel for one turn. */
export interface PlatformSurfaceTurn {
  scopeKey: string;
  policy: PlatformAudiencePolicy;
  /** What the model reads as the message: the owner's words, or `name: words` for anyone else. */
  message: string;
  /** The words as written, for the request body the sentence stream reads. */
  rawMessage: string;
  /** The surface's blocks (delivery note and the like), after the audience's instructions. */
  prompt: string;
  threadTitle: string;
  /** Her Minecraft body's game chat: the structured intent field (owner only). */
  offerMinecraftIntent?: boolean;
  /** A typed platform message shown with reactions: her reply may put one emoji on it (`TextTurnSurface.offerReaction`). */
  offerReaction?: boolean;
  /** A voice channel: her words are heard, not read (`TextTurnSurface.voice`). */
  voice?: boolean;
  /** Her `minecraft.*` tools are offered by the app's owner-alone rule; game chat asks through its intent instead. */
  minecraftTools?: boolean;
  /** Whether the surface tells the owner's turns what she did on her own (`TextTurnSurface.ownOutreach`): her Minecraft body yes, a platform reply no. */
  ownOutreach: boolean;
  /** A turn with others present is offered her Aether reading tools (`TextTurnSurface.othersFolderReading`): a platform reply yes, game chat no. */
  othersFolderReading?: boolean;
  store(turn: CompletedTurn): ShannonExperience | null;
  /** Syzygy ADR-0008 stage 3: what the mind's normalizer of this surface needs beside the audience (`TextTurnSurface.perception`). */
  perception?: TextTurnSurface['perception'];
}

export function platformTextTurnInput(turn: PlatformSurfaceTurn): TextTurnInput {
  return {
    scopeKey: turn.scopeKey, threadId: turn.policy.threadId, audience: platformAudienceTurn(turn.policy),
    message: turn.message, body: { scopeKey: turn.scopeKey, message: turn.rawMessage }, attachments: [], placeOptions: {}, request: {},
    surface: {
      prompt: turn.prompt,
      threadTitle: turn.threadTitle,
      ...(turn.offerMinecraftIntent ? { offerMinecraftIntent: true } : {}),
      ...(turn.offerReaction ? { offerReaction: true } : {}),
      ...(turn.voice ? { voice: true } : {}),
      ...(turn.minecraftTools ? { minecraftTools: true } : {}),
      // Where the owner is not there to release a protected line of his (someone else's DM), none is given.
      openOnly: !turn.policy.ownerPresent,
      ...(turn.othersFolderReading ? { othersFolderReading: true } : {}),
      // Her own outreach is the owner's matter: told only on his own turn, never to anyone else who writes (guest identity).
      ownOutreach: turn.ownOutreach && turn.policy.ownerWrote,
      store: completed => turn.store(completed),
      ...(turn.perception ? { perception: turn.perception } : {}),
      // Syzygy ADR-0013 stage 4: who wrote, by account, for her feeling events (used only while SHANNON_FEELING_AUDIENCE is on).
      ...(turn.policy.speaker ? { feelingSpeaker: turn.policy.speaker } : {}),
    },
  };
}

/**
 * The owner's turn in his platform thread, with the platform receipt of its request id, exactly as the bridge keeps a
 * mirrored turn (`PlatformBridgeService.ingest`). Throws `Error('PLATFORM_TURN_CONFLICT')` for a receipt of other content.
 */
export function keepOwnerPlatformTurn(
  conversationStore: ConversationStore, receipt: { platform: ShannonPlatform; requestId: string; payloadHash: string }, turn: CompletedTurn,
): ShannonExperience | null {
  const stored = conversationStore.ingestPlatformTurn({
    scopeKey: turn.scopeKey, platform: receipt.platform, requestId: receipt.requestId, payloadHash: receipt.payloadHash, threadId: turn.threadId,
    userMessage: turn.userMessage, shannonReply: turn.shannonReply, observedAt: turn.completedAt, context: turnPersistenceContext(turn),
  });
  return stored.duplicate ? null : stored.experience;
}

/**
 * Someone else's turn as the platform bridge keeps it: person memory with the conversation as its audience, never the
 * owner's threads. Returns why it was not kept, if it was not. Throws `Error('PLATFORM_TURN_CONFLICT')` for a receipt of
 * other content, and the bridge's own error for a malformed one.
 */
export function rememberPlatformPerson(
  bridge: Pick<PlatformBridgeService, 'ingest'>, request: Omit<PlatformTurnRequest, 'shannonReply'> & { shannonReply: string },
): string | undefined {
  try {
    return bridge.ingest(request).ignored;
  } catch (error) {
    if (!(error instanceof PlatformBridgeError)) throw error;
    if (error.code === 'PLATFORM_PEOPLE_DISABLED' || error.code === 'PLATFORM_ACTOR_DENIED') return 'people_disabled';
    if (error.code === 'RATE_LIMITED') return 'rate_limited';
    if (error.code === 'PLATFORM_TURN_CONFLICT') throw new Error('PLATFORM_TURN_CONFLICT');
    throw error;
  }
}
