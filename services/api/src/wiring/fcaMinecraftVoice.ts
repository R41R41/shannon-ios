import type { TaskRuntime, TaskView } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import type { MinecraftControl } from '../surfaces/minecraft/minecraftControl.js';
import type {
  VoiceMinecraftIntentInput, VoiceMinecraftIntentResult, VoiceMinecraftPort, VoiceMinecraftRefusal,
} from '../surfaces/platform/voiceMinecraftPort.js';
import type { MinecraftQueue } from './fcaMinecraftQueue.js';
import { applyQueueIntent } from './fcaMinecraftQueueIntent.js';

/**
 * A spoken request in a Discord voice channel, as the common task tree takes it (dc-voice, `platformVoice.ts`), from the owner or anyone
 * else in the channel (owner decision 2026-11-21). Their requests are the list (`fcaMinecraftQueue.ts`), as game chat's are
 * (`fcaMinecraftRequests.ts`): a new request is added whoever else is in the channel; words for the request under way (`message`) and every
 * word that changes the list (stop, cancel, hold, resume, move) are taken the same way. The speaker's shown name is in the words the
 * task's head reads (a message) and in the entry's goal line, so it knows who asked.
 */
export interface FcaMinecraftVoiceParts {
  control: MinecraftControl;
  runtime: TaskRuntime;
  ownerScope: string;
  stop(id: string, reason: string): Promise<TaskView[]>;
  sourceVisible(id: string): boolean;
  /** The tasks bound to a body, and the newest open request of his on a body (`fcaMinecraftRequests`). */
  bound(): TaskView[];
  openRequest(bodyId: string): TaskView | undefined;
  log(line: string): void;
  /** His list of requests. */
  queue: MinecraftQueue;
}

/**
 * The voice turn's input with the speaker's in-game name (`speaker.minecraftName`, put there by the voice route from the body's table of shown
 * names to in-game ones; `speakerMinecraftName` on the input is read as well). Absent when the speaker has none; the head then goes by the nearest player.
 */
type SpokenIntentInput = Omit<VoiceMinecraftIntentInput, 'speaker'> & {
  speaker?: VoiceMinecraftIntentInput['speaker'] & { minecraftName?: string | null };
  speakerMinecraftName?: string | null;
};
/** An in-game name as the game has it (letters, digits, underscore; up to 16; the Bedrock prefix dot is allowed), else null: it is handed to the body as the name of a player. */
const MINECRAFT_NAME = /^\.?[A-Za-z0-9_]{1,16}$/u;
const minecraftNameOf = (input: SpokenIntentInput): string | null => {
  const raw = input.speaker?.minecraftName ?? input.speakerMinecraftName;
  const name = typeof raw === 'string' ? raw.trim() : '';
  return MINECRAFT_NAME.test(name) ? name : null;
};

export function fcaMinecraftVoice(parts: FcaMinecraftVoiceParts): VoiceMinecraftPort {
  /**
   * Who asked, as the head reads it: the owner as 「本人」 with the shown name, anyone else by the shown name marked （ゲスト） so a guest cannot pass as the owner.
   * With the speaker's in-game name when it is known (「マイクラ名 X」): the head reads whose gaze to look at, and whom to hand a thing to, from it.
   */
  const whoAsked = (input: SpokenIntentInput): string => {
    const { speaker } = input;
    const game = minecraftNameOf(input);
    const tag = game ? `マイクラ名 ${game}` : '';
    if (!speaker) return game ? `本人（${tag}）` : '本人';
    const name = speaker.name.replace(/\s+/gu, ' ').trim().slice(0, 40);
    if (speaker.owner) return name || tag ? `本人（${[name, tag].filter(Boolean).join('、')}）` : '本人';
    return `${name || '通話の参加者'}（ゲスト${tag ? `、${tag}` : ''}）`;
  };
  const byGuest = (input: SpokenIntentInput): boolean => input.speaker?.owner === false;
  const refuse = (reason: VoiceMinecraftRefusal, kind: string): VoiceMinecraftIntentResult => {
    parts.log(`Shannon Minecraft voice intent refused reason=${reason} kind=${kind}`);
    return { delivered: false, reason };
  };
  /** Words for the request under way; null when none is, or it ended meanwhile (`FCA_TARGET_FINISHED`). */
  const message = (input: SpokenIntentInput, experienceId: string, bodyId: string): VoiceMinecraftIntentResult | null => {
    const running = parts.openRequest(bodyId);
    if (!running) return null;
    try {
      parts.runtime.observeExternal(input.scopeKey, running.id, {
        eventId: `dcv:${input.requestId}`, experienceIds: [experienceId], observedAt: input.observedAt,
        text: `Discordの通話での${whoAsked(input)}の言葉（いまのタスクへ）: ${input.intent.goal}`,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'FCA_TARGET_FINISHED') return null;
      throw error;
    }
    parts.log(`Shannon Minecraft voice intent delivered task=${running.id} as=message`);
    return { delivered: true, as: 'message', taskId: running.id };
  };
  const toList = async (input: SpokenIntentInput, experienceId: string | null): Promise<VoiceMinecraftIntentResult> => {
    const outcome = await applyQueueIntent(parts.queue, input.intent, { origin: 'voice', requestId: `dcv:${input.requestId}`, experienceId,
      observedAt: input.observedAt, askedBy: input.speaker || minecraftNameOf(input) ? whoAsked(input) : null, stopReason: 'owner_voice_stop' });
    if (!outcome.delivered) return refuse(outcome.reason, input.intent.kind);
    const entry = outcome.entry;
    return { delivered: true, as: outcome.as, ...(entry?.taskId ? { taskId: entry.taskId } : {}),
      ...(entry && outcome.as === 'task' ? { entryId: entry.id } : {}) };
  };
  return {
    state() {
      const bodies = parts.control.available();
      const queue = parts.queue.promptLines();
      if (bodies.length !== 1) return { connected: false, running: null, ...(queue.length ? { queue } : {}) };
      const open = parts.openRequest(bodies[0]!);
      return { connected: true, running: open ? { id: open.id, goal: open.goal } : null, ...(queue.length ? { queue } : {}) };
    },
    async intent(input) {
      const { intent } = input;
      if (intent.kind === 'none') return { delivered: false };
      if (input.scopeKey !== parts.ownerScope) return refuse('not_owner_scope', intent.kind);
      if (intent.kind === 'stop') {
        parts.log(`Shannon Minecraft voice stop by=${byGuest(input) ? 'guest' : 'owner'}`);
        const done = await toList(input, null);
        for (const task of parts.bound()) if (task.phase !== 'stopping') await parts.stop(task.id, 'owner_voice_stop');
        return done.delivered ? { ...done, as: 'stop' } : done;
      }
      if (intent.kind !== 'task' && intent.kind !== 'message') return toList(input, null);
      const bodies = parts.control.available();
      if (bodies.length !== 1) return refuse('body_unavailable', intent.kind);
      if (!input.experienceId) return refuse('no_turn', intent.kind);
      if (!parts.sourceVisible(input.experienceId)) return refuse('turn_not_visible', intent.kind);
      if (intent.kind === 'message') return message(input, input.experienceId, bodies[0]!) ?? refuse('nothing_running', intent.kind);
      return toList(input, input.experienceId);
    },
  };
}
