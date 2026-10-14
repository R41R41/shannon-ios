import { describe, expect, it } from 'vitest';
import {
  CHARACTER_CORE, INNER_NOTE_REFLECTION_SCHEMA, boundaryLines, endorsedBoundaries, feelingActor, foldBoundaries, innerNoteReflectionInstructions,
  innerNoteReflectionSchema, toldBoundaryIn, toldBoundariesOpen, type FeelingEvent,
} from '../src/index.js';

/** Boundary memory (ADR-0013 D6, stage 3): basis and origin; a told boundary is hers only once she endorses it. */
const owner = { ...feelingActor({ ownerAlone: true }), identity: 'registered' as const };
const subjects = [{ subject: 'chest', word: '胸' }, { subject: 'head', word: '頭' }];
const part = (subject: string) => subjects.find(item => item.subject === subject)?.word ?? subject;
let serial = 0;
const event = (minute: number, kind: FeelingEvent['kind'], facts: FeelingEvent['facts'] = {}, sourceId: string | null = null): FeelingEvent => {
  serial += 1;
  return { ...owner, id: `e${serial}`, kind, channel: kind === 'touched' ? 'body' : 'text', sourceId, facts,
    occurredAt: new Date(Date.parse('2026-10-14T04:00:00.000Z') + minute * 60_000).toISOString() };
};

describe('a told boundary', () => {
  it('is read from words that tell her to refuse, with the part they name', () => {
    expect(toldBoundaryIn('胸は嫌だって言わないとだめだよ', subjects)).toBe('chest');
    expect(toldBoundaryIn('嫌なら断らないと', subjects)).toBe('body');
    expect(toldBoundaryIn('胸はいやだ', subjects)).toBeNull();
    expect(toldBoundaryIn('おはよう', subjects)).toBeNull();
  });

  it('stays told, and is never worded as her own decision, until she endorses it', () => {
    const told = [event(0, 'spoke', { toldBoundary: 'chest' }, 'experience:told')];
    const [boundary] = foldBoundaries(told, 'owner');
    expect(boundary).toMatchObject({ subject: 'chest', origin: 'told', endorsed: false, toldBy: 'owner', toldSource: 'experience:told' });
    expect(toldBoundariesOpen([boundary!])).toHaveLength(1);
    const line = boundaryLines([boundary!], part);
    expect(line).toContain('「嫌と言わないと」と言われて持った境界。まだボクが自分で決めたものではない');
    expect(line).not.toContain('自分で「いや」と言った');
    const endorsed = foldBoundaries([...told, event(5, 'own_boundary', { part: 'chest' }, 'experience:told')], 'owner');
    expect(endorsed[0]).toMatchObject({ origin: 'told', endorsed: true });
    expect(boundaryLines(endorsed, part)).toContain('自分のものにした境界');
    expect(toldBoundariesOpen(endorsed)).toHaveLength(0);
  });
});

describe('her own boundary', () => {
  it('comes from her own no, with how often it was crossed after', () => {
    const touches = [event(0, 'touched', { part: 'chest', stance: 'dislike' }), event(1, 'touched', { part: 'chest' }), event(2, 'touched', { part: 'chest' })];
    const [boundary] = foldBoundaries(touches, 'owner');
    expect(boundary).toMatchObject({ subject: 'chest', origin: 'self', saidNoDays: 1, crossed: 2 });
    expect(boundaryLines([boundary!], part)).toContain('胸: ボクが自分で「いや」と言った境界（一度言った、そのあとも何度か触れられた）');
  });

  it('is hers when she says no herself, even if she was told before', () => {
    const events = [event(0, 'spoke', { toldBoundary: 'chest' }), event(3, 'touched', { part: 'chest', stance: 'refuse' })];
    expect(foldBoundaries(events, 'owner')[0]).toMatchObject({ origin: 'self' });
  });

  it('has nothing without a no or a telling', () => {
    expect(foldBoundaries([event(0, 'touched', { part: 'head', stance: 'welcome' })], 'owner')).toEqual([]);
    expect(boundaryLines([], part)).toBe('');
  });
});

describe('her reflection on told boundaries', () => {
  it('is asked only when there are some: otherwise the instructions and schema of before', () => {
    expect(innerNoteReflectionSchema([])).toBe(INNER_NOTE_REFLECTION_SCHEMA);
    expect(innerNoteReflectionInstructions(CHARACTER_CORE, { toldBoundaries: false })).toBe(innerNoteReflectionInstructions(CHARACTER_CORE));
    expect(innerNoteReflectionInstructions(CHARACTER_CORE, { toldBoundaries: true })).toContain('[言われた境界]');
    const schema = innerNoteReflectionSchema(['chest']) as { required: string[]; properties: Record<string, unknown> };
    expect(schema.required).toContain('endorsed_boundaries');
    expect(schema.properties.endorsed_boundaries).toMatchObject({ items: { enum: ['chest'] } });
  });

  it('endorses only what was offered', () => {
    expect(endorsedBoundaries({ endorsed_boundaries: ['chest', 'head', 'chest'] }, ['chest'])).toEqual(['chest']);
    expect(endorsedBoundaries({}, ['chest'])).toEqual([]);
  });
});
