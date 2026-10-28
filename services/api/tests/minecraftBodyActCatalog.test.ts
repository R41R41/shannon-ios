import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ACT_INPUT_SCHEMA, HAND_KINDS } from '../src/contracts/minecraftActContract.js';
import type { MinecraftSkillDefinition } from '../src/contracts/minecraftControlContract.js';
import { skillSchema, validControlPoll, validSkillInput, validSkills } from '../src/surfaces/minecraft/minecraftControlValidation.js';

/**
 * Run 39 (2026-10-26, rel55): the head (566abe5) refused the body's (3f4c793) whole catalog, so every poll was a 400 FCA_BODY_POLL_INVALID and the head never saw the
 * body. The body's `act` takes a `done` condition: an array of arrays of one object schema per kind of clause (11 in an `anyOf`), and `skillSchema` let an `anyOf` have 4.
 * The head's own tests built their catalogs on the head's side. The fixture is the `act` definition the body's rel55 build makes (`bodySkillCatalog`, read on the
 * production VM from `minecraftrel55…/dist`), unchanged: when the body's catalog changes, the fixture is made again from its build and these tests say whether the
 * head takes it.
 */
/**
 * rel55 and rel56 are the `act` definitions of those releases, unchanged. `produced` is the act of the body's own catalog of the continue version (`fixtures/continue/produced/catalog.json`,
 * made by the body's `continue-produce.ts` and copied by `scripts/sync-body-produced.sh`): it has the `vertical` hand and `dependsOn`, 49 properties in the hand. The comparison with the head's
 * hand (kind for kind, field for field) is made against that one, since the head's hand has moved on from rel56.
 */
const FIXTURES = ['rel55', 'rel56', 'produced'] as const;
const catalogOf = (release: string): MinecraftSkillDefinition[] => release === 'produced'
  ? (JSON.parse(readFileSync(new URL('./fixtures/continue/produced/catalog.json', import.meta.url), 'utf8')) as { offered: MinecraftSkillDefinition[] }).offered.filter(skill => skill.name === 'act')
  : JSON.parse(readFileSync(new URL(`./fixtures/minecraft-body-act-catalog-${release}.json`, import.meta.url), 'utf8')) as MinecraftSkillDefinition[];
/** The most properties a hand had in each: 48 was the head's limit for rel55 and rel56; the continue version's hand has 49 and the limit is 56. */
const HAND_PROPERTIES: Readonly<Record<(typeof FIXTURES)[number], number>> = { rel55: 48, rel56: 48, produced: 56 };

const NOW = Date.parse('2026-10-26T07:00:00.000Z');
function poll(skills: unknown): unknown {
  return { schemaVersion: 1, serverId: 'home', connectionId: 'connection-1',
    observation: { schemaVersion: 1, bodyId: 'body-1', sequence: 1, stateAt: new Date(NOW).toISOString(), receivedAt: new Date(NOW).toISOString(), connected: true, state: {}, facts: {} },
    candidates: [], activeOperationIds: [], receipts: [], skills };
}

describe.each(FIXTURES)('the body\'s actual act catalog (%s) is taken by the head\'s validation', release => {
  const catalog = catalogOf(release);
  const act = catalog.find(skill => skill.name === 'act')!;
  const properties = (act.inputSchema as { properties: Record<string, Record<string, unknown>> }).properties;
  it('is the act definition with its seven arguments, `done` among them', () => {
    expect(catalog.map(skill => skill.name)).toEqual(['act']);
    expect(Object.keys(properties)).toEqual(['hands', 'stopIf', 'why', 'accept', 'facing', 'repeat', 'done']);
  });
  it('passes validSkills and every argument\'s schema, `done` too', () => {
    for (const [name, schema] of Object.entries(properties)) expect([name, skillSchema(schema, 1)]).toEqual([name, true]);
    expect(skillSchema(act.inputSchema)).toBe(true);
    expect(validSkills(catalog)).toBe(true);
  });
  it('passes a whole poll that carries the catalog', () => {
    expect(validControlPoll(poll(catalog), NOW)).toBe(true);
    // The way it was refused: the same poll with the `done` kinds cut to 4.
    const cut = JSON.parse(JSON.stringify(catalog)) as typeof catalog;
    const kinds = (cut[0]!.inputSchema as any).properties.done.items.items;
    kinds.anyOf = [...kinds.anyOf, ...kinds.anyOf].slice(0, 17);
    expect(validControlPoll(poll(cut), NOW)).toBe(false);
  });
  it('keeps the limits the catalog sits near: the hand\'s properties, the schema\'s 16,000 characters, the poll\'s 1 MiB', () => {
    expect(Object.keys((properties.hands as any).items.properties).length).toBeLessThanOrEqual(HAND_PROPERTIES[release]);
    expect(JSON.stringify(act.inputSchema).length).toBeLessThanOrEqual(16_000);
    expect(JSON.stringify(poll(catalog)).length).toBeLessThan(1024 * 1024);
  });
  it('takes the inputs the head sends: every kind of clause in `done`, repeat, and the hands', () => {
    // At most 4 groups (alternatives) of at most 6 clauses; the kinds are spread over three acts.
    const kinds = [
      [[{ k: 'have', item: 'iron_pickaxe', n: 1 }, { k: 'food', n: 40 }], [{ k: 'hunger', n: 10 }, { k: 'hp', n: 15 }], [{ k: 'dim', dim: 'the_nether' }]],
      [[{ k: 'at', x: 1, y: 64, z: -3, r: 4, dim: 'overworld' }], [{ k: 'near', block: 'crafting_table', r: 4 }], [{ k: 'free', n: 3 }, { k: 'time', t: 'night' }]],
      [[{ k: 'furnace', x: 1, y: 64, z: 2 }, { k: 'safe', r: 16 }]],
    ];
    for (const done of kinds) expect(validSkillInput({ hands: [{ do: 'wait', seconds: 5 }], why: '[p1] 待つ', done }, act.inputSchema)).toBe(true);
    expect(validSkillInput({ hands: [{ do: 'dig', rel: true, at: [{ x: 1, y: 0, z: 0 }] }], repeat: 4, done: [[{ k: 'free', n: 0 }]] }, act.inputSchema)).toBe(true);
    expect(validSkillInput({ hands: [{ do: 'wait', seconds: 5 }], done: [[{ k: 'nothing' }]] }, act.inputSchema)).toBe(false);
    expect(validSkillInput({ hands: [{ do: 'wait', seconds: 5 }], done: [[{ k: 'food', n: 40, extra: 1 }]] }, act.inputSchema)).toBe(false);
  });
});

describe('the body\'s act catalog of the continue version (produced): the hands that take a range, and vertical', () => {
  const catalog = catalogOf('produced');
  const act = catalog.find(skill => skill.name === 'act')!;
  const hands = (act.inputSchema as any).properties.hands.items.properties;
  const takes = (hand: Record<string, unknown>) => validSkillInput({ hands: [hand], why: '[p1] x' }, act.inputSchema);
  it('names every kind of hand the head sends', () => {
    expect(hands.do.enum).toEqual(expect.arrayContaining(['go', 'obsidian', 'fight', 'mine', 'make', 'portal', 'smelt', 'vertical']));
  });
  it('has 49 properties in the hand, within the head\'s 56 (the head\'s own hand has the same 49)', () => {
    expect(Object.keys(hands)).toHaveLength(49);
    expect(Object.keys(ACT_INPUT_SCHEMA.properties.hands.items.properties)).toHaveLength(49);
    expect(Object.keys(hands).length).toBeLessThanOrEqual(56);
  });
  it('is the head\'s hand, kind for kind and field for field (a drift between the two is the way rel55 was refused)', () => {
    const theirs = ACT_INPUT_SCHEMA.properties.hands.items.properties as Record<string, any>;
    expect([...hands.do.enum].sort()).toEqual([...HAND_KINDS].sort());
    expect(Object.keys(hands).sort()).toEqual(Object.keys(theirs).sort());
    // The body may be looser than the head (the head checks first) but never tighter: what the head sends the body must take.
    for (const field of Object.keys(theirs)) {
      for (const bound of ['maximum', 'maxItems']) {
        if (hands[field][bound] !== undefined) expect([field, bound, hands[field][bound] >= theirs[field][bound]]).toEqual([field, bound, true]);
      }
      for (const bound of ['minimum', 'minItems']) {
        if (hands[field][bound] !== undefined) expect([field, bound, hands[field][bound] <= theirs[field][bound]]).toEqual([field, bound, true]);
      }
    }
  });
  it('has every field of the head\'s hand', () => {
    for (const field of ['goals', 'canDig', 'canPlace', 'maxDrop', 'waterOk', 'maxDig', 'maxPlace', 'stance', 'retreatHp', 'axis', 'furnaces', 'enter']) expect(hands).toHaveProperty(field);
  });
  it('takes a hand of each new kind as the head writes it', () => {
    expect(takes({ do: 'go', to: { x: 1, y: 2, z: 3 }, canDig: ['stone'], canPlace: ['cobblestone'], maxDrop: 3, waterOk: false, seconds: 45, maxDig: 40, maxPlace: 24 })).toBe(true);
    expect(takes({ do: 'go', goals: [{ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }], range: 2 })).toBe(true);
    expect(takes({ do: 'obsidian', at: [{ x: 1, y: 2, z: 3 }], count: 3, seconds: 90, canPlace: ['cobblestone'], maxPlace: 8 })).toBe(true);
    expect(takes({ do: 'fight', target: '#12', stance: 'fight', item: 'iron_sword', retreatHp: 8, range: 8, seconds: 20 })).toBe(true);
    expect(takes({ do: 'mine', block: 'iron_ore', at: [{ x: 1, y: 2, z: 3 }], count: 8, tool: 'stone_pickaxe', collect: true, seconds: 60, canDig: ['stone'], maxDig: 16 })).toBe(true);
    expect(takes({ do: 'make', item: 'wooden_pickaxe', count: 1 })).toBe(true);
    expect(takes({ do: 'portal', at: [{ x: 1, y: 2, z: 3 }], axis: 'x', block: 'obsidian', enter: true, canPlace: ['cobblestone'], maxPlace: 6, seconds: 60 })).toBe(true);
    expect(takes({ do: 'smelt', items: [{ item: 'raw_iron', count: 16 }], fuel: 'coal', fuelCount: 2, furnaces: 2, at: [{ x: 1, y: 2, z: 3 }], seconds: 30 })).toBe(true);
    // the continue version: vertical in each of its three forms, dependsOn on any hand
    expect(takes({ do: 'vertical', dir: 'down', shape: 'stairs', toward: 'south', toY: 10, canDig: ['stone', 'dirt'], liquid: 'stop', maxDig: 200, maxPlace: 100, range: 2, seconds: 120 })).toBe(true);
    expect(takes({ do: 'vertical', dir: 'down', shape: 'shaft', toY: -50, canDig: ['stone'], canPlace: ['cobblestone'], maxPlace: 30, liquid: 'seal' })).toBe(true);
    expect(takes({ do: 'vertical', dir: 'up', shape: 'pillar', toY: 63, canDig: ['stone'], canPlace: ['cobblestone'], liquid: 'seal_water', seconds: 60 })).toBe(true);
    expect(takes({ do: 'wait', seconds: 1, dependsOn: [] })).toBe(true);
  });
  it('refuses a field of the wrong type or range', () => {
    expect(takes({ do: 'fight', target: '#12', stance: 'hide' })).toBe(false);
    expect(takes({ do: 'portal', at: [{ x: 1, y: 2, z: 3 }], axis: 'y' })).toBe(false);
    expect(takes({ do: 'go', to: { x: 1, y: 2, z: 3 }, maxDrop: 11 })).toBe(false);
    expect(takes({ do: 'smelt', items: [{ item: 'raw_iron', count: 16 }], furnaces: 5 })).toBe(false);
    expect(takes({ do: 'vertical', dir: 'sideways', shape: 'stairs', toY: 10, canDig: ['stone'], liquid: 'stop' })).toBe(false);
    expect(takes({ do: 'vertical', dir: 'down', shape: 'diagonal', toY: 10, canDig: ['stone'], liquid: 'stop' })).toBe(false);
    expect(takes({ do: 'vertical', dir: 'down', shape: 'stairs', toY: 10, canDig: ['stone'], liquid: 'stop', maxDig: 201 })).toBe(false);
  });
});
