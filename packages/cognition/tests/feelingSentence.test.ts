import { describe, expect, it } from 'vitest';
import {
  CHARACTER_CORE, FEELING_SENTENCE_HEADER, characterCoreBlock, createCoreAffect, feelingActor, feelingSentenceBlock, feelingSentenceInput,
  feelingSentenceInstructions, feelingSentenceReason, foldFeelingDynamics, parsedFeelingSentence, type FeelingEvent,
} from '../src/index.js';

/** Her feeling sentence (ADR-0013 D7, stage 2 item 3): written only in a strong scene, from closed facts in words, read as her feeling. */
const owner = { ...feelingActor({ ownerAlone: true }), identity: 'registered' as const };
const T0 = Date.UTC(2026, 9, 14, 4, 0, 0);
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const chest = (minutes: number, stance?: string): FeelingEvent => ({ ...owner, id: `c${minutes}`, kind: 'touched', channel: 'body', sourceId: null,
  facts: { touchKind: 'poke', part: 'chest', ...(stance ? { stance } : {}) }, occurredAt: at(minutes) });

describe('when she writes it', () => {
  it('not when she is settled, nor after one welcome touch long ago', () => {
    expect(feelingSentenceReason(createCoreAffect(), T0)).toBeNull();
    const { core } = foldFeelingDynamics([chest(0, 'welcome')], owner);
    expect(feelingSentenceReason(core, T0 + 3 * 60 * 60_000)).toBeNull();
  });

  it('when the touches go on after her no: blame built up (or her feeling past its band)', () => {
    const { core } = foldFeelingDynamics([chest(0), chest(1, 'dislike'), chest(2), chest(3), chest(4)], owner);
    expect(feelingSentenceReason(core, T0 + 5 * 60_000)).not.toBeNull();
  });
});

describe('what it is written from, and how it is read', () => {
  it('fixed instructions with her character core; the facts in words, never the numbers', () => {
    expect(feelingSentenceInstructions()).toContain(characterCoreBlock(CHARACTER_CORE));
    expect(feelingSentenceInstructions()).toBe(feelingSentenceInstructions());
    const { core } = foldFeelingDynamics([chest(0), chest(1, 'dislike'), chest(2), chest(3)], owner);
    const input = feelingSentenceInput({ core, ledgerLine: '', turn: { kind: 'spoke', tags: ['insult'] } });
    expect(input).toContain('悪口');
    expect(input.replace('2〜3行', '')).not.toMatch(/\d/u);
  });

  it('keeps at most three non-empty lines, clipped; nothing usable is null', () => {
    expect(parsedFeelingSentence({ lines: ['  むかつく。 ', '', 'でも、ちょっと気になる。', 'もう知らない。', '四行目'] }))
      .toEqual(['むかつく。', 'でも、ちょっと気になる。', 'もう知らない。']);
    expect(parsedFeelingSentence({ lines: ['あ'.repeat(200)] })![0]).toHaveLength(80);
    expect(parsedFeelingSentence({ lines: [] })).toBeNull();
    expect(parsedFeelingSentence('むかつく')).toBeNull();
  });

  it('stands as her feeling, not as lines to say', () => {
    expect(feelingSentenceBlock(['むかつく。', 'でも気になる。'])).toBe(`${FEELING_SENTENCE_HEADER}\n- むかつく。\n- でも気になる。`);
    expect(FEELING_SENTENCE_HEADER).toContain('そのまま返事に書かない');
  });
});
