import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import type { ActResult } from '../src/contracts/minecraftActContract.js';
import { urgentFacts } from '../src/surfaces/minecraft/minecraftLlmcBody.js';
import { reflexHolding, reflexLine, waitForReflexRelease } from '../src/surfaces/minecraft/minecraftLlmcReflexHold.js';
import { sightLineCells, sightLineText } from '../src/surfaces/minecraft/minecraftLlmcSightLine.js';
import { stopFacts } from '../src/surfaces/minecraft/minecraftLlmcStopFacts.js';
import { llmcResult } from '../src/surfaces/minecraft/minecraftLlmc.js';
import type { MinecraftControlReceipt } from '../src/contracts/minecraftControlContract.js';

/**
 * mb-llmc r10 (production run 34, 2026-10-22; task ae935fa1, 580 s): H2 the multi-hand reflex that holds the body (the seventh unknown), H3 the
 * facts a stopped hand's cut line leaves out (24 of 50 acts stopped), H5 the cell on the line to a hostile that hits from a distance (a piglin
 * at 6 m hit her six times in 14 s and the head's wall stood on the tunnel's axis). The acts are the body's own receipts of that run
 * (`fixtures/minecraft-run34-stops-v1.json`, read with mode=ro), not made-up lines.
 */
interface Stop { n: number; t: number; outcome: string; why: string; hands: unknown[]; result: ActResult }
const fixture = JSON.parse(readFileSync(new URL('./fixtures/minecraft-run34-stops-v1.json', import.meta.url), 'utf8')) as { acts: Stop[] };
const stop = (n: number): Stop => fixture.acts.find(item => item.n === n)!;
const factsOf = (n: number, observation: BodyObservation | null = null) => stopFacts(stop(n).result, { hands: stop(n).hands }, observation);
function frame(world: Record<string, unknown>): BodyObservation {
  return { schemaVersion: 1, bodyId: 'minecraft:s', sequence: 1, stateAt: '2026-10-22T00:00:00Z', receivedAt: '2026-10-22T00:00:00Z', connected: true,
    state: { world: world as never }, facts: { alive: true } };
}
const at = (x: number, y: number, z: number) => ({ x, y, z });

describe('H3: what a stopped hand\'s line leaves out, said from the run-34 receipts', () => {
  it('a walk whose head cell is rock: the head cell is the wall, the foot is open in the map, a walk does not dig (4 of the 9 stops)', () => {
    const [fact] = factsOf(1);
    expect(fact).toContain('頭のマス (309,65,73) が nether_bricks で塞がっている（足のマス (309,64,73) は空いている）');
    expect(fact).toContain('walk は掘らない');
    expect(fact).toContain('dig at [(309,65,73)] してから walk し直す');
    // The target (308,62,73) is lower: no row of cells to dig along a level that is not the way.
    expect(fact).not.toContain('(308,64,73)');
    expect(factsOf(8)[0]).toContain('頭のマス (299,61,73) が basalt');
  });

  it('a dig out of reach: how far, the foot of the last column dug whole (not the stopped cell\'s own), the cells that are left', () => {
    expect(factsOf(5)).toEqual(['頭の補足（3 dig）: 止まった所 (300,61,73) は止まった時の足 (305,61,73) から 5.1m（dig は歩かず、足の場所から約 4.5m までしか届かない）。'
      + '続きは walk で (301,61,73)（最後に掘り終えた列の足のマス）へ進んでから dig（残り 1 マス: (300,61,73)）']);
    expect(factsOf(9)[0]).toContain('続きは walk で (295,59,73)');
    expect(factsOf(9)[0]).toContain('残り 4 マス: (294,60,73)・(294,59,73)・(293,60,73)・(293,59,73)');
    expect(factsOf(24)[0]).toContain('続きは walk で (238,57,63)');
  });

  it('a rise of 2 is two wall cells, not the lower one alone; a target filled with rock or with no floor under it', () => {
    const [step] = factsOf(11);
    expect(step).toContain('段差 2: (286,57,73) netherrack と (286,58,73) netherrack の 2 マスが壁');
    expect(step).toContain('2 マスとも dig at で空けて歩く');
    expect(factsOf(17)).toEqual(['頭の補足（2 walk）: 目的地 (262,57,63) は netherrack で埋まっている: dig at [(262,57,63)] で空けてから立つか、「立てる隣」へ walk する']);
    expect(factsOf(25)[0]).toContain('目的地 (217,57,63) の下は空気が 3 マス: 立つ床が無い。place で床 (217,56,63) を置いてから立つか');
  });

  it('an opening that would be seen: the hostiles of the frame with their distance and height, far ones said as far (the body\'s line holds the first)', () => {
    const blazes = [{ id: 2, name: 'blaze', distance: 14.5, position: at(311.5, 71, 72.5), canSee: false }, { id: 22, name: 'blaze', distance: 15.2, position: at(311.5, 71, 70.5), canSee: false }];
    const [fact] = factsOf(6, frame({ position: at(300.5, 61, 73.5), nearbyThreats: blazes }));
    expect(fact).toContain('開けるマス (299,61,73)（足から 西1）を開けると見られる敵: blaze #2 14.5m（東11・北1・上10）・blaze #22 15.2m（東11・北3・上10）');
    expect(fact).toContain('どれも 10m 以上離れている');
    expect(fact).toContain('exposeOk:true');
    // The frame has no hostile: said so, not made up.
    expect(factsOf(18)[0]).toContain('枠に敵の位置が無い');
  });

  it('a place: a cell the body says is filled needs no block; a cell with nothing to put against needs a placed block beside it; a hand that went on says no more', () => {
    expect(factsOf(19)).toEqual(['頭の補足（3 place）: (261,57,62) は既に固いブロックがある（置く必要は無い。壁のためならそのままでよい）。']);
    const [support] = factsOf(20);
    expect(support).toContain('空中のマスには支えが要る（6 面とも空気だと置けない）');
    expect(support).toContain('今立っている足元の隣');
    // Its second stop is a walk onto a cell with no floor: the floor to place.
    expect(factsOf(20)).toHaveLength(2);
    expect(factsOf(20)[1]).toContain('place で床 (259,56,63)');
  });

  it('an attack hold against a piglin 6.4 m away (8.4 s standing, 3.8 taken): it never chases, and the line to it is named', () => {
    const piglin = { id: 848, name: 'piglin', distance: 6.4, position: at(219.5, 58, 62.5), canSee: true, canReachMe: true };
    const [fact] = factsOf(26, frame({ position: at(226.5, 57, 63.5), nearbyThreats: [piglin] }));
    expect(fact).toContain('attack の hold は目から 3m 以内の相手にだけ当たり、追わない');
    expect(fact).toContain('線上のマス (225,58,63)');
    // Not in the frame: the hold's own fact still stands without a cell.
    expect(factsOf(26)[0]).toBe('頭の補足（2 attack）: attack の hold は目から 3m 以内の相手にだけ当たり、追わない: 立って待つほど撃たれる');
  });

  it('every fact of the run\'s stops is short, and a cancelled or done act has none', () => {
    for (const item of fixture.acts) for (const fact of factsOf(item.n)) {
      expect(fact.length, `#${item.n}`).toBeLessThan(420);
      expect(fact).not.toMatch(/undefined|NaN|\[object/u);
    }
    expect(stopFacts({ ...stop(1).result, ok: true }, { hands: stop(1).hands }, null)).toEqual([]);
  });

  it('comes with the act\'s result text, after the body\'s lines, through the head\'s result of an act', () => {
    const receipt = { id: 'a', connectionId: 'c', outcome: 'failed', inputsReleased: true, observedAt: '2026-10-22T00:00:00Z', result: JSON.stringify(stop(5).result) } as MinecraftControlReceipt;
    const result = llmcResult('mc.act', receipt, null, [], { hands: stop(5).hands, why: 'x' }, null);
    expect(result.text).toContain('届かない: (304,62,73)');
    expect(result.text).toContain('\n頭の補足（3 dig）: 止まった所 (300,61,73)');
    // The body's r10: an act that began after a reflex let go says so (afterReflex), and one that could not begin is a plain failed receipt, read as text.
    const after = { ...receipt, outcome: 'completed', result: JSON.stringify({ ...stop(5).result, ok: true, afterReflex: '反射 flee（低体力の逃走）の最中のため、放された後に始めた（待ち 1.6秒）' }) } as MinecraftControlReceipt;
    expect(llmcResult('mc.act', after, null, []).text.split('\n')[1]).toBe('（反射 flee（低体力の逃走）の最中のため、放された後に始めた（待ち 1.6秒））');
    const late = { ...receipt, outcome: 'failed', result: '反射 flee（低体力の逃走）の最中で、時間内に放されなかったため始められなかった（3.0秒待った。体は何も動かしていない）。放された後に頼み直す' } as MinecraftControlReceipt;
    expect(llmcResult('mc.act', late, null, []).text).toContain('放された後に頼み直す');
    // Without the input (a caller that does not pass it): as before.
    expect(llmcResult('mc.act', receipt, null, []).text).not.toContain('頭の補足');
  });
});

describe('H5: the cell on the line to a hostile that hits from a distance', () => {
  // Run 34, +498: she at (226,57,63) in a tunnel running west, the piglin #848 6.4 m away at (219,58,62), in sight; its crossbow hit six times in 14 s.
  const HER = at(226.5, 57, 63.5), PIGLIN = { id: 848, name: 'piglin', kind: 'hostile', distance: 7.1, position: at(219.5, 58, 62.5), canSee: true, canReachMe: true };
  const scene = (threat: Record<string, unknown>) => frame({ position: HER, health: 16, nearbyThreats: [threat], nearbyEntities: [threat] });

  /** The body's `solidBetween` (probeTools.ts): the cells a straight line from the eye to the creature's middle passes, not the first or the last. */
  function bodyRay(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }) {
    const a: [number, number, number] = [from.x, from.y + 1.62, from.z], b: [number, number, number] = [to.x, to.y + 1.8 * 0.5, to.z];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), steps = Math.max(1, Math.ceil(d / 0.05));
    const first = a.map(Math.floor).join(','), last = b.map(Math.floor).join(','), seen = new Set<string>();
    for (let i = 1; i < steps; i++) {
      const key = [0, 1, 2].map(axis => Math.floor(a[axis]! + (b[axis]! - a[axis]!) * i / steps)).join(',');
      if (key !== first && key !== last) seen.add(key);
    }
    return seen;
  }

  it('the urgent line of a piglin in sight names the cells on the line; they are cells the body\'s own sight passes, and the tunnel\'s axis is not', () => {
    const [reason] = urgentFacts(scene(PIGLIN), null).reasons;
    expect(reason).toMatch(/^piglin 7\.1m.*。線上のマス \(225,58,63\)（目から約 1\.5m。ここにブロックを置くと射線が切れる。届かなければ \(224,58,63\)。トンネルの軸に置いても線の上でなければ切れない）$/u);
    const ray = bodyRay(HER, PIGLIN.position);
    expect(ray.has('225,58,63')).toBe(true);
    expect(ray.has('224,58,63')).toBe(true);
    // Run 34's first answer: a wall in the tunnel's axis at the far end, which the sight still saw through.
    expect(ray.has('219,57,63') || ray.has('219,58,63')).toBe(false);
    expect(sightLineCells(HER, PIGLIN.position)).toEqual([at(225, 58, 63), at(224, 58, 63)]);
  });

  it('only a hostile that hits from a distance and sees her; none nearer than 3 m; a walker, or one that cannot see her, has no line', () => {
    expect(urgentFacts(scene({ ...PIGLIN, name: 'zombie' }), null).reasons[0]).not.toContain('線上のマス');
    expect(urgentFacts(scene({ ...PIGLIN, canSee: false }), null).reasons[0]).not.toContain('線上のマス');
    expect(urgentFacts(scene({ ...PIGLIN, name: 'skeleton' }), null).reasons[0]).toContain('線上のマス');
    expect(sightLineText(scene({ ...PIGLIN, distance: 2.5, position: at(224.5, 57, 63.5) }), 848)).toBeNull();
    expect(sightLineText(scene(PIGLIN), 7)).toBeNull();
    expect(sightLineText(null, 848)).toBeNull();
  });
});

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
