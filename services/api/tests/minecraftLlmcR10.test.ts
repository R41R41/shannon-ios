import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { urgentFacts } from '../src/surfaces/minecraft/minecraftLlmcBody.js';
import { reflexHolding, reflexLine, waitForReflexRelease } from '../src/surfaces/minecraft/minecraftLlmcReflexHold.js';

/**
 * mb-llmc r10 (production run 34, 2026-10-22; task ae935fa1, 580 s): H2 the multi-hand reflex that holds the body (the seventh unknown).
 */
function frame(world: Record<string, unknown>): BodyObservation {
  return { schemaVersion: 1, bodyId: 'minecraft:s', sequence: 1, stateAt: '2026-10-22T00:00:00Z', receivedAt: '2026-10-22T00:00:00Z', connected: true,
    state: { world: world as never }, facts: { alive: true } };
}
const at = (x: number, y: number, z: number) => ({ x, y, z });

describe('H2: the multi-hand reflex that holds the body', () => {
  const FLEE = (ageSec: number) => ({ ageSec, kind: 'flee', detail: '低体力で逃げ道なし：足元を掘って下がった' });
  const withLedger = (recent: unknown[]) => frame({ position: at(220.5, 56, 62.5), health: 7.5, reflexes: { recent, counts: {} } });

  it('holds while the newest hand of a holding kind is under two seconds old (the ledger\'s ages are whole seconds)', () => {
    expect(reflexHolding(withLedger([FLEE(0), FLEE(1)]))).toMatchObject({ kind: 'flee', ageSec: 0 });
    expect(reflexHolding(withLedger([FLEE(1)]))).toMatchObject({ kind: 'flee' });
    expect(reflexHolding(withLedger([FLEE(2), FLEE(3)]))).toBeNull();
    // Newest first: an older flee does not hold when a newer reflex of another kind came after it, and a fact-only kind never holds.
    expect(reflexHolding(withLedger([{ ageSec: 0, kind: 'eat', detail: '食べた' }, FLEE(4)]))).toBeNull();
    expect(reflexHolding(withLedger([{ ageSec: 0, kind: 'melee_none', detail: '動ける手が無い' }]))).toBeNull();
    expect(reflexHolding(frame({ position: at(0, 0, 0) }))).toBeNull();
    expect(reflexHolding(null)).toBeNull();
  });

  it('the body r10 says it in facts.reflexHeld: a name holds, null is free even when the ledger is fresh; a body without the key is read by its ledger', () => {
    const facts = (reflexHeld: string | null, recent: unknown[] = []) => ({ ...withLedger(recent), facts: { alive: true, reflexHeld } as never });
    expect(reflexHolding(facts('floor-flee', [FLEE(3)]))).toMatchObject({ kind: 'flee', by: 'facts', detail: '低体力で逃げ道なし：足元を掘って下がった' });
    expect(reflexHolding(facts('floor-last-stand'))).toMatchObject({ kind: 'last-stand', by: 'facts', detail: '' });
    expect(reflexHolding(facts('lava-escape'))).toMatchObject({ kind: 'lava-escape' });
    expect(reflexHolding(facts(null, [FLEE(0)]))).toBeNull();
    expect(reflexHolding({ ...withLedger([FLEE(0)]), facts: { alive: true } })).toMatchObject({ by: 'ledger' });
    expect(reflexLine(reflexHolding(facts('floor-flee')))).toContain('観測の reflexHeld が空に戻った');
  });

  it('the urgent decision is told first, with what the reflex is doing; no line without another reason', () => {
    const piglin = { id: 848, name: 'piglin', distance: 6.9, position: at(227.5, 60, 62.5), canSee: true };
    const held = frame({ position: at(220.5, 56, 62.5), health: 7.5, reflexes: { recent: [FLEE(0)], counts: {} }, nearbyThreats: [piglin] });
    const { reasons } = urgentFacts(held, null);
    expect(reasons[0]).toBe(reflexLine(reflexHolding(held)));
    expect(reasons[0]).toMatch(/^反射の最中: flee（低体力で逃げ道なし：足元を掘って下がった）。体は反射が握っている。act は反射が放した/u);
    expect(reasons[1]).toContain('piglin 6.9m');
    expect(urgentFacts(withLedger([FLEE(0)]), null).reasons).toEqual([]);
  });

  it('the send waits until the reflex lets go, at most the limit; an aborted wait ends at once', async () => {
    let now = 0;
    const clock = { now: () => now, sleep: async (ms: number) => { now += ms; } };
    let calls = 0;
    const letGoAfter = (count: number) => () => (calls++ < count ? withLedger([FLEE(0)]) : withLedger([FLEE(3)]));
    const free = await waitForReflexRelease({ observe: letGoAfter(4), signal: new AbortController().signal, ...clock });
    expect(free).toEqual({ waitedMs: 1000, kind: 'flee', gaveUp: false });
    now = 0;
    const stuck = await waitForReflexRelease({ observe: () => withLedger([FLEE(0)]), signal: new AbortController().signal, maxMs: 2000, ...clock });
    expect(stuck).toMatchObject({ kind: 'flee', gaveUp: true, waitedMs: 2000 });
    now = 0;
    const none = await waitForReflexRelease({ observe: () => withLedger([]), signal: new AbortController().signal, ...clock });
    expect(none).toEqual({ waitedMs: 0, kind: null, gaveUp: false });
    const aborted = new AbortController();
    aborted.abort();
    now = 0;
    expect(await waitForReflexRelease({ observe: () => withLedger([FLEE(0)]), signal: aborted.signal, ...clock })).toMatchObject({ gaveUp: true, waitedMs: 0 });
  });
});
