import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkillMemory } from '../src/mind/memory/skillMemory.js';
import { ShannonSkillConsolidator } from '../src/mind/sleep/skillConsolidation.js';
import type { SleepFcaPhaseHandler } from '../src/mind/sleep/sleepFcaPorts.js';
const AT = '2026-10-09T12:00:00.000Z', signal = new AbortController().signal;
const job = { id: 'job-1', scopeKey: 'owner', dayKey: '2026-10-09', startAt: '2026-10-08T12:00:00.000Z', endAt: AT };
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const answer = (extra = {}) => ({ action: 'propose', open: [], operation: 'create', skillId: '', expectedVersion: 0,
  name: 'weekly-review', description: '週のふりかえりをする時', steps: '1. 今週したことを三つ挙げる\n2. 来週の一つを決める',
  aids: '- study.search で先週のメモを探す', references: '- 何度かの会話から', replacements: [], purposePatternIds: [], consolidates: [], ...extra });
function fixture() {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  const skills = new SkillMemory({ database: db, createsSchema: true, defer: task => task(), log: () => {} });
  const page = skills.createPattern('owner', { kind: 'strategy', title: '三つ挙げる', body: '三つ挙げるとよい。' }, ['experience:turn1'], { carries: () => false }, AT);
  if (!('patternId' in page)) throw Error('fixture');
  let visible = true;
  const model = { model: 'scripted', json: vi.fn(async () => answer({ action: 'none' })) };
  const observeSources = vi.fn(() => true);
  const phase = (budget = 5) => new ShannonSkillConsolidator(skills, {
    knowledge: () => [], experiences: () => [], choices: () => [], visible: () => () => visible,
    sourcesPass: () => () => visible, check: () => ({ carries: () => false }),
  }, { maintainer: null, proposer: model }, { skillBudgetUsd: budget, now: () => AT }).fcaPhase({ observeSources });
  return { skills, page: page.patternId, model, phase, observeSources, forget: () => { visible = false; } };
}
async function run(phase: SleepFcaPhaseHandler, state: unknown = null) {
  const input = { job, state, signal };
  return phase.apply(await phase.decide(input), { ...input, operationId: 'step:call' });
}
describe('skill sleep on committed FCA phases', () => {
  it('makes one call per step; open persists IDs only, and a reconstructed phase proposes through the existing skill writer', async () => {
    const w = fixture(); let state = (await run(w.phase())).state;
    state = (await run(w.phase(), state)).state;
    expect(w.model.json).not.toHaveBeenCalled();
    w.model.json.mockResolvedValueOnce(answer({ action: 'open', open: [w.page] }));
    state = (await run(w.phase(), state)).state;
    expect(w.model.json).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(state)).not.toContain('三つ挙げる');
    w.model.json.mockResolvedValueOnce(answer({ purposePatternIds: [w.page] }));
    await run(w.phase(), structuredClone(state));
    expect(w.model.json).toHaveBeenCalledTimes(2);
    expect(w.skills.store.all('owner')[0]).toMatchObject({ name: 'weekly-review', status: 'trial', purposePatternIds: [w.page] });
    expect(w.observeSources).toHaveBeenCalledWith(['turn1']);
    expect((w.model.json.mock.calls[1] as unknown[])[3]).toMatchObject({ round: 2, opened: [{ id: w.page, body: '三つ挙げるとよい。' }] });
  });
  it('pre-counts unknown calls across new phase instances, preserves nightly3 cap and does not charge the shared budget', async () => {
    const w = fixture(); const state = { version: 1, stage: 'propose', run: 1, round: 1, opened: [], bases: [] };
    w.model.json.mockRejectedValue(Error('PAID_UNKNOWN'));
    for (let i = 0; i < 3; i++) await expect(run(w.phase(), state)).rejects.toThrow('PAID_UNKNOWN');
    expect((await run(w.phase(), state)).done).toBe(true);
    expect(w.model.json).toHaveBeenCalledTimes(3);
    expect(w.skills.sleepUsage.calls('owner', 'proposer', '2026-10-09')).toBe(3);
    expect((await run(w.phase(0), state)).done).toBe(true);
  });
  it('rejects forgotten sources and late abort before applying a proposal', async () => {
    const w = fixture(), phase = w.phase();
    const state = { version: 1, stage: 'propose', run: 1, round: 1, opened: [], bases: [] };
    w.model.json.mockResolvedValue(answer({ purposePatternIds: [w.page] }));
    const input = { job, state, signal }, planned = await phase.decide(input);
    w.forget(); await expect(phase.apply(planned, { ...input, operationId: 'step:call' })).rejects.toThrow('WITHHELD');
    expect(w.skills.store.all('owner')).toEqual([]);
    const other = fixture(), controller = new AbortController();
    other.model.json.mockImplementation(async () => { controller.abort(); return answer(); });
    await expect(other.phase().decide({ job, state, signal: controller.signal })).rejects.toThrow();
    expect(other.skills.store.all('owner')).toEqual([]);
  });
  it('inherits underlying sources of deprecated pattern references shown by the proposer', async () => {
    const w = fixture();
    const old = w.skills.createPattern('owner', { kind: 'strategy', title: '旧手順', body: '以前の順番を振り返る。' }, ['experience:old-turn'], { carries: () => false }, AT);
    if (!('patternId' in old)) throw Error('fixture');
    w.skills.deprecatePattern('owner', old.patternId, null, AT);
    w.skills.createPattern('owner', { kind: 'strategy', title: '新手順', body: '以前の手順から改善した。' }, [`pattern:${old.patternId}`], { carries: () => false }, AT);
    await run(w.phase(), { version: 1, stage: 'propose', run: 1, round: 1, opened: [], bases: [] });
    expect(w.observeSources).toHaveBeenCalledWith(expect.arrayContaining(['old-turn', 'turn1']));
  });
});

describe('a night with a source that is not visible', () => {
  /** A fixture whose rule fails any source naming "gone": a page built from a note whose turn the owner has since made 内緒 (production 2026-10-21). */
  function withGone(extra: { experiences?: () => { id: string; observedAt: string; summary: string; text: string }[] } = {}) {
    const db = new DatabaseSync(':memory:'); databases.push(db);
    const skills = new SkillMemory({ database: db, createsSchema: true, defer: task => task(), log: () => {} });
    const make = (title: string, sources: string[]) => {
      const page = skills.createPattern('owner', { kind: 'strategy', title, body: `${title}という本文。` }, sources, { carries: () => false }, AT);
      if (!('patternId' in page)) throw Error('fixture'); return page.patternId;
    };
    const good = make('三つ挙げる', ['experience:turn1']), bad = make('外部実行は分ける', ['knowledge:gone']);
    const model = { model: 'scripted', json: vi.fn(async () => answer({ action: 'none' })) };
    const observeSources = vi.fn(() => true), lines: string[] = [];
    const rule = (sources: readonly string[]) => !sources.some(source => source.includes('gone'));
    const consolidator = new ShannonSkillConsolidator(skills, {
      knowledge: () => [], experiences: extra.experiences ?? (() => []), choices: () => [], visible: () => () => true,
      sourcesPass: () => rule, check: () => ({ carries: () => false }),
    }, { maintainer: null, proposer: model }, { skillBudgetUsd: 5, now: () => AT });
    return { skills, good, bad, model, observeSources, lines, phase: () => consolidator.fcaPhase({ observeSources, log: line => lines.push(line) }) };
  }
  const propose = { version: 1, stage: 'propose', run: 1, round: 1, opened: [], bases: [] };

  it('leaves the page out and goes on: the model is not shown it, nothing cites it, and the night names it', async () => {
    const w = withGone(); w.model.json.mockResolvedValue(answer({ purposePatternIds: [w.good] }));
    const result = await run(w.phase(), propose);
    expect(w.model.json).toHaveBeenCalledTimes(1);
    const input = (w.model.json.mock.calls[0] as unknown[])[3] as { patternIndex: { id: string }[] };
    expect(input.patternIndex.map(page => page.id)).toEqual([w.good]);
    expect(JSON.stringify(input)).not.toContain('外部実行は分ける');
    expect(w.observeSources.mock.calls.flat().flat()).not.toContain('gone');
    expect(w.skills.store.all('owner')[0]).toMatchObject({ name: 'weekly-review', purposePatternIds: [w.good] });
    expect(result.summary).toContain('"withheld":1');
    expect(w.lines.join('\n')).toContain(`pages=1`);
    expect(w.lines.join('\n')).toContain(w.bad);
    expect(w.lines.join('\n')).not.toContain('三つ挙げる');
  });

  it('does not let a model cite or change what was left out', async () => {
    const w = withGone(); w.model.json.mockResolvedValue(answer({ purposePatternIds: [w.bad] }));
    const result = await run(w.phase(), propose);
    expect(w.skills.store.all('owner')).toEqual([]);
    expect(result.summary).toContain('"rejected":1');
  });

  it('withdraws the page for good in the night\'s model-free part, so the next night has nothing to leave out', async () => {
    const w = withGone();
    const result = await run(w.phase());
    expect(result.summary).toContain('"withheld":1');
    expect(w.skills.patterns('owner').map(page => page.patternId)).toEqual([w.good]);
    await run(w.phase(), { version: 1, stage: 'maintain', run: 1, round: 1, opened: [], bases: [] });
    expect(w.lines.join('\n')).not.toContain('Shannon skill sleep withheld');
  });

  it('still withholds the step when a source it used goes before it is applied (the guard is not weakened)', async () => {
    const w = withGone(); const state = { ...propose };
    w.model.json.mockResolvedValue(answer({ purposePatternIds: [w.good] }));
    const phase = w.phase(), input = { job, state, signal }, planned = await phase.decide(input) as { sources: string[] };
    expect(planned.sources).toContain('experience:turn1');
    const stricter = new ShannonSkillConsolidator(w.skills, {
      knowledge: () => [], experiences: () => [], choices: () => [], visible: () => () => true,
      sourcesPass: () => sources => !sources.some(source => source.includes('gone') || source === 'experience:turn1'), check: () => ({ carries: () => false }),
    }, { maintainer: null, proposer: w.model }, { skillBudgetUsd: 5, now: () => AT }).fcaPhase({ observeSources: w.observeSources });
    await expect(stricter.apply(planned, { ...input, operationId: 'step:call' })).rejects.toThrow('SKILL_FCA_SOURCE_WITHHELD');
    expect(w.skills.store.all('owner')).toEqual([]);
  });

  it('lets the event loop go while it checks many sources, and judges each source once', async () => {
    const calls = new Map<string, number>();
    const items = Array.from({ length: 60 }, (_, index) => ({ id: `t${index}`, observedAt: AT, summary: `s${index}`, text: `t${index}` }));
    const w = withGone({ experiences: () => items });
    const spin = (until: number) => { while (performance.now() < until); };
    const slow = new ShannonSkillConsolidator(w.skills, {
      knowledge: () => [], experiences: () => items, choices: () => [], visible: () => () => true,
      sourcesPass: () => sources => { for (const source of sources) calls.set(source, (calls.get(source) ?? 0) + 1); spin(performance.now() + 1); return !sources.some(source => source.includes('gone')); },
      check: () => ({ carries: () => false }),
    }, { maintainer: null, proposer: null }, { skillBudgetUsd: 5, now: () => AT }).fcaPhase({ observeSources: w.observeSources, log: () => {} });
    const marks: string[] = []; setImmediate(() => marks.push('loop'));
    const state = { version: 1, stage: 'maintain', run: 1, round: 1, opened: [], bases: [] };
    await slow.decide({ job, state, signal });
    expect(marks).toEqual(['loop']);
    expect(Math.max(...calls.values())).toBeLessThanOrEqual(3);
  });
});