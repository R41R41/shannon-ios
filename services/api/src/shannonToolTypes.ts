import type { AutonomousActionRequest } from './autonomyPolicy.js';
import type { ToolCallContext } from './shannonToolGate.js';
import type { ToolInput } from './shannonToolInput.js';
import type { ToolResult } from './shannonTools.js';

/**
 * What an executor of the registry is: it prepares one call (what she is about to do, in one sentence for the gate
 * and the record, and for her folder the paths the gate judges), then runs it. A write to her study is returned
 * as `apply`, so the runner (conversation) or the loop's reporting transaction (her own time) commits it together
 * with its activity-record entry.
 */
export interface ToolRun {
  result: ToolResult;
  /** For the activity record: one sentence with no file contents, no text of hers, and no title of a story she has not shown. */
  record: { summary: string; outcome: 'done' | 'failed'; reasonCode?: string; link?: string };
  /** The write itself. Throws to fail; may return a line added to the result (such as a new id). */
  apply?: () => string | void;
  /** The call was already written to the activity record where it closed (a folder operation from a conversation). */
  recordedElsewhere?: true;
}

export interface PreparedToolCall {
  summary: string;
  folder?: Pick<AutonomousActionRequest, 'host' | 'relativePath' | 'pathKind' | 'toRelativePath'>;
  run(signal?: AbortSignal): Promise<ToolRun>;
}

/** What one conversation turn or one session of her own time remembers between its calls. */
export interface ToolSessionMemory {
  /** The digest of each folder file she read in this session, so that `folder.update` refuses to overwrite a change made since. */
  readonly readDigests: Map<string, string>;
}

export function toolSessionMemory(): ToolSessionMemory {
  return { readDigests: new Map() };
}

export interface ToolExecutionContext extends ToolCallContext {
  memory: ToolSessionMemory;
}

export type ToolExecutor = (input: ToolInput, context: ToolExecutionContext) => PreparedToolCall | ToolResult;

export function clip(value: string, maximum: number): string {
  const line = value.replace(/\s+/gu, ' ').trim();
  return line.length > maximum ? `${line.slice(0, maximum - 1)}…` : line;
}
