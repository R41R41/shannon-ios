import { describe, expect, it } from 'vitest';
import {
  IDENTITY_TIERS_V1, NEW_PERSON, bitsPerCharacter, entropyGate, identify, identityChoice, identityMenu, identityNameKey, joinsAutomatically,
  type IdentityPerson,
} from '../src/index.js';

const OWNER: IdentityPerson = { personId: 'owner', names: ['ライ', 'Rai1241'], links: ['discord:900000000000000001'], isOwner: true };
const MINA: IdentityPerson = { personId: 'person-mina', names: ['ミナ', 'Mina_77'], links: ['discord:900000000000000002'], isOwner: false };
const ALEXANDRA: IdentityPerson = { personId: 'person-alex', names: ['alexandra_w'], links: [], isOwner: false };
const PEOPLE = [OWNER, MINA, ALEXANDRA];

describe('identity tiers (owner answer 3)', () => {
  it('folds names into one key: width, case, spaces, 「・」 and hiragana', () => {
    expect(identityNameKey(' ﾐﾅ ')).toBe('ミナ');
    expect(identityNameKey('みな')).toBe('ミナ');
    expect(identityNameKey('Mina 77')).toBe('mina77');
    expect(identityNameKey('ミナ・タナカ')).toBe('ミナタナカ');
  });

  it('pins the owner by his proofs, and only by them', () => {
    expect(identify({ name: 'だれか', ownerPinned: true }, PEOPLE)).toEqual({ tier: 0, verdict: 'owner' });
    // His name, his alias or his link without the proof never match him at any tier.
    for (const observation of [{ name: 'ライ' }, { name: 'Rai1241' }, { name: 'rai1241' }, { name: 'Rai1242' }, { name: 'x', link: 'discord:900000000000000001' }]) {
      const outcome = identify(observation, PEOPLE, () => 0.99);
      expect(JSON.stringify(outcome), JSON.stringify(observation)).not.toContain('"owner"');
      if (outcome.verdict === 'ask') expect(outcome.menu.map(item => item.personId)).not.toContain('owner');
    }
  });

  it('tier 1: matches a platform link or one exact name key automatically', () => {
    expect(identify({ name: 'だれか', link: 'discord:900000000000000002' }, PEOPLE)).toEqual({ tier: 1, verdict: 'match', personId: 'person-mina', by: 'link' });
    expect(identify({ name: 'みな' }, PEOPLE)).toEqual({ tier: 1, verdict: 'match', personId: 'person-mina', by: 'name' });
    expect(identify({ name: 'MINA_77' }, PEOPLE)).toEqual({ tier: 1, verdict: 'match', personId: 'person-mina', by: 'name' });
    // Two people by the same key are not joined to either.
    const twin = { personId: 'person-mina-2', names: ['ミナ'], links: [], isOwner: false };
    expect(identify({ name: 'ミナ' }, [...PEOPLE, twin]).verdict).not.toBe('match');
    expect(joinsAutomatically({ tier: 1, verdict: 'match', personId: 'x', by: 'name' })).toBe(true);
  });

  it('tier 2: stops fuzzy matching below 1.5 bits per character or under 6 characters, and sends CJK to tier 4', () => {
    expect(bitsPerCharacter('aaaa')).toBe(0);
    expect(bitsPerCharacter('abcd')).toBe(2);
    expect(entropyGate('')).toBe('no_name');
    expect(entropyGate('alex')).toBe('too_short');
    expect(entropyGate('aaaaaaab')).toBe('low_entropy');
    expect(entropyGate('alexandra')).toBe('fuzzy');
    expect(entropyGate('ミナ')).toBe('cjk');
    expect(entropyGate('みなみ')).toBe('cjk');
    expect(identify({ name: 'alex' }, PEOPLE, () => 0.99)).toEqual({ tier: 2, verdict: 'new', why: 'too_short' });
    expect(identify({ name: 'aaaaaaab' }, PEOPLE, () => 0.99)).toEqual({ tier: 2, verdict: 'new', why: 'low_entropy' });
    expect(identify({ name: '   ' }, PEOPLE)).toEqual({ tier: 2, verdict: 'new', why: 'no_name' });
  });

  it('tier 3: suggests a name with MinHash Jaccard ≥ 0.9, never matches it', () => {
    const near = identify({ name: 'alexandra_w ' }, PEOPLE);
    expect(near.verdict).toBe('match'); // the same key after trimming is tier 1
    const fuzzy = identify({ name: 'alexandra_ww' }, [{ ...ALEXANDRA, names: ['alexandra_wwhitfield'] }]);
    expect(fuzzy.verdict === 'suggest' || fuzzy.verdict === 'new').toBe(true);
    const long = 'alexandrawhitfield_of_the_north';
    const suggested = identify({ name: `${long}x` }, [{ ...ALEXANDRA, names: [long] }]);
    expect(suggested).toMatchObject({ tier: 3, verdict: 'suggest', personId: 'person-alex' });
    expect(suggested.verdict === 'suggest' && suggested.jaccard).toBeGreaterThanOrEqual(IDENTITY_TIERS_V1.jaccardAt);
    expect(joinsAutomatically(suggested)).toBe(false);
    // A name unlike anyone's goes on to tier 4.
    expect(identify({ name: 'bartholomew' }, PEOPLE).tier).toBe(4);
  });

  it('tier 4: a menu of at most 15 with cosine ≥ 0.6, highest first, never the owner; CJK fails closed to it', () => {
    const many: IdentityPerson[] = Array.from({ length: 20 }, (_, index) => ({ personId: `p${String(index).padStart(2, '0')}`, names: [`name${index}`], links: [], isOwner: false }));
    const cosine = (id: string) => (id === 'owner' ? 1 : id === 'p19' ? 0.5 : 0.6 + Number(id.slice(1)) / 100);
    const menu = identityMenu([OWNER, ...many], cosine);
    expect(menu).toHaveLength(IDENTITY_TIERS_V1.candidates);
    expect(menu[0]).toEqual({ personId: 'p18', cosine: 0.78 });
    expect(menu.map(item => item.personId)).not.toContain('owner');
    expect(menu.map(item => item.personId)).not.toContain('p19');
    expect(identityMenu(PEOPLE)).toEqual([]);
    expect(identify({ name: 'みなみ' }, PEOPLE, id => (id === 'person-mina' ? 0.8 : 0.1))).toEqual({ tier: 4, verdict: 'ask', menu: [{ personId: 'person-mina', cosine: 0.8 }] });
    expect(identify({ name: 'みなみ' }, PEOPLE)).toEqual({ tier: 4, verdict: 'new', why: 'no_candidate' });
    expect(joinsAutomatically({ tier: 4, verdict: 'ask', menu: [] })).toBe(false);
  });

  it('follows tier 4\'s answer only in the 0.9/0.1 band, and only as a suggestion', () => {
    const menu = [{ personId: 'person-mina', cosine: 0.8 }, { personId: 'person-alex', cosine: 0.7 }];
    expect(identityChoice(menu, { 'person-mina': 0.95, 'person-alex': 0.02 })).toEqual({ verdict: 'suggest', personId: 'person-mina', probability: 0.95 });
    expect(identityChoice(menu, { 'person-mina': 0.89 })).toEqual({ verdict: 'undecided' });
    expect(identityChoice(menu, { 'person-mina': 0.95, 'person-alex': 0.92 })).toEqual({ verdict: 'undecided' });
    expect(identityChoice(menu, { [NEW_PERSON]: 0.93 })).toEqual({ verdict: 'new' });
    expect(identityChoice(menu, { 'person-mina': 0.05, 'person-alex': 0.1 })).toEqual({ verdict: 'new' });
    expect(identityChoice(menu, { 'person-mina': 0.05, 'person-alex': 0.3 })).toEqual({ verdict: 'undecided' });
    // Off the menu, the owner among it, is ignored.
    expect(identityChoice(menu, { owner: 0.99 })).toEqual({ verdict: 'undecided' });
    expect(identityChoice([], {})).toEqual({ verdict: 'undecided' });
  });
});
