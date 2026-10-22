import { describe, expect, it, vi } from 'vitest';
import { createAnthropicFcaModel } from '../src/infra/models/anthropic/anthropicFcaModel.js';
import { inActionExecution, type ActionExecution } from '../src/infra/context/actionExecution.js';
import type { FcaModelInput } from '../src/mind/action/fca/fcaPorts.js';
import { message, scriptedAnthropic } from './support/anthropicFixtures.js';

vi.mock('../src/infra/models/anthropic/anthropicFcaMetrics.js', async importOriginal => ({ ...await importOriginal<object>(),
  decisionRequestMetrics: () => { throw new Error('metrics helper failed'); } }));

describe('measurement never fails a decision', () => {
  it('returns the decision when the request-metrics helper throws after the response was billed', async () => {
    const usage = { input_tokens: 12, output_tokens: 30, cache_creation_input_tokens: 700, cache_read_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 700 } };
    const fixture = scriptedAnthropic([message([{ type: 'tool_use', name: 'fca_wait', id: 'wait-1', input: { summary: 'Waiting for evidence' } }], 'tool_use',
      { model: 'claude-haiku-5-5', usage })]);
    const receipts: unknown[] = [];
    const model = createAnthropicFcaModel({ apiKey: 'synthetic-fca-key', fetcher: fixture.fetcher, recordUsage: value => { receipts.push(value); } });
    const input: FcaModelInput = { task: { id: 'task-1', title: 'Task', goal: 'Goal', completionCriteria: 'Done' }, messages: [], tools: [], history: [] };
    const execution = { signal: new AbortController().signal } as unknown as ActionExecution;
    const output = await inActionExecution(execution, () => model.decide(input, new AbortController().signal));
    expect(output.decision).toEqual({ kind: 'wait', summary: 'Waiting for evidence' });
    expect(receipts).toHaveLength(1);
    expect(execution.modelMetrics).toBeUndefined();
    expect(execution.modelOutcome).toBe('acknowledged');
  });
});
