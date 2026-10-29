import fs from 'node:fs';
import { withoutOutside } from './helpers/promiseLine.js';
import { describe, expect, it } from 'vitest';
import type { PlanPromise } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { dependStateOf, unitView, type InventoryEvent, type Progress } from '../src/contracts/continueContract.js';
import type { ActHand, ActHandLine, ActResult } from '../src/contracts/minecraftActContract.js';
import { actResultText } from '../src/surfaces/minecraft/minecraftLlmc.js';
import { FIGHT_END_WORDS, handFacts, seenWords, VERTICAL_STOP_WORDS } from '../src/surfaces/minecraft/minecraftLlmcResultWords.js';
import { applyLedger, emptyLedgerSeen, promiseLines, type LedgerSeen } from '../src/surfaces/minecraft/minecraftLlmcPromises.js';
import { handToLine, lineToHand } from '../src/contracts/minecraftActShortHands.js';
import { SHORT_ACT_DESCRIPTION } from '../src/contracts/minecraftActShortContract.js';

/**
 * The head's side of amendments A-1 6 (vertical's stop words and `Progress.seen`), A-2 2 (a dropped item whose cause is a cancel), A-2 3 (armour put on in the ledger) and
 * A-2 5 (how a fight ended: the fixture `result/fight-target-escaped.json`, whose `expected` is the master). The defaults and the range of vertical's limits are in
 * `continueVertical.test.ts`; the produced files of the body are in `continueProduced.test.ts`.
 */
const fixture = (path: string) => JSON.parse(fs.readFileSync(new URL(`./fixtures/continue/${path}.json`, import.meta.url), 'utf8')) as Record<string, any>;
const line = (extra: Partial<ActHandLine>): ActHandLine => ({ i: 1, do: 'vertical', status: 'stopped', line: 'vertical 止まった', goal: 'partial', end: 'finished', motorOps: 5, ...extra });
const textOf = (hand: ActHandLine, ok = false): string => {
  const result: ActResult = { v: 1, ok, done: ok ? 1 : 0, of: 1, lines: [hand], at: { x: 0, y: 64, z: 0 }, hp: 20, food: 20, ms: 1000 } as ActResult;
  return actResultText(result);
};

describe('vertical: the 14 stop codes are told in words, and `displaced` and `no_foothold` read as two things (amendment A-1 6)', () => {
  const FOURTEEN = ['unloaded', 'world_limit', 'displaced', 'no_foothold', 'cannot_dig', 'no_floor', 'no_place', 'place_unconfirmed', 'limit_dig', 'limit_place', 'limit_time',
    'lava', 'water', 'seal_failed'];
  it('has a word for each of the 14 codes and for nothing else', () => {
    expect(Object.keys(VERTICAL_STOP_WORDS).sort()).toEqual([...FOURTEEN, 'threat_exposed'].sort());
  });
  it('run 46: threat_exposed (the exposure guard refused the dig) is told with the own sentence of the hand, and the stairs and the shaft default of the footing is in the description', () => {
    const line = { i: 1, do: 'vertical', status: 'stopped', code: 'threat_exposed', goal: 'partial', end: 'finished', motorOps: 3,
      line: 'vertical 止まった threat_exposed: stone(1,40,2) を開けると、今は届かない zombie（約8m）から体が見える・届く。敵が離れるのを待つ（wait-time）か、toward を変えるか' } as unknown as ActHandLine;
    const facts = handFacts(line).join(' ');
    expect(facts).toContain('止まった理由 threat_exposed:');
    expect(facts).toContain('開けていない');
    expect(SHORT_ACT_DESCRIPTION).toContain('stairs・shaft は place= を書かないと、持っている丸石・深層岩の丸石・土を足場に置いてよい');
    expect(SHORT_ACT_DESCRIPTION).toContain('place=none');
    expect(SHORT_ACT_DESCRIPTION).toContain('vertical の手の中だけ、柵・レール・クモの巣・松明・はしご・つた・糸は書かなくても壊す。go・dig は変わらない');
    // place=none is the body's refusal of the default footing: canPlace [none]; and no place= leaves the field out (the body then defaults it for stairs and shaft)
    expect(lineToHand('vertical down stairs south y=10 dig=stone,dirt place=none liquid=stop')).toMatchObject({ do: 'vertical', canPlace: ['none'] });
    expect(lineToHand('vertical down stairs south y=10 dig=stone,dirt liquid=stop')).not.toHaveProperty('canPlace');
    expect(handToLine(lineToHand('vertical down shaft y=10 dig=stone place=none liquid=stop') as ActHand)).toContain('place=none');
    expect(SHORT_ACT_DESCRIPTION).toContain('pillar は書いた物で作る');
  });
  it('covers every code of the fixture vertical/stop-cases.json (the master of the scenes)', () => {
    const sample = fixture('vertical/stop-cases');
    expect(sample.expected.codes.length).toBeGreaterThanOrEqual(9);
    for (const code of sample.expected.codes as string[]) expect(VERTICAL_STOP_WORDS[code], code).toBeTruthy();
    expect(sample.expected.codes).toContain('no_foothold');
    expect(sample.expected.codes).toContain('displaced');
  });
  it('tells `displaced` (the body was moved off the step: a fall, a push) from `no_foothold` (it was not moved and could not step onto the footing)', () => {
    const displaced = VERTICAL_STOP_WORDS.displaced!, foothold = VERTICAL_STOP_WORDS.no_foothold!;
    expect(displaced).toContain('落ちたか押し戻された');
    expect(displaced).toContain('足場が無かったのではない');
    expect(foothold).toContain('落ちても押し戻されてもいない');
    expect(foothold).toContain('displaced とは別');
    expect(displaced).not.toEqual(foothold);
  });
  it('says of lava and water only what the body saw and which liquid values stop on it: seal_water does not stop on water (it seals it), and is not said to have stopped there (fixtures vertical/lava-seal-and-stop.json)', () => {
    const water = VERTICAL_STOP_WORDS.water!, lava = VERTICAL_STOP_WORDS.lava!;
    expect(water).toContain('水で止まるのは liquid=stop');
    expect(water).toContain('seal と seal_water は水を塞いで進む');
    expect(water).not.toMatch(/seal_water なので止まった|seal_water.*止まった/u);
    expect(lava).toContain('溶岩で止まるのは liquid=stop と seal_water');
    expect(lava).not.toContain('liquid=stop なので止まった');
  });
  it('is the same facts-only kind as the rest: no word of any of the 14 tells the model what to do', () => {
    for (const [code, words] of Object.entries(VERTICAL_STOP_WORDS)) expect(words, code).not.toMatch(/すること|しなさい|してください|べき|出し直|試す|増や(して|す)|変え(て|る)/u);
  });
  it('adds the word of the stop to the hand\'s facts, for a vertical hand only', () => {
    const facts = handFacts(line({ code: 'no_foothold', progress: { unit: 'step', done: 9, left: 1, at: { x: 0, y: 91, z: 9 } } }));
    expect(facts.some(item => item.startsWith('  事実: 止まった理由 no_foothold: '))).toBe(true);
    expect(handFacts(line({ do: 'go', code: 'no_foothold' })).some(item => item.includes('止まった理由'))).toBe(false);
    expect(handFacts(line({ code: 'limit_dig' })).join('\n')).toContain('掘る数の上限 maxDig');
  });
  it('reaches the model\'s result text, and the two lines say different things', () => {
    const one = textOf(line({ code: 'displaced', line: 'vertical 止まった displaced: 予定の段からずれた' }));
    const two = textOf(line({ code: 'no_foothold', line: 'vertical 止まった no_foothold: 次の段へ踏み出せなかった' }));
    expect(one).toContain('止まった理由 displaced:');
    expect(two).toContain('止まった理由 no_foothold:');
    expect(one).not.toContain('no_foothold');
    expect(two).not.toContain('落ちたか押し戻された');
  });
});

describe('Progress.seen: the ore a vertical hand saw on its way is told as what was seen, never followed (amendment A-1 6)', () => {
  const seen: NonNullable<Progress['seen']> = [{ block: 'iron_ore', at: { x: 3, y: 12, z: -4 } }, { block: 'diamond_ore', at: { x: 5, y: 9, z: -4 } }];
  it('is read from progress.seen, as a fact, on a hand that arrived too', () => {
    expect(seenWords(seen)).toBe('iron_ore(3,12,-4)・diamond_ore(5,9,-4)');
    const arrived = handFacts(line({ status: 'done', goal: 'done', end: 'finished', progress: { unit: 'step', done: 20, left: 0, seen } }));
    expect(arrived).toEqual(['  事実: 途中で見えた物（追っていない）: iron_ore(3,12,-4)・diamond_ore(5,9,-4)']);
  });
  it('keeps the eight at most the body sends, and says nothing when there is none', () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ block: 'coal_ore', at: { x: index, y: 1, z: 1 } }));
    expect(seenWords(many).split('・')).toHaveLength(8);
    expect(handFacts(line({ goal: 'done', end: 'finished', status: 'done', progress: { unit: 'step', done: 3, left: 0 } }))).toEqual([]);
  });
  it('is not mixed into the line of a plain stop (a stop is read from the code, the ore beside it)', () => {
    const facts = handFacts(line({ code: 'limit_time', progress: { unit: 'step', done: 4, left: 9, seen } }));
    expect(facts.filter(item => item.includes('途中で見えた物'))).toHaveLength(1);
    expect(facts.join('\n')).not.toMatch(/追え|掘れ/u);
  });
});

describe('fight: how it ended is told apart (amendment A-2 5; the fixture result/fight-target-escaped.json is the master)', () => {
  const sample = fixture('result/fight-target-escaped');
  const hands = sample.expected.cases.map((one: any) => one.hand as { goal: ActHandLine['goal']; code: string });
  const fight = (goal: ActHandLine['goal'], code: string): ActHandLine => line({ do: 'fight', status: goal === 'done' ? 'done' : 'stopped', goal, end: 'finished', code, motorOps: 20 });
  it('has the four endings of the fixture: three are done with a code, a lost one is unknown', () => {
    expect(hands.map((hand: any) => [hand.goal, hand.code])).toEqual([['done', 'target_killed'], ['done', 'target_escaped'], ['done', 'target_left'], ['unknown', 'target_lost']]);
    expect(Object.keys(FIGHT_END_WORDS)).toEqual(['target_killed', 'target_escaped', 'target_left']);
  });
  it('says an escaped opponent is alive and out of range, and does not say it was killed', () => {
    const escaped = handFacts(fight('done', 'target_escaped')).join('\n'), killed = handFacts(fight('done', 'target_killed')).join('\n');
    expect(escaped).toContain('相手は生きていて、範囲の外にいる');
    expect(escaped).not.toContain('死を観測');
    expect(killed).toContain('相手の死を観測した');
    expect(killed).not.toContain('生きて');
    expect(escaped).not.toEqual(killed);
  });
  it('says a left opponent (fleeing) was not killed either, and a lost one is not known (the old words, kept)', () => {
    expect(handFacts(fight('done', 'target_left')).join('\n')).toContain('相手は倒していない');
    expect(handFacts(fight('unknown', 'target_lost')).join('\n')).toContain('相手を見失った。倒したかは見ていない');
  });
  it('keeps the success: the act is ok and its text counts the hand done, whatever the code says', () => {
    const text = textOf(fight('done', 'target_escaped'), true);
    expect(text.split('\n')[0]).toContain('act 全部済み');
    expect(text).toContain('相手は生きていて、範囲の外にいる');
  });
  it('only reads the code on a fight hand that is done (a go with the same word is left alone)', () => {
    expect(handFacts(line({ do: 'go', goal: 'done', status: 'done', end: 'finished', code: 'target_escaped' }))).toEqual([]);
  });
});

describe('a dropped item whose cause is a cancel is not a failure of its hand, in the table and in the words (amendment A-2 2)', () => {
  it('is what the dependency table says: an item not run (or cut with no operation) is `failed` only for the ones that rely on it, never `unknown`, with the cancelled old word', () => {
    const table = fixture('continue/dependency-table');
    const rows = (table.outcomes as Array<{ goal: string; end: string; released: boolean; dependState: string; old: { outcome: string } }>).filter(row => row.old.outcome === 'cancelled');
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const row of rows) expect(dependStateOf(unitView({ goal: row.goal as never, end: row.end as never, released: row.released })), `${row.goal}/${row.end}`).toBe(row.dependState);
    // the (not_started, cut) row of amendment A-1 2: the same as the not_started one
    expect(dependStateOf(unitView({ goal: 'not_started', end: 'cut', released: true }))).toBe(dependStateOf(unitView({ goal: 'not_started', end: 'not_run', released: true })));
  });
});

// ---- the ledger: armour put on (amendment A-2 3) ---------------------------------------------------------------------------------------------------
const T0 = Date.parse('2026-10-28T10:00:00.000Z');
const iso = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const frame = (seq: number, items: Record<string, number>, worn?: string): BodyObservation => ({ schemaVersion: 1, bodyId: 'minecraft:world', sequence: seq, stateAt: iso(seq), receivedAt: iso(seq),
  connected: true, state: { world: { inventory: items, dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, ...(worn ? { worn } : {}) }, bodyRun: { bodyBoot: 'bb-1', connectionId: 'c-1' } } as never,
  facts: {} });
const event = (id: string, item: string, count: number, reason: InventoryEvent['reason'], seq: number): InventoryEvent => ({ id, obsSeq: seq, item, count, reason });
const WORN_NONE = '頭: なし、胴: なし、脚: なし、足: なし';

describe('the ledger tells armour put on as worn, not as used (amendment A-2 3)', () => {
  const promise = (): PlanPromise => ({ id: 2, rev: 1, item: 'iron_chestplate', count: 1, use: '防具', state: 'open', ledger: [] });
  const apply = (promises: PlanPromise[], seen: LedgerSeen, at: number, observation: BodyObservation, events: InventoryEvent[]) => applyLedger(promises, seen, { events, observation, at: iso(at) });

  it('the reflex puts the chestplate on: a `moved` line (reflex_armor), the count she has stays 1, and nothing is unexplained', () => {
    const first = apply([promise()], emptyLedgerSeen(), 0, frame(1, { iron_chestplate: 1 }, WORN_NONE), []);
    expect(first.promises[0]!.have).toBe(1);
    const wearing = apply(first.promises, first.ledgerSeen, 5, frame(2, {}, '頭: なし、胴: iron_chestplate(残り 240)、脚: なし、足: なし'), [event('reflex:c-1:1', 'iron_chestplate', -1, 'reflex_armor', 2)]);
    expect(wearing.added).toEqual([expect.objectContaining({ kind: 'moved', count: 1, reason: 'reflex_armor', have: 1, promise: 2 })]);
    expect(wearing.added.some(entry => entry.kind === 'unexplained' || entry.kind === 'consumed')).toBe(false);
    expect(wearing.promises[0]!.have).toBe(1);
  });
  it('the live line says it was put on, the count unchanged, and does not say it was used up or short', () => {
    const first = apply([promise()], emptyLedgerSeen(), 0, frame(1, { iron_chestplate: 1 }, WORN_NONE), []);
    const shot = frame(2, {}, '頭: なし、胴: iron_chestplate(残り 240)、脚: なし、足: なし');
    const wearing = apply(first.promises, first.ledgerSeen, 5, shot, [event('reflex:c-1:1', 'iron_chestplate', -1, 'reflex_armor', 2)]);
    const lines = promiseLines(wearing.promises, { since: iso(1), observation: shot }).map(withoutOutside);
    expect(lines).toEqual(['約束 #2 防具用のiron_chestplate 1: 今 1・直前に 1 身に着けた（理由: 反射で防具を着た。持ち物から防具の欄へ移っただけで、持っている数は変わらない）']);
    expect(lines[0]).not.toContain('減った');
    expect(lines[0]).not.toContain('足りない');
  });
  it('is not the same as a chest: stored still takes the count off, retrieved puts it back', () => {
    const planks: PlanPromise = { id: 1, rev: 1, item: 'planks', count: 4, use: '作業台', state: 'open', ledger: [] };
    const first = apply([planks], emptyLedgerSeen(), 0, frame(1, { oak_planks: 6 }), []);
    const stored = apply(first.promises, first.ledgerSeen, 5, frame(2, { oak_planks: 2 }), [event('skill:q5:1:1:1', 'oak_planks', -4, 'stored', 2)]);
    expect(stored.added).toEqual([expect.objectContaining({ kind: 'moved', count: 4, reason: 'stored', have: 2 })]);
    expect(promiseLines(stored.promises, { since: iso(1), observation: frame(2, { oak_planks: 2 }) })[0]).toContain('4 減った');
    const back = apply(stored.promises, stored.ledgerSeen, 9, frame(3, { oak_planks: 6 }), [event('skill:q6:1:1:1', 'oak_planks', 4, 'retrieved', 3)]);
    expect(promiseLines(back.promises, { since: iso(6), observation: frame(3, { oak_planks: 6 }) })[0]).toContain('4 増えた');
  });
  it('is once by id, as every event is: the same armour event again is not a second line', () => {
    const first = apply([promise()], emptyLedgerSeen(), 0, frame(1, { iron_chestplate: 1 }, WORN_NONE), []);
    const shot = frame(2, {}, '頭: なし、胴: iron_chestplate(残り 240)、脚: なし、足: なし');
    const once = apply(first.promises, first.ledgerSeen, 5, shot, [event('reflex:c-1:1', 'iron_chestplate', -1, 'reflex_armor', 2)]);
    const again = apply(once.promises, once.ledgerSeen, 6, shot, [event('reflex:c-1:1', 'iron_chestplate', -1, 'reflex_armor', 2)]);
    expect(again.added).toEqual([]);
  });
});

describe('A-5 3: a placement the body counted and then found gone is a fact said once', () => {
  it('reads progress.corrected of a vertical hand into one fact each, and says the valid steps were counted again', async () => {
    const { placementCorrections } = await import('../src/surfaces/minecraft/minecraftLlmcResultWords.js');
    const result = JSON.stringify({ v: 1, ok: true, done: 1, of: 1, ms: 1000, at: { x: 191, y: 58, z: 188 }, hp: 20, food: 20,
      lines: [{ i: 1, do: 'vertical', status: 'done', line: '', progress: { unit: 'step', done: 6, left: 0, corrected: [{ at: { x: 191, y: 59, z: 188 }, was: 'cobblestone', now: 'air', step: 7 }] } }] });
    const facts = placementCorrections('q90', result);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.text).toContain('置いた (191,59,188) が無くなった');
    expect(facts[0]!.text).toContain('今 air');
    expect(facts[0]!.text).toContain('今 6 段');
    expect(placementCorrections('q90', undefined)).toEqual([]);
  });
});
