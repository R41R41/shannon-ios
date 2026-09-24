import { describe, expect, it } from 'vitest';
import { buildIntentPrompt, selectPrimaryIntent, type ShannonCognitiveFrame, type ShannonIntent } from '../src/index.js';

const at = '2026-09-25T03:00:00.000Z';
function intent(overrides: Partial<ShannonIntent> = {}): ShannonIntent {
  return {
    id: 'intent-1', title: 'シャノンの人格を育てる', desiredOutcome: 'シャノンを一貫した人格として感じられるように改善したい',
    status: 'active', source: 'explicit-user-goal', threadId: 'thread-a', priority: 0.8, confidence: 0.95,
    createdAt: at, updatedAt: at, ...overrides,
  };
}

describe('Shannon intention frame', () => {
  it('prefers the current thread and excludes inactive objectives', () => {
    const selected = selectPrimaryIntent('その方針で続けて', 'thread-a', [
      intent({ id: 'paused', status: 'paused' }),
      intent(),
      intent({ id: 'other', threadId: 'thread-b', title: '旅行を計画する', desiredOutcome: '浜松旅行を計画したい' }),
    ], at);
    expect(selected?.id).toBe('intent-1');
  });

  it('projects an evidence boundary without exposing hidden reasoning', () => {
    const frame: ShannonCognitiveFrame = {
      situation: { occurredAt: at, channel: 'text' }, primaryIntent: intent(),
      supportingIntentIDs: [], recalledMemoryIDs: [], responseMode: 'propose-action',
    };
    const prompt = buildIntentPrompt(frame);
    expect(prompt).toContain('Primary objective: シャノンの人格を育てる');
    expect(prompt).toContain('Only a verified action receipt');
    expect(prompt).not.toContain('chain of thought');
  });
});
