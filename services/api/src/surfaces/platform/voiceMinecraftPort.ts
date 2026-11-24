import type { MinecraftIntent } from '../../contracts/minecraftBodyContract.js';
import type { SpeakerPos } from '../minecraft/minecraftPeopleWords.js';

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
  /** His recent requests that are not going on, as 「goal」（止めた・終わった…）: not work that is coming. */
  resting?: string[];
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
  /**
   * What the task's head is shown of the spoken line beside the intent's goal (the goal is the voice's rewrite, cut to 120 characters). All four are optional: a
   * line without them reads as before (the speaker's name from `speaker`, the time from `observedAt`, no words as spoken and no place).
   * - `speakerName`: the speaker's shown name.
   * - `speakerWords`: the words as the person said them.
   * - `spokenAt`: when they said it (ISO).
   * - `speakerPos`: where they stood in the game; absent when the body does not know.
   */
  speakerName?: string | undefined;
  speakerWords?: string | undefined;
  spokenAt?: string | undefined;
  speakerPos?: SpeakerPos | undefined;
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
/** The journal's line for an intent and what became of it (no text): kind, outcome, and where her words put a request (`-` for none). */
export function intentLog(intent: MinecraftIntent, outcome: VoiceMinecraftIntentResult): string {
  const where = `placement=${intent.placement || '-'} target=${intent.target || '-'}`;
  const done = `delivered=${outcome.delivered} as=${outcome.as ?? '-'} reason=${outcome.reason ?? '-'}`;
  return `Shannon platform voice intent kind=${intent.kind} ${done} ${where}`;
}

export function voiceIntentLineKind(kind: MinecraftIntent['kind'], as: VoiceMinecraftIntentResult['as']): 'task_message' | 'task' | 'stop' | 'none' {
  if (as === 'message' || kind === 'message') return 'task_message';
  if (kind === 'task' || kind === 'stop') return kind;
  return kind === 'cancel' || kind === 'hold' ? 'stop' : 'none';
}
