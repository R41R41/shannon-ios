import type { ValueRead } from '@shannon/learning';
/** ADR-0008 stage 5: owner reactions. IDs, closed values and revisions only; no tool traces or reply text in a response. */
export type FeedbackReaction = 'good' | 'bad' | null;
export interface FeedbackState {
  targetId: string;
  threadId: string;
  turnId: string;
  revision: number;
  reaction: FeedbackReaction;
  operationId: string | null;
}
export interface FeedbackChoiceLink { choiceId: string; tool: string; ok: boolean; }
export interface FeedbackTurnDraft {
  recordId: string; threadId: string; replyDigest: string; surface: 'text' | 'voice';
  ownerAlone: boolean; usable: boolean; choices: readonly FeedbackChoiceLink[]; at: string;
}
export interface FeedbackSource {
  kind?:'turn'|'task-note';
  status: 'visible' | 'forgotten' | 'deleted' | 'hidden';
  /** Digest of the exact stored assistant reply, never its text. */
  replyDigest: string;
  ownerAlone: boolean;
}
export interface FeedbackTaskProof {
  taskId: string; threadId: string; attemptId: string; status: 'verified'; evidenceIds: readonly string[];
}
export type FeedbackTaskProofStatus={status:'verified';proof:FeedbackTaskProof}|{status:'invalid'}|{status:'unknown'};
export interface FeedbackTaskDispatch {
  taskId:string; attemptId:string; at:string; presence:'alone'|'others'|'away'|'unknown';
  /** Frozen by the canonical dispatch read port, never by a model/Host or a later callback. Present-null is unusable. */
  expectation?:{presence:'alone'|'others'|'away'|'unknown';value:ValueRead|null};
}
export interface FeedbackEvidenceSnapshot {
  seq: number;
  policy: string;
  reactions: ReadonlyMap<string, Exclude<FeedbackReaction, null>>;
}
export interface FeedbackEvidenceReader { snapshot(scopeKey: string): FeedbackEvidenceSnapshot; }
export interface FeedbackPorts {
  captureTurn(scopeKey: string, draft: FeedbackTurnDraft): void;
  bindTurn(scopeKey: string, binding: { recordId: string; threadId: string; turnId: string; reply: string }): FeedbackState | null;
  bindTaskReply(scopeKey: string, binding: { taskId: string; threadId: string; messageId: string; reply: string }): FeedbackState | null;
  taskDispatched(scopeKey:string,dispatch:FeedbackTaskDispatch):void;
  taskVerified(scopeKey:string,taskId:string,attemptId:string,at:string,costYen:number):void;
  taskUnusable(scopeKey:string,taskId:string,attemptId:string,at:string):void;
  project(scopeKey: string, threadId: string, turnId: string): FeedbackState | null;
}
