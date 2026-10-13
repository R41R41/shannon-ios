import type { FcaConversationPort, FcaSourceGuard } from '../mind/action/fca/fcaConversationPorts.js';
import type { TaskRuntime, TaskView } from '../mind/action/taskRuntime/taskRuntimePorts.js';
import type { MinecraftControl } from '../surfaces/minecraft/minecraftControl.js';
import type { MinecraftBodyDependencies } from '../surfaces/minecraft/minecraftBody.js';
import type { MinecraftTaskToolPort } from '../mind/tools/shannonToolRunner.js';
import { toolOk, toolFailure } from '../mind/tools/shannonTools.js';
import { withToolEvidence } from '../mind/tools/toolEvidence.js';

/** Existing conversation tools now refer to common tasks. No legacy queue or planner fallback in this mode. */
export function fcaMinecraftRequests(parts: { control: MinecraftControl; runtime: TaskRuntime; conversation: FcaConversationPort;
  visible: FcaSourceGuard; ownerScope: string; ownerAlone(): boolean; stop(id: string, reason: string): Promise<TaskView[]>;
  sourceVisible(id: string): boolean;
  /** Same SQLite connection as task authority and body bindings; nested authority writes use savepoints. */
  atomic<T>(work: () => T): T;
}): { tools: MinecraftTaskToolPort; intent: NonNullable<MinecraftBodyDependencies['fcaIntent']> } {
  const bound = (visible: (id: string) => boolean = id => parts.visible(parts.ownerScope, id)) => {
    const tasks: TaskView[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = parts.runtime.list(parts.ownerScope, { limit: 100, offset });
      tasks.push(...page.filter(task => parts.control.store.body(task.id) && visible(task.id)));
      if (page.length < 100) return tasks;
    }
  };
  const spec = (goal: string) => ({ title: goal.slice(0, 120), goal, completionCriteria: '目的の達成を新しいワールド観測と実行結果から確認する。', context: '共通FCAのmc.*の道具で実行する。minecraft.reflexで視覚操作の短いセッションを要求できる。' });
  return {
    tools: { available: scope => scope === parts.ownerScope && parts.conversation.taskToolsAvailable(scope), async execute(name, input, context, signal) {
      signal?.throwIfAborted();
      // 2026-10-13: the turn's task context closed after its menu was built (`fca_context_budget`), and the call threw. Whatever
      // closed it (the scope, the audience, the budget), the request is refused as a closed value she can say, and nothing starts.
      if (context.scopeKey !== parts.ownerScope || !parts.ownerAlone() || !parts.conversation.taskToolsAvailable(context.scopeKey)) {
        return toolFailure('unavailable', 'いまはマイクラの依頼を受け付けられません。少しあとでもう一度頼んでください。', { retryable: false });
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
    async intent(input) {
      const { intent, scopeKey } = input;
      if (intent.kind === 'none') return intent;
      if (scopeKey !== parts.ownerScope || !parts.ownerAlone() || !input.experienceId || !parts.sourceVisible(input.experienceId)) return { kind: 'none', goal: '', rejected: 'queue_unavailable' };
      if (intent.kind === 'stop') { for (const task of bound()) await parts.stop(task.id, 'owner_game_stop'); return intent; }
      const bodyId = parts.control.bodyId(input.request.serverId);
      if (!parts.control.frame(bodyId)) return { kind: 'none', goal: '', rejected: 'queue_unavailable' };
      const sourceId = input.experienceId;
      return parts.atomic(() => {
        const task = parts.runtime.createChild(scopeKey, parts.runtime.ensureRoot(scopeKey).id, spec(intent.goal), `mc:${input.request.requestId}`);
        parts.runtime.observeExternal(scopeKey, task.id, { eventId: `mc:${input.request.requestId}`, experienceIds: [sourceId], observedAt: input.request.observedAt, text: `ゲーム内の本人の依頼: ${intent.goal}` });
        if (!parts.control.store.bind(task.id, bodyId)) throw new Error('FCA_BODY_BINDING_CONFLICT');
        return { ...intent, request: { id: task.id } };
      });
    },
  };
}
