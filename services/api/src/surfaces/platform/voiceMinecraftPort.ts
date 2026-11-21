import type { MinecraftIntent } from '../../contracts/minecraftBodyContract.js';

/**
 * What a Discord voice channel's turn may ask of her Minecraft body (Syzygy dc-voice, owner request 2026-10-20: 「エンドラ討伐をしながら、
 * Discordでライ氏や友人と会話」). The port is the common task tree's side of it (`fcaMinecraftRequests.ts`, `voice`): the voice route
 * asks it what the body is doing before her reply, and hands it the owner's spoken request after.
 *
 * - Anyone in the channel may ask (owner decision 2026-11-21: 「全員と自由に話せてほしい」; before it only the verified owner's words
 *   reached it, and a new task only while he was alone). The speaker travels with the request (`speaker`), so the task's head knows who asked.
 * - A request while one is under way is a message to that task (the in-game 「続けて」 of run 19); `stop` stops the body's tasks;
 *   anything else is a new task.
 */
export interface VoiceMinecraftState {
  /** Her body is connected to a world. */
  connected: boolean;
  /** The owner's Minecraft request under way, in her words (what she may tell him back), or null. */
  running: { id: string; goal: string } | null;
}

export type VoiceMinecraftRefusal = 'not_owner_scope' | 'body_unavailable' | 'no_turn' | 'turn_not_visible';

/** Who spoke: a member of the channel (shown name); `owner` when it is the verified owner. */
export interface VoiceSpeaker {
  id: string;
  name: string;
  owner: boolean;
}

export interface VoiceMinecraftIntentInput {
  scopeKey: string;
  /** The voice turn's request id (idempotent: a retried turn is not delivered twice). */
  requestId: string;
  observedAt: string;
  intent: MinecraftIntent;
  /** The stored turn of the words (the provenance of a message or a task); null when it was kept nowhere. */
  experienceId: string | null;
  /** Who said it; absent, the owner (the form before 2026-11-21). */
  speaker?: VoiceSpeaker;
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
