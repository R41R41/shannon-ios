import type { FeelingSpeaker, MemoryAudience } from '@shannon/cognition';
import { switchOn, type SwitchValues } from '@shannon/switches';
import { serverEnvironment } from '../infra/config/serverEnvironment.js';
import type { CompletedTurn } from '../mind/sleep/sleepPorts.js';
import type { ShannonExperience } from '../mind/memory/memoryPorts.js';

/**
 * One head, entries only hear and speak (owner 2026-10-20, `SHANNON_ONE_HEAD`; design: side-session-notes one-head-design.md). Every
 * entry (the apps' Talk and voice, Discord's text and voice channel) hands her one mind the same shape of a turn and reads the same
 * events back; who is present is decided by her mind, and the entry only hears, plays and shows. This file is that shape:
 *
 * - `ConversationTurn`: who said what where, in voice or text, before whom (`POST /v1/converse`, the Discord body; the apps' requests are
 *   read into the same seat by their own routes, which already prove the owner by the device's pairing).
 * - `ConversationEvent`: `decision`, `expression`, `sentence`, `intent`, `done`, `error`, in that order (`expression` is her face for a
 *   body that can show one; an entry that cannot reads past it).
 * - `VoiceSeat`: what a platform entry hands the one voice turn (`apiLiveVoice.ts`), which the apps' voice goes through too.
 */
export const ONE_HEAD_CONVERSE_PATH = '/v1/converse';

export function oneHeadEnabled(values: SwitchValues = serverEnvironment()): boolean {
  return switchOn(values, 'SHANNON_ONE_HEAD');
}

/** Owner 2026-10-21 (`SHANNON_VOICE_SONNET`): her spoken replies are Sonnet's, and a spoken reply's first clause is said at once. */
export function voiceSonnetEnabled(values: SwitchValues = serverEnvironment()): boolean {
  return switchOn(values, 'SHANNON_VOICE_SONNET');
}

export interface ConversationHeardLine {
  userId: string;
  name: string;
  text: string;
  at: string;
}

/** The one shape of a turn, as an entry sends it. */
export interface ConversationTurn {
  version: 1;
  requestId: string;
  observedAt: string;
  modality: 'voice' | 'text';
  where: {
    platform: 'discord';
    conversationId: string;
    conversationKind: 'channel' | 'dm';
    /** The channel's name, for a conversation nobody bound (its title in her prompt). */
    title?: string;
    voiceChannelId?: string;
  };
  who: { userId: string; displayName: string };
  presence: {
    /** The people there (bots excluded), the speaker included. */
    participants: string[];
    heard?: ConversationHeardLine[];
    followsShannonTurn?: boolean;
    speakingNow?: boolean;
    situation?: string;
  };
  words: string;
  voice?: { fillerId?: string; sttMs?: number; utteranceMs?: number };
}

/** Her face for this turn, for an entry that shows one (the apps' Live2D); Discord reads past it. */
export type ExpressionEvent = {
  type: 'expression';
  affect?: string;
  intensity?: number;
  delivery?: string;
  presentationId?: string;
};

/** A voice plan (`voicePlanResponse`) as an expression event, or null when it carries no face. */
export function expressionOf(plan: Record<string, unknown> | undefined): ExpressionEvent | null {
  if (!plan) return null;
  const affect = typeof plan.affect === 'string' ? plan.affect : undefined;
  const intensity = typeof plan.affectIntensity === 'number' && Number.isFinite(plan.affectIntensity) ? plan.affectIntensity : undefined;
  const delivery = typeof plan.delivery === 'string' ? plan.delivery : undefined;
  if (affect === undefined && delivery === undefined) return null;
  return { type: 'expression', ...(affect !== undefined ? { affect } : {}), ...(intensity !== undefined ? { intensity } : {}),
    ...(delivery !== undefined ? { delivery } : {}) };
}

/**
 * What a platform entry (a Discord voice channel) hands the one voice turn: the bridge's policy for this speaker, put into the facts the
 * turn reads, the surface's own blocks, and where the turn is kept. The apps' seat (the owner, someone beside him, a friend's call) is
 * read by the voice turn itself from the paired device's request.
 */
export interface VoiceSeat {
  /** The conversation's thread (the platform thread, `platformBridgeThreadId`). */
  threadId: string;
  /** Who hears the reply. */
  present: MemoryAudience;
  /** The owner alone in a conversation of his own (`policy.gate.ownerOnly`): exactly the apps' owner turn. */
  ownerAlone: boolean;
  /** The verified owner is the one speaking. */
  ownerSpeaking: boolean;
  /** The owner is there to release a protected line of his; false: only what may be shown to anyone (`openOnly`). */
  ownerPresent: boolean;
  /** Who spoke, by account, for her feeling events (`policy.speaker`); absent in the owner's own conversation. */
  speaker?: FeelingSpeaker;
  /** The words as the model reads them: the owner's own, or `name: words` for anyone else. */
  message: string;
  /** The surface's blocks: the audience's instructions (shared header, people, speak-time check) and the channel's. */
  prompt: string;
  /** The conversation's fixed title. */
  threadTitle: string;
  /** What a stored turn is labelled with (`ChatAudienceTurn.turnLabel`). */
  turnLabel: { audience?: MemoryAudience; speaker?: 'owner' | 'unknown' };
  /** The structured reply carries `minecraftIntent` (the owner, not alone in his own conversation, with the body connected). */
  offerMinecraftIntent: boolean;
  /** Keeps the completed turn where the platform keeps it: the experience, or null when it is kept nowhere in his conversation. */
  keep(turn: CompletedTurn): ShannonExperience | null;
}
