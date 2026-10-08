import type { ObserverBatch, ObserverEvent, ObserverJson } from '../../../contracts/observerContract.js';

export type ObservationState = 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown' | 'unobserved';
export type ConnectionState = 'disconnected' | 'connecting' | 'live' | 'held' | 'paused' | 'lost';
export interface ObservedSpan {
  id: string; runId: string; node: string; parentSpanId: string | null; startedAt: string | null; endedAt: string | null;
  state: ObservationState; firstSequence: number; lastSequence: number; elapsedMs?: number;
  model?: string; input?: ObserverJson; output?: ObserverJson; origin?: 'server' | 'client'; isRunRoot?: boolean; linked?: boolean;
}
export interface ObservedRun {
  id: string; spans: Map<string, ObservedSpan>; events: ObserverEvent[]; startedAt: string | null;
  endedAt: string | null; firstSequence: number; lastSequence: number; incomplete: boolean;
  state: 'running' | 'completed' | 'failed' | 'unknown'; rootSpanId?: string; linkedCount?: number;
}
export interface ObserverState {
  instanceId: string | null; cursor: number; events: ObserverEvent[]; runs: Map<string, ObservedRun>;
  selectedRunId: string | null; availability: 'disconnected' | 'ready' | 'held'; transport: ConnectionState;
  notice: string; generatedAt: string | null; dropped: number;
}
export const MAX_EVENTS: number;
export function createObserverState(): ObserverState;
export function validEnvelope(value: unknown): value is ObserverBatch;
export function reduceObserverEnvelope(previous: ObserverState, envelope: ObserverBatch, followLatest?: boolean): ObserverState;
export function spanState(span?: ObservedSpan, run?: ObservedRun, transport?: ConnectionState): ObservationState;
export function nodeState(run: ObservedRun | undefined, node: string, transport?: ConnectionState): { spans: ObservedSpan[]; latest?: ObservedSpan; activeCount: number; state: ObservationState };
export function linkedRunView(state: ObserverState, runId: string | null): ObservedRun | undefined;
export function runToolEvidence(run?: ObservedRun): { offered: Set<string>; chosen: Set<string>; called: Set<string>; schemas: Map<string, ObserverJson> };
export function observerBasePath(pathname: string): string;
export interface ObserverRequest {
  method?: string; headers?: Record<string, string>; body?: string; cache: string; credentials: string;
  redirect: string; signal: AbortSignal;
}
export interface ObserverClientOptions {
  fetch(url: string, init: ObserverRequest): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  basePath?: string;
  getCursor?(): number;
  onEnvelope(envelope: ObserverBatch, delivery?: { liveReceipts: boolean }): void;
  onCredential?(credential: { token: string; expiresAt: string | null } | null): void;
  onCatalog?(catalog: unknown): void;
  onConnection?(state: ConnectionState): void;
  onReset?(reason: string): void;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}
export function createObserverClient(options: ObserverClientOptions): {
  connect(token: string, expiresAt?: string | null): void; pair(code: string): Promise<void>; disconnect(reason?: string): void;
  pause(): void; resume(): void;
};

export function createObserverSession(getStorage: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, key: string, now?: () => number): {
  read(): { token: string; expiresAt: string | null } | null;
  write(credential: { token: string; expiresAt: string | null } | null): boolean;
  clear(): void;
};
export function createReceiptGate(): { accept(envelope: ObserverBatch): boolean; reset(): void };
