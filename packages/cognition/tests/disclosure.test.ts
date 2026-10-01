import { describe, expect, it } from 'vitest';
import {
  OWNER_AUDIENCE,
  UNKNOWN_GUEST_PRESENCE,
  audienceCovers,
  classifySensitivity,
  createInitialCompanionState,
  describeAudience,
  disclosureFor,
  discloseSnapshot,
  groupAudience,
  mayDisclose,
  normalizeAudience,
  normalizeDisclosure,
  ownerSpoke,
  peopleAudience,
  reduceCompanionState,
  resolveDisclosure,
  restoreCompanionState,
  widenAudience,
  type CompanionStateSnapshot,
  type MemoryDisclosure,
} from '../src/index.js';

const at = '2026-10-02T03:00:00.000Z';
const withA = peopleAudience(['person-a']);
const withB = peopleAudience(['person-b']);
const withAandB = peopleAudience(['person-a', 'person-b']);
const discord = groupAudience('discord:channel-1');

const label = (sensitivity: 'sensitive' | 'ordinary' | undefined, audience = OWNER_AUDIENCE): MemoryDisclosure => ({
  audience, ...(sensitivity ? { sensitivity } : {}),
});

describe('disclosure rule', () => {
  it('lets the owner alone use everything, labelled or not', () => {
    for (const disclosure of [undefined, label('sensitive'), label('sensitive', withA), label(undefined, discord)]) {
      expect(mayDisclose(disclosure, OWNER_AUDIENCE)).toBe(true);
    }
  });

  it('withholds a sensitive one-to-one item from a friend, an unknown guest and a group', () => {
    for (const present of [withA, UNKNOWN_GUEST_PRESENCE, discord]) {
      expect(mayDisclose(label('sensitive'), present)).toBe(false);
    }
  });

  it('lets an ordinary item be used with anyone present', () => {
    for (const present of [withA, UNKNOWN_GUEST_PRESENCE, discord]) {
      expect(mayDisclose(label('ordinary'), present)).toBe(true);
      expect(mayDisclose(label('ordinary', withB), present)).toBe(true);
    }
  });

  it('uses what was said with A when A is present and withholds it when only B is', () => {
    const saidWithA = label('sensitive', withA);
    expect(mayDisclose(saidWithA, withA)).toBe(true);
    expect(mayDisclose(saidWithA, withB)).toBe(false);
    // B was not there, so A and B together have not all heard it.
    expect(mayDisclose(saidWithA, withAandB)).toBe(false);
    // Said in front of both: either of them, or both, may hear it again.
    expect(mayDisclose(label('sensitive', withAandB), withA)).toBe(true);
    expect(mayDisclose(label('sensitive', withAandB), withAandB)).toBe(true);
  });

  it('fails closed on everything unknown', () => {
    // Unknown sensitivity is sensitive; unknown audience is the owner alone.
    expect(mayDisclose(undefined, withA)).toBe(false);
    expect(mayDisclose({}, withA)).toBe(false);
    expect(mayDisclose({ sensitivity: 'sensitive' }, withA)).toBe(false);
    expect(mayDisclose(label(undefined, withA), withB)).toBe(false);
    // An unidentified guest is in no audience, not even one recorded with an unidentified guest.
    expect(audienceCovers(UNKNOWN_GUEST_PRESENCE, UNKNOWN_GUEST_PRESENCE)).toBe(false);
    expect(audienceCovers(peopleAudience(['person-a'], true), peopleAudience(['person-a'], true))).toBe(false);
    expect(mayDisclose(label('sensitive', peopleAudience(['person-a'], true)), withA)).toBe(true);
  });

  it('treats a platform conversation as one audience', () => {
    const saidThere = label('sensitive', discord);
    expect(mayDisclose(saidThere, discord)).toBe(true);
    expect(mayDisclose(saidThere, groupAudience('discord:channel-2'))).toBe(false);
    expect(mayDisclose(saidThere, withA)).toBe(false);
    expect(mayDisclose(label('sensitive', withA), discord)).toBe(false);
  });

  it('reads malformed stored labels as the safe side', () => {
    expect(normalizeAudience(null)).toEqual(OWNER_AUDIENCE);
    expect(normalizeAudience({ kind: 'everyone' })).toEqual(OWNER_AUDIENCE);
    expect(normalizeAudience({ kind: 'group', groupKey: '' })).toEqual(OWNER_AUDIENCE);
    expect(normalizeAudience({ kind: 'people', personIds: ['b', 'a', 'a', 7] })).toEqual({ kind: 'people', personIds: ['a', 'b'] });
    expect(normalizeDisclosure({ sensitivity: 'public', category: 'nothing' })).toBeUndefined();
    expect(normalizeDisclosure('ordinary')).toBeUndefined();
    // An audience that cannot be read does not vouch for the owner having spoken.
    expect(ownerSpoke(normalizeDisclosure({ audience: { kind: 'everyone' }, sensitivity: 'ordinary', speaker: 'owner' }))).toBe(false);
    expect(ownerSpoke(normalizeDisclosure({ audience: { kind: 'owner' }, sensitivity: 'ordinary' }))).toBe(true);
    expect(mayDisclose(normalizeDisclosure({ sensitivity: 'public' }), withA)).toBe(false);
  });

  it('knows whose words a turn holds', () => {
    expect(ownerSpoke(undefined)).toBe(true);
    expect(ownerSpoke({ audience: OWNER_AUDIENCE })).toBe(true);
    expect(ownerSpoke({ audience: withA })).toBe(false);
    expect(ownerSpoke({ audience: UNKNOWN_GUEST_PRESENCE })).toBe(false);
    expect(ownerSpoke({ audience: discord })).toBe(false);
    expect(ownerSpoke({ audience: discord, speaker: 'owner' })).toBe(true);
    expect(ownerSpoke({ audience: OWNER_AUDIENCE, speaker: 'unknown' })).toBe(false);
  });

  it('widens an audience to everyone who has heard it', () => {
    expect(widenAudience(undefined, undefined)).toEqual(OWNER_AUDIENCE);
    expect(widenAudience(OWNER_AUDIENCE, withA)).toEqual(withA);
    expect(widenAudience(withA, withB)).toEqual(withAandB);
    expect(widenAudience(discord, withA)).toEqual(discord);
  });

  it('describes an audience for the owner', () => {
    const nameOf = (id: string) => ({ 'person-a': 'ミキ' } as Record<string, string>)[id];
    expect(describeAudience(undefined)).toBe('ライ氏と二人の時');
    expect(describeAudience(withA, nameOf)).toBe('ミキさんと一緒の時');
    expect(describeAudience(UNKNOWN_GUEST_PRESENCE, nameOf)).toBe('名前を聞いていない方と一緒の時');
    expect(describeAudience(discord)).toBe('グループの会話');
  });
});

describe('sensitivity rules', () => {
  it.each([
    ['これは内緒にしてね', 'secret'],
    ['誰にも言わないでほしいんだけど', 'secret'],
    ['来月、病院で検査を受ける', 'health'],
    ['最近眠れないし、気分が落ち込む', 'mental'],
    ['年収が下がった', 'money'],
    ['住所は港区です', 'contact'],
    ['連絡先は test@example.com です', 'contact'],
    ['彼女と別れた', 'romance_family'],
    ['会社を辞めようと思っている', 'work'],
    ['弁護士に相談した', 'legal'],
    ['週末は京都に行く', 'schedule'],
    ['ミキさんは転んだらしい', 'third_party'],
    ['友達が引っ越した', 'third_party'],
  ] as const)('marks %s as %s', (text, category) => {
    const decision = classifySensitivity(text);
    expect(decision.sensitivity).toBe('sensitive');
    expect(decision.category).toBe(category);
    expect(decision.reason).toContain('を含む');
  });

  it.each([
    '紅茶が好き', '猫の動画をよく見る', 'このゲームのラスボスが強い', 'たくさん食べた', 'シャノンさん、声が可愛いね',
    '映画の感想を話したい',
  ])('leaves %s ordinary', text => {
    expect(classifySensitivity(text)).toEqual({ sensitivity: 'ordinary', reason: '守るべき個人情報の語を含まない' });
  });

  it('labels an item with its audience and the rule decision', () => {
    expect(disclosureFor('紅茶が好き')).toEqual({ audience: OWNER_AUDIENCE, sensitivity: 'ordinary',
      reason: '守るべき個人情報の語を含まない', decidedBy: 'rule' });
    expect(disclosureFor('年収の話', withA, { speaker: 'unknown' })).toMatchObject({
      audience: withA, sensitivity: 'sensitive', category: 'money', speaker: 'unknown' });
    // A call whose guest was never named is protected whatever its content.
    expect(disclosureFor('紅茶が好き', UNKNOWN_GUEST_PRESENCE)).toMatchObject({
      sensitivity: 'sensitive', category: 'unknown_audience' });
    expect(disclosureFor('猫を飼っている', withA, { force: 'third_party' })).toMatchObject({
      sensitivity: 'sensitive', category: 'third_party' });
  });
});

describe('labels in the companion snapshot', () => {
  const seeded = (): CompanionStateSnapshot => {
    let state = createInitialCompanionState('owner', at);
    const apply = (event: Parameters<typeof reduceCompanionState>[1]) => { state = reduceCompanionState(state, event, at); };
    apply({ type: 'user-fact-upserted', fact: { id: 'fact-tea', statement: 'ユーザーは紅茶が好き', confidence: 0.8, observedAt: at,
      disclosure: disclosureFor('ユーザーは紅茶が好き') } });
    apply({ type: 'user-fact-upserted', fact: { id: 'fact-debt', statement: 'ユーザーには借金がある', confidence: 0.8, observedAt: at,
      disclosure: disclosureFor('ユーザーには借金がある') } });
    apply({ type: 'user-fact-upserted', fact: { id: 'fact-old', statement: 'ユーザーは散歩が好き', confidence: 0.8, observedAt: at } });
    apply({ type: 'relationship-upserted', relationship: { id: 'rel-a', statement: 'ミキさんの前で転職の話をした', confidence: 0.7,
      observedAt: at, disclosure: disclosureFor('ミキさんの前で転職の話をした', withA) } });
    apply({ type: 'prospective-memory-upserted', memory: { id: 'promise-1', summary: '明日病院に行く', status: 'pending',
      createdAt: at, updatedAt: at, disclosure: disclosureFor('明日病院に行く') } });
    apply({ type: 'interest-observed', interest: '登山' });
    apply({ type: 'memory-activated', memory: { id: 'exp-1', summary: 'ユーザー: 借金の相談', relevance: 0.9, observedAt: at } });
    return state;
  };

  it('returns the same snapshot when the owner is alone', () => {
    const state = seeded();
    expect(discloseSnapshot(state, OWNER_AUDIENCE)).toBe(state);
  });

  it('keeps only ordinary items and items the people present already heard', () => {
    const state = seeded();
    const forB = discloseSnapshot(state, withB);
    expect(forB.userFacts.map(item => item.id)).toEqual(['fact-tea']);
    expect(forB.relationships).toEqual([]);
    expect(forB.prospectiveMemories).toEqual([]);
    expect(forB.interests).toEqual([]);
    expect(forB.activeMemories).toEqual([]);
    expect(discloseSnapshot(state, withA).relationships.map(item => item.id)).toEqual(['rel-a']);
    expect(discloseSnapshot(state, discord).userFacts.map(item => item.id)).toEqual(['fact-tea']);
  });

  it('lets the owner mark an item 機微 or ふつう, and that choice wins over the rule', () => {
    let state = seeded();
    const control = (memoryId: string, sensitivity: 'sensitive' | 'ordinary') => ({ type: 'memory-control-upserted' as const, control: {
      memoryId, kind: 'user-fact' as const, status: 'active' as const, pinned: false, updatedAt: at,
      changeReason: 'ユーザーが扱いを変更', sensitivity } });
    state = reduceCompanionState(state, control('fact-tea', 'sensitive'), at);
    state = reduceCompanionState(state, control('fact-old', 'ordinary'), at);
    expect(discloseSnapshot(state, withB).userFacts.map(item => item.id).sort()).toEqual(['fact-old']);
    expect(resolveDisclosure(state, 'fact-tea', state.userFacts.find(item => item.id === 'fact-tea')?.disclosure))
      .toMatchObject({ sensitivity: 'sensitive', decidedBy: 'owner' });
  });

  it('keeps a label when the same fact is stored again without one, and widens who has heard it', () => {
    let state = seeded();
    state = reduceCompanionState(state, { type: 'user-fact-upserted', fact: { id: 'fact-debt', statement: 'ユーザーには借金がある',
      confidence: 0.9, observedAt: at } }, at);
    expect(state.userFacts.find(item => item.id === 'fact-debt')?.disclosure).toMatchObject({ sensitivity: 'sensitive', category: 'money' });
    state = reduceCompanionState(state, { type: 'user-fact-upserted', fact: { id: 'fact-debt', statement: 'ユーザーには借金がある',
      confidence: 0.9, observedAt: at, disclosure: disclosureFor('ユーザーには借金がある', withA) } }, at);
    expect(state.userFacts.find(item => item.id === 'fact-debt')?.disclosure?.audience).toEqual(withA);
    expect(discloseSnapshot(state, withA).userFacts.map(item => item.id)).toContain('fact-debt');
    expect(discloseSnapshot(state, withB).userFacts.map(item => item.id)).not.toContain('fact-debt');
  });

  it('survives persistence, and a snapshot written before labels existed is owner-only', () => {
    const state = seeded();
    const restored = restoreCompanionState('owner', JSON.parse(JSON.stringify(state)), at);
    expect(restored.userFacts.find(item => item.id === 'fact-debt')?.disclosure).toEqual(
      state.userFacts.find(item => item.id === 'fact-debt')?.disclosure);
    expect(restored.relationships[0]?.disclosure?.audience).toEqual(withA);
    const legacy = restoreCompanionState('owner', { scopeKey: 'owner', version: 3, updatedAt: at,
      userFacts: [{ id: 'old', statement: 'ユーザーは紅茶が好き', confidence: 0.8, observedAt: at, disclosure: { sensitivity: 'public' } }],
      relationships: [], prospectiveMemories: [], memoryControls: [], interests: [], activeMemories: [] }, at);
    expect(legacy.userFacts[0]?.disclosure).toBeUndefined();
    expect(discloseSnapshot(legacy, withA).userFacts).toEqual([]);
    expect(discloseSnapshot(legacy, OWNER_AUDIENCE).userFacts).toHaveLength(1);
  });
});
