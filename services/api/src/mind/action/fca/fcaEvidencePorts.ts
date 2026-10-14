import type { FcaAffectSnapshot } from '../../emotion/emotionPorts.js';
import type { FcaActionExpectation, FcaExpectationComparison } from '../../prediction/predictionPorts.js';
import type { TaskSource, TaskStep } from '../taskRuntime/taskRuntimePorts.js';
import type { FcaModelOutput, FcaToolCall } from './fcaPorts.js';
import type { ToolResult } from '../../tools/toolRegistryPorts.js';
export type { FcaActionExpectation } from '../../prediction/predictionPorts.js';

export interface FcaAffectAppraisal { eventId: string; revision: number; value: number; cause: string; target: string }
export interface FcaOutcomeContext {
  eventId: string; taskId: string; operationId: string; name: string; observation: 'observed' | 'unknown';
  result: { ok: boolean; text: string } | null;
  expectation: FcaActionExpectation | null; comparison: FcaExpectationComparison | null; appraisalRevision: number;
}
export interface FcaSharedContext { affect: FcaAffectSnapshot; recentOutcomes: readonly FcaOutcomeContext[] }
export interface FcaAuxiliaryResult { id: string; text: string; ok: boolean }
export interface FcaDurableOutcome {
  scopeKey: string; taskId: string; stepId: string; outcomeId: string; goal: string;
  action: FcaToolCall; expectation: FcaActionExpectation | null; comparison: FcaExpectationComparison | null;
  observation: 'observed' | 'unknown'; result: { ok: boolean; text: string } | null;
  observedAt: string; sources: readonly TaskSource[];
  /** Lifecycle outcomes use this committed status, never the requested completion or transport ok flag. */
  actualTaskStatus?: string;
  /** The body actions this outcome closes a segment of (`fcaEvidenceSegments.ts`): one episode for all of them. */
  segment?: FcaSegment;
}
export type FcaSegmentNotable = 'failure' | 'unknown' | 'mismatch' | 'danger' | 'first_time';
/** One body action of a segment, as closed values: its name, whether it worked, and why it was notable. */
export interface FcaSegmentAction { name: string; ok: boolean | null; notable?: FcaSegmentNotable }
/**
 * The body actions a segment's episode covers, oldest first, their evidence rows (`eventIds`, the same order), and what closed it:
 * an outcome's name, `task_<status>` for a paused or ended task, or `segment_stale` after a quiet time (`fcaEvidenceSegments.ts`).
 */
export interface FcaSegment { actions: readonly FcaSegmentAction[]; eventIds: readonly string[]; closedBy: string }
export interface FcaEvidence {
  /** Asynchronous only between its row checks (`fcaEvidenceRows.ts`). */
  prepare(step: TaskStep): Promise<FcaSharedContext>;
  beforeActions(step: TaskStep, output: FcaModelOutput): boolean;
  observed(step: TaskStep, call: FcaToolCall, result: ToolResult): void;
  unknown(step: TaskStep, call: FcaToolCall): void;
  committed(step: TaskStep): void;
  flush(): void;
}
