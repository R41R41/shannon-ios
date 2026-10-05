import type { SQLiteAutonomyStore } from './autonomyStore.js';
import type { HostFolderOperations } from './hostFolderOperations.js';
import { folderExecutors } from './shannonFolderTools.js';
import { studyExecutors } from './shannonStudyTools.js';
import { authorizeToolCall } from './shannonToolGate.js';
import { validToolInput } from './shannonToolInput.js';
import type { PreparedToolCall, ToolExecutionContext, ToolExecutor } from './shannonToolTypes.js';
import {
  offeredTools, shannonTool, toolFailure, type ShannonToolDefinition, type ToolAudience, type ToolResult, type ToolSurface,
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

export class ShannonToolRunner {
  private readonly executors: Readonly<Record<string, ToolExecutor>>;

  constructor(
    store: SQLiteAutonomyStore,
    private readonly folder: HostFolderOperations,
    private readonly recorder: ToolRecorder,
    private readonly now: () => string,
    private readonly transaction: <T>(operation: () => T) => T = operation => store.transaction(operation),
  ) {
    this.executors = Object.freeze({ ...studyExecutors(store, now), ...folderExecutors(folder) });
  }

  /** The tools a surface offers to this audience now. Her folder's tools only while a device is registered for it. */
  offered(surface: ToolSurface, audience: ToolAudience): readonly ShannonToolDefinition[] {
    return offeredTools(surface, audience, tool => tool.domain !== 'host_folder' || this.folder.boundHosts().length > 0);
  }

  /** The gate, the input check, and the executor's preparation. A result here is the call's answer: nothing ran. */
  prepare(name: string, rawInput: unknown, context: ToolExecutionContext): { tool: ShannonToolDefinition; prepared: PreparedToolCall } | { tool: ShannonToolDefinition | null; result: ToolResult } {
    const tool = shannonTool(name);
    const refused = authorizeToolCall(tool, context);
    if (refused || !tool) return { tool, result: refused ?? toolFailure('not_offered', 'そういう道具はない。', { retryable: false }) };
    const executor = this.executors[tool.name];
    if (!executor) return { tool, result: toolFailure('not_offered', `${tool.name} はまだ使えない。`, { retryable: false }) };
    const checked = validToolInput(rawInput, tool.input);
    if ('problem' in checked) return { tool, result: toolFailure('invalid_input', `入力が正しくない（${checked.problem}）。`, { retryable: false }) };
    try {
      const prepared = executor(checked.input, context);
      return 'run' in prepared ? { tool, prepared } : { tool, result: prepared };
    } catch {
      return { tool, result: toolFailure('failed', 'うまく準備できなかった。', { retryable: true }) };
    }
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
