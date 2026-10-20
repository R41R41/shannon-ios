import type { TaskRuntime, TaskSpec, TaskView } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import type { MinecraftControl } from '../surfaces/minecraft/minecraftControl.js';
import type {
  VoiceMinecraftIntentInput, VoiceMinecraftIntentResult, VoiceMinecraftPort, VoiceMinecraftRefusal,
} from '../surfaces/platform/voiceMinecraftPort.js';

/**
 * An owner's spoken request in a Discord voice channel, as the common task tree takes it (dc-voice, `platformVoice.ts`). The platform
 * policy has already said that the verified owner spoke. A request while one of his is under way is a message to that task, as game
 * chat's is (`fcaMinecraftRequests.ts`), and a stop stops the body's tasks, whoever else is in the channel; a new task is made only
 * when he is alone there (`allowNew`).
 */
export interface FcaMinecraftVoiceParts {
  control: MinecraftControl;
  runtime: TaskRuntime;
  ownerScope: string;
  stop(id: string, reason: string): Promise<TaskView[]>;
  sourceVisible(id: string): boolean;
  /** Same SQLite connection as task authority and body bindings; nested authority writes use savepoints. */
  atomic<T>(work: () => T): T;
  /** The tasks bound to a body (`fcaMinecraftRequests`); the newest open request of his on a body; the spec of a request. */
  bound(): TaskView[];
  openRequest(bodyId: string): TaskView | undefined;
  spec(goal: string): TaskSpec;
  log(line: string): void;
}

export function fcaMinecraftVoice(parts: FcaMinecraftVoiceParts): VoiceMinecraftPort {
  const refuse = (reason: VoiceMinecraftRefusal, kind: string): VoiceMinecraftIntentResult => {
    parts.log(`Shannon Minecraft voice intent refused reason=${reason} kind=${kind}`);
    return { delivered: false, reason };
  };
  /** A message to the request under way; null when none is, or it ended meanwhile (`FCA_TARGET_FINISHED`). */
  const message = (input: VoiceMinecraftIntentInput, experienceId: string, bodyId: string): VoiceMinecraftIntentResult | null => {
    const running = parts.openRequest(bodyId);
    if (!running) return null;
    try {
      parts.runtime.observeExternal(input.scopeKey, running.id, {
        eventId: `dcv:${input.requestId}`, experienceIds: [experienceId], observedAt: input.observedAt,
        text: `Discordの通話での本人の言葉（いまのタスクへ）: ${input.intent.goal}`,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'FCA_TARGET_FINISHED') return null;
      throw error;
    }
    parts.log(`Shannon Minecraft voice intent delivered task=${running.id} as=message`);
    return { delivered: true, as: 'message', taskId: running.id };
  };
  const newTask = (input: VoiceMinecraftIntentInput, experienceId: string, bodyId: string): VoiceMinecraftIntentResult => parts.atomic(() => {
    const root = parts.runtime.ensureRoot(input.scopeKey).id;
    const task = parts.runtime.createChild(input.scopeKey, root, parts.spec(input.intent.goal), `dcv:${input.requestId}`, { sources: 'asking' });
    parts.runtime.observeExternal(input.scopeKey, task.id, {
      eventId: `dcv:${input.requestId}`, experienceIds: [experienceId], observedAt: input.observedAt,
      text: `Discordの通話での本人の依頼: ${input.intent.goal}`,
    });
    if (!parts.control.store.bind(task.id, bodyId)) throw new Error('FCA_BODY_BINDING_CONFLICT');
    return { delivered: true, as: 'task', taskId: task.id };
  });
  return {
    state() {
      const bodies = parts.control.available();
      if (bodies.length !== 1) return { connected: false, running: null };
      const open = parts.openRequest(bodies[0]!);
      return { connected: true, running: open ? { id: open.id, goal: open.goal } : null };
    },
    async intent(input) {
      const { intent } = input;
      if (intent.kind === 'none') return { delivered: false };
      if (input.scopeKey !== parts.ownerScope) return refuse('not_owner_scope', intent.kind);
      if (intent.kind === 'stop') {
        for (const task of parts.bound()) await parts.stop(task.id, 'owner_voice_stop');
        return { delivered: true, as: 'stop' };
      }
      const bodies = parts.control.available();
      if (bodies.length !== 1) return refuse('body_unavailable', intent.kind);
      if (!input.experienceId) return refuse('no_turn', intent.kind);
      if (!parts.sourceVisible(input.experienceId)) return refuse('turn_not_visible', intent.kind);
      const delivered = message(input, input.experienceId, bodies[0]!);
      if (delivered) return delivered;
      return input.allowNew ? newTask(input, input.experienceId, bodies[0]!) : refuse('others_present', intent.kind);
    },
  };
}
