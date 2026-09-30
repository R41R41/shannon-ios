import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { needsSemanticMemoryRecall } from '../src/index.js';

const fixture = JSON.parse(readFileSync(new URL('../../../config/memory-recall-cues.json', import.meta.url), 'utf8')) as {
  cases: Array<{ text: string; memoryTurn: boolean }>;
};

describe('text memory-turn classifier', () => {
  it.each(fixture.cases)('classifies "$text" as memoryTurn=$memoryTurn (shared with Swift)', ({ text, memoryTurn }) => {
    expect(needsSemanticMemoryRecall(text)).toBe(memoryTurn);
  });
});
