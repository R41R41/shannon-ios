/** Owner-only, short-lived execution observation. Never a cognition ledger or action command. */
export const OBSERVER_SCHEMA_VERSION = 1 as const;
export const OBSERVER_NODES = ['turn','pcm','stt','join','perception','jevv','jevt','recall','workspace','context','native','llm','store','gate','tools','decode','autonomy','memory','plan','sentences','sleep','embedding','tts','play','minecraft','agentHost','taskHub','queue','fca','compact','wait','emotion','prediction','reflex','reflexJev','reflexDecision','bodyObserve','bodyControl'] as const;
export type ObserverNodeId = typeof OBSERVER_NODES[number];
export type ObserverJson = null | boolean | number | string | ObserverJson[] | { [key: string]: ObserverJson };
export type ObserverKind = 'run.started' | 'run.completed' | 'span.started' | 'span.completed' | 'span.failed' | 'span.cancelled' | 'handoff';
export interface ObserverTaskLink { taskId?: string; parentTaskId?: string | null; stepId?: string; actionId?: string }
export interface ObserverEvent extends ObserverTaskLink {
  sequence: number; runId: string; spanId: string; parentSpanId: string | null;
  node: ObserverNodeId; kind: ObserverKind; at: string; elapsedMs?: number; model?: string;
  input?: ObserverJson; output?: ObserverJson; fromNode?: ObserverNodeId; toNode?: ObserverNodeId;
  sourceSpanId?: string | null;
  origin?: 'server' | 'client';
}
export type ObserverDraft = Omit<ObserverEvent,'sequence'> & { scopeKey: string };
export interface ObserverBatch {
  schemaVersion: 1; instanceId: string; events: ObserverEvent[]; cursor: number;
  oldestCursor: number; gap: boolean; availability: 'ready' | 'held'; generatedAt: string;
  dropped?: number;
}
