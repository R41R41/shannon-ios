import { afterEach, describe, expect, it } from 'vitest';
import { applyPlanUpdate, planFromSeeds } from '@shannon/mind';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { REPLAN_SYSTEM, forgetReplans } from '../src/surfaces/minecraft/minecraftLlmcReplan.js';
import { queueBriefLines, readSavedResults, replanBrief, resultDigest, type BriefInput } from '../src/surfaces/minecraft/minecraftLlmcReplanBrief.js';
import { hopsLine } from '../src/surfaces/minecraft/minecraftLlmcQueueWords.js';
import { createWaitLedger } from '../src/surfaces/minecraft/minecraftPurposeProgress.js';
import { createEndgame } from '../src/surfaces/minecraft/minecraftEndgame.js';
import { forgetStalls } from '../src/surfaces/minecraft/minecraftLlmcStalls.js';
import type { LlmcQueue, RanListener } from '../src/surfaces/minecraft/minecraftLlmcQueueState.js';
import { unheldReplan } from '../src/wiring/minecraftLlmcReplanWiring.js';

afterEach(() => {
  forgetReplans();
  forgetStalls();
});

/** A result the body gave for a fight that never began (the third run of 11/26, the head's own words for the stopped hand). */
const FIGHT_RESULT = [
  'q35 3.5m の #26 が回って来るのを斬る。目が隠れたら手を変える: act 0/2 済みで止まった（failure）',
  '1 fight 止 届かない: fight 止まった not_visible: enderman #26 エンダーマンの目が見えない（8009ms/8000ms。間に (125,61,-374) netherrack ほか 2。10.5m。対象 #26、微動 0/2、屋根外の注視 0/2）',
  '  事実: 進んでいない: 進んだ 0打・残りは分からない',
  '  事実: 穴の手が止まった理由 enderman_not_visible: 相手の目が見えない',
  '2 pickup 未 未実行',
].join('\n');
/** The line the head's queue says when her last moves were short (it is advice to the head). */
const HOPS = hopsLine([42, 14, 5, 2, 2], [4000, 4000, 4000])!;

const tree = (() => {
  const planned = planFromSeeds([{ title: 'エンダーマンからパールを取る', kind: 'pearl', doneWhen: 'have:ender_pearl>=14' }])!;
  return applyPlanUpdate(planned, { ops: [{ op: 'add', parent: planned.nodes[0]!.id, title: '開けた地面で目の見える個体へ fight する', kind: 'pearl', doneWhen: 'have:ender_pearl>=14' }] },
    { at: new Date(0).toISOString() }).tree;
})();

const input = (over: Partial<BriefInput> = {}): BriefInput => ({ goal: 'エンドラを討伐して', seconds: 928, stall: { kind: 'node_stalled', why: '節 n3 が 121 秒、進みが無い', node: 'n3' },
  tree, doneStatus: '未: ender_pearl 11/14', now: ['場所: the_nether (122,62,-317)'], facts: [], results: [], queue: ['列に項目なし', HOPS], earlier: [], sameNode: 0,
  knowledge: '', ...over });

describe('what the plan made again is given of the last results and of the body\'s queue (the third run of 11/26)', () => {
  it('writes the stop\'s code of a result into the brief, which a plain cut of the text lost', () => {
    const line = resultDigest(FIGHT_RESULT);
    expect(line).toContain('not_visible');
    expect(line).toContain('理由 enderman_not_visible');
    expect(line).not.toContain('\n');
    const text = replanBrief(input({ results: [line] }));
    expect(text).toContain('## 直近の結果');
    expect(text).toContain('エンダーマンの目が見えない');
  });

  it('has no section of results only when there are none, and reads a saved list with care', () => {
    expect(replanBrief(input())).not.toContain('## 直近の結果');
    expect(readSavedResults(['a', 3, '', null, 'b'])).toEqual(['a', 'b']);
    expect(readSavedResults(['1', '2', '3', '4', '5', '6'])).toEqual(['3', '4', '5', '6']);
    expect(readSavedResults('x')).toEqual([]);
  });

  it('leaves the head\'s advice on the length of a go out of the queue unless the stall is stops in one spot', () => {
    expect(queueBriefLines(['列に項目なし', HOPS], 'node_stalled')).toEqual(['列に項目なし']);
    expect(replanBrief(input())).not.toContain('直近の go は');
    expect(queueBriefLines(['列に項目なし', HOPS], 'same_spot_stops')).toEqual(['列に項目なし', HOPS]);
    const spot = replanBrief(input({ stall: { kind: 'same_spot_stops', why: '同じ所で止まった', node: 'n3' } }));
    expect(spot).toContain('直近の go は 42・14・5・2・2 m');
  });

  it('tells the strong model to name the cause from the results, and that a child with its parent\'s condition cannot end alone, each with its reason', () => {
    expect(REPLAN_SYSTEM).toContain('直近の結果');
    expect(REPLAN_SYSTEM).toMatch(/子の節の済む条件が親の節と同じ[^]*理由: 条件が親と同じ節は単独で終わらず/u);
  });
});

describe('the results go across steps through the checkpoint', () => {
  const frame = { connected: true, state: { world: { dimension: 'the_nether', position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, inventory: [] } }, facts: {}, bodyId: 'b', sequence: 1,
    stateAt: new Date(0).toISOString() } as unknown as BodyObservation;
  function step(checkpoint: unknown) {
    const listeners: RanListener[] = [], briefs: string[] = [], clock = { now: 0 };
    const queue = { onRan: (listener: RanListener) => { listeners.push(listener); }, lines: () => ['列に項目なし', HOPS], runningInput: () => null } as unknown as LlmcQueue;
    const unheld = unheldReplan({ held: false, taskId: 'rr', goal: 'エンドラを討伐して', createdAt: new Date(0).toISOString(), checkpoint,
      replanner: async (_system, brief) => { briefs.push(brief); return { ops: [], why: '待ちに見える' }; }, observe: () => frame, plan: { tree: () => tree, view: () => null },
      bodyParts: { plan: () => undefined, planView: () => null, planTree: () => tree, endgame: createEndgame(null) }, queue, waits: createWaitLedger(null),
      activeClock: () => clock.now, heldMs: () => 0, validate: () => null, log: () => undefined });
    return { listeners, briefs, clock, unheld: unheld! };
  }

  it('shows a step the results the step before had, and no advice on go length for a stall of the node', async () => {
    const first = step(null);
    for (const listener of first.listeners) listener({ call: { id: 'c', name: 'mc_act', input: {} }, why: 'w' } as never, { ok: false, text: FIGHT_RESULT } as never);
    first.clock.now = 130_000;
    first.unheld.watch.look();
    first.unheld.flow.note({ kind: 'node_stalled', key: tree.current ?? tree.nodes[0]!.id, why: '節が 121 秒、進みが無い' });
    const saved = JSON.parse(JSON.stringify(first.unheld.checkpoint()));
    expect(saved.minecraftReplanResults).toHaveLength(1);
    const next = step(saved);
    await next.unheld.flow.run(new AbortController().signal);
    expect(next.briefs).toHaveLength(1);
    expect(next.briefs[0]).toContain('## 直近の結果');
    expect(next.briefs[0]).toContain('理由 enderman_not_visible');
    expect(next.briefs[0]).not.toContain('直近の go は');
  });
});
