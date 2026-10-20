import type { MinecraftIntent } from '../minecraft/minecraftIntent.js';

/**
 * What a Discord voice channel's turn may ask of her Minecraft body (Syzygy dc-voice, owner request 2026-10-20: 「エンドラ討伐をしながら、
 * Discordでライ氏や友人と会話」). The port is the common task tree's side of it (`fcaMinecraftRequests.ts`, `voice`): the voice route
 * asks it what the body is doing before her reply, and hands it the owner's spoken request after.
 *
 * - Only the verified owner's words ever reach it (the platform policy decides who wrote); a friend's never do.
 * - A request while one of his is under way is a message to that task (the in-game 「続けて」 of run 19); `stop` stops the body's
 *   tasks. A new task is made only when he is alone in the channel (`allowNew`), as in game chat.
 */
export interface VoiceMinecraftState {
  /** Her body is connected to a world. */
  connected: boolean;
  /** The owner's Minecraft request under way, in her words (what she may tell him back), or null. */
  running: { id: string; goal: string } | null;
}

export type VoiceMinecraftRefusal = 'not_owner_scope' | 'body_unavailable' | 'no_turn' | 'turn_not_visible' | 'others_present';

export interface VoiceMinecraftIntentInput {
  scopeKey: string;
  /** The voice turn's request id (idempotent: a retried turn is not delivered twice). */
  requestId: string;
  observedAt: string;
  intent: MinecraftIntent;
  /** The stored turn of the owner's words (the provenance of a message or a task); null when it was kept nowhere. */
  experienceId: string | null;
  /** A new task may be made when none is running (the owner is alone in the channel). */
  allowNew: boolean;
}

export interface VoiceMinecraftIntentResult {
  delivered: boolean;
  as?: 'message' | 'task' | 'stop';
  taskId?: string;
  reason?: VoiceMinecraftRefusal;
}

export interface VoiceMinecraftPort {
  state(): VoiceMinecraftState;
  intent(input: VoiceMinecraftIntentInput): Promise<VoiceMinecraftIntentResult>;
}
