import { describe, expect, it } from 'vitest';
import { parseCodexModelCatalog } from '../src/integrations/agentHost/codexModelCatalog.js';

describe('Codex model catalog', () => {
  it('normalizes App Server models and reasoning effort descriptors', () => {
    expect(parseCodexModelCatalog({ data: [{
      id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', description: 'Everyday agent work',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low' }, { effort: 'high' }, { effort: 'unsupported' },
      ],
      defaultReasoningEffort: 'high',
    }] })).toEqual([{
      id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', description: 'Everyday agent work',
      supportedReasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high',
    }]);
  });

  it('ignores malformed entries without losing valid models', () => {
    expect(parseCodexModelCatalog({ models: [null, { name: 'missing id' }, {
      model: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', reasoningEfforts: ['medium', 'xhigh', 'max', 'ultra'],
    }] })).toEqual([{
      id: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna',
      supportedReasoningEfforts: ['medium', 'xhigh', 'max', 'ultra'],
    }]);
  });
});
