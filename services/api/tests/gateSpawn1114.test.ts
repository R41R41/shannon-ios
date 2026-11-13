import { describe, expect, it } from 'vitest';
import { orderedPlan, PLAN_LIMITS, type PlanTree } from '@shannon/mind';
import { openingDraft, seedPlan } from '../src/surfaces/minecraft/minecraftFirstPlan.js';
import { doneStatusWords, nodesSeenDone, parseDoneWhen, type DoneFacts } from '../src/surfaces/minecraft/minecraftPlanDone.js';
import { GATE_SPAWN_M, gateSpawnIn, seenMarks } from '../src/surfaces/minecraft/minecraftSeenMarks.js';
import { PREP_RULES_WORDS } from '../src/surfaces/minecraft/minecraftLlmcPrepRules.js';
import { V2_STAGES } from '../src/surfaces/minecraft/minecraftLlmcV2Knowledge.js';

/**
 * Run 10 (11/14, the owner): she died in the Nether with 7 rods and came back at a far spawn; the pack lay by the blazes for its 5 minutes.
 * Before going in, one of the 8 beds is set down in front of the lit gate (overworld side), used (by day it sets the point, no sleep) and
 * left standing. The plan says it as its own node between the light and the entering, closed when the body's respawn bed is by the portal.
 */
const PORTAL = 'p ネザーポータル (12,64,22) 北 3m';
const world = (respawn: string | null, landmarks: string[] = [PORTAL], portal?: string): Record<string, unknown> => ({
  mapLandmarks: landmarks,
  rememberedPlaces: { ...(respawn ? { respawn } : {}), ...(portal ? { nether_portal: portal } : {}) },
});
const facts = (frame: Record<string, unknown>): DoneFacts => ({ counts: new Map([['white_bed', 7]]), dimension: 'overworld',
  feet: { x: 10, y: 64, z: 18 }, food: 120, seen: seenMarks(frame) });

describe('the gate\'s respawn bed (run 10, 11/14)', () => {
  const plan = seedPlan('エンドラを倒して')!;
  const gate = plan.nodes.find(node => node.parentId === null && node.title === '黒曜石10とゲート')!;
  const kids = plan.nodes.filter(node => node.parentId === gate.id);

  it('lights the gate with noEnter, sets the bed in front of it, then enters, as three nodes in that order', () => {
    expect(kids.map(node => node.title)).toEqual(['溶岩源で黒曜石10（ゲートの分）', '火打ち金（火打石は砂利）', 'ゲートを組んで火をつける（noEnter）',
      'ゲートの前にベッドを置いて use（寝ない・壊さない）', 'ゲートに入る（p のマスへ walk）']);
    expect(kids.map(node => node.doneWhen).slice(2)).toEqual(['see:nether_portal|dim:the_nether|have:ender_eye>=10',
      'see:gate_spawn|dim:the_nether|have:ender_eye>=10', 'dim:the_nether|have:ender_eye>=10']);
    const bed = kids[3]!;
    expect(bed.note).toContain('ネザーで死んでもゲートの前で復活し、すぐ戻って落とし物（約5分で消える）を拾える');
    expect(bed.note).toContain('集めた8個の1個を使う');
    expect((bed.caution ?? []).join(' ')).toContain('掘らずに残す（帰りに掘って8に戻す）');
    expect((gate.caution ?? []).join(' ')).toContain('点いたらゲートの前にベッドを置いて use し、すぐ入る');
    // The way back takes the gate's bed again, so the End's check still counts 8 in the pack.
    expect(plan.nodes.find(node => node.title.startsWith('ベッドを8個にする'))!.note).toContain('ゲートの前のベッドも掘って持つ');
  });

  it('keeps every node within the plan\'s bounds (title 60, note 120, caution 80 and 4 lines, 64 nodes)', () => {
    expect(plan.nodes.length).toBeLessThanOrEqual(PLAN_LIMITS.nodes);
    for (const node of plan.nodes) {
      expect(node.title.length, node.title).toBeLessThanOrEqual(PLAN_LIMITS.title);
      expect((node.note ?? '').length, node.title).toBeLessThanOrEqual(PLAN_LIMITS.text);
      expect((node.doneWhen ?? '').length, node.title).toBeLessThanOrEqual(PLAN_LIMITS.text);
      expect((node.caution ?? []).length, node.title).toBeLessThanOrEqual(PLAN_LIMITS.rules);
      for (const line of node.caution ?? []) expect(line.length, line).toBeLessThanOrEqual(PLAN_LIMITS.rule);
      if (node.doneWhen) expect(parseDoneWhen(node.doneWhen), node.doneWhen).not.toBeNull();
    }
  });

  it('puts the bed\'s node in the first plan\'s draft (the model keeps the draft\'s nodes and conditions up to the Nether)', () => {
    const draft = openingDraft(seedPlan('エンドラを倒して', 'overworld'))!;
    expect(draft).toContain('ゲートの前にベッドを置いて use（寝ない・壊さない） [portal] doneWhen: see:gate_spawn|dim:the_nether|have:ender_eye>=10');
    expect(draft).toContain('ゲートに入る（p のマスへ walk） [portal] doneWhen: dim:the_nether|have:ender_eye>=10');
    // Since the golden boots' node (11/13, `dim:the_nether` as a later alternative) the draft ended at the boots, without the gate at all.
    expect(draft).toContain('黒曜石10とゲート [portal] doneWhen: dim:the_nether|have:ender_eye>=10');
    expect(draft).toContain('溶岩源で黒曜石10（ゲートの分）');
    expect(draft).not.toContain('出発の点検（ネザーの奥へ）');
    expect(draft.length).toBeLessThan(3_200);
  });

  it('reads the gate\'s spawn from the body\'s respawn bed beside a portal it sees or remembers, and nothing else', () => {
    expect(gateSpawnIn(world('3m 北 (10,64,20) bed リスポーン地点'))).toBe(true);
    expect(seenMarks(world('3m 北 (10,64,20) bed リスポーン地点')).has('gate_spawn')).toBe(true);
    expect(gateSpawnIn(world('3m 北 (10,64,20) bed リスポーン地点', [], '3m 北 (12,64,22) ↔the_nether(1,64,2)'))).toBe(true);
    // A bed slept in on the first night, far from the gate, is not the gate's.
    expect(gateSpawnIn(world('140m 西 (-120,70,22) bed リスポーン地点'))).toBe(false);
    expect(gateSpawnIn(world(null))).toBe(false);
    expect(gateSpawnIn(world('3m 北 (10,64,20) bed リスポーン地点', []))).toBe(false);
    expect(GATE_SPAWN_M).toBe(8);
  });

  it('moves the plan from the light to the bed, and from the bed to the entering, by what the body sees', () => {
    // Everything before the light is done (the gate itself, their parent, is open).
    const order = orderedPlan(plan.nodes).map(node => node.id);
    const before = new Set(order.slice(0, order.indexOf(kids[2]!.id)).filter(id => id !== gate.id));
    const tree: PlanTree = { ...plan, nodes: plan.nodes.map(node => before.has(node.id) ? { ...node, state: 'done' as const } : node) };
    // Lit, no bed by it yet: the light closes, the bed's node stays open and says what is missing.
    const lit = facts(world(null));
    expect(nodesSeenDone(tree, lit, true)).toEqual([kids[2]!.id]);
    expect(doneStatusWords(kids[3]!.doneWhen, lit)).toContain('ゲートの 8m 内のリスポーン地点はまだ無い（ベッドを place して use）');
    // The bed used by the gate: the bed's node closes too, and the entering and the gate stay open until the Nether.
    const set = facts(world('3m 北 (10,64,20) bed リスポーン地点'));
    const done = nodesSeenDone(tree, set, true);
    expect(done).toEqual([kids[2]!.id, kids[3]!.id]);
    expect(done).not.toContain(kids[4]!.id);
    expect(done).not.toContain(gate.id);
  });

  it('says why in the stage rules the decisions read before the gate, and the comeback in the Nether\'s', () => {
    expect(PREP_RULES_WORDS).toContain('ゲートは portal noEnter で点け、入る前にゲートのすぐ前（現世側・枠の 2〜4m 前の床）にベッドを 1 個 place して use し、掘らずに残す');
    expect(PREP_RULES_WORDS).toContain('ネザーで死んでもゲートの前で復活し、約 5 分で消える落とし物を 4 秒のゲートからすぐ拾いに戻れる');
    expect(PREP_RULES_WORDS).toContain('ネザーではベッドを使わない（爆発する）');
    expect(V2_STAGES.prep).toContain('ゲートの前にリスポーン用の 1 個を置いて use し（帰りに掘って戦い用に戻す）');
    expect(V2_STAGES.nether).toContain('ゲートの前に use したベッドならそこで復活し、ゲートから 4 秒でネザーに戻れる');
  });
});
