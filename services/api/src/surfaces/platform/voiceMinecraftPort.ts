import type { MinecraftIntent } from '../../contracts/minecraftBodyContract.js';

/**
 * What a Discord voice channel's turn may ask of her Minecraft body (Syzygy dc-voice, owner request 2026-10-20: 「エンドラ討伐をしながら、
 * Discordでライ氏や友人と会話」). The port is the common task tree's side of it (`fcaMinecraftRequests.ts`, `voice`): the voice route
 * asks it what the body is doing before her reply, and hands it the owner's spoken request after.
 *
 * - Only the verified owner's words ever reach it (the platform policy decides who wrote); a friend's never do.
 * - His requests are a list (`fcaMinecraftQueue.ts`): `task` adds one, `message` is words for the one that is running, and `stop`,
 *   `cancel`, `hold`, `resume` and `move` change the list. A new request is added only when he is alone in the channel (`allowNew`),
 *   as in game chat; every other word is taken whoever is there.
 */
export interface VoiceMinecraftState {
  /** Her body is connected to a world. */
  connected: boolean;
  /** The owner's Minecraft request under way, in her words (what she may tell him back), or null. */
  running: { id: string; goal: string } | null;
  /** The list of his requests as lines (`[依頼の列]`); none when it is empty or the port does not keep one. */
  queue?: string[];
}

export type VoiceMinecraftRefusal = 'not_owner_scope' | 'body_unavailable' | 'no_turn' | 'turn_not_visible' | 'others_present'
  | 'nothing_running' | 'no_such_request' | 'queue_full';

export interface VoiceMinecraftIntentInput {
  scopeKey: string;
  /** The voice turn's request id (idempotent: a retried turn is not delivered twice). */
  requestId: string;
  observedAt: string;
  intent: MinecraftIntent;
  /** The stored turn of the owner's words (the provenance of a message or a task); null when it was kept nowhere. */
  experienceId: string | null;
  /** A new request may be added (the owner is alone in the channel). */
  allowNew: boolean;
}

export interface VoiceMinecraftIntentResult {
  delivered: boolean;
  /** `queue`: a word about the list other than a new request, a stop or a message (cancel, hold, resume, move). */
  as?: 'message' | 'task' | 'stop' | 'queue';
  taskId?: string;
  /** The entry of the list a new request became (its id is the one the body is told). */
  entryId?: string;
  reason?: VoiceMinecraftRefusal;
}

export interface VoiceMinecraftPort {
  state(): VoiceMinecraftState;
  intent(input: VoiceMinecraftIntentInput): Promise<VoiceMinecraftIntentResult>;
}

/** The kind of the intent line the voice client is sent: the kinds it has always known (words about the list besides a stop are `none` to it). */
export function voiceIntentLineKind(kind: MinecraftIntent['kind'], as: VoiceMinecraftIntentResult['as']): 'task_message' | 'task' | 'stop' | 'none' {
  if (as === 'message' || kind === 'message') return 'task_message';
  if (kind === 'task' || kind === 'stop') return kind;
  return kind === 'cancel' || kind === 'hold' ? 'stop' : 'none';
}
