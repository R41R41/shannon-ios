import type { ToolExecutionEvidence } from '../../contracts/toolEvidenceContract.js';
import type { ToolResult } from './shannonTools.js';

/** Only an executor that has observed the native result may add this projection. */
export function withToolEvidence(result: ToolResult, evidence: ToolExecutionEvidence): ToolResult {
  return Object.freeze({ ...result, evidence: Object.freeze({ ...evidence, target: Object.freeze({ ...evidence.target }),
    ...(evidence.labels ? { labels: Object.freeze([...evidence.labels]) } : {}) }) });
}
