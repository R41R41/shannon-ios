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
  /** His recent requests that are not going on (stopped, failed, done, paused): for the voice's words about work that is not coming. */
  resting?(bodyId: string): Array<{ goal: string; how: string }>;
  log(line: string): void;
  /** His list of requests. */
  queue: MinecraftQueue;
}

/** An in-game name as the game has it (letters, digits, underscore; up to 16; the Bedrock prefix dot is allowed), else null: it is handed to the body as the name of a player. */
const MINECRAFT_NAME = /^\.?[A-Za-z0-9_]{1,16}$/u;
/** The speaker's in-game name (`speaker.minecraftName`, put there by the voice route); null when the speaker has none (the head then goes by the nearest player). */
const minecraftNameOf = (input: VoiceMinecraftIntentInput): string | null => {
  const raw = input.speaker?.minecraftName;
  const name = typeof raw === 'string' ? raw.trim() : '';
  return MINECRAFT_NAME.test(name) ? name : null;
};

export function fcaMinecraftVoice(parts: FcaMinecraftVoiceParts): VoiceMinecraftPort {
  /**
   * Who asked, as the head reads it: the owner as 「本人」 with the shown name, anyone else by the shown name marked （ゲスト） so a guest cannot pass as the owner.
   * With the speaker's in-game name when it is known (「マイクラ名 X」): the head reads whose gaze to look at, and whom to hand a thing to, from it.
   */
  const whoAsked = (input: VoiceMinecraftIntentInput): string => {
    const { speaker } = input;
    if (!speaker) return '本人';
    const game = minecraftNameOf(input);
    const tag = game ? `マイクラ名 ${game}` : '';
    const name = speaker.name.replace(/\s+/gu, ' ').trim().slice(0, 40);
    if (speaker.owner) return name || tag ? `本人（${[name, tag].filter(Boolean).join('、')}）` : '本人';
    return `${name || '通話の参加者'}（ゲスト${tag ? `、${tag}` : ''}）`;
  };
  const byGuest = (input: VoiceMinecraftIntentInput): boolean => input.speaker?.owner === false;
  const refuse = (reason: VoiceMinecraftRefusal, kind: string): VoiceMinecraftIntentResult => {
    parts.log(`Shannon Minecraft voice intent refused reason=${reason} kind=${kind}`);
    return { delivered: false, reason };
  };
  /** Words for the request under way; null when none is, or it ended meanwhile (`FCA_TARGET_FINISHED`). */
  const message = (input: VoiceMinecraftIntentInput, experienceId: string, bodyId: string): VoiceMinecraftIntentResult | null => {
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
  const toList = async (input: VoiceMinecraftIntentInput, experienceId: string | null): Promise<VoiceMinecraftIntentResult> => {
    const outcome = await applyQueueIntent(parts.queue, input.intent, { origin: 'voice', requestId: `dcv:${input.requestId}`, experienceId,
      observedAt: input.observedAt, askedBy: input.speaker ? whoAsked(input) : null, stopReason: 'owner_voice_stop' });
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
      // The list says which request runs: right after a swap the task of the one put aside may not have stopped yet (or the new one's not
      // started), and her reply must not name the old one as the work under way.
      const entry = parts.queue.current();
      const open = parts.openRequest(bodies[0]!);
      const running = entry ? { id: entry.taskId ?? entry.id, goal: entry.goal } : open ? { id: open.id, goal: open.goal } : null;
      const resting = (parts.resting?.(bodies[0]!) ?? []).filter(item => item.goal !== running?.goal.replace(/s+/gu, ' ').trim().slice(0, 40)).map(item => `「${item.goal}」（${item.how}）`);
      return { connected: true, running, ...(queue.length ? { queue } : {}), ...(resting.length ? { resting } : {}) };
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
      if (intent.kind === 'message') {
        const told = message(input, input.experienceId, bodies[0]!);
        if (told) return told;
        // Words for a request, and none is under way: a request of their own (as in game chat, `fcaMinecraftRequests.ts`), not a refusal.
        parts.log('Shannon Minecraft voice intent message with nothing running added as task');
        return toList({ ...input, intent: { kind: 'task', goal: intent.goal, placement: 'end' } }, input.experienceId);
      }
      return toList(input, input.experienceId);
    },
  };
}
