import { afterEach, describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { ACT_INPUT_SCHEMA, actProblem, handContinuesOnFail, MC_ACT_TOOL, MC_VIEW_TOOL, type ActInput, type ActResult } from '../src/contracts/minecraftActContract.js';
import { validSkillInput } from '../src/surfaces/minecraft/minecraftControlValidation.js';
import { actResultText, AROUND_PREFIX, llmcPrepare, llmcStoredResult, LLMC_KEPT_RESULT_CHARS } from '../src/surfaces/minecraft/minecraftLlmc.js';
import { forgetLlmcEvents, urgentReasons, withLlmcBody } from '../src/surfaces/minecraft/minecraftLlmcBody.js';
import { createFoodTrend, lookHint, minecraftLlmcLive } from '../src/surfaces/minecraft/minecraftLlmcLive.js';
import { DANGER_KNOWLEDGE, LLMC_SYSTEM_APPENDIX, WOOD_KNOWLEDGE } from '../src/surfaces/minecraft/minecraftKnowledge.js';
import { llmcTools } from '../src/wiring/minecraftLlmcWiring.js';
import { createFcaProgressTools } from '../src/mind/action/fca/fcaProgressTools.js';
import type { FcaToolDefinition } from '../src/mind/action/fca/fcaPorts.js';

/** mb-llmc r3 (production run 27, 2026-10-22): what the head changed after the first run of the mode. */
afterEach(() => { forgetLlmcEvents(); });

function frame(world: Record<string, unknown>): BodyObservation {
  return { schemaVersion: 1, bodyId: 'minecraft:s', sequence: 1, stateAt: '2026-10-22T00:00:00Z', receivedAt: '2026-10-22T00:00:00Z', connected: true,
    state: { world: world as never }, facts: { alive: true } };
}
const tool = (name: string, domain: FcaToolDefinition['domain'] = 'meta'): FcaToolDefinition => ({ name, description: name,
  input: { type: 'object', properties: {}, required: [], additionalProperties: false }, domain, effect: 'read', cost: 'none',
  audiences: ['owner_alone'], surfaces: ['text'] });
const result = (lines: ActResult['lines'], extra: Partial<ActResult> = {}): ActResult => ({ v: 1, ok: false, done: lines.filter(line => line.status === 'done').length,
  of: lines.length, lines, at: { x: 1, y: 64, z: 2 }, hp: 3.6, food: 12, ms: 2_300, ...extra });

describe('a hand that fails need not stop the act (run 27: [equip stone_sword, walk away] stopped at the equip; the creeper blew)', () => {
  it('onFail is a field of every hand, in the schema and the field check (it was refused before r3)', () => {
    const input: ActInput = { hands: [{ do: 'equip', item: 'stone_sword', onFail: 'continue' }, { do: 'walk', to: { x: 9, y: 64, z: 2 }, sprint: true, onFail: 'stop' }] };
    expect(validSkillInput(input, ACT_INPUT_SCHEMA)).toBe(true);
    expect(actProblem(input)).toBeNull();
    expect(llmcPrepare(MC_ACT_TOOL, input).problem).toBeNull();
    expect(llmcPrepare(MC_ACT_TOOL, { hands: [{ do: 'eat', onFail: 'later' }] }).problem).toMatch(/onFail は continue・stop のどれか/u);
  });

  it('by default the quick hands (equip, eat, look, sneak, jump) go on, every other kind stops; onFail says otherwise', () => {
    expect(['equip', 'eat', 'look', 'sneak', 'jump'].every(kind => handContinuesOnFail({ do: kind as never }))).toBe(true);
    expect(['walk', 'dig', 'place', 'craft', 'attack', 'use'].some(kind => handContinuesOnFail({ do: kind as never }))).toBe(false);
    expect(handContinuesOnFail({ do: 'dig', onFail: 'continue' })).toBe(true);
    expect(handContinuesOnFail({ do: 'equip', onFail: 'stop' })).toBe(false);
  });

  it('the result says the act ran to its end with a failed hand, the hand marked 失', () => {
    const text = actResultText(result([
      { i: 1, do: 'equip', status: 'failed', line: '無い: stone_sword を持っていない' },
      { i: 2, do: 'walk', status: 'done', line: '(1,64,2)→(9,64,2) 1.9秒' }]));
    expect(text.split('\n')[0]).toBe('act 最後まで動いた（済み 1/2、失敗して続けた手 1、2.3秒）');
    expect(text).toContain('1 equip 失 無い: stone_sword を持っていない');
    expect(text).toContain('2 walk 済 ');
  });
});

describe('the mode\'s menu and goal progress (run 27: 48 tools of her other work at every epoch, the failures restated every round)', () => {
  it('the tools port: the menu, no skill index, and progress without the failed calls (which every act result already says)', async () => {
    const base = { definitions: [tool('mc.act', 'minecraft_body'), tool('study_list'), tool('skill.read')], skillIndex: () => 'skills',
      async execute() { return { ok: false, text: 'x', failure: 'failed' as const, retryable: true }; } };
    const progress = createFcaProgressTools(base, { permit: async () => undefined, requireConditions: true });
    progress.progress.observed('op-1', 'mc.act', { ok: false, text: 'x', failure: 'failed', retryable: true });
    expect(progress.progress.context().failures).toHaveLength(1);
    const mode = llmcTools(progress);
    expect(mode.definitions.map(definition => definition.name)).toEqual(['mc.act']);
    expect(mode.skillIndex).toBeUndefined();
    mode.progress!.observed('op-2', 'mc.act', { ok: false, text: 'y', failure: 'failed', retryable: true });
    expect(mode.progress!.context()).toMatchObject({ failures: [], replans: [], conditions: [] });
    expect(JSON.stringify(mode.progress!.context())).not.toContain('op-2');
  });
});

describe('a long result kept short in the history, shown whole once (run 27: an observation 5,066 characters, a plan 2,842 kept to the end)', () => {
  const map = `地図 v1 足=(1,64,2)\n${'# . '.repeat(800)}`;
  it('a view past the bound: its first line stored, the rest shown once', () => {
    const { stored, shown } = llmcStoredResult(MC_VIEW_TOOL, map);
    expect(stored.length).toBeLessThan(LLMC_KEPT_RESULT_CHARS);
    expect(stored).toMatch(/^地図 v1 足=\(1,64,2\)…（続き \d+字は、この次の判断の live\.lastResults に一度だけ出した）$/u);
    expect(shown).toBe(map.slice(map.indexOf('\n') + 1));
    expect(llmcStoredResult('mc.find-blocks', 'oak_log (3,64,9) 7m')).toEqual({ stored: 'oak_log (3,64,9) 7m', shown: null });
  });

  it('an act keeps its lines; only a stopped hand\'s 3×3×3 goes to the next decision', () => {
    const text = `act 0/1 済みで止まった（failure）\n1 place 止 置けない (1,64,2) 自分の足のマス\n${AROUND_PREFIX}x=0..2 z=1..3 y=65: .../.@./...\n今 (1,64,2) 体力20 満腹20`;
    const { stored, shown } = llmcStoredResult(MC_ACT_TOOL, text);
    expect(stored).not.toContain(AROUND_PREFIX);
    expect(stored).toContain('1 place 止 置けない (1,64,2) 自分の足のマス');
    expect(shown).toBe(text.split('\n')[2]);
    expect(llmcStoredResult(MC_ACT_TOOL, 'act 全部済み（1/1、1.0秒）')).toEqual({ stored: 'act 全部済み（1/1、1.0秒）', shown: null });
  });

  it('the body lifecycle stores the short text and the next live state alone shows the rest', () => {
    const inner = { start() {}, revision: () => 0, context: () => ({ revision: 0, observation: null }), async guard() { return true; },
      toolSignal: (_name: string, parent: AbortSignal) => parent, async close() {} };
    const body = withLlmcBody(inner, { llmc: { plan: () => undefined, planView: () => null }, taskId: 'r3-shown', createdAt: new Date().toISOString(),
      observe: () => frame({ localMap: 'm', health: 20 }), arrival: () => ({ at: null, kind: null }), r4: { probe: () => null, planWhere: () => null } });
    body.context();
    expect(body.storedResult!({ id: 'v', name: MC_VIEW_TOOL, input: {} }, map)).toContain('live.lastResults');
    body.context();
    expect((body.transient!() as { lastResults?: string[] }).lastResults).toEqual([map.slice(map.indexOf('\n') + 1)]);
    body.context();
    expect((body.transient!() as { lastResults?: string[] }).lastResults).toBeUndefined();
  });
});

describe('an urgent step (run 27: a creeper stopped her act at 3.9 m; the next decision came 12.8 s later, after the blast)', () => {
  it('a hostile within 8 m (a creeper within 10), low health beside one, or an act cut by a hostile or a reflex', () => {
    expect(urgentReasons(frame({ nearbyThreats: [{ name: 'creeper', distance: 9.2 }], health: 20 }), null)).toEqual(['creeper 9.2m（爆発は約7m まで届く）']);
    expect(urgentReasons(frame({ nearbyThreats: [{ name: 'zombie', distance: 12 }], health: 6 }), null)).toEqual(['体力 6 で敵が近い']);
    expect(urgentReasons(frame({ nearbyThreats: [{ name: 'zombie', distance: 12 }], health: 20 }), null)).toEqual([]);
    expect(urgentReasons(frame({ health: 20 }), '前の act は stopIf（敵が近い）で止まった')).toHaveLength(1);
  });

  it('the lifecycle says so from the last act\'s result and the frame, and the live state names why first', () => {
    let threats: unknown[] = [];
    const inner = { start() {}, revision: () => 0, context: () => ({ revision: 0, observation: null }), async guard() { return true; },
      toolSignal: (_name: string, parent: AbortSignal) => parent, async close() {} };
    const lines: string[] = [];
    const body = withLlmcBody(inner, { llmc: { plan: () => undefined, planView: () => null }, taskId: 'r3-urgent', createdAt: new Date().toISOString(),
      observe: () => frame({ localMap: 'm', health: 20, nearbyThreats: threats }), arrival: () => ({ at: null, kind: null }), log: line => lines.push(line), r4: { probe: () => null, planWhere: () => null } });
    expect(body.urgent!()).toBe(false);
    body.noteResult!({ id: 'a', name: MC_ACT_TOOL, input: {} }, { ok: false, retryable: true,
      text: 'act 1/3 済みで止まった（stopIf: hostileWithin:creeper #12 3.9m）' });
    expect(body.urgent!()).toBe(true);
    body.context();
    expect(Object.keys(body.transient!())[0]).toBe('urgent');
    body.noteResult!({ id: 'b', name: MC_ACT_TOOL, input: {} }, { ok: true, retryable: false, text: 'act 全部済み（1/1、1.0秒）' });
    expect(body.urgent!()).toBe(false);
    threats = [{ name: 'skeleton', distance: 5 }];
    expect(body.urgent!()).toBe(true);
    expect(lines.filter(line => line.startsWith('Shannon Minecraft urgent step task=r3-urgent'))).toHaveLength(2);
  });
});

describe('look round when stuck (run 27: mc.view was never used, through a 20-block fall and six stops at the same walls)', () => {
  it('the same stop twice, a fall, or water: a hint in the live state', () => {
    expect(lookHint({ recentStops: ['(1,64,2)→(1,66,2) 一歩ではない ×2 3秒前'] })).toMatch(/mc_view/u);
    expect(lookHint({ recentStops: ['(1,64,2)→(1,66,2) 一歩ではない ×1 3秒前'] })).toBeNull();
    expect(lookHint({ oxygen: 4 })).toMatch(/溺れかけた/u);
    expect(lookHint({}, 19)).toMatch(/落ちた/u);
    const live = minecraftLlmcLive({ observation: frame({ localMap: 'm', oxygen: 4 }), elapsedMinutes: 1, trend: createFoodTrend(), events: [] });
    expect(live.look).toMatch(/mc_view/u);
  });
});

describe('the knowledge the run asked for', () => {
  it('no bare-handed shaft where there is no wood, and the order to look for it; the dangers and the map\'s own cells', () => {
    expect(WOOD_KNOWLEDGE).toMatch(/素手で真下へ掘らない/u);
    expect(WOOD_KNOWLEDGE).toMatch(/\(1\) 地表の木.*\(2\) 村の木の物.*\(3\) 難破船.*\(4\) 廃坑/su);
    expect(WOOD_KNOWLEDGE).toMatch(/縦穴でなく dig の階段/u);
    expect(DANGER_KNOWLEDGE).toMatch(/低体力（体力 8 以下）では戦わない/u);
    expect(DANGER_KNOWLEDGE).toMatch(/夜.*先に囲う/u);
    expect(DANGER_KNOWLEDGE).toMatch(/約 7m/u);
    for (const words of ['自分の足のマス', 'rel: true の手では {x:1,y:0,z:0} が足の東隣', 'onFail: "continue"', 'live.lastResults', 'live.urgent', '必ず mc.view',
      '畑（k）']) expect(LLMC_SYSTEM_APPENDIX).toContain(words);
  });
});
