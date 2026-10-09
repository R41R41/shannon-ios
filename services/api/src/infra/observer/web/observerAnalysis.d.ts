import type { ObservedSpan, ObservedRun, ObserverState } from './observer.d.ts';
export function spanKey(span: ObservedSpan): string;
export type ObservedTaskPhase = 'ready' | 'executing' | 'waiting' | 'stopping' | 'unknown' | 'stopped' | 'completed' | 'failed';
export interface ObservedTask { id: string; parentId: string | null; parentConflict: boolean; spans: ObservedSpan[]; runIds: Set<string>; stepIds: Set<string>; lastSequence: number; phase: ObservedTaskPhase | null; phaseRevision: number | null; phaseSequence: number; depth: number; orphan: boolean; cycle: boolean; }
export function observedTasks(state: ObserverState): ObservedTask[];
export function taskRunView(state: ObserverState, taskId: string, stepId?: string | null): ObservedRun;
export interface TimingSummary { total: number; n: number; median: number | null; p95: number | null; running: number; failed: number; unmeasured: number; unknown: number; cache: { readTokens: number; writeTokens: number; readN: number; writeN: number; providerN: number }; }
export function timingSummary(spans: Iterable<ObservedSpan>): TimingSummary;
export function timingGroups(spans: Iterable<ObservedSpan>): (TimingSummary & { node: string; model: string | null; origin: string; spans: ObservedSpan[] })[];
export function timelineRows(spans: Iterable<ObservedSpan>): { span: ObservedSpan; offsetMs: number | null; durationMs: number | null; provenance: 'observed' | 'unmeasured' | 'open' }[];
export function createElapsedClock(): { clear(): void; observe(spans: Iterable<ObservedSpan>, now: number): void; elapsed(span: ObservedSpan | undefined, now: number): number | null };

export interface MilestoneSummary { n: number; median: number | null; p95: number | null; }
export function streamTimingSummary(spans: Iterable<ObservedSpan>): { completedRequests: number; firstVisible: MilestoneSummary; finalUsage: MilestoneSummary };
