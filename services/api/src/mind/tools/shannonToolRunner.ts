import { observeAsync, observeSync, observerHandoff } from '../../infra/observer/observerContext.js';
import type { AetherAccess } from '../../integrations/aether/aetherAccess.js';
import type { AetherProposalStore } from '../../integrations/aether/aetherProposal.js';
import { ROOM_LOOK_GUARD, roomLookGuard } from '../action/ownTime/ownTimePorts.js';
import type { SQLiteAutonomyStore } from '../action/ownTime/ownTimePorts.js';
import type { SecretCheck } from '../inhibition/disclosurePorts.js';
import type { HostFolderOperations } from '../action/ownTime/ownTimePorts.js';
import { folderExecutors, folderToolForHosts } from './shannonFolderTools.js';
import { minecraftExecutors, minecraftToolOffered, type MinecraftRequestPort } from './shannonMinecraftTools.js';
import { aetherExecutors } from './shannonAetherTools.js';
import { ownerDocumentExecutors } from './shannonOwnerDocumentTools.js';
import { aetherStudyTool, studyExecutors } from './shannonStudyTools.js';
import { authorizeToolCall, authorizeToolInput, gatedAether, shownAetherCall } from '../inhibition/toolGatePorts.js';
import type { StudyAether } from '../action/ownTime/ownTimePorts.js';
import { validToolInput, type ToolInput } from './shannonToolInput.js';
import type { PreparedToolCall, ToolExecutionContext, ToolExecutor, ToolDocuments } from './shannonToolTypes.js';
import {
  isReadToolDomain, offeredTools, providerToolName, shannonTool, toolFailure, toolForSurface, toolFromProviderName,
  type ReadToolDomain, type ShannonToolDefinition, type ToolAudience, type ToolResult, type ToolSurface,
} from './shannonTools.js';
import { READ_TOOL_PORT, readToolExecutors, type ReadToolPorts } from './shannonReadTools.js';
import { skillExecutors } from './shannonSkillTools.js';
import type { SkillTurnPorts } from '../../contracts/skillMemoryContract.js';
import { skillHash } from '../memory/memoryPorts.js';
import { WITHHELD_TOOL, withheldRail, type WithheldRail, type WithheldReason, type WithheldSink } from '../../contracts/withheldActionContract.js';
import { actionPermit, currentActionExecution } from '../../infra/context/actionExecution.js';
import { actionResource } from '../../contracts/actionThreadContract.js';
import type { SelfRewriteRuntimePort } from '../inhibition/selfRewritePorts.js';
import { selfRewriteExecutors } from './shannonSelfRewriteTools.js';
import { MEMORY_TOOLS } from './memoryToolDefinitions.js';
import { TASK_TOOLS } from './taskToolDefinitions.js';
import { SELF_REWRITE_TOOLS } from './selfRewriteToolDefinitions.js';

/**
 * Runs the registry's tools. Conversations (text and voice) call `call`; her own time uses `prepare` inside a
 * loop step, whose decision and record the loop already makes (`autonomyLoopToolStep.ts`).
 *
 * Every call passes the one gate entry (`authorizeToolCall`) and the input check before an executor sees it, and
 * every call from a conversation is written to the activity record, also one that was refused, with no content.
 */
export interface ToolRecorder {
  recordConversationAction(scopeKey: string, report: { summary: string; tool: string; outcome: 'done' | 'failed'; reasonCode?: string }): unknown;
}

const STUDY_REJECTIONS: Readonly<Record<string, ToolResult>> = Object.freeze({
  STUDY_LIMIT: toolFailure('limit', '上限に達していて、できなかった。', { retryable: false }),
  STUDY_INVALID: toolFailure('invalid_input', '題名か本文か直した理由が、決まりに合わなかった（空、長すぎるなど）。', { retryable: false }),
  STUDY_CLOSED: toolFailure('conflict', 'しまってあるので、できなかった。', { retryable: false }),
  STUDY_NOT_FOUND: toolFailure('not_found', '見つからなかった。', { retryable: false }),
  STUDY_AETHER_LINKED: toolFailure('conflict', 'Aetherには書けていて、書斎にはもう取り込まれていた（二つにはしなかった）。study.list で確かめる。', { retryable: false }),
});

/** Aether as her tools reach it (Syzygy ADR-0007 revised); every part absent while it is not configured. */
export interface ToolAetherPorts {
  access?: AetherAccess | null;
  /** Her study in Aether: the study tools write there, and read what Aether has. */
  study?: StudyAether | null;
  /** The owner's proposal inbox (`AETHER_SHANNON_PROPOSAL_DIR`), for `aether.propose`. */
  proposals?: AetherProposalStore | null;
  /** Her own time may read the owner's documents (`SHANNON_AUTONOMY_OWNER_DOCUMENTS=on`, the autonomy service only); absent, `ownerDocs.*` do not exist. */
  ownerDocuments?: boolean;
}

/** Syzygy ADR-0008 stage 1: a tool call of hers in a conversation that ran, as closed values (data only, no effect). */
export type ToolCallChoiceSink = (scopeKey: string, call: { tool: string; surface: 'text' | 'voice'; audience: ToolAudience; ok: boolean }, at: string) => void;

/**
 * Results a rule withheld (Syzygy ADR-0008 §14: the gate, who can see or hear, what the owner said is 内緒): a turn's choices leave
 * them out (`turnToolResults`), so a stop is never learned as a failure of hers.
 */
const WITHHELD_RESULTS = new WeakSet<object>();

export function wasWithheld(result: ToolResult): boolean {
  return WITHHELD_RESULTS.has(result);
}

export interface TaskRuntimeToolPort {
  available(scopeKey: string): boolean;
  execute(name: string, input: unknown, context: ToolExecutionContext): ToolResult;
  observeRead?(scopeKey: string, receipt: { name: string; documents?: ToolDocuments; ok: boolean }): void;
}
export interface MemoryToolPort {
  available(scopeKey: string, context?: ToolExecutionContext): boolean;
  execute(name: string, input: unknown, context: ToolExecutionContext, signal?: AbortSignal): Promise<ToolResult>;
}
export interface MinecraftTaskToolPort extends MemoryToolPort {
  /** Trusted per-call read metadata is kept outside the result shown to the model. */
  execute(name: string, input: unknown, context: ToolExecutionContext, signal?: AbortSignal): Promise<ToolResult & { documents?: ToolDocuments }>;
}
export class ShannonToolRunner {
  private minecraftTasks: MinecraftTaskToolPort | null = null;
  useMinecraftTasks(port: MinecraftTaskToolPort): void { this.minecraftTasks = port; }
  private taskMemory: MemoryToolPort | null = null;
  private taskRuntime: TaskRuntimeToolPort | null = null;
  private executors: Readonly<Record<string, ToolExecutor>>;
  /**
   * Review M2 (owner: 「できるようにする」): told of each of her own `aetherFolder.update` and `.delete` that worked
   * (`observeCopyWrites`), so that a write to one of her skills' copies is known as hers (`shannon_copy`), never as the owner's.
   */
  private copyWrites: ((scopeKey: string, documentId: string, write: { kind: 'update' | 'delete'; bodyHash: string | null }) => void) | null = null;
  /** Syzygy ADR-0008 §14: where a call a rule stopped is written (`observeWithheld`); null, nothing is written. */
  private withheld: { sink: WithheldSink; now: () => string } | null = null;
  private choices: { sink: ToolCallChoiceSink; now: () => string } | null = null;
  /** Syzygy ADR-0008 stage 2: the ports of her read tools (`useReads`); null, they do not exist on this server. */
  private reads: ReadToolPorts | null = null;
  /** Syzygy ADR-0008 stage 2, step 6: her skill memory (`useSkills`); null, `skill.read` does not exist on this server. */
  private skills: SkillTurnPorts | null = null;
  private selfRewrite: SelfRewriteRuntimePort | null = null;

  constructor(
    private readonly store: SQLiteAutonomyStore,
    private readonly folder: HostFolderOperations,
    private readonly recorder: ToolRecorder,
    now: () => string,
    private readonly transaction: <T>(operation: () => T) => T = operation => store.transaction(operation),
    /** Her Minecraft body's request queue (`minecraftBodyRequests.ts`); absent, its tools are never offered. */
    private readonly minecraft: MinecraftRequestPort | null = null,
    private readonly aether: ToolAetherPorts = {},
  ) {
    const folderTools = folderExecutors(folder, scopeKey => roomLookGuard(store.study.roomLookTexts(scopeKey, ROOM_LOOK_GUARD.notes)));
    this.executors = Object.freeze({ ...studyExecutors(store, now, aether.study ?? null), ...(aether.study ? withoutStories(store, folderTools, aether.study) : folderTools),
      ...minecraftExecutors(minecraft), ...aetherExecutors(aether.proposals ?? null, aether.study ?? null), ...ownerDocumentExecutors(aether.access ?? null) });
  }

  /**
   * The tools a surface offers to this audience now. Her folder's tools only while a device is registered for it; her
   * Minecraft body's only in the scope that has one (`scopeKey`), and `minecraft.request` only while the body is present.
   */
  offered(surface: ToolSurface, audience: ToolAudience, scopeKey?: string): readonly ShannonToolDefinition[] {
    // Her Aether tools only while the Aether client is configured (URL and token), and a proposal only while the inbox is too:
    // with the inbox alone (or the token alone) every offer is what it was before Aether access. Only to the owner's scope.
    const tools = [...offeredTools(surface, audience, tool => tool.domain === 'memory_read' ? !!scopeKey && (this.taskMemory?.available(scopeKey) ?? false) : tool.domain === 'task_runtime' ? !!scopeKey && (this.taskRuntime?.available(scopeKey) ?? false) : isReadToolDomain(tool.domain) ? this.readsFor(tool.domain)
      : tool.domain === 'skill_read' ? this.skills !== null
      : tool.domain === 'vm_workspace' ? this.selfRewrite !== null
      : tool.domain === 'host_folder' ? this.folder.boundHosts().length > 0
      : tool.domain === 'minecraft_body' ? this.minecraftTasks ? !!scopeKey && this.minecraftTasks.available(scopeKey) : minecraftToolOffered(this.minecraft, tool, scopeKey)
        : tool.domain === 'owner_documents_read' ? this.ownerDocumentsFor(scopeKey)
        : tool.domain === 'aether_proposal' ? this.aether.proposals?.configured === true && this.aetherFor(scopeKey)
          : tool.name.startsWith('aether') ? this.aetherFor(scopeKey) : true),
      ...(this.selfRewrite ? SELF_REWRITE_TOOLS.filter(tool => tool.surfaces.includes(surface) && tool.audiences.includes(audience)) : [])];
    const hosts = this.folder.boundHosts();
    const named = hosts.length > 1 ? tools.map(tool => folderToolForHosts(tool, hosts)) : tools;
    return this.aether.study && (scopeKey === undefined || this.aether.study.covers(scopeKey)) ? named.map(aetherStudyTool) : named;
  }

  /**
   * Whether her Aether tools exist for this scope: the client is configured and the scope is the owner's (`aetherStudyScope`,
   * the one scope whose study lives in Aether). A call that names no scope gets none.
   */
  private aetherFor(scopeKey: string | undefined): boolean {
    return Boolean(this.aether.access) && scopeKey !== undefined && (this.aether.study?.covers(scopeKey) ?? false);
  }

  /** Whether her own time may read the owner's documents in this scope: switched on, and her Aether tools exist there. */
  private ownerDocumentsFor(scopeKey: string | undefined): boolean {
    return this.aether.ownerDocuments === true && this.aetherFor(scopeKey);
  }

  /**
   * A tool by its name or its provider name, as this server has it: without the Aether client her Aether tools are not
   * there at all, so a call of one is refused and recorded exactly as a call of a name that never existed (as before Aether).
   * The same holds for `ownerDocs.*` while her own time may not read the owner's documents (as before they existed).
   */
  knownTool(name: string): ShannonToolDefinition | null {
    const tool = toolFromProviderName(name) ?? shannonTool(name)
      ?? (this.selfRewrite ? SELF_REWRITE_TOOLS.find(tool => tool.name === name || providerToolName(tool.name) === name) ?? null : null);
    // Her read tools do not exist without their ports: a call of one is refused as a name that never existed.
    if (tool && isReadToolDomain(tool.domain) && !this.readsFor(tool.domain)) return null;
    if (tool?.domain === 'memory_read' && !this.taskMemory) return null;
    if (tool?.domain === 'skill_read' && !this.skills) return null;
    if (tool?.domain === 'vm_workspace' && !this.selfRewrite) return null;
    if (tool?.domain === 'owner_documents_read' && !(this.aether.ownerDocuments === true && this.aether.access)) return null;
    return tool && !this.aether.access && (tool.name.startsWith('aether') || tool.domain === 'aether_proposal') ? null : tool;
  }

  /** The gate, the input check, and the executor's preparation. A result here is the call's answer: nothing ran. */
  prepare(name: string, rawInput: unknown, context: ToolExecutionContext): { tool: ShannonToolDefinition; prepared: PreparedToolCall } | { tool: ShannonToolDefinition | null; result: ToolResult } {
    const observedName = this.knownTool(name)?.name ?? 'unknown';
    return observeSync('gate', { name: observedName, surface: context.surface, audience: context.audience },
      () => this.prepareOnce(name, rawInput, context), value => 'result' in value
        ? observedToolResult(observedName, value.result, 'not_run') : { name: value.tool.name, allowed: true, status: 'prepared' });
  }

  private prepareOnce(name: string, rawInput: unknown, context: ToolExecutionContext): ReturnType<ShannonToolRunner['prepare']> {
    const named = shannonTool(name) ?? (this.selfRewrite ? SELF_REWRITE_TOOLS.find(tool => tool.name === name) : null);
    const tool = named && this.knownTool(named.name) ? named : null;
    const refused = authorizeToolCall(tool, context);
    if (refused || !tool) return tool && refused ? this.withhold(context, tool, refused, tool.surfaces.includes(context.surface) ? 'audience' : 'not_offered')
      : { tool, result: refused ?? toolFailure('not_offered', 'そういう道具はない。', { retryable: false }) };
    const executor: ToolExecutor | undefined = tool.domain === 'minecraft_body' && this.minecraftTasks ? (input, context) => ({
      summary: '共通タスクのマイクラ作業を操作する。', run: async signal => {
        const { documents, ...result } = await this.minecraftTasks!.execute(tool.name, input, context, signal);
        return { result, ...(documents ? { documents } : {}), record: { summary: '共通タスクへのマイクラ操作を受け付けました。', outcome: result.ok ? 'done' as const : 'failed' as const } };
      },
    }) : this.executors[tool.name];
    if (tool.domain === 'memory_read' && !this.taskMemory?.available(context.scopeKey, context)) return { tool, result: toolFailure('not_offered', 'この実行では記憶の道具を使えません。', { retryable: false }) };
    if (tool.domain === 'task_runtime' && !this.taskRuntime?.available(context.scopeKey)) return { tool, result: toolFailure('not_offered', 'この実行ではタスクの道具を使えない。', { retryable: false }) };
    if ((tool.name.startsWith('aether') || tool.domain === 'aether_proposal') && !this.aetherFor(context.scopeKey)) {
      return this.withhold(context, tool, toolFailure('not_offered', `${tool.name} はここでは使えない。`, { retryable: false, refusal: { why: 'Aetherの道具はライ氏のscopeだけ', wouldWork: 'ライ氏との会話か、ボクの時間で使う' } }), 'not_offered');
    }
    if (tool.domain === 'owner_documents_read' && !this.ownerDocumentsFor(context.scopeKey)) {
      return this.withhold(context, tool, toolFailure('not_offered', `${tool.name} はここでは使えない。`, { retryable: false, refusal: { why: 'ライ氏の文書は、ライ氏のscopeの自分の時間に、許された時だけ読む', wouldWork: 'ライ氏と二人だけの会話で aether の道具を使う' } }), 'not_offered');
    }
    // Only for one of her pursuits she is working on now (ADR-0007), checked here as well as by the loop.
    const pursuitId = rawInput && typeof rawInput === 'object' ? (rawInput as { pursuitId?: unknown }).pursuitId : undefined;
    const pursuit = tool.domain === 'owner_documents_read' && typeof pursuitId === 'string' ? this.store.pursuits.get(context.scopeKey, pursuitId.trim()) : null;
    if (tool.domain === 'owner_documents_read' && typeof pursuitId === 'string' && pursuit?.status !== 'active') {
      return this.withhold(context, tool, toolFailure('refused', `${pursuit ? 'その気になっていることは、いま進めていない' : '台帳にない id だった'}。ライ氏の文書は、いま進めている気になっていることのためにだけ読む。`, {
        retryable: false, refusal: { why: 'pursuitId が台帳のいま進めているものではない', wouldWork: 'pursuitId に台帳のいま進めているものの id を書く' } }), 'not_pursuing');
    }
    if (!executor) return { tool, result: toolFailure('not_offered', `${tool.name} はまだ使えない。`, { retryable: false }) };
    // The schema of this surface: in a conversation a write is shorter (`toolForSurface`).
    const checked = validToolInput(rawInput, toolForSurface(tool, context.surface).input);
    if ('problem' in checked) return { tool, result: toolFailure('invalid_input', `入力が正しくない（${checked.problem}）。`, { retryable: false }) };
    const inputRefused = authorizeToolInput(tool, checked.input, context);
    if (inputRefused) return this.withhold(context, tool, inputRefused, 'outside_reach', context.audience === 'others' ? 'audience' : 'gate');
    const secret = secretRefusal(tool.name, checked.input, context.secrets);
    if (secret) return this.withhold(context, tool, secret, 'secret');
    try {
      // Aether as this call may reach it: the gate narrows it with anyone else present and in her own time.
      // With anyone else present, what she wrote after reading the owner's documents is not read either (ADR-0007).
      const informed = (documentId: string) => this.store.informed.marked(context.scopeKey, documentId);
      const prepared = executor(checked.input, this.aether.access && this.aetherFor(context.scopeKey) ? { ...context, aether: gatedAether(this.aether.access, context, informed) } : context);
      // With anyone else present, what she read reaches the model without the owner's private things.
      if(!('run' in prepared))return {tool,result:prepared};
      const call=this.notedCopyWrite(tool,checked.input,context.scopeKey,shownAetherCall(tool,prepared,context));
      return {tool,prepared:{...call,run:async signal=>{
        const resources=tool.domain==='vm_workspace' || tool.domain==='task_runtime' ? [] : tool.effect==='write'?[actionResource(context.scopeKey,call.folder?`folder:${call.folder.host}`:'study')]:[];
        const refusedNow = await observeAsync('gate', { name: tool.name, phase: 'before_execution' }, async () => {
          await actionPermit(resources);
          // The original gate and live secret predicate are evaluated again after waiting for a resource.
          return authorizeToolCall(tool,context) ?? authorizeToolInput(tool,checked.input,context);
        }, refusal => refusal ? observedToolResult(tool.name, refusal, 'not_run') : { name: tool.name, allowed: true });
        if(refusedNow) return {result:refusedNow,record:{summary:'実行直前の関門で止まりました。',outcome:'failed' as const,reasonCode:'refused'}};
        const active=currentActionExecution();
        const combined=active?signal?AbortSignal.any([signal,active.signal]):active.signal:signal;
        context.beforeExecution?.();
        observerHandoff('gate', 'tools', { name: tool.name });
        return observeAsync('tools', { name: tool.name, phase: 'execute', argumentFields: Object.keys(tool.input.properties).filter(key => Object.hasOwn(checked.input, key)) },
          () => call.run(combined), run => ({ ...observedToolResult(tool.name, run.result, run.apply ? 'awaiting_commit' : 'returned'),
            acknowledged: run.acknowledged ?? null, commitPending: Boolean(run.apply) }));
      }}};
    } catch {
      return { tool, result: toolFailure('failed', 'うまく準備できなかった。', { retryable: true }) };
    }
  }

  /**
   * A call from a conversation that the turn refused before it reached here (a name it does not offer): recorded, not run. With
   * `withheld` (a rule stopped it: who can hear, words not trusted to write) it is also written as withheld (ADR-0008 §14).
   */
  refused(name: string, scopeKey: string, result: ToolResult, withheld?: { surface: 'text' | 'voice'; tool: string; reason: WithheldReason }): ToolResult {
    try {
      this.recorder.recordConversationAction(scopeKey, { summary: `会話の中で道具「${this.knownTool(name)?.name ?? '不明'}」を使おうとしましたが、使えませんでした。`, tool: name.slice(0, 120), outcome: 'failed', reasonCode: 'not_offered' });
    } catch { /* the refusal stands */ }
    if (withheld) this.note(scopeKey, withheld.surface, withheld.tool, withheld.reason);
    return result;
  }

  /** Review M2: where her own Aether folder writes are noted (the wiring hands it while the skills are on, in both processes). */
  observeCopyWrites(noted: (scopeKey: string, documentId: string, write: { kind: 'update' | 'delete'; bodyHash: string | null }) => void): void { this.copyWrites = noted; }

  /** Her `aetherFolder.update` or `.delete`, noted once it worked (the skill memory keeps it only for a skill's copy). */
  private notedCopyWrite(tool: ShannonToolDefinition, input: ToolInput, scopeKey: string, prepared: PreparedToolCall): PreparedToolCall {
    const noted = this.copyWrites;
    const documentId = typeof input.documentId === 'string' ? input.documentId.trim() : '';
    if (!noted || !documentId || (tool.name !== 'aetherFolder.update' && tool.name !== 'aetherFolder.delete')) return prepared;
    const kind = tool.name === 'aetherFolder.update' ? 'update' as const : 'delete' as const;
    const bodyHash = kind === 'update' && typeof input.body === 'string' ? skillHash(input.body) : null;
    return { ...prepared, run: async signal => {
      const run = await prepared.run(signal);
      if (run.result.ok) { try { noted(scopeKey, documentId, { kind, bodyHash }); } catch { /* the write stands */ } }
      return run;
    } };
  }

  /** Syzygy ADR-0008 §14: every call a rule stops is written as withheld, through this sink (the wiring hands it only with stage 2 on). */
  observeWithheld(sink: WithheldSink, now: () => string): void { this.withheld = { sink, now }; }

  /** A tool or step a rule stopped outside `prepare` (her own time's tool step), written as withheld. */
  note(scopeKey: string, surface: ToolSurface, tool: string, reason: WithheldReason, rail: WithheldRail = withheldRail(reason)): void {
    if (!this.withheld) return;
    try { this.withheld.sink(scopeKey, { surface, tool: WITHHELD_TOOL.test(tool) ? tool : 'unknown', reason, rail }, this.withheld.now()); } catch { /* the refusal stands */ }
  }

  private withhold(context: ToolExecutionContext, tool: ShannonToolDefinition, result: ToolResult, reason: WithheldReason, rail?: WithheldRail): { tool: ShannonToolDefinition; result: ToolResult } {
    WITHHELD_RESULTS.add(result);
    this.note(context.scopeKey, context.surface, tool.name, reason, rail);
    return { tool, result };
  }

  /**
   * Syzygy ADR-0008 stage 2, step 3 (`SHANNON_READ_TOOLS`): her read tools exist from now on, over these ports (the wiring hands
   * them only while the switch is on). Never called, every offer, name and refusal is what it was.
   */
  useTaskRuntime(port: TaskRuntimeToolPort): void {
    this.taskRuntime = port;
    this.executors = Object.freeze({ ...this.executors, ...Object.fromEntries(TASK_TOOLS.map(tool => [tool.name,
      (input: ToolInput, context: ToolExecutionContext): PreparedToolCall => ({ summary: '共通タスクを操作します。', run: async () => {
        const result = port.execute(tool.name, input, context);
        return { result, record: { summary: '共通タスクの操作結果を記録しました。', outcome: result.ok ? 'done' : 'failed' } };
      } })])) });
  }

  useMemory(port: MemoryToolPort): void {
    this.taskMemory = port;
    this.executors = Object.freeze({ ...this.executors, ...Object.fromEntries(MEMORY_TOOLS.map(tool => [tool.name,
      (input: ToolInput, context: ToolExecutionContext): PreparedToolCall => ({ summary: '関連する記憶を参照します。', run: async signal => {
        const result = await port.execute(tool.name, input, context, signal);
        return { result, record: { summary: '記憶の参照結果を記録しました。', outcome: result.ok ? 'done' : 'failed' } };
      } })])) });
  }

  useReads(ports: ReadToolPorts): void {
    this.reads = ports;
    this.executors = Object.freeze({ ...this.executors, ...readToolExecutors(ports) });
  }

  /**
   * Syzygy ADR-0008 stage 2, step 6 (`SHANNON_SKILLS`): `skill.read` exists from now on, over her skill memory (the wiring hands
   * it only while the switch is on). Never called, every offer, name and refusal is what it was.
   */
  useSkills(ports: SkillTurnPorts): void {
    this.skills = ports;
    this.executors = Object.freeze({ ...this.executors, ...skillExecutors(ports) });
  }
  /** Stage 5 only: no port means no schemas, prompts or effects. */
  useSelfRewrite(port: SelfRewriteRuntimePort): void {
    this.selfRewrite = port;
    this.executors = Object.freeze({ ...this.executors, ...selfRewriteExecutors(port) });
  }

  private readsFor(domain: ReadToolDomain): boolean {
    return Boolean(this.reads?.[READ_TOOL_PORT[domain]]);
  }

  /** Syzygy ADR-0008 stage 1: told of every conversation call that ran (`SHANNON_CHOICE_LEDGER`); never set, nothing is told. */
  observeChoices(sink: ToolCallChoiceSink, now: () => string): void { this.choices = { sink, now }; }

  /** One call from a conversation: run, commit, record. Never throws. */
  async call(name: string, rawInput: unknown, context: ToolExecutionContext, signal?: AbortSignal): Promise<ToolResult> {
    const ran: { tool?: string } = {};
    const result = await this.callOnce(name, rawInput, context, ran, signal);
    const surface = context.surface;
    if (this.choices && ran.tool && (surface === 'text' || surface === 'voice')) {
      try { this.choices.sink(context.scopeKey, { tool: ran.tool, surface, audience: context.audience, ok: result.ok }, this.choices.now()); } catch { /* data only */ }
    }
    return result;
  }

  private async callOnce(name: string, rawInput: unknown, context: ToolExecutionContext, ran: { tool?: string }, signal?: AbortSignal): Promise<ToolResult> {
    const record = (summary: string, outcome: 'done' | 'failed', reasonCode?: string) => {
      try {
        this.recorder.recordConversationAction(context.scopeKey, { summary, tool: name.slice(0, 120), outcome, ...(reasonCode ? { reasonCode } : {}) });
      } catch { /* the call stands; a record that cannot be written is not hers to fix */ }
    };
    const ready = this.prepare(name, rawInput, context);
    if ('result' in ready) {
      record(`会話の中で道具「${ready.tool?.name ?? '不明'}」を使おうとしましたが、使えませんでした。`, 'failed', ready.result.failure);
      return ready.result;
    }
    ran.tool = ready.tool.name;
    let run;
    try { run = await ready.prepared.run(signal); } catch {
      record(`会話の中で道具「${ready.tool.name}」を使おうとしましたが、うまくいきませんでした。`, 'failed', 'failed');
      return toolFailure('failed', 'うまくいかなかった。', { retryable: true });
    }
    if (ready.tool.effect === 'read' && ready.tool.domain !== 'memory_read') this.taskRuntime?.observeRead?.(context.scopeKey,
      { name: ready.tool.name, documents: run.documents, ok: run.result.ok });
    if (!run.apply) {
      if (!run.recordedElsewhere) record(run.record.summary, run.record.outcome, run.record.reasonCode);
      if(context.surface!=='autonomy' && context.acknowledgementOwner !== 'fca')await currentActionExecution()?.checkpoint?.('tool_returned');
      return run.result;
    }
    try {
      await actionPermit();
      const added = observeSync('tools', { name: ready.tool.name, phase: 'commit' }, () => this.transaction(() => {
        const line = run.apply!();
        this.recorder.recordConversationAction(context.scopeKey, { summary: run.record.summary, tool: ready.tool.name, outcome: 'done' });
        return line;
      }), () => ({ name: ready.tool.name, ok: true, status: 'committed' }));
      if(context.surface!=='autonomy' && context.acknowledgementOwner !== 'fca')await currentActionExecution()?.checkpoint?.('tool_committed');
      return added ? { ...run.result, text: `${run.result.text}\n${added}` } : run.result;
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      record(`会話の中で道具「${ready.tool.name}」を使おうとしましたが、できませんでした。`, 'failed', STUDY_REJECTIONS[code] ? code : 'failed');
      return STUDY_REJECTIONS[code] ?? toolFailure('failed', 'うまくいかなかった。', { retryable: true });
    }
  }
}

export { STUDY_REJECTIONS };

/**
 * With her study in Aether her stories live there only, never in the folder on the owner's PC or Mac (Syzygy ADR-0007
 * revised): a file write that carries a run of one of her stories is refused. Like the room-look check it catches copying,
 * not a retelling.
 */
function withoutStories(store: SQLiteAutonomyStore, executors: Readonly<Record<string, ToolExecutor>>, study: StudyAether): Readonly<Record<string, ToolExecutor>> {
  const guarded = (executor: ToolExecutor): ToolExecutor => (input, context) => {
    if (!study.covers(context.scopeKey)) return executor(input, context);
    const content = typeof input.content === 'string' ? input.content : '';
    let carries = false;
    try { carries = roomLookGuard(store.study.list(context.scopeKey, 500, 'include').filter(piece => piece.kind === 'story').map(piece => piece.body))(content); } catch { carries = true; }
    return carries ? toolFailure('refused', '物語の文が入っているので、PCのフォルダには書かない。', {
      retryable: false, refusal: { why: '物語はAetherの書斎にだけ置く決まり', wouldWork: '物語は study の道具で書斎に書き、フォルダには物語の文を除いて書く' },
    }) : executor(input, context);
  };
  return Object.freeze({ ...executors, 'folder.create': guarded(executors['folder.create']!), 'folder.update': guarded(executors['folder.update']!) });
}

/** The tools whose words end up in her study or her folder. */
const WRITING_TOOLS: ReadonlySet<string> = new Set(['study.create', 'study.update', 'study.rename', 'folder.create', 'folder.update', 'folder.rename', 'folder.move',
  'aetherFolder.create', 'aetherFolder.update', 'aether.propose']);

/** A write from a conversation that repeats what must reach nobody but the owner (the check her own time uses), or null. */
function secretRefusal(name: string, input: Readonly<Record<string, unknown>>, secrets: SecretCheck | null | undefined): ToolResult | null {
  if (secrets === undefined || !WRITING_TOOLS.has(name)) return null;
  if (secrets === null) {
    return toolFailure('unavailable', '書く前に、内緒のことと忘れたことの記憶を読めなかったので、書かなかった。', { retryable: true, refusal: { why: '記憶をいま読めなかった', wouldWork: '少しあとでもう一度' } });
  }
  const words = Object.values(input).filter((value): value is string => typeof value === 'string');
  if (!words.some(word => secrets.carries(word))) return null;
  return toolFailure('refused', 'ライ氏に内緒と言われたこと、または忘れてと頼まれたことと同じ言い回しが入っているので、書かなかった。', {
    retryable: false, refusal: { why: '内緒のこと・忘れたことを書くことになる', wouldWork: 'そこを除いて書き直す' },
  });
}

/** A result's content can be private recall, an unshown story or file contents; retain only the execution outcome. */
function observedToolResult(name: string, result: ToolResult, status: 'not_run' | 'awaiting_commit' | 'returned') {
  return { name, ok: result.ok, failureKind: result.failure ?? null, retryable: result.retryable, status, withheld: wasWithheld(result) };
}
