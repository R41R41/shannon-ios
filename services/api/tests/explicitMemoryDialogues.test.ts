import { describe, expect, it } from 'vitest';
import { extractExplicitMemoryProposals } from '../src/mind/sleep/sleepConsolidation.js';
import { EXPLICIT_MEMORY_DIALOGUE_CASES } from './explicitMemoryDialogueCases.js';

describe('immediate explicit-memory dialogue coverage', () => {
  for (const dialogue of EXPLICIT_MEMORY_DIALOGUE_CASES) {
    it(`${dialogue.category}: ${dialogue.id}`, () => {
      const proposals = extractExplicitMemoryProposals(dialogue.message);
      expect(proposals).toHaveLength(dialogue.expected.length);
      for (const expected of dialogue.expected) {
        expect(proposals).toEqual(expect.arrayContaining([
          expect.objectContaining({
            kind: expected.kind,
            statement: expect.stringContaining(expected.includes[0] ?? ''),
            evidence: dialogue.message.replace(/[。！？!?]+$/u, ''),
          }),
        ]));
        const matching = proposals.find(proposal => proposal.kind === expected.kind
          && expected.includes.every(fragment => proposal.statement.includes(fragment)));
        expect(matching, `missing ${expected.includes.join(' / ')} in ${JSON.stringify(proposals)}`).toBeDefined();
      }
    });
  }

  it('extracts multiple explicit memories from one natural turn', () => {
    const proposals = extractExplicitMemoryProposals(
      '好きな食べ物は寿司。大きな音が苦手。結論から話してほしい。最近SwiftUIに興味がある。',
    );
    expect(proposals.map(proposal => proposal.kind)).toEqual([
      'user-fact', 'user-fact', 'relationship', 'interest',
    ]);
  });
});

