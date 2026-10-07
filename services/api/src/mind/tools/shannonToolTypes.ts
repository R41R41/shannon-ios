import type { AetherAccess } from '../../integrations/aether/aetherAccess.js';
import type { OthersTextCheck } from '../inhibition/disclosurePorts.js';
import type { AutonomousActionRequest } from '../inhibition/inhibitionPorts.js';
import type { SecretCheck } from '../inhibition/disclosurePorts.js';
import type { ToolCallContext } from '../inhibition/inhibitionPorts.js';
import type { ToolInput } from './shannonToolInput.js';
import type { ToolResult } from './shannonTools.js';

/**
 * What an executor of the registry is: it prepares one call (what she is about to do, in one sentence for the gate
 * and the record, and for her folder the paths the gate judges), then runs it. A write to her study is returned
 * as `apply`, so the runner (conversation) or the loop's reporting transaction (her own time) commits it together
 * with its activity-record entry.
 */
export interface ToolRun {
  /** Closed outside outcome; false holds the original action rather than reporting a failed new attempt. */
  acknowledged?: boolean;
  result: ToolResult;
  /** For the activity record: one sentence with no file contents, no text of hers, and no title of a story she has not shown. */
  record: { summary: string; outcome: 'done' | 'failed'; reasonCode?: string; link?: string };
  /** The write itself. Throws to fail; may return a line added to the result (such as a new id). */
  apply?: () => string | void;
  /** The call was already written to the activity record where it closed (a folder operation from a conversation). */
  recordedElsewhere?: true;
  /** For the provenance mark of her own time (`autonomyLoopProvenance.ts`). A write's ids are added by `apply`. */
  documents?: ToolDocuments;
}

/**
 * What a call or a step read and wrote, by id (an Aether document id, `shannon-study://<piece id>`, `autonomy-reading://<id>`),
 * and whether it read something of the owner's (`informs`). Never text.
 */
export interface ToolDocuments {
  informs?: true;
  read?: readonly string[];
  wrote?: readonly string[];
}

export interface PreparedToolCall {
  summary: string;
  paths?: readonly string[];
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
   * (`aetherShownText.ts`, applied by the gate's `shownAetherCall`); `null` or absent there: it could not be read, and
   * nothing read is given. Not used with the owner alone or in her own time.
   */
  othersText?: OthersTextCheck | null;
  /**
   * In her own time: marks what a write just put in Aether when her session is marked (`autonomyLoopProvenance.ts`), the moment
   * Aether answers, so a write whose report later fails is still marked. Absent in a conversation.
   */
  informedWrite?: (documentIds: readonly string[]) => void;
  /**
   * In her own time, in a session that is not marked: a document (Aether id or `shannon-study://<piece>`) that a listing leaves
   * out, so that listing her things does not mark the session (option (a), ADR-0007). Absent everywhere else.
   */
  unlisted?: (documentId: string) => boolean;
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
