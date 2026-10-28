import type { FcaConversationPort, FcaSourceGuard } from '../mind/action/fca/fcaConversationPorts.js';
import type { TaskRecord, TaskRuntime, TaskView } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import type { MinecraftControl } from '../surfaces/minecraft/minecraftControl.js';
import type { MinecraftBodyDependencies, MinecraftIntentRefusal } from '../surfaces/minecraft/minecraftBody.js';
import { minecraftTaskUnavailable, type MinecraftTaskToolPort } from '../mind/tools/shannonToolRunner.js';
import { toolOk, toolFailure } from '../mind/tools/shannonTools.js';
import { withToolEvidence } from '../mind/tools/toolEvidence.js';
import { operatorMinecraftRequests, type OperatorMinecraftRequests } from './operatorMinecraftRequests.js';
import type { VoiceMinecraftPort } from '../surfaces/platform/voiceMinecraftPort.js';
import { fcaMinecraftVoice } from './fcaMinecraftVoice.js';
import { LLMC_STALE_FRAME_MS } from '../surfaces/minecraft/minecraftLlmcLive.js';
import { fcaMinecraftBodyWake } from './fcaMinecraftBodyWake.js';
import { isNativeDragonGoal } from './fcaMinecraftGoalBinding.js';

/** How long the mod's 「やめる」 waits for the body's stop acknowledgement before it is answered (the stop is already asked). */
export const OWNER_STOP_WAIT_MS = 3_000;
/** The completion criteria every admitted Minecraft request carries (`minecraft.request` and the in-game intent). */
export const MINECRAFT_REQUEST_CRITERIA = '目的の達成を新しいワールド観測と実行結果から確認する。';
/**
 * The working note every admitted Minecraft request is handed as its first inbox line (mb-llmc-cand 9, run 37: an earlier note told of
 * `minecraft.observe` and `minecraft.reflex`, tools the menu does not have; the menu is mc.act, mc.probe, mc.view, plan.update and the two controls).
 */
export const MINECRAFT_REQUEST_CONTEXT = '体の今の状態は毎判断の live に出る。もっと見たい時は mc_probe（周りの事実）か mc_view（地図を広く・別の向きで）で調べ、手は mc_act で出す。';

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

/**
 * The owner's own words when they are one of the closed dragon requests (`isNativeDragonGoal`), else null. mc-chat-stale-frame (2026-10-26): the
 * model that reads the chat turn rewrites the goal (「エンドラを討伐して」 became 「エンダードラゴンを倒すため、装備や食料などを整えて…」), the
 * rewrite is in no closed set, and the task lost the dragon's trusted completion evidence and the body's dragon tools. The task keeps what he said.
 */
export function ownDragonWords(message: unknown): string | null {
  return typeof message === 'string' && isNativeDragonGoal(message) ? message.trim() : null;
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
  admission: NonNullable<MinecraftBodyDependencies['fcaAdmission']>; operator: OperatorMinecraftRequests; voice: VoiceMinecraftPort;
  /** The mod's 「やめる」 (`MINECRAFT_STOP_PATH`): stops the owner's unfinished body task(s) without a conversation turn. */
  ownerStop(input: { taskId?: string }): Promise<{ stopped: string[]; open: number }>;
  /** Wakes a task that slept for a body that was not there, once the body is (`fcaMinecraftBodyWake.ts`); ticked every second by the wake. */
  bodyWake: ReturnType<typeof fcaMinecraftBodyWake> } {
  /**
   * The tasks bound to a body that `visible` lets through. `keep` (cheap, from the task's own record) is asked first: `visible` is the source
   * guard, a walk of the task's provenance, 100–370 ms of the API's one thread each in production. mc-chat-stale-frame (2026-10-26): the chat request
   * of 2026-10-25 03:23 asked it of all 48 tasks ever bound to the body, the 31 that held sources walked in full, one after the other (8 s with
   * no poll of the body read), to find the one open request there was not.
   */
  const bound = (visible: (id: string) => boolean = id => parts.visible(parts.ownerScope, id), keep: (task: TaskView) => boolean = () => true) => {
    const tasks: TaskView[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = parts.runtime.list(parts.ownerScope, { limit: 100, offset });
      tasks.push(...page.filter(task => parts.control.store.body(task.id) && keep(task) && visible(task.id)));
      if (page.length < 100) return tasks;
    }
  };
  /** A task a stop can still do something to: not one that already stopped or ended (`runtime.stop` would only write the request again). */
  const unfinished = (task: TaskView) => !['stopped', 'completed', 'failed'].includes(task.phase);
  const spec = (goal: string) => ({ title: goal.slice(0, 120), goal, completionCriteria: MINECRAFT_REQUEST_CRITERIA,
    context: MINECRAFT_REQUEST_CONTEXT });
  const log = parts.log ?? ((line: string) => console.log(line));
  /**
   * What refuses an in-game request before her reply is made: the scope, someone else known to be present, no frame of the body. A frame
   * a few seconds old still shows a body (mc-chat-stale-frame, 2026-10-26: a stall of the API's thread made a body that had
   * polled 4 s before look gone); the task's decisions are told how old their picture is.
   */
  const admission = (input: { scopeKey: string; request: { serverId: string } }): MinecraftIntentRefusal | null =>
    input.scopeKey !== parts.ownerScope ? 'not_owner_scope' : !parts.ownerAlone() ? 'others_present'
      : !parts.control.latest(parts.control.bodyId(input.request.serverId), LLMC_STALE_FRAME_MS) ? 'body_unavailable' : null;
  /**
   * The newest Minecraft request of his (`admittedMinecraftRequest`, not a task that merely touched the body) on this body that can
   * still take a message and act on it: ready, executing or waiting, and not paused (a stopping task would drop it).
   */
  const openRequest = (bodyId: string): TaskView | undefined => bound(undefined, task => ['ready', 'executing', 'waiting'].includes(task.phase)
    && task.status !== 'paused' && parts.control.store.body(task.id) === bodyId
    && admittedMinecraftRequest(task, task.parentId ? parts.runtime.get(parts.ownerScope, task.parentId) : null, true))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
  const refused = (reason: MinecraftIntentRefusal, kind: string) => {
    log(`Shannon Minecraft intent refused reason=${reason} kind=${kind}`);
    return { kind: 'none' as const, goal: '', rejected: 'queue_unavailable' as const, reason };
  };
  const voice = fcaMinecraftVoice({ control: parts.control, runtime: parts.runtime, ownerScope: parts.ownerScope, stop: parts.stop,
    sourceVisible: parts.sourceVisible, atomic: parts.atomic, bound: () => bound(undefined, unfinished), openRequest, spec, log });
  /**
   * dragon26 (the mod's 「やめる」 was said to her as 「今の作業をやめて」 and refused twice as `turn_not_visible`, so the task ran on): the stop of
   * the owner's own button. It is the owner's body device (the route checked it) stopping the owner's tasks bound to a body, so no turn's
   * sources are asked: `taskId` narrows it to that task (the mod shows one), none stops every unfinished one. The runtime's stop waits for the
   * body's acknowledgement; the answer does not wait longer than `OWNER_STOP_WAIT_MS` for it (the stop itself goes on).
   */
  const ownerStop = async (input: { taskId?: string }): Promise<{ stopped: string[]; open: number }> => {
    const open = bound(() => true, unfinished);
    const targets = input.taskId ? open.filter(task => task.id === input.taskId) : open;
    const stops = targets.map(async task => {
      log(`Shannon Minecraft owner stop requested task=${task.id} reason=owner_ui_stop phase=${task.phase}`);
      try {
        const after = await parts.stop(task.id, 'owner_ui_stop');
        log(`Shannon Minecraft owner stop settled task=${task.id} phase=${after.find(item => item.id === task.id)?.phase ?? 'unknown'}`);
      } catch (error) {
        log(`Shannon Minecraft owner stop failed task=${task.id} code=${error instanceof Error ? error.message.slice(0, 60) : 'unknown'}`);
      }
    });
    await Promise.race([Promise.allSettled(stops), new Promise<void>(resolve => setTimeout(resolve, OWNER_STOP_WAIT_MS).unref())]);
    if (!targets.length) log(`Shannon Minecraft owner stop found nothing task=${input.taskId ?? '-'} open=${open.length}`);
    return { stopped: targets.map(task => task.id), open: open.length };
  };
  return {
    voice,
    ownerStop,
    bodyWake: fcaMinecraftBodyWake({ control: parts.control, runtime: parts.runtime, ownerScope: parts.ownerScope, log }),
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
      if (intent.kind === 'stop') { for (const task of bound(undefined, unfinished)) await parts.stop(task.id, 'owner_game_stop'); return intent; }
      const bodyId = parts.control.bodyId(input.request.serverId);
      const goal = ownDragonWords(input.request.message) ?? intent.goal;
      // A Minecraft request of his under way takes the words as a message (「続けて」 in run 19 would have been a second task beside it).
      const running = openRequest(bodyId);
      if (running) {
        try {
          parts.runtime.observeExternal(scopeKey, running.id, { eventId: `mc:${input.request.requestId}`, experienceIds: [sourceId],
            observedAt: input.request.observedAt, text: `ゲーム内の本人の言葉（いまのタスクへ）: ${goal}` });
          log(`Shannon Minecraft intent delivered task=${running.id} as=message`);
          return { ...intent, goal, request: { id: running.id } };
        } catch (error) {
          // It ended meanwhile (`FCA_TARGET_FINISHED`): a new task, as before. A changed retry of the same request still conflicts.
          if (!(error instanceof Error) || error.message !== 'FCA_TARGET_FINISHED') throw error;
        }
      }
      return parts.atomic(() => {
        // Only the asking turn (the event below), not the root's whole set (owner decision 2026-10-15, `TaskChildOptions`).
        const task = parts.runtime.createChild(scopeKey, parts.runtime.ensureRoot(scopeKey).id, spec(goal), `mc:${input.request.requestId}`,
          { sources: 'asking' });
        parts.runtime.observeExternal(scopeKey, task.id, { eventId: `mc:${input.request.requestId}`, experienceIds: [sourceId], observedAt: input.request.observedAt, text: `ゲーム内の本人の依頼: ${goal}` });
        if (!parts.control.store.bind(task.id, bodyId)) throw new Error('FCA_BODY_BINDING_CONFLICT');
        return { ...intent, goal, request: { id: task.id } };
      });
    },
  };
}
