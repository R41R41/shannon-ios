import type { MinecraftIntent } from '../../contracts/minecraftBodyContract.js';

/**
 * What a Discord voice channel's turn may ask of her Minecraft body (Syzygy dc-voice, owner request 2026-10-20: 「エンドラ討伐をしながら、
 * Discordでライ氏や友人と会話」). The port is the common task tree's side of it (`fcaMinecraftRequests.ts`, `voice`): the voice route
 * asks it what the body is doing before her reply, and hands it the owner's spoken request after.
 *
 * - Anyone in the channel may ask (owner decision 2026-11-21: 「全員と自由に話せてほしい」; before it only the verified owner's words
 *   reached it, and a new task only while he was alone). The speaker travels with the request (`speaker`), so the task's head knows who asked.
 * - The requests are a list (`fcaMinecraftQueue.ts`): `task` adds one (whoever else is there), `message` is words for the one that is running, and
 *   `stop`, `cancel`, `hold`, `resume` and `move` change the list.
 */
export interface VoiceMinecraftState {
  /** Her body is connected to a world. */
  connected: boolean;
  /** The owner's Minecraft request under way, in her words (what she may tell him back), or null. */
  running: { id: string; goal: string } | null;
  /** The list of his requests as lines (`[依頼の列]`); none when it is empty or the port does not keep one. */
  queue?: string[];
}

export type VoiceMinecraftRefusal = 'not_owner_scope' | 'body_unavailable' | 'no_turn' | 'turn_not_visible'
  | 'nothing_running' | 'no_such_request' | 'queue_full';

/** Who spoke: a member of the channel (shown name); `owner` when it is the verified owner. */
export interface VoiceSpeaker {
  id: string;
  name: string;
  owner: boolean;
  /** Who they are in the game, when the body knows (`speakerMinecraftName` of the voice turn): the player whose look 「ここ」 is read from. */
  minecraftName?: string;
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
