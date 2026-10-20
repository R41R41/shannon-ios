import type { FcaConversationPort, FcaSourceGuard } from '../mind/action/fca/fcaConversationPorts.js';
import type { TaskRecord, TaskRuntime, TaskView } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import type { MinecraftControl } from '../surfaces/minecraft/minecraftControl.js';
import type { MinecraftBodyDependencies, MinecraftIntentRefusal } from '../surfaces/minecraft/minecraftBody.js';
import { minecraftTaskUnavailable, type MinecraftTaskToolPort } from '../mind/tools/shannonToolRunner.js';
import { toolOk, toolFailure } from '../mind/tools/shannonTools.js';
import { withToolEvidence } from '../mind/tools/toolEvidence.js';
import { operatorMinecraftRequests, type OperatorMinecraftRequests } from './operatorMinecraftRequests.js';
import type { VoiceMinecraftIntentResult, VoiceMinecraftPort } from '../surfaces/platform/voiceMinecraftPort.js';

/** The completion criteria every admitted Minecraft request carries (`minecraft.request` and the in-game intent). */
export const MINECRAFT_REQUEST_CRITERIA = '目的の達成を新しいワールド観測と実行結果から確認する。';
/** The working note every admitted Minecraft request is handed as its first inbox line. */
export const MINECRAFT_REQUEST_CONTEXT = '共通FCAのmc.*の道具で実行する。判断ごとの身体の観測は要約で、全体はminecraft.observeで読む。'
  + '一人称画像が得られるときはminecraft.reflexで視覚操作の短いセッションを要求できる。';

/**
 * Whether a task is a Minecraft request the owner made, as admitted: bound to a body at creation, with the admission's criteria,
 * directly under the conversation or the root. A child it starts, or any other task that merely touched the body (a tool call
 * binds too), is not one.
 */
export function admittedMinecraftRequest(
  task: Pick<TaskRecord, 'origin' | 'completionCriteria'>, parent: Pick<TaskRecord, 'kind'> | null, bound: boolean,
): boolean {
  return bound && task.origin === 'owner_request' && task.completionCriteria === MINECRAFT_REQUEST_CRITERIA
    && (parent?.kind === 'root' || parent?.kind === 'conversation');
}

/** Existing conversation tools now refer to common tasks. No legacy queue or planner fallback in this mode. */
export function fcaMinecraftRequests(parts: { control: MinecraftControl; runtime: TaskRuntime; conversation: FcaConversationPort;
  visible: FcaSourceGuard; ownerScope: string; ownerAlone(): boolean; stop(id: string, reason: string): Promise<TaskView[]>;
  sourceVisible(id: string): boolean;
  /** Same SQLite connection as task authority and body bindings; nested authority writes use savepoints. */
  atomic<T>(work: () => T): T;
  /** Where the content-free lines go (`console.log` when absent). */
  log?(line: string): void;
}): { tools: MinecraftTaskToolPort; intent: NonNullable<MinecraftBodyDependencies['fcaIntent']>;
  admission: NonNullable<MinecraftBodyDependencies['fcaAdmission']>; operator: OperatorMinecraftRequests; voice: VoiceMinecraftPort } {
  const bound = (visible: (id: string) => boolean = id => parts.visible(parts.ownerScope, id)) => {
    const tasks: TaskView[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = parts.runtime.list(parts.ownerScope, { limit: 100, offset });
      tasks.push(...page.filter(task => parts.control.store.body(task.id) && visible(task.id)));
      if (page.length < 100) return tasks;
    }
  };
  const spec = (goal: string) => ({ title: goal.slice(0, 120), goal, completionCriteria: MINECRAFT_REQUEST_CRITERIA, context: MINECRAFT_REQUEST_CONTEXT });
  const log = parts.log ?? ((line: string) => console.log(line));
  /** What refuses an in-game request before her reply is made: the scope, someone else known to be present, no frame of the body. */
  const admission = (input: { scopeKey: string; request: { serverId: string } }): MinecraftIntentRefusal | null =>
    input.scopeKey !== parts.ownerScope ? 'not_owner_scope' : !parts.ownerAlone() ? 'others_present'
      : !parts.control.frame(parts.control.bodyId(input.request.serverId)) ? 'body_unavailable' : null;
  /**
   * The newest Minecraft request of his (`admittedMinecraftRequest`, not a task that merely touched the body) on this body that can
   * still take a message and act on it: ready, executing or waiting, and not paused (a stopping task would drop it).
   */
  const openRequest = (bodyId: string): TaskView | undefined => bound()
    .filter(task => ['ready', 'executing', 'waiting'].includes(task.phase) && task.status !== 'paused' && parts.control.store.body(task.id) === bodyId
      && admittedMinecraftRequest(task, task.parentId ? parts.runtime.get(parts.ownerScope, task.parentId) : null, true))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
  const refused = (reason: MinecraftIntentRefusal, kind: string) => {
    log(`Shannon Minecraft intent refused reason=${reason} kind=${kind}`);
    return { kind: 'none' as const, goal: '', rejected: 'queue_unavailable' as const, reason };
  };
  /**
   * An owner's spoken request in a Discord voice channel (dc-voice, `platformVoice.ts`). The platform policy has already said that the
   * verified owner spoke. A request while one of his is under way is a message to that task, as game chat's is, and a stop stops the
   * body's tasks, whoever else is in the channel; a new task is made only when he is alone there (`allowNew`).
   */
  const voice: VoiceMinecraftPort = {
    state() {
      const bodies = parts.control.available();
      if (bodies.length !== 1) return { connected: false, running: null };
      const open = openRequest(bodies[0]!);
      return { connected: true, running: open ? { id: open.id, goal: open.goal } : null };
    },
    async intent(input) {
      const { intent, scopeKey } = input;
      if (intent.kind === 'none') return { delivered: false };
      const fail = (reason: NonNullable<VoiceMinecraftIntentResult['reason']>): VoiceMinecraftIntentResult => {
        log(`Shannon Minecraft voice intent refused reason=${reason} kind=${intent.kind}`);
        return { delivered: false, reason };
      };
      if (scopeKey !== parts.ownerScope) return fail('not_owner_scope');
      if (intent.kind === 'stop') {
        for (const task of bound()) await parts.stop(task.id, 'owner_voice_stop');
        return { delivered: true, as: 'stop' };
      }
      const bodies = parts.control.available();
      if (bodies.length !== 1) return fail('body_unavailable');
      if (!input.experienceId) return fail('no_turn');
      if (!parts.sourceVisible(input.experienceId)) return fail('turn_not_visible');
      const bodyId = bodies[0]!;
      const running = openRequest(bodyId);
      if (running) {
        try {
          parts.runtime.observeExternal(scopeKey, running.id, { eventId: `dcv:${input.requestId}`, experienceIds: [input.experienceId], observedAt: input.observedAt,
            text: `Discordの通話での本人の言葉（いまのタスクへ）: ${intent.goal}` });
          log(`Shannon Minecraft voice intent delivered task=${running.id} as=message`);
          return { delivered: true, as: 'message', taskId: running.id };
        } catch (error) {
          // It ended meanwhile (`FCA_TARGET_FINISHED`): a new task if he is alone, as game chat does. A changed retry still conflicts.
          if (!(error instanceof Error) || error.message !== 'FCA_TARGET_FINISHED') throw error;
        }
      }
      if (!input.allowNew) return fail('others_present');
      const experienceId = input.experienceId;
      return parts.atomic(() => {
        const task = parts.runtime.createChild(scopeKey, parts.runtime.ensureRoot(scopeKey).id, spec(intent.goal), `dcv:${input.requestId}`, { sources: 'asking' });
        parts.runtime.observeExternal(scopeKey, task.id, { eventId: `dcv:${input.requestId}`, experienceIds: [experienceId], observedAt: input.observedAt,
          text: `Discordの通話での本人の依頼: ${intent.goal}` });
        if (!parts.control.store.bind(task.id, bodyId)) throw new Error('FCA_BODY_BINDING_CONFLICT');
        return { delivered: true, as: 'task', taskId: task.id };
      });
    },
  };
  return {
    voice,
    operator: operatorMinecraftRequests({ ...parts, bound: () => bound(() => true), spec }),
    tools: { available: scope => scope === parts.ownerScope && parts.conversation.taskToolsAvailable(scope), async execute(name, input, context, signal) {
      signal?.throwIfAborted();
      // 2026-10-13: the turn's task context closed after its menu was built (`fca_context_budget`), and the call threw. Whatever
      // closed it (the scope, the audience, the budget), the request is refused as a closed value she can say, and nothing starts.
      if (context.scopeKey !== parts.ownerScope || !parts.ownerAlone() || !parts.conversation.taskToolsAvailable(context.scopeKey)) {
        return minecraftTaskUnavailable(name);
      }
      const value = input as { goal?: string; id?: string };
      if (name === 'minecraft.request') {
        const bodies = parts.control.available();
        if (bodies.length !== 1) return toolFailure('unavailable', '利用するマイクラの体が一つに決まっていないか、接続されていない。');
        return parts.atomic(() => {
          const result = parts.conversation.executeTaskTool('task.create', spec(value.goal!), context);
          if (!result.ok) return result;
          const task = JSON.parse(result.text) as TaskView;
          if (!parts.control.store.bind(task.id, bodies[0]!)) throw new Error('FCA_BODY_BINDING_CONFLICT');
          return withToolEvidence(toolOk(`共通タスクとして受け付けた。まだ達成していない。${result.text}`),
            { outcome: 'queued', action: 'request', target: { kind: 'minecraft_request', id: task.id }, operationId: task.id });
        });
      }
      // The foreground bridge additionally recognizes sources pending in this exact turn.
      const reads = bound(() => true).map(task => ({ task, result: parts.conversation.executeTaskTool('task.get', { id: task.id }, context) }))
        .filter(item => item.result.ok);
      const tasks = reads.map(item => item.task);
      if (name === 'minecraft.status') {
        // Reuse the trusted read so provenance follows this foreground conversation and its descendants.
        // task.get already observed canonical memory/experience lineage; close the external-read receipt too.
        const sourceIds = [...new Set(tasks.flatMap(task => parts.runtime.taskSources(context.scopeKey, task.id)
          .flatMap(source => source.readSourceIds ?? [])))];
        return { ...toolOk(reads.map(item => item.result.text).join('\n') || 'マイクラに結び付いたタスクはまだない。'), documents: { sourceIds } };
      }
      if (name !== 'minecraft.cancel') throw new Error('FCA_TOOL_NOT_OFFERED');
      const open = tasks.filter(task => !['stopped', 'completed', 'failed'].includes(task.phase));
      const targets = value.id ? open.filter(task => task.id === value.id)
        : open.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, 1);
      if (!targets.length) return toolFailure('not_found', '指定された進行中のマイクラタスクが見つからない。');
      // Exactly one target is selected above. Stop admission alone cannot certify that physical inputs stopped.
      const stopped = await parts.stop(targets[0]!.id, 'owner_minecraft_stop');
      return withToolEvidence(toolOk('停止要求を受け付けた。身体操作の停止確認後に停止済みになる。'),
        { outcome: stopped.some(task => task.id === targets[0]!.id && task.phase === 'stopped') ? 'applied' : 'queued', action: 'cancel',
          target: { kind: 'minecraft_request', id: targets[0]!.id }, operationId: targets[0]!.id });
    } },
    admission,
    async intent(input) {
      const { intent, scopeKey } = input;
      if (intent.kind === 'none') return intent;
      // Minecraft run 19 (10:54 JST): four checks gave one `queue_unavailable` and no line; each now has its reason, in the journal too.
      const early = admission(input);
      const reason = early && (intent.kind !== 'stop' || early !== 'body_unavailable') ? early
        : !input.experienceId ? 'no_turn' : !parts.sourceVisible(input.experienceId) ? 'turn_not_visible' : null;
      if (reason) return refused(reason, intent.kind);
      const sourceId = input.experienceId!;
      if (intent.kind === 'stop') { for (const task of bound()) await parts.stop(task.id, 'owner_game_stop'); return intent; }
      const bodyId = parts.control.bodyId(input.request.serverId);
      // A Minecraft request of his under way takes the words as a message (「続けて」 in run 19 would have been a second task beside it).
      const running = openRequest(bodyId);
      if (running) {
        try {
          parts.runtime.observeExternal(scopeKey, running.id, { eventId: `mc:${input.request.requestId}`, experienceIds: [sourceId],
            observedAt: input.request.observedAt, text: `ゲーム内の本人の言葉（いまのタスクへ）: ${intent.goal}` });
          log(`Shannon Minecraft intent delivered task=${running.id} as=message`);
          return { ...intent, request: { id: running.id } };
        } catch (error) {
          // It ended meanwhile (`FCA_TARGET_FINISHED`): a new task, as before. A changed retry of the same request still conflicts.
          if (!(error instanceof Error) || error.message !== 'FCA_TARGET_FINISHED') throw error;
        }
      }
      return parts.atomic(() => {
        // Only the asking turn (the event below), not the root's whole set (owner decision 2026-10-15, `TaskChildOptions`).
        const task = parts.runtime.createChild(scopeKey, parts.runtime.ensureRoot(scopeKey).id, spec(intent.goal), `mc:${input.request.requestId}`,
          { sources: 'asking' });
        parts.runtime.observeExternal(scopeKey, task.id, { eventId: `mc:${input.request.requestId}`, experienceIds: [sourceId], observedAt: input.request.observedAt, text: `ゲーム内の本人の依頼: ${intent.goal}` });
        if (!parts.control.store.bind(task.id, bodyId)) throw new Error('FCA_BODY_BINDING_CONFLICT');
        return { ...intent, request: { id: task.id } };
      });
    },
  };
}
