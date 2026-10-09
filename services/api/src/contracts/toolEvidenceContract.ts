/** A projection of an executor's original outcome, never a second receipt authority or a persisted result. */
export interface ToolExecutionEvidence {
  outcome: 'queued' | 'applied' | 'failed' | 'unknown';
  action: string;
  target: { kind: 'minecraft_request' | 'minecraft_server' | 'folder' | 'aether_document' | 'aether_proposal'; id?: string };
  /** Identifiers already issued by the canonical executor. Never manufacture a success receipt. */
  operationId?: string;
  receiptId?: string;
  revision?: number;
  /** Authorized input labels, used only within this turn for exact quoted-target matching. No body or goal text. */
  labels?: readonly string[];
}
