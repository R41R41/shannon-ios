import { afterEach, describe, expect, it } from 'vitest';
import { OWNER_AUDIENCE, peopleAudience } from '@shannon/cognition';
import { memoryWorld } from './support/memoryWorld.js';
import { createTaskMemory } from '../src/mind/memory/taskMemory.js';
import { ShannonMemoryService } from '../src/mind/memory/memoryService.js';
import { SQLitePeopleMemoryStore } from '../src/mind/memory/store/peopleMemoryStore.js';
import { OWNER_PERSON_KEY, impressionMemoryId, type PersonImpression } from '../src/mind/memory/impressions.js';
import { ownerImpressionReader } from '../src/mind/recall/impressionRecall.js';

/**
 * A turn that recalled an impression of a person (`impression:<id>`, `turnCognitiveContext.ts`). From 2026-10-01 no read of her memory
 * knew those ids, so such a turn, and every turn that recalled it, was hidden from memory reads and from the check of a request's
 * source (45 turns in production by 2026-10-20). Now it is visible while the owner alone may be shown that impression, and only then.
 */
const worlds: Array<{ close(): void }> = [];
afterEach(() => worlds.splice(0).forEach(world => world.close()));

function fixture(environment: Record<string, string> = {}) {
  const w = memoryWorld(); worlds.push(w);
  const people = new SQLitePeopleMemoryStore(w.path);
  worlds.push({ close: () => people.close?.() });
  const impressions = w.store.impressionStore();
  const memory = (env = environment) => createTaskMemory({ state: w.store, conversations: w.store, ownerScope: 'owner', ownerAlone: () => true,
    now: w.now, environment: env });
  const evidence = w.store.appendTurn('owner', 'thread', 'シャノンは可愛いね', 'えへへ', w.now());
  const impression = (id: string, extra: Partial<PersonImpression> = {}): PersonImpression => ({
    id, personKey: OWNER_PERSON_KEY, kind: 'speech_habit', pattern: 'ボクのことをよく「可愛い」と言う', keyTerms: ['可愛い'], herFeeling: 'うれしい',
    feelingTag: 'happy', feelingHistory: [], supportCount: 3, contraCount: 0, contraStreak: 0, supportDays: 2, lastSupportDay: '2026-10-06',
    firstSeenAt: '2026-10-05T03:00:00.000Z', lastSeenAt: '2026-10-06T03:00:00.000Z',
    evidence: [{ id: evidence.id, at: evidence.observedAt, stance: 'support' }], status: 'active',
    disclosure: { audience: OWNER_AUDIENCE, sensitivity: 'sensitive', decidedBy: 'rule' }, createdAt: '2026-10-05T03:00:00.000Z',
    updatedAt: '2026-10-06T03:00:00.000Z', ...extra });
  const save = (row: PersonImpression) => impressions.saveImpressions('owner', [row], []);
  const recalling = (memoryId: string) => {
    const turn = w.store.appendTurn('owner', 'platform:minecraft:x', '続けて', 'はいはい', w.now(), { recalledMemoryIds: [memoryId] } as never);
    const later = w.store.appendTurn('owner', 'platform:minecraft:x', 'まだ？', 'うん', w.now(), { recalledMemoryIds: [turn.id] } as never);
    return { turn, later };
  };
  const visible = (id: string, env?: Record<string, string>) => memory(env).read('owner', [id], OWNER_AUDIENCE).map(item => item.id);
  return { ...w, people, impressions, memory, evidence, impression, save, recalling, visible };
}

describe('a turn that recalled an impression of a person', () => {
  it('is read as visible while the owner alone may be shown the impression, and so is a turn that recalled it', () => {
    const f = fixture();
    f.save(f.impression('imp-a'));
    const id = impressionMemoryId('imp-a'), { turn, later } = f.recalling(id);
    expect(f.visible(turn.id)).toEqual([turn.id]);
    expect(f.visible(later.id)).toEqual([later.id]);
    expect(f.memory().read('owner', [id], OWNER_AUDIENCE)).toMatchObject([{ id, applicability: 'impression of a person',
      summary: 'ライ氏は、ボクのことをよく「可愛い」と言う／ボクの気持ち: うれしい' }]);
    // A fading one is still shown when the message brings it up.
    f.save(f.impression('imp-a', { status: 'fading' }));
    expect(f.visible(turn.id)).toEqual([turn.id]);
  });

  it('is hidden when the impression is gone, retired, closed in time, forgotten, or switched off', () => {
    const f = fixture();
    const id = impressionMemoryId('imp-b'), { turn, later } = f.recalling(id);
    // Never stored, or stored and later merged away or dropped.
    expect(f.visible(turn.id)).toEqual([]);
    f.save(f.impression('imp-b'));
    expect(f.visible(turn.id)).toEqual([turn.id]);
    f.impressions.saveImpressions('owner', [], ['imp-b']);
    expect(f.visible(turn.id)).toEqual([]);
    expect(f.visible(later.id)).toEqual([]);
    for (const extra of [{ status: 'retired' as const }, { status: 'candidate' as const }, { invalidAt: '2026-10-06T00:00:00.000Z' },
      { expiredAt: '2026-10-06T00:00:00.000Z' }]) {
      f.save(f.impression('imp-b', extra));
      expect(f.visible(turn.id), JSON.stringify(extra)).toEqual([]);
    }
    f.save(f.impression('imp-b'));
    expect(f.visible(turn.id, { SHANNON_IMPRESSIONS: 'off' })).toEqual([]);
    expect(f.visible(turn.id)).toEqual([turn.id]);
    f.advance(1000);
    new ShannonMemoryService(f.store, f.store, f.now).mutate('owner', { memoryId: id, action: 'forget' });
    expect(f.visible(turn.id)).toEqual([]);
    expect(f.memory().read('owner', [id], OWNER_AUDIENCE)).toEqual([]);
  });

  it('is hidden when every turn the impression was noticed in is forgotten, and not while one of them is kept', () => {
    const f = fixture();
    const second = f.store.appendTurn('owner', 'thread', 'ほんと可愛いなあ', 'もう', f.now());
    f.save(f.impression('imp-c', { evidence: [{ id: f.evidence.id, at: f.evidence.observedAt, stance: 'support' },
      { id: second.id, at: second.observedAt, stance: 'support' }] }));
    const { turn } = f.recalling(impressionMemoryId('imp-c'));
    expect(f.visible(turn.id)).toEqual([turn.id]);
    f.advance(1000);
    new ShannonMemoryService(f.store, f.store, f.now).mutate('owner', { memoryId: f.evidence.id, action: 'forget' });
    expect(f.visible(turn.id)).toEqual([turn.id]);
    f.advance(1000);
    new ShannonMemoryService(f.store, f.store, f.now).mutate('owner', { memoryId: second.id, action: 'forget' });
    expect(f.visible(turn.id)).toEqual([]);
  });

  it('the reader itself answers by the owner\'s controls: his correction is the text, his forgetting is nothing', () => {
    const f = fixture();
    f.save(f.impression('imp-e'));
    const id = impressionMemoryId('imp-e');
    const reader = () => ownerImpressionReader(f.store, f.store.snapshot('owner'), 'owner', OWNER_AUDIENCE, {})(id);
    expect(reader()).toBe('ライ氏は、ボクのことをよく「可愛い」と言う／ボクの気持ち: うれしい');
    f.advance(1000);
    new ShannonMemoryService(f.store, f.store, f.now).mutate('owner', { memoryId: id, action: 'correct', text: 'ライ氏はたまにボクを褒める' });
    expect(reader()).toBe('ライ氏はたまにボクを褒める');
    f.advance(1000);
    new ShannonMemoryService(f.store, f.store, f.now).mutate('owner', { memoryId: id, action: 'forget' });
    expect(reader()).toBeNull();
    // A store that cannot answer gives what these ids gave before: nothing.
    const broken = { ...f.store, impressionStore: () => { throw new Error('closed'); } } as unknown as typeof f.store;
    expect(ownerImpressionReader(broken, f.store.snapshot('owner'), 'owner', OWNER_AUDIENCE, {})(id)).toBeNull();
  });

  it('of another person: visible while that person is remembered, hidden once forgotten or unknown', () => {
    const f = fixture();
    const miki = f.people.createPerson('owner', { displayName: 'ミキ', howKnown: '友だち' }, f.now());
    f.save(f.impression('imp-m', { personKey: miki.id, pattern: 'ボクをからかう', keyTerms: ['ちび'],
      disclosure: { audience: peopleAudience([miki.id]), sensitivity: 'ordinary', decidedBy: 'rule' } }));
    f.save(f.impression('imp-x', { personKey: 'nobody-known' }));
    const { turn } = f.recalling(impressionMemoryId('imp-m'));
    expect(f.visible(turn.id)).toEqual([turn.id]);
    expect(f.memory().read('owner', [impressionMemoryId('imp-m')], OWNER_AUDIENCE)).toMatchObject([{ summary: expect.stringContaining('ミキさんは、ボクをからかう') }]);
    expect(f.visible(f.recalling(impressionMemoryId('imp-x')).turn.id)).toEqual([]);
    // With F6 decay another person's impression is usable by the age of its evidence, which a later reading may hide without any write:
    // closed here, so what one reading found visible stays true for every later one (the lineage memo). The owner's own keep their rule.
    expect(f.visible(turn.id, { SHANNON_EVIDENCE_DECAY: 'on' })).toEqual([]);
    const own = f.impression('imp-o');
    f.save(own);
    expect(f.visible(f.recalling(impressionMemoryId('imp-o')).turn.id, { SHANNON_EVIDENCE_DECAY: 'on' })).toHaveLength(1);
    f.people.updatePerson('owner', miki.id, { forgottenAt: f.now() }, f.now());
    expect(f.visible(turn.id)).toEqual([]);
  });

  it('is never judged for anyone but the owner alone', () => {
    const f = fixture();
    const miki = f.people.createPerson('owner', { displayName: 'ミキ', howKnown: '友だち' }, f.now());
    f.save(f.impression('imp-d'));
    const id = impressionMemoryId('imp-d'), { turn } = f.recalling(id);
    const withMiki = peopleAudience([miki.id]);
    expect(ownerImpressionReader(f.store, f.store.snapshot('owner'), 'owner', OWNER_AUDIENCE, {})(id)).not.toBeNull();
    expect(ownerImpressionReader(f.store, f.store.snapshot('owner'), 'owner', withMiki, {})(id)).toBeNull();
    // Not of that form, or another kind of id: unknown here.
    expect(ownerImpressionReader(f.store, f.store.snapshot('owner'), 'owner', OWNER_AUDIENCE, {})('imp-d')).toBeNull();
    const memory = createTaskMemory({ state: f.store, conversations: f.store, ownerScope: 'owner', ownerAlone: () => true, now: f.now, environment: {} });
    expect(memory.read('owner', [turn.id], withMiki)).toEqual([]);
    const notAlone = createTaskMemory({ state: f.store, conversations: f.store, ownerScope: 'owner', ownerAlone: () => false, now: f.now, environment: {} });
    expect(notAlone.read('owner', [turn.id], OWNER_AUDIENCE)).toEqual([]);
  });
});
