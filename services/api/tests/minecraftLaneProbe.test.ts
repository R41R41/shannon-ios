import { describe, expect, it } from 'vitest';
import { MC_PROBE_TOOL, PROBE_DESCRIPTION, PROBE_INPUT_SCHEMA, PROBE_KINDS } from '../src/contracts/minecraftProbeContract.js';
import { readLaneProbeResult } from '../src/contracts/minecraftLaneProbeContract.js';
import { validSkillInput } from '../src/surfaces/minecraft/minecraftControlValidation.js';
import { llmcPrepare, llmcResult, llmcStoredResult } from '../src/surfaces/minecraft/minecraftLlmc.js';
import { laneProbeFacts } from '../src/surfaces/minecraft/minecraftLaneProbeFacts.js';
import { prepareProbeInput, probeAnswerText, probeLabel } from '../src/surfaces/minecraft/minecraftLlmcProbeInput.js';

const at = (x: number, y: number, z: number) => ({ x, y, z });
const context = { feet: at(0, 20, 0), creatures: [] };
type Cell = [number, number, number, string | null, string];
const cell = (x: number, y: number, z: number): Cell => [x, y, z, 'air', 'air'];

/** Synthetic v1 tables, in the exact column order of S2's laneProbeFields (including its added standFact column). */
function report() {
  const cells: Cell[] = [cell(1, 21, 0), cell(2, 20, 0), cell(2, 21, 0), cell(3, 20, 0), cell(3, 21, 0),
    cell(4, 20, 0), cell(4, 21, 0), cell(5, 20, 0), cell(5, 21, 0), cell(5, 20, 1), cell(5, 20, 2),
    cell(5, 20, 3), cell(5, 20, 4), cell(6, 20, 0)];
  const best = { direction: 'east', plug: 0, lane: [[1, 2], [3, 4], [5, 6]], waiting: [7, 8],
    required: { enclosure: 8, roof: 3, plug: 1, lid: 20, total: 32, unknown: 0, complete: true },
    build: [[0, 0, null, 3, 9, 1], [0, 0, null, 2, 9, 1], [0, 1, null, 1, 10, 2],
      [0, 1, null, 7, 11, 3], [0, 2, null, 4, 12, 4], [0, 3, null, 0, null, null]],
    clear: [1, 2], hazards: [[1, true], [7, false], [8, false]], remainingOutsideLane: 2, unknownOutsideLane: 0 };
  const candidates = [best, ...['west', 'south', 'north'].map((direction, i) => ({ ...best, direction,
    required: { ...best.required, total: 35 + i * 5 }, plug: 13, lane: [[13, 13]], waiting: [13, 13] }))];
  return { v: 1, kind: 'lane', found: true,
    text: '湧ける空間は12か所。建築順は囲み、屋根と栓、蓋が基本で支えを先にする。',
    spawner: at(0, 20, 0), from: at(-2, 20, 0),
    spawn: { min: at(-4, 19, -4), max: at(4, 21, 4), spaces: 12, columns: 4, unknown: 0 },
    blaze: { count: 2, limit: 6, atLimit: false, min: at(-4, 16, -4), max: at(5, 25, 5) },
    candidates, cells, facts: [[13, true, 0, 0, 'solid', false, 0]], standFacts: [[null, false, false]],
    rows: { indexBase: 0, cells: ['x', 'y', 'z', 'name', 'state'],
      facts: ['cell', 'supportNow', 'occupiedCount', 'belowDepth', 'belowEnd', 'needsClearing', 'standFact'],
      build: ['fact', 'partIndex', 'supportAfterCell', 'flags', 'standAtCell', 'group'],
      parts: ['enclosure', 'roof', 'plug', 'lid'], flags: { inReach: 1, visibleNow: 2, noSupport: 4 },
      lane: ['feetCell', 'headCell'], waiting: ['feetCell', 'headCell'], hazards: ['cell', 'inside'],
      standFacts: ['noStand', 'blockedByCreature', 'fireNear'] } };
}

describe('mc.probe kind=lane input', () => {
  it('offers lane with optional spawner and from, with the same finite coordinate validation as the body', () => {
    expect(PROBE_KINDS).toContain('lane');
    expect(PROBE_DESCRIPTION).toContain('lane(spawner, from:');
    expect(validSkillInput({ kind: 'lane' }, PROBE_INPUT_SCHEMA)).toBe(true);
    expect(prepareProbeInput({ kind: 'lane' }, context)).toEqual({ input: { kind: 'lane' }, fixes: [], problem: null });
    const input = { kind: 'lane', spawner: at(0, 20, 0), from: at(-2, 20, 0) };
    expect(llmcPrepare(MC_PROBE_TOOL, input, context)).toEqual({ input, fixes: [], problem: null });
    expect(validSkillInput(input, PROBE_INPUT_SCHEMA)).toBe(true);
    expect(probeLabel({ kind: 'lane', spawner: input.spawner })).toBe('lane (0,20,0)');
    expect(probeLabel({ kind: 'lane' })).toBe('lane');
  });

  it('normalizes positions and drops fields the body does not use for lane', () => {
    expect(prepareProbeInput({ kind: 'lane', spawner: [0.9, 20, -0.2], from: '-2,20,0', radius: 8 }, context))
      .toEqual({ input: { kind: 'lane', spawner: at(0, 20, -1), from: at(-2, 20, 0) }, problem: null,
        fixes: ['spawner を整数の座標にした', 'from を整数の座標にした', 'lane に使わない欄 radius を外した'] });
  });

  it.each([NaN, Infinity, -Infinity])('refuses non-finite input coordinates (%s) without losing the explicit spawner', value => {
    for (const field of ['spawner', 'from']) {
      const input = { kind: 'lane', [field]: at(value, 20, 0) };
      expect(prepareProbeInput(input, context).input).toBeNull();
      expect(llmcPrepare(MC_PROBE_TOOL, input, context).problem).toContain(`lane の ${field}`);
      expect(validSkillInput(input, PROBE_INPUT_SCHEMA)).toBe(false);
    }
    expect(prepareProbeInput({ kind: 'lane', spawner: null }, context).problem).toContain('spawner');
  });
});

describe('lane answers as short facts', () => {
  it('all fields: resolves the compact tables, with the minimum direction and totals for the other three', () => {
    const raw = JSON.stringify(report());
    const text = probeAnswerText(raw, false);
    expect(text.split('\n')).toHaveLength(8);
    expect(text).toContain('スポナー (0,20,0) ／ 数え箱の生き残り 2/6');
    expect(text).toContain('湧ける空間 12か所');
    expect(text).toContain('最少 東: 必要 32個（囲み8・屋根3・栓1・蓋20）');
    expect(text).toContain('栓 (1,21,0) ／ 待ち場（足/頭）(5,20,0)/(5,21,0)');
    expect(text).toContain('通路（足/頭、観測3マス）(2,20,0)/(2,21,0) (3,20,0)/(3,21,0) (4,20,0)/(4,21,0)');
    expect(text).toContain('立つ所（先頭3か所まで）(5,20,1) (5,20,2) (5,20,3)');
    expect(text).not.toContain('(5,20,4)');
    expect(text).toContain('手が届かない 3・見えない 3・支え無し 2 ／ 片付け 2・危険 3');
    expect(text).toContain('指定の形で通路外の湧ける空間 2か所・不明 0か所');
    expect(text.split('\n').at(-1)).toBe('他の向き: 西: 35個 ／ 南: 40個 ／ 北: 45個');
    expect(text).not.toMatch(/せよ|建てる|建築順|先にする|"cells"|"facts"|"build"|湧ける空間は/u);
    expect(text).not.toContain('不明あり');
    expect(probeAnswerText(raw, true)).toBe(text);
    expect(llmcResult(MC_PROBE_TOOL, { outcome: 'completed', result: raw } as never, null)).toMatchObject({ ok: true, text });
  });

  it('keeps the existing history path: the detail is shown once and is not repeated in stored history', () => {
    const text = probeAnswerText(JSON.stringify(report()), false);
    const stored = llmcStoredResult(MC_PROBE_TOOL, text);
    expect(stored.stored).toContain(text.split('\n')[0]);
    expect(stored.stored).not.toContain('立つ所');
    expect(stored.shown).toBe(text.slice(text.indexOf('\n') + 1));
    expect(stored.shown).not.toContain('スポナー');
  });

  it('missing fields and malformed rows stay unknown; an absent build is not zero unreachable cells', () => {
    const partial = { v: 1, kind: 'lane', found: true, candidates: [{ direction: 'south', required: { total: 4, unknown: 2 },
      build: [[null, null, null, 1, null, null], []], clear: null }] };
    const text = probeAnswerText(JSON.stringify(partial), false);
    expect(text.split('\n').length).toBeLessThanOrEqual(8);
    expect(text).toContain('最少 南: 必要 4個');
    expect(text).toContain('不明あり');
    expect(text).toContain('手が届かない 0・見えない 1・支え無し 0（印不明1）');
    expect(text).toContain('片付け 不明・危険 不明');
    expect(text).not.toMatch(/undefined|NaN|Infinity|"candidates"/u);
    const absent = probeAnswerText(JSON.stringify({ kind: 'lane', candidates: [{}] }), false);
    expect(absent).toContain('手が届かない 不明・見えない 不明・支え無し 不明');
    expect(readLaneProbeResult({ kind: 'lane', candidates: [null] })?.best).toBeNull();
    expect(readLaneProbeResult(null)).toBeNull();
  });

  it('empty candidates: retains bounded body text once without a raw JSON tail', () => {
    const raw = JSON.stringify({ v: 1, kind: 'lane', found: true, text: '向きは未観測。', candidates: [] });
    const text = probeAnswerText(raw, false);
    expect(text).toContain('候補なし: 向きは未観測');
    expect(text.match(/向きは未観測/gu)).toHaveLength(1);
    expect(text).not.toMatch(/最少|"candidates"/u);
    expect(probeAnswerText(JSON.stringify({ kind: 'lane', candidates: [] }), false)).toContain('向きの観測なし');
  });

  it('found=false: only the observed absence, even if stale candidates are present', () => {
    const data = { ...report(), found: false, text: '読み込み済みの範囲に湧き場はない。' };
    expect(probeAnswerText(JSON.stringify(data), false)).toBe('lane: 読み込み済みの範囲に湧き場はない');
    expect(probeAnswerText(JSON.stringify({ kind: 'lane', found: false }), true)).toBe('lane: 湧き場は見つかっていない');
    expect(probeAnswerText(JSON.stringify({ kind: 'lane', found: false,
      text: 'レーン計画はネザーの湧き場を調べる。ここはネザーではない。' }), false)).toBe('lane: ここはネザーではない');
  });

  it('survivors at the reported limit: names the stopped-spawning threshold', () => {
    const data = report();
    data.blaze.count = 6;
    data.blaze.atLimit = true;
    const text = probeAnswerText(JSON.stringify(data), false);
    expect(text).toContain('生き残り 6/6（湧きが止まる数に達している）');
    expect(text.match(/湧きが止まる数に達している/gu)).toHaveLength(1);
  });

  it('a complete JSON over 16,000 characters: reads the first candidate and text, never other directions\' details', () => {
    const data = report();
    data.text = '本文の観測。';
    const padding = Array.from({ length: 1_000 }, () => cell(40, 20, 40));
    data.cells.push(...padding, cell(6, 20, 7));
    data.candidates[0]!.build[0]![4] = data.cells.length - 1;
    for (const other of data.candidates.slice(1)) {
      other.build = Array.from({ length: 2_000 }, () => [0, 0, null, 0, 12, 1]);
      other.clear = Array.from({ length: 1_000 }, () => 13);
    }
    const raw = JSON.stringify(data);
    expect(raw.length).toBeGreaterThan(16_000);
    const read = readLaneProbeResult(JSON.parse(raw))!;
    expect(read.text).toBe('本文の観測。');
    expect(read.best?.stands?.[0]).toEqual(at(6, 20, 7));
    expect(read.others).toEqual([{ direction: 'west', total: 35 }, { direction: 'south', total: 40 }, { direction: 'north', total: 45 }]);
    const text = probeAnswerText(raw, false);
    expect(text).toContain('(6,20,7)');
    expect(text).toContain('他の向き: 西: 35個 ／ 南: 40個 ／ 北: 45個');
    expect(text).not.toMatch(/\(40,20,40\)|\(5,20,4\)|"build"|後略/u);
    expect(text.length).toBeLessThan(1_000);
    expect(text.split('\n').length).toBeLessThanOrEqual(8);
  });

  it('reads neither other candidates\' geometry nor unused shared facts', () => {
    const data = report();
    const unused = () => { throw new Error('unneeded table read'); };
    const others = data.candidates.slice(1).map(c => ({ direction: c.direction, required: c.required, get build() { return unused(); } }));
    const read = readLaneProbeResult({ ...data, candidates: [data.candidates[0], ...others],
      get facts() { return unused(); }, get standFacts() { return unused(); } });
    expect(read?.best?.direction).toBe('east');
    expect(read?.others).toHaveLength(3);
  });

  it.each([NaN, Infinity, -Infinity])('never displays non-finite result coordinates (%s), including table references', value => {
    const data = report();
    data.spawner.x = value;
    for (const row of data.cells) row[1] = value;
    const read = readLaneProbeResult(data)!;
    expect(read.spawner).toBeNull();
    expect(read.best?.plug).toBeNull();
    expect(read.best?.waiting).toEqual([null, null]);
    expect(read.best?.lane).toEqual([[null, null], [null, null], [null, null]]);
    expect(read.best?.stands).toEqual([]);
    expect(laneProbeFacts(read)).not.toMatch(/NaN|Infinity/u);
    // JSON.parse accepts an overflowing exponent as Infinity; no leaked raw JSON or invalid position.
    const raw = '{"v":1,"kind":"lane","found":true,"spawner":{"x":1e400,"y":20,"z":0},"candidates":[]}';
    expect(probeAnswerText(raw, false)).toContain('スポナー 不明');
    expect(probeAnswerText(raw, false)).not.toContain('Infinity');
  });

  it.each([null, -1, 0.5, Infinity, '0', 1_000_000])('invalid cell references (%s) are unknown, never a guessed coordinate', ref => {
    const data = report();
    const read = readLaneProbeResult({ ...data, candidates: [{ ...data.candidates[0], plug: ref, waiting: [ref, ref] }] });
    expect(read?.best?.plug).toBeNull();
    expect(read?.best?.waiting).toEqual([null, null]);
  });
});
