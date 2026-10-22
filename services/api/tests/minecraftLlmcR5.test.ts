import { afterEach, describe, expect, it } from 'vitest';
import { planPath, planRules, type PlanTree } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { MC_ACT_TOOL } from '../src/contracts/minecraftActContract.js';
import { createFcaPlanTools } from '../src/mind/action/fca/fcaPlanTools.js';
import { forgetLlmcEvents, noteCautions, withLlmcBody } from '../src/surfaces/minecraft/minecraftLlmcBody.js';
import { createSurpriseWatch, forgetSurpriseWatches, scanLines, surpriseFrame } from '../src/surfaces/minecraft/minecraftLlmcProbe.js';
import { probeAnswerText } from '../src/surfaces/minecraft/minecraftLlmcProbeInput.js';
import { cautionFact } from '../src/surfaces/minecraft/minecraftLlmcCaution.js';
import { doneFacts, nodesSeenDone, parseDoneWhen, seenDoneUpdate } from '../src/surfaces/minecraft/minecraftPlanDone.js';
import {
  FIRST_PLAN_SYSTEM_R4, FIRST_PLAN_SYSTEM_R5, forgetFirstPlans, SCAN_WAIT, seedPlan, startFirstPlan,
} from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { LLMC_SYSTEM_APPENDIX, LLMC_SYSTEM_APPENDIX_R4, LLMC_SYSTEM_APPENDIX_R5, LLMC_SYSTEM_APPENDIX_R6, llmcSystemAppendix, R5_KNOWLEDGE } from '../src/surfaces/minecraft/minecraftKnowledge.js';
import { llmcCompletionMistake } from '../src/wiring/minecraftLlmcWiring.js';

/**
 * mb-llmc r5 (production run 28, 2026-10-22, owner 「止めて直す」): the plan's nodes marked done from the frame, a fact noted as a caution at the
 * second same surprise, the completion's mistake in one line, and the knowledge of completion and of stairs (the rest in the modules r4 had:
 * minecraftLlmcR5Watch.test.ts).
 */
afterEach(() => { forgetLlmcEvents(); forgetSurpriseWatches(); forgetFirstPlans(); });

function frame(world: Record<string, unknown>): BodyObservation {
  return { schemaVersion: 1, bodyId: 'minecraft:s', sequence: 1, stateAt: '2026-10-22T00:00:00Z', receivedAt: '2026-10-22T00:00:00Z', connected: true,
    state: { world: world as never }, facts: { alive: true } };
}
const at = (x: number, y: number, z: number) => ({ x, y, z });
/** Run 28 at 608 s: the blacksmith's chest gave an iron pickaxe, a helmet and boots, bread and ingots. */
const RUN28 = frame({ position: at(176.5, 63, 199.5), dimension: 'overworld', worn: '頭: iron_helmet(残り165)、胴: なし、脚: なし、足: iron_boots(残り195)',
  inventory: [{ name: 'spruce_log', count: 4 }, { name: 'stone_pickaxe', count: 1 }, { name: 'stone_axe', count: 1 }, { name: 'stone_sword', count: 1 },
    { name: 'wooden_pickaxe', count: 1 }, { name: 'iron_pickaxe', count: 1 }, { name: 'bread', count: 4 }, { name: 'red_bed', count: 3 },
    { name: 'iron_ingot', count: 4 }] });

describe('the plan moves on by what the frame shows (run 28: "now" stayed on p1.1 to the end, 0 of 39 done)', () => {
  it('reads the predicate form, and leaves free words to the model', () => {
    expect(parseDoneWhen('have:stone_pickaxe&have:stone_sword')).toEqual([[{ kind: 'have', item: 'stone_pickaxe', count: 1 },
      { kind: 'have', item: 'stone_sword', count: 1 }]]);
    expect(parseDoneWhen('have:iron_ingot>=24 | dim:nether')).toEqual([[{ kind: 'have', item: 'iron_ingot', count: 24 }],
      [{ kind: 'dim', dimension: 'the_nether' }]]);
    expect(parseDoneWhen('at:(196,69,237)~6&food>=40')).toEqual([[{ kind: 'at', x: 196, y: 69, z: 237, r: 6 }, { kind: 'food', points: 40 }]]);
    for (const words of ['stone_pickaxe を持つ', '原木6以上', 'ネザーレンガ（N）が見える', 'have:', 'have:log&', '']) expect(parseDoneWhen(words)).toBeNull();
  });

  it('every doneWhen of the seed that an observation can show is a predicate', () => {
    const tree = seedPlan('エンドラを討伐してください')!;
    const free = tree.nodes.filter(node => node.doneWhen && !parseDoneWhen(node.doneWhen)).map(node => node.doneWhen);
    expect(free).toEqual(['ネザーレンガ（N）が見える']);
  });

  it('marks the nodes done that run 28 had done at 608 s, and the current node moves past them', () => {
    const tree = seedPlan('エンドラを討伐してください')!;
    const facts = doneFacts(RUN28)!;
    expect(facts.food).toBe(44);
    const done = nodesSeenDone(tree, facts);
    // Wood and stone (all three tools), the food and the bed (bread 44 points, a bed), the iron pickaxe is not yet the iron node (no bucket).
    // r9: a node is done by its own predicate: p1 (the pack: the stone pickaxe) and its children p1.2, p1.3 (their tools) are; p1.1 (6 logs: she has 4)
    // is not closed with its parent, and a parent done by the pack leaves its open children as they are (nothing under it is picked next).
    expect(done).toEqual(expect.arrayContaining(['p1', 'p1.2', 'p1.3', 'p2', 'p2.3']));
    expect(done).not.toContain('p1.1');
    expect(done).not.toContain('p3');
    const seen = seenDoneUpdate(tree, RUN28)!;
    const lines: string[] = [];
    const plan = createFcaPlanTools({ taskId: 'r5-plan', checkpoint: { fcaPlanTree: tree }, rules: true, seen: held => seenDoneUpdate(held, RUN28),
      log: line => lines.push(line) });
    const view = plan.port.view()!;
    expect(view.now).not.toMatch(/^p1\.1 /u);
    expect(view.now).toMatch(/^p2\.[12] |^p3\.1 /u);
    expect(plan.port.committed()).not.toBeNull();
    expect(lines.some(line => line.startsWith('Shannon FCA plan settled task=r5-plan'))).toBe(true);
    expect(seen.ids).toEqual(done);
    // Read again: nothing more to do, no line.
    const before = lines.length;
    plan.port.view();
    expect(lines).toHaveLength(before);
  });

  it('a dimension, a place and food; a blocked node is left to the model', () => {
    const tree: PlanTree = { schema: 'shannon.plan-tree.v1', revision: 1, current: 'a', nodes: [
      { id: 'a', parentId: null, order: 0, title: 'ゲート', state: 'continue', doneWhen: 'dim:the_nether' },
      { id: 'b', parentId: null, order: 1, title: '村', state: 'continue', doneWhen: 'at:10,64,-3~3' },
      { id: 'c', parentId: null, order: 2, title: '箱', state: 'blocked', reason: 'x', doneWhen: 'at:10,64,-3' }] };
    const nether = doneFacts(frame({ position: at(10, 64, -3), dimension: 'minecraft:the_nether' }))!;
    expect(nodesSeenDone(tree, nether)).toEqual(['a', 'b']);
    expect(nodesSeenDone(tree, { ...nether, dimension: 'overworld', feet: at(30, 64, -3) })).toEqual([]);
  });
});

describe('the body\'s r5 words and fields (r4-contract.md 08:20)', () => {
  it('a path that cannot end on its target still gives its points; the scan\'s range row and one more row are shown', () => {
    const path = JSON.stringify({ v: 1, kind: 'path', text: '的そのものには立てない（下 2 マスが空気（立つ床が無い））。隣 (170,56,199) まで。'
      + '(164,55,197)→(171,55,199) 直線 7.3m：隣 (170,56,199) まで掘らず置かずに歩いて行ける。9 マス', reachable: true, onTarget: false,
      points: [at(166, 55, 198), at(170, 56, 199)], stands: [] });
    const read = probeAnswerText(path, true);
    expect(read.startsWith('的そのものには立てない')).toBe(true);
    expect(read).toContain('道の点（walk の path に使える）: (166,55,198) (170,56,199)');
    const rows = ['範囲 読み込み 441 チャンク・半径 10 チャンク（約 168m）', ...Array.from({ length: 12 }, (_, index) => `原木 oak ×${index} 最寄り (1,64,${index})`)];
    const shown = scanLines({ trigger: 'login', at: 't1', dimension: 'overworld', text: '走査', rows, radiusChunks: 10, viewDistance: 10, waitedMs: 6200 }, null)!;
    expect(shown.lines).toHaveLength(10);
    expect(shown.lines[1]).toMatch(/^範囲 読み込み/u);
    expect(SCAN_WAIT.ms).toBeGreaterThanOrEqual(18_000);
  });
});

describe('the first plan writes its doneWhen as predicates (r5)', () => {
  it('r5\'s words follow r4\'s, and the plan is asked with them', async () => {
    expect(FIRST_PLAN_SYSTEM_R5.startsWith(FIRST_PLAN_SYSTEM_R4)).toBe(true);
    for (const words of ['have:', 'dim:the_nether', 'at:x,y,z~', 'food>=', '& で全部', '| でどれか']) expect(FIRST_PLAN_SYSTEM_R5).toContain(words);
    const asked: string[] = [];
    startFirstPlan({ taskId: 'fp-r5', goal: 'エンドラを討伐して', held: { schema: 'shannon.plan-tree.v1', revision: 0, current: null, nodes: [] },
      world: { scan: { at: 't', text: '走査', rows: [] } }, planner: async system => { asked.push(system); return { nodes: [] }; }, log: () => {},
      r4: { world: () => ({ scan: { at: 't', text: '走査', rows: [] } }), system: FIRST_PLAN_SYSTEM_R5 } });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(asked).toEqual([FIRST_PLAN_SYSTEM_R5]);
  });
});

describe('a fact noted at the second same surprise (run 28: the same 「見えない」 15 times, never written down)', () => {
  const dig = { hands: [{ do: 'dig', at: [at(175, 53, 197)] }] };
  const stopped = 'act 0/1 済みで止まった（failure）\n1 dig 止 掘れない: Digging aborted（サーバーが壊したと言わない）\n今 (176,53,197) 体力20 満腹20';
  const sight = JSON.stringify({ v: 1, kind: 'sight', text: '(175,53,197) stone：見えない。間に固いブロック 1：(174,54,197) stone。目から 2.2m',
    visible: false, reach: true, distance: 2.2, between: [{ at: at(174, 54, 197), name: 'stone' }], target: { at: at(175, 53, 197), name: 'stone' } });

  it('the watch counts each surprise; the second dig surprise says the sight\'s fact', () => {
    const watch = createSurpriseWatch('r5-dig');
    const ctx = () => surpriseFrame(frame({ position: at(176.5, 53, 197.5), health: 20, dimension: 'overworld' }), 1);
    watch.detect(ctx(), null);
    for (let index = 0; index < 3; index++) watch.noteResult(MC_ACT_TOOL, false, stopped, dig);
    const [first] = watch.detect(ctx(), null);
    expect(first).toMatchObject({ code: 'dig', nth: 1, hand: { do: 'dig', aim: at(175, 53, 197) } });
    expect(cautionFact({ code: first!.code, nth: first!.nth!, hand: first!.hand! }, first!.probes, [sight])).toBeNull();
    for (let step = 0; step < 4; step++) watch.detect(ctx(), null);
    watch.noteResult(MC_ACT_TOOL, false, stopped, dig);
    const [second] = watch.detect(ctx(), null);
    expect(second).toMatchObject({ code: 'dig', nth: 2 });
    const fact = cautionFact({ code: 'dig', nth: 2, hand: second!.hand! }, second!.probes, [sight]);
    expect(fact).toBe('(175,53,197) の stone は見えない: 間に stone (174,54,197)');
    // Without an answer, the hand's own line: still a fact, never what to dig.
    expect(cautionFact({ code: 'repeat', nth: 2, hand: { do: 'walk', aim: at(146, 75, 206), line: '着かなかった: 頭の高さが stone' } }, [], []))
      .toBe('(146,75,206) の walk: 着かなかった: 頭の高さが stone');
    expect(cautionFact({ code: 'health', nth: 3, hand: null }, [], [])).toBeNull();
  });

  it('reads the body\'s r5 words: a dig not seen, a target she cannot stand on (r4-contract.md 08:20)', () => {
    const notSeen = 'act 0/1 済みで止まった（failure）\n1 dig 止 掘れない: (175,53,197)（自分から西1・下0）の stone が見えない：間に (174,54,197) stone（目から2.3m）';
    const watch = createSurpriseWatch('r5-notseen');
    const ctx = () => surpriseFrame(frame({ position: at(176.5, 53, 197.5), health: 20, dimension: 'overworld' }), 1);
    watch.detect(ctx(), null);
    for (let index = 0; index < 3; index++) watch.noteResult(MC_ACT_TOOL, false, notSeen, dig);
    const [first] = watch.detect(ctx(), null);
    expect(first).toMatchObject({ code: 'dig', line: '同じ掘りの中止が 3 回: 「掘れない」', hand: { do: 'dig', aim: at(175, 53, 197) } });
    const fallback = cautionFact({ code: 'dig', nth: 2, hand: first!.hand! }, [], [])!;
    expect(fallback).toBe('dig: 掘れない: (175,53,197)（自分から西1・下0）の stone が見えない：間に (174,54,197) stone（目から2.3m）');
    expect(fallback.length).toBeLessThanOrEqual(80);
    const path = JSON.stringify({ v: 1, kind: 'path', text: '的そのものには立てない（下 2 マスが空気（立つ床が無い））。隣 (170,56,199) まで。…',
      reachable: true, onTarget: false });
    expect(cautionFact({ code: 'repeat', nth: 2, hand: null }, [{ kind: 'path', to: at(171, 55, 199) }], [path]))
      .toBe('(171,55,199): 的そのものには立てない（下 2 マスが空気（立つ床が無い））');
  });

  it('is written on the current node\'s caution (the oldest goes past 4), and the plan\'s rules show it in the same decision', () => {
    const tree = seedPlan('エンドラを討伐してください')!;
    const plan = createFcaPlanTools({ taskId: 'r5-caution', checkpoint: { fcaPlanTree: tree }, rules: true });
    const note = (text: string) => plan.port.amend!({ ops: [{ op: 'caution', text }] }, 'noted');
    const surprise = { code: 'dig' as const, line: 'x', probes: [{ kind: 'sight' as const, target: at(175, 53, 197) }], nth: 2,
      hand: { do: 'dig', aim: at(175, 53, 197), line: '掘れない' } };
    expect(noteCautions([surprise], surprise.probes, [sight], note)).toBe(1);
    expect(planRules(plan.port.tree())).toEqual(['注意: (175,53,197) の stone は見えない: 間に stone (174,54,197)']);
    for (const index of [1, 2, 3, 4]) note(`事実 ${index}`);
    const rules = planPath(plan.port.tree()).rules!;
    expect(rules).toHaveLength(4);
    expect(rules[0]).toBe('注意: 事実 1');
    expect(noteCautions([{ ...surprise, nth: 1 }], surprise.probes, [sight], note)).toBe(0);
  });

  it('withLlmcBody notes it through its r4 parts when the probes came back', async () => {
    const noted: string[] = [];
    const body = withLlmcBody({ start() {}, revision: () => 0, context: () => ({ revision: 0, observation: null }), async guard() { return true; },
      toolSignal: (_name, parent) => parent, async close() {} }, { llmc: { plan: () => undefined, planView: () => null }, taskId: 'r5-body',
      createdAt: '2026-10-22T00:00:00Z', observe: () => frame({ position: at(176.5, 53, 197.5), health: 20, dimension: 'overworld' }),
      arrival: () => ({ at: 1, kind: 'login' }), log: () => {},
      r4: { probe: () => async () => sight, planWhere: () => null, caution: text => { noted.push(text); return true; } } });
    await body.investigate!(new AbortController().signal);
    for (let round = 0; round < 2; round++) {
      for (let index = 0; index < 3; index++) {
        body.noteResult!({ id: `c${round}${index}`, name: MC_ACT_TOOL, input: dig }, { ok: false, text: stopped, retryable: true } as never);
      }
      await body.investigate!(new AbortController().signal);
      for (let step = 0; step < 4; step++) await body.investigate!(new AbortController().signal);
    }
    expect(noted).toEqual(['(175,53,197) の stone は見えない: 間に stone (174,54,197)']);
  });
});

describe('the completion and the knowledge (r5)', () => {

  it('a turned-back completion is answered in one line: what a completion is for this goal, and to go on', () => {
    const line = llmcCompletionMistake('エンドラを討伐してください').line(2);
    expect(line).toMatch(/^完了の誤り（続けて 2 回目）/u);
    for (const words of ['ドラゴンの死を見た時だけ', '時間や遠さで区切らない', '計画を見直して続ける']) expect(line).toContain(words);
    expect(line.split('\n')).toHaveLength(1);
    expect(llmcCompletionMistake('ネザーに行って').line(1)).toContain('ネザーに入った時だけ');
    expect(llmcCompletionMistake('x').amend).toBeTypeOf('function');
  });


  it('the knowledge: a completion only on the goal seen, never cut by time; stairs one step at a time; the code\'s own plan changes', () => {
    for (const words of ['ドラゴンの死を見た時だけ', '時間や遠さで区切らない', '計画を見直して続ける', '階段は 1 段ずつ', '足の前の 2 マス（頭と足）を掘ってから 1 歩下りる',
      '間のブロックを先に掘る', 'have:', 'caution']) expect(R5_KNOWLEDGE).toContain(words);
    // r6: the mode's appendix is r6's now (minecraftLlmcR6.test.ts), which begins with r5's.
    expect(LLMC_SYSTEM_APPENDIX_R5).toBe(`${LLMC_SYSTEM_APPENDIX_R4}\n\n${R5_KNOWLEDGE}`);
    expect(LLMC_SYSTEM_APPENDIX_R6.startsWith(LLMC_SYSTEM_APPENDIX_R5)).toBe(true);
    expect(llmcSystemAppendix(false)).toBe(LLMC_SYSTEM_APPENDIX);
  });
});
