import { describe, expect, it } from 'vitest';
import { createFcaProgressTools } from '../src/mind/action/fca/fcaProgressTools.js';
import type { FcaToolDefinition } from '../src/mind/action/fca/fcaPorts.js';
import { toolOk } from '../src/mind/tools/toolRegistryPorts.js';
const definition: FcaToolDefinition = { name: 'read', description: 'read', effect: 'read', cost: 'none', domain: 'task_runtime',
  input: { type: 'object', properties: {}, required: [], additionalProperties: false }, audiences: ['owner_alone'], surfaces: ['text'] };
const call = () => ({ name: 'goal.verify', input: {}, scopeKey: 'owner', taskId: 'task', operationId: 'verify', signal: new AbortController().signal });
const binding = { id: 'original', conditions: [{ id: 'value', tool: 'read', input: {}, path: 'verified', operator: 'eq' as const, expected: true }] };
describe('domain-owned verification interruption', () => {
  it('cannot certify a read that was interrupted during its awaited result', async () => {
    const child = new AbortController();
    const tools = createFcaProgressTools({ definitions: [definition], async execute(request) {
      expect(request.signal).toBe(child.signal); child.abort(); return toolOk('{"verified":true}');
    } }, { binding, permit: async () => {}, observationSignal: () => child.signal });
    expect(await tools.progress.verifyCompletion(call(), async () => {})).toMatchObject({ status: 'not_verified', checks: [{ passed: false, failure: 'observation_interrupted' }] });
  });
  it('never converts unknown outside outcomes into ordinary verification interruptions', async () => {
    const child = new AbortController();
    const tools = createFcaProgressTools({ definitions: [definition], async execute() { child.abort(); throw Error('FCA_BODY_OUTCOME_UNKNOWN'); } }, {
      binding, permit: async () => {}, observationSignal: () => child.signal,
    });
    await expect(tools.progress.verifyCompletion(call(), async () => {})).rejects.toThrow('FCA_BODY_OUTCOME_UNKNOWN');
    expect(tools.progress.context().verification).toBeNull();
  });
});
