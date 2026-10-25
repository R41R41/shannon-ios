import type { FcaExternalTools } from './fcaPorts.js';
import type { ToolResult } from '../../tools/toolRegistryPorts.js';

export interface FcaGoalCondition {
  id: string; tool: string; input: Record<string, unknown>; path: string;
  operator: 'eq' | 'gte' | 'contains' | 'exists'; expected?: string | number | boolean | null;
}
/** Only trusted request/domain code can bind predicates to the original requested success. */
export interface FcaGoalBinding { id: string; conditions: readonly FcaGoalCondition[] }
export interface FcaGoalCheck { conditionId: string; operationId: string; tool: string; passed: boolean; resultDigest: string; failure?: string }
export interface FcaGoalVerification {
  status: 'verified' | 'not_verified' | 'self_reported'; bindingId: string | null;
  checks: readonly FcaGoalCheck[]; suggestedChecks: readonly FcaGoalCheck[];
  /** Why a completion was turned back, in the owner's words, when the check knows (the mistake's line carries it; never stored). */
  reason?: string;
}
export interface FcaProgress {
  binding?: FcaGoalBinding;
  /** Fixed words when a completion needs conditions of her own that pass (`createFcaProgressTools`' `requireConditions`). */
  completionRule?: string;
  conditions: readonly FcaGoalCondition[]; verification: FcaGoalVerification | null;
  failures: readonly { operationId: string; name: string; failure: string; retryable: boolean }[];
  replans: readonly { failureOperationId: string; summary: string; nextSteps: readonly string[] }[];
}
export interface FcaProgressHooks {
  context(): FcaProgress;
  observed(operationId: string, name: string, result: ToolResult): void;
  /** Fresh observations use the same original segment and awaited gate; never repeat a write/model request. */
  verifyCompletion(request: Parameters<FcaExternalTools['execute']>[0], permit: () => Promise<void>): Promise<FcaGoalVerification>;
}
