import { describe, expect, it } from 'vitest';
import type { BodyObservation, BodyValue } from '../src/contracts/bodyControlContract.js';
import type { MinecraftControlReceipt } from '../src/contracts/minecraftControlContract.js';
import { jobsLine, reflexesLine } from '../src/surfaces/minecraft/minecraftObservationReflexes.js';
import { minecraftSkillResult } from '../src/surfaces/minecraft/minecraftOutcome.js';
import { createPaceLedger } from '../src/surfaces/minecraft/minecraftPaceLedger.js';
import { storedBodyResult, STORED_BODY_RESULT_CHARACTERS } from '../src/surfaces/minecraft/minecraftStoredResult.js';
import { minecraftTransientBody } from '../src/surfaces/minecraft/minecraftTransientBody.js';
import { minecraftTransientObservation } from '../src/surfaces/minecraft/minecraftTransientObservation.js';

/** Transient mode, before the switch is turned on (integration review of release/19a, L-1 to L-4). */
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
/** Every string and key of a value (JSON.stringify escapes a lone surrogate, so the check reads the strings themselves). */
const strings = (value: unknown): string[] => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings)
  : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...strings(item)]) : [];
const lone = (value: unknown) => strings(value).some(item => LONE.test(item));
const frame = (world: Record<string, BodyValue>, facts: Record<string, string | number | boolean | null> = { alive: true }): BodyObservation => ({
  schemaVersion: 1, bodyId: 'b', sequence: 9, stateAt: '2026-10-17T00:00:00Z', receivedAt: '2026-10-17T00:00:01Z', connected: true, state: { world }, facts });
const failure = (failureType: string | undefined, result: string) => minecraftSkillResult({ outcome: 'failed', failureType, result } as unknown as MinecraftControlReceipt);

describe('L-1: a cut body result keeps its retry hint', () => {
  it('keeps the head and the hint of a 3,000 character failure, and says how much of the body was left out', () => {
    const result = failure('timeout', '掘れなかった。'.repeat(500));
    expect(result.text.length).toBeGreaterThan(3_000);
    const stored = storedBodyResult('mc.mine-block', result.text);
    expect(stored.length).toBeLessThanOrEqual(STORED_BODY_RESULT_CHARACTERS + 20);
    expect(stored.startsWith('掘れなかった。掘れなかった。')).toBe(true);
    expect(stored).toMatch(/…\(\d+文字省略\)\n［再試行の目安: retry_same｜そのままもう一度試せる］$/u);
  });
  it('keeps the hint of every kind, and that of a reflex cut', () => {
    for (const [type, hint] of [['interrupted_by_reflex', 'retry_same'], ['material_missing', 'need_material'], ['unsupported_target', 'invalid_input'], ['stuck', 'change_situation']] as const) {
      const stored = storedBodyResult('minecraft.craft', failure(type, 'x'.repeat(5_000)).text);
      expect(stored).toContain(`［再試行の目安: ${hint}｜`);
      expect(stored.endsWith('］')).toBe(true);
      expect(stored.length).toBeLessThan(2_100);
    }
  });
  it('does not split a surrogate pair at the cut, and leaves a result without a hint as it was cut before', () => {
    const emoji = failure('timeout', '😀'.repeat(3_000)).text;
    expect(LONE.test(storedBodyResult('mc.x', emoji))).toBe(false);
    const plain = '原木'.repeat(2_000);
    expect(storedBodyResult('mc.mine-block', plain)).toBe(`${plain.slice(0, 2_000)}…(${plain.length - 2_000}文字省略)`);
    // A hint in the middle of the text is only text; a short result is not touched.
    const middle = `［再試行の目安: retry_same｜x］\n${'y'.repeat(3_000)}`;
    expect(storedBodyResult('mc.x', middle)).toMatch(/…\(\d+文字省略\)$/u);
    const short = failure('timeout', '短い').text;
    expect(storedBodyResult('mc.x', short)).toBe(short);
  });
});

describe('L-2: a reflex cut is not the same failure again', () => {
  const call = { name: 'mc.mine-block', input: { blockName: 'iron_ore' } };
  it('does not count two reflex cuts in a row, nor end a run of a real failure', () => {
    const ledger = createPaceLedger({ kept: undefined, began: 0, now: () => 0 });
    ledger.use();
    ledger.note(call, { ok: false, failure: 'failed', bodyReflex: true }, 60_000);
    ledger.note(call, { ok: false, failure: 'failed', bodyReflex: true }, 60_000);
    expect(ledger.snapshot().sameFailure).toBeUndefined();
    expect(ledger.snapshot().last15min.mining).toBeGreaterThan(0); // Its time still counts.
    ledger.note(call, { ok: false, failure: 'failed' }, 60_000);
    ledger.note(call, { ok: false, failure: 'failed', bodyReflex: true }, 60_000);
    expect(ledger.snapshot().sameFailure).toBeUndefined();
    ledger.note(call, { ok: false, failure: 'failed' }, 60_000);
    expect(ledger.snapshot().sameFailure).toMatchObject({ tool: 'mc.mine-block', times: 2 });
  });
  it('still notices a real repeat, and the receipt of a reflex carries the mark the ledger reads', () => {
    expect(failure('interrupted_by_reflex', 'x')).toMatchObject({ bodyReflex: true });
    expect(failure('timeout', 'x').bodyReflex).toBeUndefined();
    const ledger = createPaceLedger({ kept: undefined, began: 0, now: () => 0 });
    ledger.note(call, { ok: false, failure: 'failed' }, 1); ledger.note(call, { ok: false, failure: 'failed' }, 1);
    expect(ledger.snapshot().sameFailure?.times).toBe(2);
  });
});

describe('L-3: jobs once, reflexes in a line', () => {
  const furnace = (index: number) => ({ input: 'raw_iron', count: 8 + index, status: 'waiting_external', remainingEstimateMs: 80_000, position: { x: index, y: 64, z: -2 }, unfueledInputCount: 0 });
  const bodyOf = (world: Record<string, BodyValue>) => minecraftTransientBody({ observation: frame({ dimension: 'overworld', inventory: [], ...world }), pace: { elapsedMinutes: 1 },
    fields: {}, ledger: createPaceLedger({ kept: undefined, began: 0, now: () => 0 }) }) as { observation: Record<string, unknown>; jobs?: unknown };
  it('says the jobs at the top level and not again in the observation', () => {
    const body = bodyOf({ jobs: [furnace(0), furnace(1)] });
    expect(body.jobs).toEqual([furnace(0), furnace(1)]);
    expect(body.observation).not.toHaveProperty('jobs');
    expect(JSON.stringify(body).match(/raw_iron/gu)).toHaveLength(2); // Two furnaces, each once.
  });
  it('gives jobs too long to copy as the one line of the legacy summary, still once', () => {
    const many = Array.from({ length: 12 }, (_, index) => furnace(index));
    const body = bodyOf({ jobs: many });
    expect(JSON.stringify(many).length).toBeGreaterThan(800);
    expect(body.jobs).toBe(jobsLine(many as unknown as BodyValue));
    expect(String(body.jobs)).toContain('炉（見込みで、完了の確認ではない）');
    expect(body.observation).not.toHaveProperty('jobs');
    expect(body.observation.omitted ?? []).not.toContain('world.jobs');
  });
  it('names a job list of a shape it does not know in the observation, as before', () => {
    const odd = Array.from({ length: 40 }, (_, index) => ({ kind: 'furnace', finishesInSeconds: index, note: 'あいう' }));
    const body = bodyOf({ jobs: odd });
    expect(body).not.toHaveProperty('jobs');
    expect(body.observation.omitted).toContain('world.jobs');
  });
  it('renders reflexes over 600 characters as the legacy line, never as a bare name', () => {
    const reflexes = { recent: Array.from({ length: 14 }, (_, index) => ({ ageSec: index * 5, kind: 'eat', detail: `食事（パン${index}）を取った` })), counts: { eat: 14, shield: 3 } };
    expect(JSON.stringify(reflexes).length).toBeGreaterThan(600);
    const out = minecraftTransientObservation(frame({ dimension: 'overworld', inventory: [], reflexes }));
    expect(out.reflexes).toBe(reflexesLine(reflexes));
    expect(String(out.reflexes)).toMatch(/^体の反射（新しい順）: 0秒前 食事（パン0）を取った／/u);
    expect(String(out.reflexes).length).toBeLessThanOrEqual(320);
    expect(out.omitted ?? []).not.toContain('world.reflexes');
    // Small reflexes stay as they were, and a shape the line does not know is still named.
    const small = { recent: [{ ageSec: 5, kind: 'shield', detail: '盾' }], counts: { shield: 1 } };
    expect(minecraftTransientObservation(frame({ reflexes: small })).reflexes).toEqual(small);
    expect(minecraftTransientObservation(frame({ reflexes: { odd: 'x'.repeat(700) } })).omitted).toContain('world.reflexes');
  });
  it('does not split a surrogate pair in the line of reflexes or jobs', () => {
    const filler = 'あ'.repeat(303);
    for (const detail of [`${filler}😀😀😀`, `${filler.slice(0, -1)}😀😀😀`, `${filler.slice(0, -2)}😀😀😀`]) {
      const line = reflexesLine({ recent: [{ ageSec: 1, kind: 'eat', detail }] });
      expect(line).not.toBeNull();
      expect(LONE.test(line!)).toBe(false);
    }
  });
});

describe('L-4: no lone surrogate from the world', () => {
  it('cuts an unmatched slot fact of the inventory at a whole character', () => {
    for (const pad of [185, 186, 187]) {
      const fact = `iron_ingot×4 ${'x'.repeat(pad)}${'😀'.repeat(8)}`;
      const out = minecraftTransientObservation(frame({ dimension: 'overworld', inventory: [] }, { alive: true, 'slot:3': fact }));
      expect(lone(out)).toBe(false);
      expect(JSON.stringify(out.inventory)).toContain('iron_ingot×4');
      expect(JSON.stringify(out.inventory)).toContain('@3');
    }
  });
  it('leaves none in a whole frame full of emoji', () => {
    const emoji = '😀'.repeat(300), odd = `${'a'.repeat(199)}😀😀`;
    const out = minecraftTransientObservation(frame({ dimension: 'overworld', biome: odd, heldItem: odd, inventory: [{ name: odd, count: 1 }, `${odd}×2`],
      nearbyEntities: [{ name: odd, kind: odd, distance: 3 }], nearbyThreats: [{ name: emoji, kind: odd, distance: 4 }], memo: { a: emoji.slice(0, 190), b: odd } },
    { alive: true, note: odd, 'slot:1': `iron_ingot×4 ${odd}`, 'slot:2': `${'b'.repeat(186)}${emoji}` }));
    expect(lone(out)).toBe(false);
  });
});
