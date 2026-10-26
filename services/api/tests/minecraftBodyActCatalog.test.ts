import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MinecraftSkillDefinition } from '../src/contracts/minecraftControlContract.js';
import { skillSchema, validControlPoll, validSkillInput, validSkills } from '../src/surfaces/minecraft/minecraftControlValidation.js';

/**
 * Run 39 (2026-10-26, rel55): the head (566abe5) refused the body's (3f4c793) whole catalog, so every poll was a 400 FCA_BODY_POLL_INVALID and the head never saw the
 * body. The body's `act` takes a `done` condition: an array of arrays of one object schema per kind of clause (11 in an `anyOf`), and `skillSchema` let an `anyOf` have 4.
 * The head's own tests built their catalogs on the head's side. The fixture is the `act` definition the body's rel55 build makes (`bodySkillCatalog`, read on the
 * production VM from `minecraftrel55…/dist`), unchanged: when the body's catalog changes, the fixture is made again from its build and these tests say whether the
 * head takes it.
 */
const FIXTURE = new URL('./fixtures/minecraft-body-act-catalog-rel55.json', import.meta.url);
const catalog = JSON.parse(readFileSync(FIXTURE, 'utf8')) as MinecraftSkillDefinition[];
const act = catalog.find(skill => skill.name === 'act')!;
const properties = (act.inputSchema as { properties: Record<string, Record<string, unknown>> }).properties;

const NOW = Date.parse('2026-10-26T07:00:00.000Z');
function poll(skills: unknown): unknown {
  return { schemaVersion: 1, serverId: 'home', connectionId: 'connection-1',
    observation: { schemaVersion: 1, bodyId: 'body-1', sequence: 1, stateAt: new Date(NOW).toISOString(), receivedAt: new Date(NOW).toISOString(), connected: true, state: {}, facts: {} },
    candidates: [], activeOperationIds: [], receipts: [], skills };
}

describe('the body\'s actual act catalog (rel55) is taken by the head\'s validation', () => {
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
  it('keeps the limits the catalog sits near: the hand\'s 32 properties, the schema\'s 16,000 characters, the poll\'s 1 MiB', () => {
    expect(Object.keys((properties.hands as any).items.properties).length).toBeLessThanOrEqual(32);
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
