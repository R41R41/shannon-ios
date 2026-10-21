import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyPlanUpdate, planFromSeeds, planPath, planText, readPlanTree, PLAN_LIMITS } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import type { MinecraftSkillDefinition } from '../src/contracts/minecraftControlContract.js';
import { MC_ACT_TOOL } from '../src/contracts/minecraftActContract.js';
import { MC_PROBE_TOOL, PROBE_INPUT_SCHEMA, type ProbeInput } from '../src/contracts/minecraftProbeContract.js';
import { validSkillInput } from '../src/surfaces/minecraft/minecraftControlValidation.js';
import { llmcBodyDefinitions, llmcPrepare, llmcResult, llmcSchema } from '../src/surfaces/minecraft/minecraftLlmc.js';
import { forgetLlmcEvents, withLlmcBody, type LlmcProbeParts } from '../src/surfaces/minecraft/minecraftLlmcBody.js';
import {
  createSurpriseWatch, fitInvestigation, forgetSurpriseWatches, INVESTIGATION_TAIL, LLMC_PROBE, runInvestigation, scanForPlan, scanLines, stepProbes,
  surpriseFrame, type Surprise,
} from '../src/surfaces/minecraft/minecraftLlmcProbe.js';
import { prepareProbeInput, probeAnswerText } from '../src/surfaces/minecraft/minecraftLlmcProbeInput.js';
import { llmcTokens } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { INVESTIGATE_KNOWLEDGE, LLMC_SYSTEM_APPENDIX, LLMC_SYSTEM_APPENDIX_R4, llmcSystemAppendix, NETHER_ENTRY_KNOWLEDGE } from '../src/surfaces/minecraft/minecraftKnowledge.js';
import { createFcaPlanTools, PLAN_UPDATE_DEFINITION, PLAN_UPDATE_RULES_DEFINITION } from '../src/mind/action/fca/fcaPlanTools.js';
import {
  firstPlanInput, FIRST_PLAN_SCHEMA, FIRST_PLAN_SCHEMA_R4, FIRST_PLAN_SYSTEM, FIRST_PLAN_SYSTEM_R4, forgetFirstPlans, planFromAnswer, SCAN_WAIT,
  startFirstPlan,
} from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import type { FcaToolDefinition } from '../src/mind/action/fca/fcaPorts.js';

/**
 * mb-llmc r4 (owner 2026-10-22, shared note r4-contract.md): a surprise is probed by the code before the decision and said first in its live
 * state; the model has mc.probe of its own; the plan's nodes carry forbid and caution; the body's scan goes to the first plan and the live
 * state; the knowledge says how to look when stuck, how to read a dangerous fact and what to do on entering the Nether.
 */
afterEach(() => { forgetLlmcEvents(); forgetSurpriseWatches(); forgetFirstPlans(); vi.useRealTimers(); });

function frame(world: Record<string, unknown>): BodyObservation {
  return { schemaVersion: 1, bodyId: 'minecraft:s', sequence: 1, stateAt: '2026-10-22T00:00:00Z', receivedAt: '2026-10-22T00:00:00Z', connected: true,
    state: { world: world as never }, facts: { alive: true } };
}
const at = (x: number, y: number, z: number) => ({ x, y, z });
const here = (health: number, y = 64, extra: Record<string, unknown> = {}) => ({ position: at(10.5, y, -3.5), health, dimension: 'overworld', ...extra });
const answer = (kind: string, text: string, fields: Record<string, unknown> = {}) => JSON.stringify({ v: 1, kind, text, ...fields });
const inner = () => ({ start() {}, revision: () => 0, context: () => ({ revision: 0, observation: null }), async guard() { return true; },
  toolSignal: (_name: string, parent: AbortSignal) => parent, async close() {} });

describe('the surprises of a step, from the facts alone (shared note 2; arch-check 23 5)', () => {
  const ctx = (world: Record<string, unknown>, arrival: number | null = 1) => surpriseFrame(frame(world), arrival);

  it('health down 5 or more in one decision, or under 10: around and the column under her feet', () => {
    const watch = createSurpriseWatch('s-health');
    expect(watch.detect(ctx(here(20)), null)).toEqual([]);
    const [found] = watch.detect(ctx(here(13)), null);
    expect(found).toMatchObject({ code: 'health', line: '体力 20→13（1 判断で −7）' });
    expect(found!.probes).toEqual([{ kind: 'around', radius: 8 }, { kind: 'column', x: 10, z: -4, yFrom: 66, yTo: 50 }]);
    expect(watch.detect(ctx(here(12)), null)).toEqual([]);
    expect(watch.detect(ctx(here(9)), null)[0]).toMatchObject({ code: 'health', line: '体力 12→9（1 判断で −3）' });
  });

  it('a fall of 5 or more; not after an arrival (a death, a login) nor across a portal', () => {
    const watch = createSurpriseWatch('s-fall');
    watch.detect(ctx(here(20, 64)), null);
    expect(watch.detect(ctx(here(20, 57)), null)).toMatchObject([{ code: 'fall', line: '1 判断で 7 段下がった（y 64→57）' }]);
    expect(watch.detect(ctx(here(20, 40), 2), null)).toEqual([]);
    expect(watch.detect(ctx({ ...here(20, 30), dimension: 'the_nether' }, 2), null)).toEqual([]);
  });

  it('air under 10: the column over her head and around, not again in the next two steps', () => {
    const watch = createSurpriseWatch('s-air');
    const [first] = watch.detect(ctx(here(20, 40, { oxygen: 6 })), null);
    expect(first).toMatchObject({ code: 'oxygen', line: '酸素 6（10 未満）' });
    expect(first!.probes[0]).toEqual({ kind: 'column', x: 10, z: -4, yFrom: 56, yTo: 40 });
    expect(watch.detect(ctx(here(20, 40, { oxygen: 5 })), null)).toEqual([]);
    expect(watch.detect(ctx(here(20, 40, { oxygen: 4 })), null)).toEqual([]);
    expect(watch.detect(ctx(here(20, 40, { oxygen: 3 })), null)).toHaveLength(1);
  });

  it('the same stop twice (by the hand and its closed reason): history there and the path to where the walk went', () => {
    const watch = createSurpriseWatch('s-repeat');
    const walk = { hands: [{ do: 'walk', to: at(-153, 62, 230) }] };
    const stopped = 'act 0/1 済みで止まった（failure）\n1 walk 止 一歩ではない: (−153,62,193) の先は段差 2\n今 (-153,62,193) 体力20 満腹20';
    watch.noteResult(MC_ACT_TOOL, false, stopped, walk);
    expect(watch.detect(ctx(here(20)), null)).toEqual([]);
    watch.noteResult(MC_ACT_TOOL, false, stopped, walk);
    const [found] = watch.detect(ctx(here(20)), null);
    expect(found).toMatchObject({ code: 'repeat', line: '同じ止まりの 2 回目: walk「一歩ではない」' });
    expect(found!.probes).toEqual([{ kind: 'history', at: at(10, 64, -4), radius: 4 }, { kind: 'path', to: at(-153, 62, 230) }]);
    // Probed once: the same stop again right after is not probed again at once.
    watch.noteResult(MC_ACT_TOOL, false, stopped, walk);
    expect(watch.detect(ctx(here(20)), null)).toEqual([]);
  });

  it('a stop of a place twice gives a sight of the block it aimed at; a reflex or a stopIf is no stop of hers', () => {
    const watch = createSurpriseWatch('s-place');
    const place = { hands: [{ do: 'place', block: 'cobblestone', at: [at(5, 70, 5)] }] };
    const text = 'act 0/1 済みで止まった（failure）\n1 place 止 置けない: 周りが全部空気';
    watch.noteResult(MC_ACT_TOOL, false, text, place);
    watch.noteResult(MC_ACT_TOOL, false, text, place);
    expect(watch.detect(ctx(here(20)), null)[0]!.probes[1]).toEqual({ kind: 'sight', target: at(5, 70, 5) });
    const other = createSurpriseWatch('s-reflex');
    const reflex = 'act 0/1 済みで止まった（reflex: 溶岩から上がった）\n1 walk 止 反射: 溶岩から上がった（手の途中）';
    other.noteResult(MC_ACT_TOOL, false, reflex, { hands: [{ do: 'walk', to: at(1, 2, 3) }] });
    other.noteResult(MC_ACT_TOOL, false, reflex, { hands: [{ do: 'walk', to: at(1, 2, 3) }] });
    expect(other.detect(ctx(here(20)), null)).toEqual([]);
  });

  it('the same dig stopped three times: sight of the block and around (run 26: the blazes over the floor)', () => {
    const watch = createSurpriseWatch('s-dig');
    const dig = { hands: [{ do: 'dig', at: [at(310, 69, 73)] }] };
    const text = 'act 0/1 済みで止まった（failure）\n1 dig 止 見られる: 掘ると blaze から見える';
    watch.noteResult(MC_ACT_TOOL, false, text, dig);
    watch.noteResult(MC_ACT_TOOL, false, text, dig);
    expect(watch.detect(ctx(here(20)), null)[0]!.code).toBe('repeat');
    watch.noteResult(MC_ACT_TOOL, false, text, dig);
    const [found] = watch.detect(ctx(here(20)), null);
    expect(found).toMatchObject({ code: 'dig', line: '同じ掘りの中止が 3 回: 「見られる」' });
    expect(found!.probes).toEqual([{ kind: 'sight', target: at(310, 69, 73) }, { kind: 'around', radius: 8 }]);
  });

  it('an attack that hit nothing: sight of the target and around', () => {
    const watch = createSurpriseWatch('s-miss');
    watch.noteResult(MC_ACT_TOOL, true, 'act 全部済み（1/1、20.0秒）\n1 attack 済 blaze を 20秒攻撃した（9回振って 0回当たった）（20.1秒）',
      { hands: [{ do: 'attack', target: '#41', seconds: 20 }], accept: ['blaze'] });
    expect(watch.detect(ctx(here(20)), null)).toMatchObject([{ code: 'miss', probes: [{ kind: 'sight', target: '#41' }, { kind: 'around' }] }]);
    watch.noteResult(MC_ACT_TOOL, true, '1 attack 済 blaze を 20秒攻撃した（9回振って 3回当たった）', { hands: [{ do: 'attack', target: '#41' }] });
    expect(watch.detect(ctx(here(20)), null)).toEqual([]);
  });

  it('find-blocks far from the plan node\'s place: the path to what it found', () => {
    const watch = createSurpriseWatch('s-found');
    watch.noteResult('mc.find-blocks', true, 'oak_log (60,70,10) 50m ほか 3', {});
    expect(watch.detect(ctx(here(20)), '(12,64,-2) 村の北')).toMatchObject([{ code: 'found', probes: [{ kind: 'path', to: at(60, 70, 10) }] }]);
    watch.noteResult('mc.find-blocks', true, 'oak_log (14,70,0) 4m', {});
    expect(watch.detect(ctx(here(20)), '(12,64,-2) 村の北')).toEqual([]);
  });

  it('at most two probes a step, the dangers first, each once', () => {
    const surprises: Surprise[] = [
      { code: 'health', line: 'h', probes: [{ kind: 'around', radius: 8 }, { kind: 'column', x: 1, z: 1, yFrom: 3, yTo: -10 }] },
      { code: 'fall', line: 'f', probes: [{ kind: 'column', x: 1, z: 1, yFrom: 3, yTo: -10 }, { kind: 'around', radius: 8 }] },
      { code: 'repeat', line: 'r', probes: [{ kind: 'history', at: at(1, 1, 1), radius: 4 }] }];
    expect(stepProbes(surprises)).toEqual([{ kind: 'around', radius: 8 }, { kind: 'column', x: 1, z: 1, yFrom: 3, yTo: -10 }]);
    expect(LLMC_PROBE.maxProbes).toBe(2);
  });
});

describe('the investigation before the decision: bounded in probes, tokens and time (shared note 2)', () => {
  const surprises: Surprise[] = [{ code: 'fall', line: '1 判断で 8 段下がった（y 48→40）', probes: [] }];
  const probes: ProbeInput[] = [{ kind: 'column', x: 10, z: -4, yFrom: 42, yTo: 26 }, { kind: 'around', radius: 8 }];

  it('the surprise first, then each answer with the danger as the body wrote it, then the one line on what to do', async () => {
    const run = async (input: ProbeInput) => input.kind === 'column'
      ? answer('column', '下 7 段は空気（落差 7、底 y=32 stone）', { runs: [] }) : answer('around', '敵なし。溶岩 (12,38,-3) 3m');
    const done = await runInvestigation({ surprises, probes, feet: at(10.5, 40, -3.5), run, budgetMs: 1_000 });
    expect(done.lines).toEqual(['驚き: 1 判断で 8 段下がった（y 48→40）', '調べ column 足の列 y=42〜26: 下 7 段は空気（落差 7、底 y=32 stone）',
      '調べ around 8m: 敵なし。溶岩 (12,38,-3) 3m', INVESTIGATION_TAIL]);
    expect(done.answered).toBe(2);
    // arch-check 6 S1: no word of the head's own that reads as "dig here".
    expect(done.lines.join('\n')).not.toMatch(/切れ目|足がかり/u);
  });

  it('past the time it goes on without the answer, and says so (an urgent step waits less)', async () => {
    const run = (input: ProbeInput) => input.kind === 'column' ? new Promise<string | null>(resolve => setTimeout(() => resolve('late'), 400))
      : Promise.resolve(answer('around', '敵なし'));
    const began = performance.now();
    const done = await runInvestigation({ surprises, probes, feet: null, run, budgetMs: 60 });
    expect(performance.now() - began).toBeLessThan(300);
    expect(done.answered).toBe(1);
    expect(done.lines[1]).toMatch(/^調べ column \(10,-4\) y=42〜26: 時間切れ（添えずに進めた。要るなら mc\.probe で）$/u);
    expect(done.lines[2]).toBe('調べ around 8m: 敵なし');
  });

  it('a body with no probe: the surprises alone; a probe that throws is said as no answer', async () => {
    expect((await runInvestigation({ surprises, probes, feet: null, run: null, budgetMs: 100 })).lines).toEqual([`驚き: ${surprises[0]!.line}`, INVESTIGATION_TAIL]);
    const done = await runInvestigation({ surprises, probes: probes.slice(0, 1), feet: null, run: async () => { throw new Error('x'); }, budgetMs: 100 });
    expect(done.lines[1]).toMatch(/答えが無かった$/u);
  });

  it('at most 600 tokens together: the longest answer is cut first', async () => {
    const long = '下 30 段は空気（落差 30）。'.repeat(80);
    const done = await runInvestigation({ surprises, probes, feet: null, run: async () => answer('column', long), budgetMs: 100 });
    expect(llmcTokens(JSON.stringify(done.lines))).toBeLessThanOrEqual(LLMC_PROBE.tokens);
    expect(done.lines[0]).toBe(`驚き: ${surprises[0]!.line}`);
    expect(done.lines.at(-1)).toBe(INVESTIGATION_TAIL);
    expect(done.lines[1]).toMatch(/^調べ column .+: 下 30 段は空気（落差 30）。/u);
    expect(fitInvestigation(['a'.repeat(5_000)], 100)[0]!.length).toBeLessThan(5_000);
  });

  it('a path\'s points, where to stand and the nearest point are added when the body\'s text lacks them (S4: the swim points became the path)', () => {
    const text = probeAnswerText(answer('path', '掘らずには行けない: (−150,62,200) の先は水深 3', {
      points: [{ x: -153, y: 62, z: 193 }, { x: -153, y: 61, z: 200 }], stands: [{ at: { x: -150, y: 62, z: 260 }, eye: 1.6, steps: 70 }],
      nearest: { x: -150, y: 62, z: 255 } }), true);
    expect(text).toBe('掘らずには行けない: (−150,62,200) の先は水深 3 ／ 道の点（walk の path に使える）: (-153,62,193) (-153,61,200) ／ '
      + '的の近くに立てる所: (-150,62,260) ／ 行ける所で一番近い点: (-150,62,255)');
    expect(probeAnswerText(answer('sight', '届かない（4.9m）。間に netherrack', { between: [{ at: { x: 310, y: 69, z: 73 }, name: 'nether_bricks' }] }), true))
      .toBe('届かない（4.9m）。間に netherrack ／ 間: nether_bricks (310,69,73)');
    expect(probeAnswerText('plain words', true)).toBe('plain words');
  });
});

describe('the lifecycle investigates before the decision and says it first in the live state', () => {
  const plan = { plan: () => undefined, planView: () => null };
  function body(world: () => Record<string, unknown>, probe: LlmcProbeParts['probe'], taskId = 'r4-life') {
    const lines: string[] = [];
    const lifecycle = withLlmcBody(inner(), { llmc: plan, taskId, createdAt: new Date().toISOString(), observe: () => frame(world()),
      arrival: () => ({ at: 1, kind: 'login' }), log: line => lines.push(line), r4: { probe, planWhere: () => null } });
    return { lifecycle, lines };
  }

  it('a fall: the fixed probes are sent, their answers come first in this decision\'s live state, once', async () => {
    let y = 48;
    const sent: ProbeInput[] = [];
    const { lifecycle, lines } = body(() => ({ ...here(20, y), localMap: 'm' }), () => async input => {
      sent.push(input);
      return input.kind === 'column' ? answer('column', '下 7 段は空気（落差 7）') : answer('around', '敵なし');
    });
    expect(await lifecycle.investigate!(new AbortController().signal)).toBeNull();
    lifecycle.context();
    expect(lifecycle.transient!()).not.toHaveProperty('investigation');
    y = 40;
    const found = await lifecycle.investigate!(new AbortController().signal);
    expect(found).toMatchObject({ surprises: ['fall'], probes: 2, answered: 2 });
    expect(sent.map(item => item.kind)).toEqual(['column', 'around']);
    lifecycle.context();
    const live = lifecycle.transient!() as { investigation: string[] };
    expect(Object.keys(live)[0]).toBe('investigation');
    expect(live.investigation[0]).toBe('驚き: 1 判断で 8 段下がった（y 48→40）');
    expect(live.investigation[1]).toContain('下 7 段は空気（落差 7）');
    expect(lines.some(line => /^Shannon Minecraft surprise task=r4-life surprises=fall probes=2 answered=2 ms=\d+$/u.test(line))).toBe(true);
    expect(await lifecycle.investigate!(new AbortController().signal)).toBeNull();
    lifecycle.context();
    expect(lifecycle.transient!()).not.toHaveProperty('investigation');
  });

  it('the results of the step feed the watch (the same stop twice from the acts as they came back)', async () => {
    const { lifecycle } = body(() => here(20), () => async () => answer('history', '前の手: walk 一歩ではない ×2'), 'r4-repeat');
    await lifecycle.investigate!(new AbortController().signal);
    const call = { id: 'a', name: MC_ACT_TOOL, input: { hands: [{ do: 'walk', to: at(30, 64, 0) }] } };
    const result = { ok: false, retryable: true, text: 'act 0/1 済みで止まった（failure）\n1 walk 止 一歩ではない: 段差 2' } as const;
    lifecycle.noteResult!(call, result);
    expect(await lifecycle.investigate!(new AbortController().signal)).toBeNull();
    lifecycle.noteResult!(call, result);
    expect(await lifecycle.investigate!(new AbortController().signal)).toMatchObject({ surprises: ['repeat'], probes: 2 });
  });

  it('the body\'s scan is shown once when a new one comes; a portal\'s says to look at the plan again', () => {
    let scan: Record<string, unknown> | undefined;
    const { lifecycle } = body(() => ({ ...here(20), localMap: 'm', ...(scan ? { scan } : {}) }), () => null, 'r4-scan');
    lifecycle.context();
    expect(lifecycle.transient!()).not.toHaveProperty('scan');
    scan = { trigger: 'portal', at: '2026-10-22T04:00:00Z', dimension: 'the_nether', text: 'ネザーの幹 4m 東、溶岩の海 20m 下', reach: 160,
      rows: ['W crimson_stem (11,35,13) 東4m', 'N nether_bricks (200,60,40) 東190m 要塞'] };
    lifecycle.context();
    expect((lifecycle.transient!() as { scan: string[] }).scan).toEqual(['走査（次元の移動の後・the_nether・160m 内）: ネザーの幹 4m 東、溶岩の海 20m 下',
      'W crimson_stem (11,35,13) 東4m', 'N nether_bricks (200,60,40) 東190m 要塞', '次元が変わった: この走査で、計画の次の節（材料・場所・順番）を plan.update で見直す']);
    lifecycle.context();
    expect(lifecycle.transient!()).not.toHaveProperty('scan');
    expect(scanLines(scan, null)!.lines.length).toBeLessThanOrEqual(10);
    expect(scanLines({ ...scan, trigger: 'login', rows: Array.from({ length: 20 }, (_, index) => `row${index}`) }, null)!.lines).toHaveLength(10); // r5: the range row and 9 rows
  });

  it('without r4 the lifecycle has no investigate and shows no scan (switch off: as r3)', () => {
    const lifecycle = withLlmcBody(inner(), { llmc: plan, taskId: 'r4-off', createdAt: new Date().toISOString(),
      observe: () => frame({ ...here(20), localMap: 'm', scan: { trigger: 'login', at: 't', text: 'x' } }), arrival: () => ({ at: 1, kind: 'login' }) });
    expect(lifecycle.investigate).toBeUndefined();
    lifecycle.context();
    const live = lifecycle.transient!();
    expect(live).not.toHaveProperty('scan');
    expect(live).not.toHaveProperty('investigation');
  });
});

describe('mc.probe: offered in the head\'s words, put into the body\'s form (the body\'s 04:10 form)', () => {
  const skill = (name: string): MinecraftSkillDefinition => ({ name, description: name, readOnly: true,
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } });
  const definition = (name: string, description: string, readOnly: boolean): FcaToolDefinition => ({ name, description,
    input: { type: 'object', properties: {}, required: [], additionalProperties: false }, domain: 'minecraft_body', effect: readOnly ? 'read' : 'write',
    cost: 'none', audiences: ['owner_alone'], surfaces: ['text'] });
  const context = { feet: at(10.5, 64, -3.5), creatures: [{ id: 41, name: 'blaze', distance: 6.2 }, { id: 7, name: 'blaze', distance: 9 }] };

  it('offered only with r4 and a body that has probe; a read, after mc.view, with the head\'s fixed words and schema', () => {
    const skills = [skill('act'), skill('view'), skill('probe'), skill('find-blocks')];
    expect(llmcBodyDefinitions(skills, definition).map(tool => tool.name)).toEqual(['mc.act', 'mc.view', 'mc.find-blocks']);
    const tools = llmcBodyDefinitions(skills, definition, { probe: true });
    expect(tools.map(tool => tool.name)).toEqual(['mc.act', 'mc.view', 'mc.probe', 'mc.find-blocks']);
    expect(tools[2]).toMatchObject({ effect: 'read', nativeInputSchema: PROBE_INPUT_SCHEMA });
    expect(llmcBodyDefinitions([skill('act')], definition, { probe: true }).map(tool => tool.name)).toEqual(['mc.act']);
  });

  it('each kind in the body\'s form: a creature by name becomes the nearest one\'s #id, a column gets its x, z and bounds', () => {
    expect(prepareProbeInput({ kind: 'sight', target: 'blaze' }, context)).toEqual({ input: { kind: 'sight', target: '#41' },
      fixes: ['target の blaze を一番近い #41（6.2m）にした'], problem: null });
    expect(prepareProbeInput({ kind: 'sight', at: [310.4, 69, 73] }, context).input).toEqual({ kind: 'sight', target: at(310, 69, 73) });
    expect(prepareProbeInput({ kind: 'sight', target: '310,69,73' }, context).input).toEqual({ kind: 'sight', target: at(310, 69, 73) });
    expect(prepareProbeInput({ kind: 'sight', target: 12 }, context).input).toEqual({ kind: 'sight', target: '#12' });
    expect(prepareProbeInput({ kind: 'column' }, context)).toMatchObject({ input: { kind: 'column', x: 10, z: -4, yFrom: 66, yTo: 50 }, problem: null });
    expect(prepareProbeInput({ kind: 'column', yFrom: 10, yTo: 60 }, context).input).toMatchObject({ yFrom: 60, yTo: 10 });
    expect(prepareProbeInput({ kind: 'column', yFrom: 300, yTo: -60 }, context).input).toMatchObject({ yFrom: 300, yTo: 205 });
    expect(prepareProbeInput({ kind: 'look_history' }, context).input).toEqual({ kind: 'history', at: at(10, 64, -4), radius: 4 });
    expect(prepareProbeInput({ kind: 'around', radius: 40, to: at(1, 2, 3) }, context)).toMatchObject({ input: { kind: 'around', radius: 16 },
      fixes: ['radius を 16 にした', 'around に使わない欄 to を外した'] });
    expect(prepareProbeInput({ kind: 'path', to: { x: '5', y: 64, z: 9.7 } }, context).input).toEqual({ kind: 'path', to: at(5, 64, 9) });
    expect(prepareProbeInput({ kind: 'scan' }, context).input).toEqual({ kind: 'scan' });
  });

  it('what cannot be sent says why in one line, and nothing goes to the body', () => {
    expect(prepareProbeInput({ kind: 'path' }, context).problem).toBe('path には to {x,y,z} が要る');
    expect(prepareProbeInput({ kind: 'sight', target: 'ghast' }, context).problem).toMatch(/近くに見えない/u);
    expect(prepareProbeInput({ kind: 'teleport' }, context).problem).toMatch(/^kind は path・sight・column・around・history・scan/u);
    expect(prepareProbeInput({ kind: 'column' }, { feet: null, creatures: [] }).problem).toMatch(/足の位置も分からない/u);
  });

  it('through the mode\'s prepare: checked against the body\'s form (a sight of a block is not refused), fixes said', () => {
    expect(llmcSchema(MC_PROBE_TOOL)).toBeDefined();
    const prepared = llmcPrepare(MC_PROBE_TOOL, { kind: 'sight', at: at(1, 2, 3) }, context);
    expect(prepared).toEqual({ input: { kind: 'sight', target: at(1, 2, 3) }, fixes: ['at を target にした'], problem: null });
    expect(validSkillInput(prepared.input, llmcSchema(MC_PROBE_TOOL)!)).toBe(true);
    expect(llmcPrepare(MC_PROBE_TOOL, { kind: 'path' }, context).problem).toBe('path には to {x,y,z} が要る');
    // The model's schema takes what the model writes; the head's checks of it are as strict as the body's form.
    expect(validSkillInput({ kind: 'sight', target: 'blaze' }, PROBE_INPUT_SCHEMA)).toBe(true);
  });

  it('a model\'s own call reads the text and then the fields; a failed one says so', () => {
    const receipt = (outcome: 'completed' | 'failed', result: string) => ({ outcome, result }) as never;
    const ok = llmcResult(MC_PROBE_TOOL, receipt('completed', answer('column', 'y=40〜33 空気×8（落差 8）／y=32 stone', { x: 1, z: 2 })), null);
    expect(ok).toMatchObject({ ok: true, text: 'y=40〜33 空気×8（落差 8）／y=32 stone\n{"x":1,"z":2}' });
    expect(llmcResult(MC_PROBE_TOOL, receipt('failed', 'nope'), null)).toMatchObject({ ok: false });
    expect(llmcResult(MC_PROBE_TOOL, receipt('completed', answer('scan', 'x', { rows: ['r'.repeat(4_000)] })), null, ['kind を scan にした']).text.length)
      .toBeLessThan(2_700);
  });
});

describe('forbid and caution on the plan\'s nodes (shared note 4; arch-check 23: they held longest and worked)', () => {
  const tree = () => planFromSeeds([{ title: '木と石の道具', children: [{ title: '原木を集める' }, { title: '作業台' }] }, { title: '鉄' }])!;

  it('forbid / caution add to the current node by default, the oldest goes past four, the same line once; lift takes one off', () => {
    let plan = applyPlanUpdate(tree(), { ops: [{ op: 'forbid', text: '素手で真下を掘らない' }, { op: 'caution', id: 'p1', text: '東は落差 7' }] });
    expect(plan.problem).toBeNull();
    const current = plan.tree.nodes.find(node => node.id === plan.tree.current)!;
    expect(current).toMatchObject({ id: 'p1.1', forbid: ['素手で真下を掘らない'] });
    for (const text of ['a', 'b', 'c', 'd', '素手で真下を掘らない']) plan = applyPlanUpdate(plan.tree, { ops: [{ op: 'forbid', text }] });
    expect(plan.tree.nodes.find(node => node.id === 'p1.1')!.forbid).toEqual(['b', 'c', 'd', '素手で真下を掘らない']);
    plan = applyPlanUpdate(plan.tree, { ops: [{ op: 'lift', text: '真下' }, { op: 'lift', id: 'p1', text: '東は落差 7' }] });
    expect(plan.problem).toBeNull();
    expect(plan.tree.nodes.find(node => node.id === 'p1.1')!.forbid).toEqual(['b', 'c', 'd']);
    expect(plan.tree.nodes.find(node => node.id === 'p1')).not.toHaveProperty('caution');
    expect(applyPlanUpdate(plan.tree, { ops: [{ op: 'lift', text: '無い行' }] }).problem).toMatch(/禁止・注意は無い/u);
    expect(applyPlanUpdate(plan.tree, { ops: [{ op: 'forbid', text: 'x'.repeat(PLAN_LIMITS.rule + 1) }] }).problem).toMatch(/長すぎる/u);
    expect(applyPlanUpdate(plan.tree, { ops: [{ op: 'forbid', id: 'n99', text: 'x' }] }).problem).toBe('ops[0]: n99 が無い');
  });

  it('the path shows the current node\'s and its parents\' lines (at most 8), and none of another branch; a tree with none shows no key', () => {
    expect(planPath(tree())).not.toHaveProperty('rules');
    const plan = applyPlanUpdate(tree(), { ops: [{ op: 'forbid', id: 'p1', text: '村の鉄ゴーレムを殴らない' }, { op: 'caution', text: '夜は囲う' },
      { op: 'forbid', id: 'p2', text: '溶岩の隣を掘らない' }] }).tree;
    expect(planPath(plan).rules).toEqual(['注意: 夜は囲う', '禁止（p1）: 村の鉄ゴーレムを殴らない']);
    const text = planText(plan);
    expect(text).toContain('    注意: 夜は囲う');
    expect(text).toContain('  禁止: 溶岩の隣を掘らない');
    let many = plan;
    for (const [index, op] of (['forbid', 'caution'] as const).flatMap(kind => [1, 2, 3, 4].map(n => [n, kind] as const)).entries()) {
      many = applyPlanUpdate(many, { ops: [{ op: op[1], id: index % 2 ? 'p1' : 'p1.1', text: `${op[1]}${op[0]}` }] }).tree;
    }
    expect(planPath(many).rules).toHaveLength(PLAN_LIMITS.shownRules);
  });

  it('a tree with forbid and caution is read back from the checkpoint; add and split may carry them', () => {
    const plan = applyPlanUpdate(tree(), { ops: [{ op: 'add', title: 'ネザー', forbid: ['ネザーで寝ない'] },
      { op: 'split', id: 'p2', into: [{ title: '鉄を掘る', caution: ['y=16 の洞窟は暗い'] }] }] });
    expect(plan.problem).toBeNull();
    expect(readPlanTree(JSON.parse(JSON.stringify(plan.tree)))).toEqual(plan.tree);
    expect(readPlanTree({ ...plan.tree, nodes: [{ ...plan.tree.nodes[0], forbid: ['1', '2', '3', '4', '5'] }] })).toBeNull();
  });

  it('the tool: r4 offers the ops and the arrays in fixed words; without r4 it is r3\'s definition, byte for byte', async () => {
    expect(JSON.stringify(createFcaPlanTools({ taskId: 't', checkpoint: null }).tools.definitions)).toBe(JSON.stringify([PLAN_UPDATE_DEFINITION]));
    const tools = createFcaPlanTools({ taskId: 't', checkpoint: null, rules: true });
    expect(tools.tools.definitions).toEqual([PLAN_UPDATE_RULES_DEFINITION]);
    const schema = PLAN_UPDATE_RULES_DEFINITION.nativeInputSchema as { properties: { ops: { items: { properties: Record<string, { enum?: string[] }> } } } };
    expect(schema.properties.ops.items.properties.op!.enum).toEqual(['add', 'split', 'set', 'move', 'drop', 'forbid', 'caution', 'lift']);
    expect(PLAN_UPDATE_RULES_DEFINITION.description).toContain(PLAN_UPDATE_DEFINITION.description);
    expect(PLAN_UPDATE_RULES_DEFINITION.description).toMatch(/plan\.rules/u);
    const signal = new AbortController().signal;
    const call = (input: unknown) => tools.tools.execute({ id: 'c', name: 'plan.update', input, taskId: 't', scopeKey: 'o', operationId: 'op', signal } as never);
    await call({ ops: [{ op: 'add', title: '木' }] });
    const result = await call({ ops: [{ op: 'forbid', text: '素手で真下を掘らない' }] });
    expect(result).toMatchObject({ ok: true });
    expect(tools.port.view()!.rules).toEqual(['禁止: 素手で真下を掘らない']);
  });
});

describe('the body\'s scan to the first plan (shared note 3; arch-check 6: run 26\'s stem 4 m away, run 27\'s 160 m of no tree)', () => {
  const scan = { trigger: 'login', at: '2026-10-22T04:00:00Z', dimension: 'overworld', text: '160m 内に地表の原木なし。村なし。', rows: ['C dungeon の箱 (10,20,5) 北40m'] };

  it('r4\'s input has the scan\'s words and rows; r3\'s has none', () => {
    const world = { position: at(-6, 69, 10), scan };
    const input = firstPlanInput('ネザーへ', world, { scan: true });
    expect(input).toContain('走査（読み込み済みの範囲の目印）:\n160m 内に地表の原木なし。村なし。\n- C dungeon の箱 (10,20,5) 北40m');
    expect(firstPlanInput('ネザーへ', world)).not.toContain('走査');
    expect(scanForPlan(undefined)).toBeNull();
  });

  it('r4\'s words, schema and answer: the scan, the Nether\'s check, a node\'s forbid and caution', () => {
    expect(FIRST_PLAN_SYSTEM_R4.startsWith(FIRST_PLAN_SYSTEM)).toBe(true);
    expect(FIRST_PLAN_SYSTEM_R4).toContain('走査');
    expect(FIRST_PLAN_SYSTEM_R4).toContain(NETHER_ENTRY_KNOWLEDGE);
    expect(JSON.stringify(FIRST_PLAN_SCHEMA)).not.toContain('forbid');
    expect(JSON.stringify(FIRST_PLAN_SCHEMA_R4)).toContain('"forbid"');
    const tree = planFromAnswer({ nodes: [{ id: 'p1', parent: '', title: '木を探す', where: '', doneWhen: '', forbid: ['素手で真下を掘らない', ''],
      caution: ['砂漠は暑い'] }] })!;
    expect(tree.nodes[0]).toMatchObject({ forbid: ['素手で真下を掘らない'], caution: ['砂漠は暑い'] });
  });

  it('with no scan yet, the plan waits for one (16 s at most: the body scans within 15 s of a spawn) and is asked with r4\'s words and the scan', async () => {
    expect(SCAN_WAIT.ms).toBe(20_000); // r5: the body's r5 scan comes up to 15 s after the spawn, later than its r4 did
    let world: Record<string, unknown> = { position: at(0, 64, 0) };
    const asked: Array<{ system: string; input: string }> = [];
    const planner = async (system: string, input: string) => { asked.push({ system, input }); return { nodes: [] }; };
    startFirstPlan({ taskId: 'fp-r4', goal: 'ネザーへ', held: { schema: 'shannon.plan-tree.v1', revision: 0, current: null, nodes: [] }, world, planner,
      log: () => {}, r4: { world: () => world, everyMs: 10, waitMs: 1_000 } });
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(asked).toHaveLength(0);
    world = { ...world, scan };
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(asked).toHaveLength(1);
    expect(asked[0]!.system).toBe(FIRST_PLAN_SYSTEM_R4);
    expect(asked[0]!.input).toContain('160m 内に地表の原木なし');
  });

  it('without r4 the plan is asked at once with r3\'s words', () => {
    const asked: string[] = [];
    startFirstPlan({ taskId: 'fp-r3', goal: 'ネザーへ', held: { schema: 'shannon.plan-tree.v1', revision: 0, current: null, nodes: [] },
      world: { scan }, planner: async system => { asked.push(system); return { nodes: [] }; }, log: () => {} });
    expect(asked).toEqual([FIRST_PLAN_SYSTEM]);
  });
});

describe('the knowledge r4 adds (shared note 5)', () => {
  it('how to look when stuck, how to read a dangerous fact, the plan\'s forbid and caution, the scan, the Nether\'s check', () => {
    for (const words of ['同じ止まりが 2 回 → まず history', 'path', 'sight', '落ちた・溺れそう → column', '当たらない・届かない → sight',
      '何があるか分からない → scan か mc.view', '前提', 'forbid', 'caution', 'lift']) expect(INVESTIGATE_KNOWLEDGE).toContain(words);
    expect(INVESTIGATE_KNOWLEDGE).toMatch(/「下 n 段は空気」なら飛び降りない。n が 3 段以下で、鉄の防具（全身）があれば降りてよい/u);
    expect(INVESTIGATE_KNOWLEDGE).toMatch(/足がかりではない/u);
    for (const words of ['crimson_stem', 'warped_stem', 'crafting_table', 'cobblestone_slab', 'shield', 'offhand', '帰りのゲートの座標'])
      expect(NETHER_ENTRY_KNOWLEDGE).toContain(words);
    expect(LLMC_SYSTEM_APPENDIX_R4.startsWith(LLMC_SYSTEM_APPENDIX)).toBe(true);
    expect(llmcSystemAppendix(false)).toBe(LLMC_SYSTEM_APPENDIX);
    // r5 follows r4's words with its own (`R5_KNOWLEDGE`).
    expect(llmcSystemAppendix(true).startsWith(LLMC_SYSTEM_APPENDIX_R4)).toBe(true);
    expect(LLMC_SYSTEM_APPENDIX).not.toContain('mc.probe');
  });
});
