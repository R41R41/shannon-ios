import { afterEach, expect, it } from 'vitest';
import { createWaitLedger, observedWait, readActiveWait } from '../src/surfaces/minecraft/minecraftPurposeProgress.js';
import { forgetStalls, noteProgress, restoreStalls, stallsCheckpoint } from '../src/surfaces/minecraft/minecraftLlmcStalls.js';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
afterEach(forgetStalls);
const frame = (world: object) => ({ connected: true, state: { world }, facts: {} }) as unknown as BodyObservation;
const snapshot = (extra: object = {}) => ({ node: 'food', state: 'doing', milestone: 'food', items: 3, inventory: {}, purpose: {}, ...extra });
const day = [[{ k: 'time', t: 'day' }]];
const saved = (extra: Record<string, unknown> = {}) => ({ version: 1, quiet: false, node: { snapshot: snapshot(), since: 1000 }, spot: null, explained: null,
  seen: null, waits: 0, gains: [], refusals: 0, deaths: null, ...extra });
const held = (taskId: string) => (stallsCheckpoint(taskId).minecraftStalls as { gains: string[] } | null);

it('an observed wait that ends before its deadline (the day came) starts the node window again', () => {
  noteProgress('t', snapshot(), 0);
  for (const activeMs of [60_000, 120_000, 180_000, 240_000]) expect(noteProgress('t', snapshot({ waitUntil: 300_000 }), activeMs)).toBeNull();
  expect(noteProgress('t', snapshot(), 273_000)).toBeNull();
  expect(noteProgress('t', snapshot(), 273_000 + 119_000)).toBeNull();
  expect(noteProgress('t', snapshot(), 273_000 + 120_000)?.kind).toBe('node_stalled');
});

it('a wait that ran past its deadline is held, and so is a node that never waited', () => {
  noteProgress('t', snapshot(), 0);
  expect(noteProgress('t', snapshot({ waitUntil: 300_000 }), 240_000)).toBeNull();
  expect(noteProgress('t', snapshot(), 301_000)?.kind).toBe('node_stalled');
  forgetStalls();
  noteProgress('t', snapshot(), 0);
  expect(noteProgress('t', snapshot(), 121_000)?.kind).toBe('node_stalled');
});

it('a night wait through the real pieces: quiet while it lasts, and no hold at the look right after the dawn', () => {
  const ledger = createWaitLedger(null);
  const wait = observedWait(day, frame({ dimension: 'overworld', timeOfDay: 14_000 }))!;
  const until = ledger.until('food', wait, 0)!;
  noteProgress('t', snapshot({ waitUntil: until }), 0);
  for (let ms = 30_000; ms < until - 30_000; ms += 30_000) expect(noteProgress('t', snapshot({ waitUntil: until }), ms)).toBeNull();
  const dawn = until - 20_000;
  expect(observedWait(day, frame({ dimension: 'overworld', timeOfDay: 100 }))).toBeNull();
  expect(noteProgress('t', snapshot(), dawn)).toBeNull();
  expect(noteProgress('t', snapshot(), dawn + 119_000)).toBeNull();
  expect(noteProgress('t', snapshot(), dawn + 120_000)?.kind).toBe('node_stalled');
});

it('a saved task comes back as it was, through JSON', () => {
  noteProgress('t', snapshot({ purpose: { 'have:iron_ingot': 2 } }), 5_000);
  noteProgress('t', snapshot({ purpose: { 'have:iron_ingot': 2 } }), 9_000);
  const before = stallsCheckpoint('t');
  forgetStalls();
  restoreStalls('t', JSON.parse(JSON.stringify(before.minecraftStalls)));
  expect(stallsCheckpoint('t')).toEqual(before);
});

it('a damaged checkpoint is left behind, never thrown on: the task starts counting afresh', () => {
  const damaged: Array<[string, Record<string, unknown>]> = [
    ['external work is a number', { node: { snapshot: snapshot({ externalWork: 7 }), since: 1 } }],
    ['a wait that ends in the year 10^300', { node: { snapshot: snapshot({ waitUntil: 1e300 }), since: 1 } }],
    ['the death counter has no epoch', { deaths: { deathSeq: 2 } }],
    ['the inventory holds a text', { node: { snapshot: snapshot({ inventory: { iron_ingot: 'many' } }), since: 1 } }],
    ['more evidence than a node keeps', { node: { snapshot: snapshot({ purpose: Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`explore:${i}`, 1])) }), since: 1 } }],
    ['a spot with no position', { spot: { stops: 1 } }],
    ['another version', { version: 2 }],
    ['the node is a text', { node: 'p1' }],
  ];
  for (const [name, change] of damaged) {
    forgetStalls();
    restoreStalls('t', saved(change));
    expect(stallsCheckpoint('t').minecraftStalls, name).toBeNull();
    expect(noteProgress('t', snapshot(), 0), name).toBeNull();
  }
  for (const nothing of [null, undefined, 'x', 7, []]) {
    forgetStalls();
    restoreStalls('t', nothing);
    expect(stallsCheckpoint('t').minecraftStalls).toBeNull();
  }
});

it('a task that never saw a death counter is restored with none', () => {
  restoreStalls('t', saved({ deaths: undefined }));
  expect(stallsCheckpoint('t').minecraftStalls).toMatchObject({ deaths: null, version: 1 });
});

it('only the newest 256 observed gains are kept, when saving and when restoring', () => {
  restoreStalls('t', saved({ gains: Array.from({ length: 100_000 }, (_, i) => `e${i}`) }));
  expect(held('t')?.gains).toHaveLength(256);
  expect(held('t')?.gains.at(0)).toBe('e99744');
  expect(held('t')?.gains.at(-1)).toBe('e99999');
  forgetStalls();
  restoreStalls('t', saved({ gains: ['', 'x'.repeat(300), 'ok', 7 as unknown as string] }));
  expect(held('t')?.gains).toEqual(['ok']);
});

it('a wait deadline or an active wait is read only when it is believable', () => {
  const now = Date.now();
  const ledger = createWaitLedger({ 'food:time:day': 1e300, 'food:other': now + 60_000, ['x'.repeat(300)]: 5, text: 'soon' });
  expect(Object.keys(ledger.checkpoint().minecraftWaitDeadlines)).toEqual(['food:other']);
  const many = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, now + 1_000]));
  expect(Object.keys(createWaitLedger(many).checkpoint().minecraftWaitDeadlines)).toHaveLength(128);
  expect(readActiveWait({ node: 'p2', until: now + 60_000 })).toEqual({ node: 'p2', until: now + 60_000 });
  for (const bad of [{ node: 'p2', until: 1e300 }, { node: 'x'.repeat(65), until: now }, { node: 3, until: now }, { node: 'p2' }, 'p2', null, undefined]) {
    expect(readActiveWait(bad)).toBeUndefined();
  }
});

it('past 256 pieces of evidence the oldest observation cells are forgotten: a new cell still counts, a remembered one does not', () => {
  const seen = (cell: string, extra: Record<string, number> = {}) => snapshot({ purpose: { 'have:iron_ingot': 0, ...extra, [`explore:${cell}`]: 1 } });
  noteProgress('t', seen('c0'), 0);
  for (let i = 1; i <= 300; i++) expect(noteProgress('t', seen(`c${i}`), i * 130_000), `cell ${i}`).toBeNull();
  expect(noteProgress('t', seen('c300'), 301 * 130_000)?.kind).toBe('node_stalled');
});

it('the objective\'s own evidence is kept when cells are forgotten', () => {
  noteProgress('t', snapshot({ purpose: { 'have:iron_ingot': 0, 'explore:c0': 1 } }), 0);
  for (let i = 1; i <= 300; i++) noteProgress('t', snapshot({ purpose: { 'have:iron_ingot': 0, [`explore:c${i}`]: 1 } }), i * 100_000);
  expect(noteProgress('t', snapshot({ purpose: { 'have:iron_ingot': 1, 'explore:c300': 1 } }), 301 * 100_000 + 130_000)).toBeNull();
  expect(noteProgress('t', snapshot({ purpose: { 'have:iron_ingot': 1, 'explore:c300': 1 } }), 301 * 100_000 + 130_000 + 121_000)?.kind).toBe('node_stalled');
});
