import { describe, expect, it } from 'vitest';
import { OWNER_AUDIENCE, UNKNOWN_GUEST_PRESENCE, groupAudience, peopleAudience } from '@shannon/cognition';
import { MIND_EVENT_KINDS, MIND_EVENT_SCHEMA, MIND_SURFACES, checkedMindEvent, mindEvent, withoutText, type MindEvent, type MindEventDraft } from '../src/index.js';

const AT = '2026-10-07T03:00:00.000Z';
const draft: MindEventDraft = {
  id: 'evt-1', kind: 'utterance', surface: 'text', audience: OWNER_AUDIENCE, presence: { ownerOnlyHears: true, othersMayHear: false },
  speaker: { kind: 'owner', verified: true, tier: null }, time: AT, salienceInputs: { ownerSpeech: true, addressed: true },
  provenance: { source: 'conversation', sourceId: 'turn-1', trust: 'owner' }, content: { text: '今日は寒いね' },
};
const built = () => mindEvent(draft) as MindEvent;

describe('mind.event.v1', () => {
  it('builds a frozen event with the schema and the defaults', () => {
    const event = built();
    expect(event).toEqual({
      schema: MIND_EVENT_SCHEMA, id: 'evt-1', kind: 'utterance', surface: 'text', body: null, audience: { kind: 'owner' },
      presence: { ownerOnlyHears: true, othersMayHear: false }, speaker: { kind: 'owner', personId: null, verified: true, tier: null }, people: [], time: AT,
      salienceInputs: { ownerSpeech: true, addressed: true }, provenance: { source: 'conversation', sourceId: 'turn-1', trust: 'owner', episodeIds: [] },
      content: { text: '今日は寒いね' },
    });
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.speaker)).toBe(true);
    expect(Object.isFrozen(event.provenance.episodeIds)).toBe(true);
    expect(MIND_EVENT_KINDS).toContain('touch');
    expect(MIND_SURFACES).toEqual(['text', 'voice', 'body', 'minecraft', 'platform', 'outreach', 'own_time']);
  });

  it('copies the surface\'s audience as it was decided, never recomputing it, and cannot be changed through the copy', () => {
    // A people audience as a surface decided it, ids unsorted: a copy keeps them as they are (normalizeAudience would sort them).
    const decided = { kind: 'people' as const, personIds: ['person-b', 'person-a'], unknownGuest: true };
    const event = mindEvent({ ...draft, audience: decided, presence: { ownerOnlyHears: false, othersMayHear: true } }) as MindEvent;
    expect(event.audience).toEqual(decided);
    expect(event.audience).not.toBe(decided);
    decided.personIds.push('person-c');
    expect(event.audience).toEqual({ kind: 'people', personIds: ['person-b', 'person-a'], unknownGuest: true });
    for (const audience of [OWNER_AUDIENCE, UNKNOWN_GUEST_PRESENCE, peopleAudience(['p1']), groupAudience('discord:111:222')]) {
      expect((mindEvent({ ...draft, audience, presence: { ownerOnlyHears: false, othersMayHear: true } }) as MindEvent).audience).toEqual(audience);
    }
  });

  it('restores an inbox row through the audience normalizer, and survives JSON', () => {
    const row = JSON.parse(JSON.stringify(built()));
    expect(checkedMindEvent(row)).toEqual(built());
    const garbled = { ...row, audience: { kind: 'people', personIds: ['b', 'a', 'a'] } };
    expect((checkedMindEvent(garbled) as MindEvent).audience).toEqual({ kind: 'people', personIds: ['a', 'b'] });
  });

  it('refuses what is not closed', () => {
    const event = JSON.parse(JSON.stringify(built())) as Record<string, unknown>;
    const refused: Array<[string, Record<string, unknown>]> = [
      ['words is not allowed', { ...event, words: 'x' }],
      ['schema must be', { ...event, schema: 'mind.event.v2' }],
      ['id is invalid', { ...event, id: 'なでた' }],
      ['id is invalid', { ...event, id: 'x'.repeat(81) }],
      ['kind is invalid', { ...event, kind: 'command' }],
      ['surface is invalid', { ...event, surface: 'email' }],
      ['body is invalid', { ...event, body: '' }],
      ['time is invalid', { ...event, time: 'now' }],
      ['audience is invalid', { ...event, audience: { kind: 'everyone' } }],
      ['presence must be', { ...event, presence: { ownerOnlyHears: true } }],
      ['presence cannot be the owner alone', { ...event, presence: { ownerOnlyHears: true, othersMayHear: true } }],
      ['speaker.kind is invalid', { ...event, speaker: { kind: 'admin', personId: null, verified: false, tier: null } }],
      ['speaker.tier must be', { ...event, speaker: { kind: 'person', personId: 'p1', verified: false, tier: 5 } }],
      ['a speaker named by tier 3 or 4 is not verified', { ...event, speaker: { kind: 'person', personId: 'p1', verified: true, tier: 3 } }],
      ['a speaker named by tier 3 or 4 is not verified', { ...event, speaker: { kind: 'person', personId: 'p1', verified: true, tier: 4 } }],
      ['people is invalid', { ...event, people: Array.from({ length: 13 }, (_, index) => `p${index}`) }],
      ['salienceInputs.loud is not allowed', { ...event, salienceInputs: { loud: true } }],
      ['salienceInputs.ownerSpeech must be a boolean', { ...event, salienceInputs: { ownerSpeech: 1 } }],
      ['salienceInputs.touch must be', { ...event, salienceInputs: { touch: 'hug' } }],
      ['salienceInputs.novelty must be in', { ...event, salienceInputs: { novelty: 1.5 } }],
      ['salienceInputs.predictionError must be', { ...event, salienceInputs: { predictionError: { delta: 1 } } }],
      ['provenance.trust is invalid', { ...event, provenance: { source: 'web', sourceId: 'page-1', trust: 'trusted', episodeIds: [] } }],
      ['provenance.source is invalid', { ...event, provenance: { source: '出どころ', sourceId: 'page-1', trust: 'untrusted', episodeIds: [] } }],
      ['provenance.episodeIds is invalid', { ...event, provenance: { source: 'web', sourceId: 'page-1', trust: 'untrusted', episodeIds: ['a b'] } }],
      ['content must be', { ...event, content: { text: 'x', ref: 'y' } }],
      ['content is invalid', { ...event, content: { text: 'x'.repeat(4_001) } }],
      ['content is invalid', { ...event, content: { ref: 'a ref with spaces' } }],
    ];
    for (const [reason, value] of refused) expect(checkedMindEvent(value), reason).toContain(reason);
    expect(checkedMindEvent(null)).toBe('event must be an object');
    expect(checkedMindEvent([])).toBe('event must be an object');
  });

  it('takes the text out for the journal, the inbox and a snapshot, and keeps a reference', () => {
    expect(withoutText(built()).content).toBeNull();
    expect(JSON.stringify(withoutText(built()))).not.toContain('今日は寒いね');
    const referenced = mindEvent({ ...draft, content: { ref: 'message:turn-1' } }) as MindEvent;
    expect(withoutText(referenced)).toBe(referenced);
  });
});
