import type { AetherAccess } from './aetherAccess.js';
import type { OthersTextCheck } from './aetherShownText.js';
import type { AutonomousActionRequest } from './autonomyPolicy.js';
import type { SecretCheck } from './conversationSecrets.js';
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
  /** In a conversation: the owner's message this turn answers (thread and words), the same for a retry of it. */
  readonly turnKey?: string;
}

export function toolSessionMemory(turnKey?: string): ToolSessionMemory {
  return { readDigests: new Map(), ...(turnKey ? { turnKey } : {}) };
}

export interface ToolExecutionContext extends ToolCallContext {
  memory: ToolSessionMemory;
  /**
   * In a conversation: the check against what the owner asked to keep secret or to forget (`conversationSecrets.ts`).
   * A write that repeats it is refused; `null` means his memory could not be read just now, and that write is refused
   * (the next may pass). Absent in her own time, whose plan already drops such inputs.
   */
  secrets?: SecretCheck | null;
  /** In a conversation: the time this call may take, from the turn's deadline. A folder operation waits no longer. */
  timeMilliseconds?: number;
  /** In a conversation: the Talk the call was made in (a request to her Minecraft body remembers where it was asked). */
  threadId?: string;
  /** Aether as this call may reach it, set by the runner from the gate (`gatedAether`); absent while Aether is not configured. */
  aether?: AetherAccess;
  /**
   * In a conversation with anyone else present: what of the owner's must not reach the model from what she reads of Aether
   * (`aetherShownText.ts`, applied by the gate's `shownAetherCall`); `null` when it could not be read, and nothing read is
   * then given. Absent with the owner alone and in her own time.
   */
  othersText?: OthersTextCheck | null;
}

export type ToolExecutor = (input: ToolInput, context: ToolExecutionContext) => PreparedToolCall | ToolResult;

export function clip(value: string, maximum: number): string {
  const line = value.replace(/\s+/gu, ' ').trim();
  return line.length > maximum ? `${line.slice(0, maximum - 1)}…` : line;
}

/** A file cannot close the frame around it, or open a section of her prompt: the markers inside it lose their shape. */
export function neutralMarkers(text: string): string {
  return text.replace(/-{3}(?=\s*ここ(?:から|まで))/gu, '－－－').replace(/\[(?=道具の結果|ボクの道具|ボクの|ひとりの時間)/gu, '［');
}
