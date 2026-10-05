import type { AetherAccess } from './aetherAccess.js';
import type { AetherProposalStore } from './aetherProposal.js';
import { ROOM_LOOK_GUARD, roomLookGuard } from './autonomyHostFolderPath.js';
import type { SQLiteAutonomyStore } from './autonomyStore.js';
import type { SecretCheck } from './conversationSecrets.js';
import type { HostFolderOperations } from './hostFolderOperations.js';
import { folderExecutors } from './shannonFolderTools.js';
import { minecraftExecutors, minecraftToolOffered, type MinecraftRequestPort } from './shannonMinecraftTools.js';
import { aetherExecutors } from './shannonAetherTools.js';
import { aetherStudyTool, studyExecutors } from './shannonStudyTools.js';
import { authorizeToolCall, authorizeToolInput, gatedAether } from './shannonToolGate.js';
import type { StudyAether } from './studyAether.js';
import { validToolInput } from './shannonToolInput.js';
import type { PreparedToolCall, ToolExecutionContext, ToolExecutor } from './shannonToolTypes.js';
import {
  offeredTools, shannonTool, toolFailure, toolForSurface, toolFromProviderName, type ShannonToolDefinition, type ToolAudience, type ToolResult, type ToolSurface,
} from './shannonTools.js';

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
});

/** Aether as her tools reach it (Syzygy ADR-0007 revised); every part absent while it is not configured. */
export interface ToolAetherPorts {
  access?: AetherAccess | null;
  /** Her study in Aether: the study tools write there, and read what Aether has. */
  study?: StudyAether | null;
  /** The owner's proposal inbox (`AETHER_SHANNON_PROPOSAL_DIR`), for `aether.propose`. */
  proposals?: AetherProposalStore | null;
}

export class ShannonToolRunner {
  private readonly executors: Readonly<Record<string, ToolExecutor>>;

  constructor(
    store: SQLiteAutonomyStore,
    private readonly folder: HostFolderOperations,
    private readonly recorder: ToolRecorder,
    now: () => string,
    private readonly transaction: <T>(operation: () => T) => T = operation => store.transaction(operation),
    /** Her Minecraft body's request queue (`minecraftBodyRequests.ts`); absent, its tools are never offered. */
    private readonly minecraft: MinecraftRequestPort | null = null,
    private readonly aether: ToolAetherPorts = {},
  ) {
    const folderTools = folderExecutors(folder, scopeKey => roomLookGuard(store.study.roomLookTexts(scopeKey, ROOM_LOOK_GUARD.notes)));
    this.executors = Object.freeze({ ...studyExecutors(store, now, aether.study ?? null), ...(aether.study ? withoutStories(store, folderTools) : folderTools),
      ...minecraftExecutors(minecraft), ...aetherExecutors(aether.proposals ?? null) });
  }

  /**
   * The tools a surface offers to this audience now. Her folder's tools only while a device is registered for it; her
   * Minecraft body's only in the scope that has one (`scopeKey`), and `minecraft.request` only while the body is present.
   */
  offered(surface: ToolSurface, audience: ToolAudience, scopeKey?: string): readonly ShannonToolDefinition[] {
    // Her Aether tools only while Aether is configured, and a proposal only while the inbox is: without them every offer is what it was.
    const tools = offeredTools(surface, audience, tool => tool.domain === 'host_folder' ? this.folder.boundHosts().length > 0
      : tool.domain === 'minecraft_body' ? minecraftToolOffered(this.minecraft, tool, scopeKey)
        : tool.domain === 'aether_proposal' ? this.aether.proposals?.configured === true
          : tool.name.startsWith('aether') ? Boolean(this.aether.access) : true);
    return this.aether.study ? tools.map(aetherStudyTool) : tools;
  }

  /** The gate, the input check, and the executor's preparation. A result here is the call's answer: nothing ran. */
  prepare(name: string, rawInput: unknown, context: ToolExecutionContext): { tool: ShannonToolDefinition; prepared: PreparedToolCall } | { tool: ShannonToolDefinition | null; result: ToolResult } {
    const tool = shannonTool(name);
    const refused = authorizeToolCall(tool, context);
    if (refused || !tool) return { tool, result: refused ?? toolFailure('not_offered', 'そういう道具はない。', { retryable: false }) };
    const executor = this.executors[tool.name];
    if (!executor) return { tool, result: toolFailure('not_offered', `${tool.name} はまだ使えない。`, { retryable: false }) };
    // The schema of this surface: in a conversation a write is shorter (`toolForSurface`).
    const checked = validToolInput(rawInput, toolForSurface(tool, context.surface).input);
    if ('problem' in checked) return { tool, result: toolFailure('invalid_input', `入力が正しくない（${checked.problem}）。`, { retryable: false }) };
    const inputRefused = authorizeToolInput(tool, checked.input, context);
    if (inputRefused) return { tool, result: inputRefused };
    const secret = secretRefusal(tool.name, checked.input, context.secrets);
    if (secret) return { tool, result: secret };
    try {
      // Aether as this call may reach it: the gate narrows it with anyone else present and in her own time.
      const prepared = executor(checked.input, this.aether.access ? { ...context, aether: gatedAether(this.aether.access, context) } : context);
      return 'run' in prepared ? { tool, prepared } : { tool, result: prepared };
    } catch {
      return { tool, result: toolFailure('failed', 'うまく準備できなかった。', { retryable: true }) };
    }
  }

  /** A call from a conversation that the turn refused before it reached here (a name it does not offer): recorded, not run. */
  refused(name: string, scopeKey: string, result: ToolResult): ToolResult {
    try {
      this.recorder.recordConversationAction(scopeKey, { summary: `会話の中で道具「${(toolFromProviderName(name) ?? shannonTool(name))?.name ?? '不明'}」を使おうとしましたが、使えませんでした。`, tool: name.slice(0, 120), outcome: 'failed', reasonCode: 'not_offered' });
    } catch { /* the refusal stands */ }
    return result;
  }

  /** One call from a conversation: run, commit, record. Never throws. */
  async call(name: string, rawInput: unknown, context: ToolExecutionContext, signal?: AbortSignal): Promise<ToolResult> {
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
    let run;
    try { run = await ready.prepared.run(signal); } catch {
      record(`会話の中で道具「${ready.tool.name}」を使おうとしましたが、うまくいきませんでした。`, 'failed', 'failed');
      return toolFailure('failed', 'うまくいかなかった。', { retryable: true });
    }
    if (!run.apply) {
      if (!run.recordedElsewhere) record(run.record.summary, run.record.outcome, run.record.reasonCode);
      return run.result;
    }
    try {
      const added = this.transaction(() => {
        const line = run.apply!();
        this.recorder.recordConversationAction(context.scopeKey, { summary: run.record.summary, tool: ready.tool.name, outcome: 'done' });
        return line;
      });
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
function withoutStories(store: SQLiteAutonomyStore, executors: Readonly<Record<string, ToolExecutor>>): Readonly<Record<string, ToolExecutor>> {
  const guarded = (executor: ToolExecutor): ToolExecutor => (input, context) => {
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

