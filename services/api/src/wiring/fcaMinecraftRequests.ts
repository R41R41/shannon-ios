import type { DatabaseSync } from 'node:sqlite';
import type { FcaConversationPort, FcaSourceGuard } from '../mind/action/fca/fcaConversationPorts.js';
import type { TaskRecord, TaskRuntime, TaskView } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import type { MinecraftControl } from '../surfaces/minecraft/minecraftControl.js';
import type { MinecraftBodyDependencies, MinecraftIntentRefusal } from '../surfaces/minecraft/minecraftBody.js';
import type { MinecraftIntent } from '../surfaces/minecraft/minecraftIntent.js';
import { minecraftTaskUnavailable, type MinecraftTaskToolPort } from '../mind/tools/shannonToolRunner.js';
import { toolOk, toolFailure } from '../mind/tools/shannonTools.js';
import { withToolEvidence } from '../mind/tools/toolEvidence.js';
import { operatorMinecraftRequests, operatorRequestTask, type OperatorMinecraftRequests } from './operatorMinecraftRequests.js';
import type { VoiceMinecraftPort } from '../surfaces/platform/voiceMinecraftPort.js';
import { fcaMinecraftVoice } from './fcaMinecraftVoice.js';
import { LLMC_STALE_FRAME_MS } from '../surfaces/minecraft/minecraftLlmcLive.js';
import { fcaMinecraftBodyWake } from './fcaMinecraftBodyWake.js';
import { isNativeDragonGoal } from './fcaMinecraftGoalBinding.js';
import { operatorSocketPath, requestOperatorSocket } from '../infra/ops/operatorSocket.js';
import { OPERATOR_LIMITS } from '../contracts/operatorContract.js';
import { bodyIntentOf } from '../surfaces/minecraft/minecraftIntent.js';
import type { MinecraftQueueOrigin } from '../contracts/minecraftQueueContract.js';
import { fcaMinecraftQueue } from './fcaMinecraftQueue.js';
import { applyQueueIntent } from './fcaMinecraftQueueIntent.js';
import { queueTaskPorts } from './fcaMinecraftQueuePorts.js';
import { queueBusy, queueEntryOfTask, queueStatusLines } from './fcaMinecraftQueueApp.js';

/** How long the mod's 「やめる」 waits for the body's stop acknowledgement before it is answered (the stop is already asked). */
export const OWNER_STOP_WAIT_MS = 3_000;
/**
 * The in-game dragon request as an operator's request (owner decision 2026-11-10, the filming: he asks from the mod, and the run must
 * still be one that `resume`, `budget` and `cancel` reach and that pauses at its cap instead of failing; those hang on the audit row
 * only the operator's request writes). The label of the audit row, the limits (the contract's most: the run from nothing to the dragon),
 * and how long the API's own socket is waited for before the request is made the old way.
 */
export const GAME_DRAGON_OPERATOR = 'game-owner';
export const GAME_DRAGON_BUDGET_YEN = OPERATOR_LIMITS.maxBudgetYen - 1;
export const GAME_DRAGON_SOCKET_WAIT_MS = 10_000;
/** The completion criteria every admitted Minecraft request carries (`minecraft.request` and the in-game intent). */
export const MINECRAFT_REQUEST_CRITERIA = '目的の達成を新しいワールド観測と実行結果から確認する。';
/**
 * The working note every admitted Minecraft request is handed as its first inbox line (mb-llmc-cand 9, run 37: an earlier note told of
 * `minecraft.observe` and `minecraft.reflex`, tools the menu does not have; the menu is mc.act, mc.probe, mc.view, plan.update and the two controls).
 */
export const MINECRAFT_REQUEST_CONTEXT = '体の今の状態は毎判断の live に出る。もっと見たい時は mc_probe（周りの事実）か mc_view（地図を広く・別の向きで）で調べ、手は mc_act で出す。'
  + '計画の節の doneWhen は have:cake>=1 のように、持ち物などの観測の形で書く。';

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
  /** Content-free words for why `sourceVisible` was false (alone or not, whether the turn was found, which recalled id is hidden); for the journal only. */
  sourceWhy?(id: string): string;
  /** Same SQLite connection as task authority and body bindings; nested authority writes use savepoints. */
  atomic<T>(work: () => T): T;
  /** That connection: the list of requests is kept in it (`fcaMinecraftQueue.ts`). */
  db: DatabaseSync;
  /** Where the content-free lines go (`console.log` when absent). */
  log?(line: string): void;
  /** The database path, beside which the operator's socket is (`operatorSocketPath`); absent, the dragon request is made the old way. */
  path?: string;
  /** The call on the operator's socket (`requestOperatorSocket` when absent; a test's own). */
  operatorCall?(path: string, body: unknown, timeoutMs: number): Promise<{ status: number; body: unknown }>;
}): { tools: MinecraftTaskToolPort; intent: NonNullable<MinecraftBodyDependencies['fcaIntent']>;
  admission: NonNullable<MinecraftBodyDependencies['fcaAdmission']>; operator: OperatorMinecraftRequests; voice: VoiceMinecraftPort;
  /** The mod's 「やめる」 (`MINECRAFT_STOP_PATH`): stops the owner's unfinished body task(s) without a conversation turn. */
  ownerStop(input: { taskId?: string }): Promise<{ stopped: string[]; open: number }>;
  /** Wakes a task that slept for a body that was not there, once the body is (`fcaMinecraftBodyWake.ts`); ticked every second by the wake. */
  bodyWake: ReturnType<typeof fcaMinecraftBodyWake>;
  /** The owner's list of requests for the body (`fcaMinecraftQueue.ts`); ticked every second by the wake too. */
  queue: ReturnType<typeof fcaMinecraftQueue> } {
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
  /** A task a stop can still do something to and that is not yet stopping (the list's stop already asked it). */
  const stoppable = (task: TaskView) => unfinished(task) && task.phase !== 'stopping';
  const spec = (goal: string) => ({ title: goal.slice(0, 120), goal, completionCriteria: MINECRAFT_REQUEST_CRITERIA,
    context: MINECRAFT_REQUEST_CONTEXT });
  const log = parts.log ?? ((line: string) => console.log(line));
  /**
   * What refuses an in-game request before her reply is made: the scope and no frame of the body (others on the server no longer refuse: owner decision 2026-11-21, 「全員と自由に」). A frame
   * a few seconds old still shows a body (mc-chat-stale-frame, 2026-10-26: a stall of the API's thread made a body that had
   * polled 4 s before look gone); the task's decisions are told how old their picture is.
   */
  const admission = (input: { scopeKey: string; request: { serverId: string } }): MinecraftIntentRefusal | null =>
    input.scopeKey !== parts.ownerScope ? 'not_owner_scope'
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
  /**
   * What refuses an in-game word before it is acted on. Minecraft run 19 (10:54 JST): four checks gave one `queue_unavailable` and no
   * line; each now has its reason, in the journal too. A stop is taken without a body, and so is every other word that only changes the
   * list; a new request and words for the one running need the body.
   */
  const precheck = (input: Parameters<NonNullable<MinecraftBodyDependencies['fcaIntent']>>[0]): MinecraftIntentRefusal | null => {
    const early = admission(input);
    const needsBody = input.intent.kind === 'task' || input.intent.kind === 'message';
    if (early && (needsBody || early !== 'body_unavailable')) return early;
    if (!input.experienceId) return 'no_turn';
    if (parts.sourceVisible(input.experienceId)) return null;
    if (parts.sourceWhy) {
      let why = 'unknown';
      try { why = parts.sourceWhy(input.experienceId); } catch { /* the line is only for the journal */ }
      log(`Shannon Minecraft source not visible kind=${input.intent.kind} ${why}`);
    }
    return 'turn_not_visible';
  };
  /** A stop of the list also stops every other task bound to the body that is not already stopping (the old stop of the chat). */
  const stopOthers = async (): Promise<void> => {
    for (const task of bound(undefined, stoppable)) await parts.stop(task.id, 'owner_game_stop');
  };
  /** The app's request while the body has one: it joins the list. */
  const joinList = async (goal: string) => {
    const added = await queue.operate({ op: 'add', goal }, { origin: 'app' });
    if (!added.ok || !added.entry) return toolFailure('unavailable', '依頼の列がいっぱいで足せなかった。');
    return withToolEvidence(toolOk(`依頼の列に足した（#${added.entry.seq}）。順番が来たら始まる。まだ達成していない。`),
      { outcome: 'queued', action: 'request', target: { kind: 'minecraft_request', id: added.entry.id }, operationId: added.entry.id });
  };
  /** The app's cancel of a task: through the list when it is on it (the list goes on with the next), else the runtime's stop. */
  const cancelRequest = async (taskId: string): Promise<TaskView[]> => {
    const listed = queueEntryOfTask(queue, taskId);
    if (!listed) return parts.stop(taskId, 'owner_minecraft_stop');
    await queue.operate({ op: 'cancel', id: listed.id }, { origin: 'app', stopReason: 'owner_minecraft_stop' });
    return [parts.runtime.get(parts.ownerScope, taskId)!];
  };
  /**
   * His words for the request under way: delivered to its task as a message (never a second request). Null when none is running (or it ended
   * meanwhile): the words then are a request of their own, not words for work that is not there (`intent` below), so he is not asked to say them again.
   */
  const message = (input: Parameters<NonNullable<MinecraftBodyDependencies['fcaIntent']>>[0], sourceId: string, goal: string) => {
    const running = openRequest(parts.control.bodyId(input.request.serverId));
    if (!running) return null;
    try {
      parts.runtime.observeExternal(input.scopeKey, running.id, { eventId: `mc:${input.request.requestId}`, experienceIds: [sourceId],
        observedAt: input.request.observedAt, text: `ゲーム内の本人の言葉（いまのタスクへ）: ${goal}` });
      log(`Shannon Minecraft intent delivered task=${running.id} as=message`);
      return { kind: 'task' as const, goal, request: { id: running.id } };
    } catch (error) {
      // It ended meanwhile (`FCA_TARGET_FINISHED`): nothing is running to take the words.
      if (!(error instanceof Error) || error.message !== 'FCA_TARGET_FINISHED') throw error;
      return null;
    }
  };
  /**
   * The owner's dragon words asked of the API's own operator socket, exactly as the CLI's `minecraft request` asks them (the same checks,
   * task, audit row and wake). The task's id when it was accepted, else null: any refusal, error or wait that ran out leaves the request
   * to the path it had before (never worse than it was), with one content-free line saying why.
   */
  const dragonAsOperator = async (goal: string): Promise<string | null> => {
    if (!parts.path) return null;
    try {
      const reply = await (parts.operatorCall ?? requestOperatorSocket)(operatorSocketPath(parts.path), { v: 1, operator: GAME_DRAGON_OPERATOR,
        domain: 'minecraft', op: 'request', args: { goal, maxMinutes: OPERATOR_LIMITS.maxMinutes, budgetYen: GAME_DRAGON_BUDGET_YEN } },
      GAME_DRAGON_SOCKET_WAIT_MS);
      const body = reply.body as { code?: unknown; taskId?: unknown } | null;
      const taskId = reply.status === 202 && typeof body?.taskId === 'string' && body.taskId ? body.taskId : null;
      const code = typeof body?.code === 'string' ? body.code.slice(0, 40) : '-';
      log(`Shannon Minecraft intent dragon as=operator status=${reply.status} code=${code} accepted=${taskId ? 'yes' : 'no'}`);
      return taskId;
    } catch (error) {
      const code = error instanceof Error ? error.message.slice(0, 60).replace(/[^ -~]/gu, '?') : 'unknown';
      log(`Shannon Minecraft intent dragon as=operator failed code=${code}`);
      return null;
    }
  };
  /** Where a task of his came from: the operator's, the app's (under his conversation) or the game's and the voice's (under the root). */
  const requestOrigin = (task: TaskView): MinecraftQueueOrigin | null => {
    if (operatorRequestTask(task, MINECRAFT_REQUEST_CRITERIA)) return 'operator';
    const parent = task.parentId ? parts.runtime.get(parts.ownerScope, task.parentId) : null;
    if (!admittedMinecraftRequest(task, parent, true)) return null;
    return parent?.kind === 'conversation' ? 'app' : 'chat';
  };
  /**
   * The id of the new task for his words: his dragon words through the operator's socket when that takes them, else `own` (the path every
   * request had before). A wait that ran out may still have made the task: that one is the request, not a second one beside it.
   */
  const newTask = async (message: string, goal: string, bodyId: string, own: () => string | Promise<string>): Promise<string> => {
    if (!ownDragonWords(message)) return own();
    const taskId = await dragonAsOperator(goal);
    if (taskId) return taskId;
    const made = openRequest(bodyId);
    if (made) log(`Shannon Minecraft intent dragon found task=${made.id} after=operator_unanswered`);
    return made?.id ?? own();
  };
  const queue = fcaMinecraftQueue(queueTaskPorts({ db: parts.db, control: parts.control, runtime: parts.runtime, ownerScope: parts.ownerScope,
    atomic: parts.atomic, stop: parts.stop, log, spec, newTask, requestOrigin: task => requestOrigin(task) }));
  const voice = fcaMinecraftVoice({ control: parts.control, runtime: parts.runtime, ownerScope: parts.ownerScope, stop: parts.stop,
    sourceVisible: parts.sourceVisible, bound: () => bound(undefined, unfinished), openRequest, log, queue });
  /**
   * dragon26 (the mod's 「やめる」 was said to her as 「今の作業をやめて」 and refused twice as `turn_not_visible`, so the task ran on): the stop of
   * the owner's own button. It is the owner's body device (the route checked it) stopping the owner's tasks bound to a body, so no turn's
   * sources are asked: `taskId` narrows it to that task (the mod shows one), none stops every unfinished one. The runtime's stop waits for the
   * body's acknowledgement; the answer does not wait longer than `OWNER_STOP_WAIT_MS` for it (the stop itself goes on).
   */
  const ownerStop = async (input: { taskId?: string }): Promise<{ stopped: string[]; open: number }> => {
    // A request on the list is cancelled through it (the list goes on with the next); no task named stops the whole list.
    const open = bound(() => true, unfinished);
    const held = input.taskId ? queueEntryOfTask(queue, input.taskId) ?? queue.locate(input.taskId) : null;
    const by = { origin: 'mod' as const, stopReason: 'owner_ui_stop' };
    if (held) {
      log(`Shannon Minecraft owner stop requested task=${held.taskId ?? held.id} reason=owner_ui_stop phase=${open.find(task => task.id === held.taskId)?.phase ?? 'none'}`);
      await queue.operate({ op: 'cancel', id: held.id }, by);
    } else if (!input.taskId) await queue.operate({ op: 'stop' }, by);
    const targets = held ? [] : input.taskId ? open.filter(task => task.id === input.taskId) : open;
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
    return { stopped: held ? [held.taskId ?? held.id] : targets.map(task => task.id), open: open.length };
  };
  return {
    voice,
    ownerStop,
    queue,
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
        // The body is busy or the list has requests: his new one joins the list (the body has one request at a time).
        if (queueBusy(queue, bound(() => true, unfinished).length > 0)) return joinList(value.goal!);
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
        return { ...toolOk(queueStatusLines(queue, reads.map(item => item.result.text)).join('\n') || 'マイクラに結び付いたタスクはまだない。'),
          documents: { sourceIds } };
      }
      if (name !== 'minecraft.cancel') throw new Error('FCA_TOOL_NOT_OFFERED');
      const open = tasks.filter(task => !['stopped', 'completed', 'failed'].includes(task.phase));
      const targets = value.id ? open.filter(task => task.id === value.id)
        : open.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, 1);
      if (!targets.length) return toolFailure('not_found', '指定された進行中のマイクラタスクが見つからない。');
      // Exactly one target is selected above. Stop admission alone cannot certify that physical inputs stopped.
      const stopped = await cancelRequest(targets[0]!.id);
      return withToolEvidence(toolOk('停止要求を受け付けた。身体操作の停止確認後に停止済みになる。'),
        { outcome: stopped.some(task => task.id === targets[0]!.id && task.phase === 'stopped') ? 'applied' : 'queued', action: 'cancel',
          target: { kind: 'minecraft_request', id: targets[0]!.id }, operationId: targets[0]!.id });
    } },
    admission,
    async intent(input) {
      const { intent } = input;
      if (intent.kind === 'none') return bodyIntentOf(intent);
      const reason = precheck(input);
      if (reason) return refused(reason, intent.kind);
      const sourceId = input.experienceId!;
      // His own dragon words, not her rewrite of them, are what the task keeps (a message to it too).
      const goal = intent.kind === 'task' || intent.kind === 'message' ? ownDragonWords(input.request.message) ?? intent.goal : intent.goal;
      let asked: MinecraftIntent = intent;
      if (intent.kind === 'message') {
        const told = message(input, sourceId, goal);
        if (told) return told;
        // Words for a request, and none is under way (it just ended, or the list is empty): they stay his words, as a request of their own on the
        // list. Refusing them told him to say again what he had said (a cake just made, "put it on this oak"): the request was in the words.
        log('Shannon Minecraft intent message with nothing running added as task');
        asked = { kind: 'task', goal, placement: 'end' };
      }
      const outcome = await applyQueueIntent(queue, { ...asked, goal }, { origin: 'chat', requestId: `mc:${input.request.requestId}`,
        experienceId: sourceId, observedAt: input.request.observedAt, stopReason: 'owner_game_stop' });
      if (!outcome.delivered) return refused(outcome.reason, asked.kind);
      if (asked.kind === 'stop') await stopOthers();
      return asked.kind === 'task' ? { kind: 'task' as const, goal, request: { id: outcome.entry!.taskId ?? outcome.entry!.id } } : bodyIntentOf(asked);
    },
  };
}
