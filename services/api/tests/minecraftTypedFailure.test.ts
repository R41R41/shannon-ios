import { afterEach, describe, expect, it } from 'vitest';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { actProblem, type ActHandLine, type ActInput, type ActResult } from '../src/contracts/minecraftActContract.js';
import { typedFailureOf, typedFailureAttemptsOf, typedFailureLines, repeatedTypedFailure, failureCheckedAt,
  type TypedFailureAttempt } from '../src/surfaces/minecraft/minecraftLlmcTypedFailure.js';
import { tableNote, TABLE_REACH_METERS } from '../src/surfaces/minecraft/minecraftLlmcTableNote.js';
import { createLlmcEvents, tasks } from '../src/surfaces/minecraft/minecraftLlmcEvents.js';
import { factsContext, type LlmcBodyParts } from '../src/surfaces/minecraft/minecraftLlmcBodyFacts.js';
import { inputFacts } from '../src/surfaces/minecraft/minecraftLlmcFacts.js';
import { gateHold } from '../src/surfaces/minecraft/minecraftLlmcReadiness.js';
import { withLlmcBody, forgetLlmcEvents } from '../src/surfaces/minecraft/minecraftLlmcBody.js';
import type { FcaBodyLifecycle } from '../src/mind/action/fca/fcaPorts.js';
import type { MinecraftControlReceipt } from '../src/contracts/minecraftControlContract.js';
import { createQueueProgress } from '../src/surfaces/minecraft/minecraftLlmcQueueProgress.js';
import type { QueueDeps, QueueItem, LlmcQueue, RanListener } from '../src/surfaces/minecraft/minecraftLlmcQueueState.js';
import { toolFailure } from '../src/mind/tools/toolRegistryPorts.js';

const AT = Date.parse('2026-11-03T00:00:00.000Z');
const where = { x: 2, y: 64, z: 1 };
const frame = (world: Record<string, unknown> = {}, at = AT): BodyObservation => ({
  schemaVersion: 1, bodyId: 'minecraft:test', sequence: 1, stateAt: new Date(at).toISOString(), receivedAt: new Date(at + 5).toISOString(),
  connected: true, facts: {}, state: { world: { dimension: 'overworld', position: { x: 0, y: 64, z: 0 }, health: 20, food: 20,
    inventory: [], ...world } as never },
});
const stopped = (extra: Partial<ActHandLine> = {}): ActHandLine => ({ i: 1, do: 'make', status: 'stopped',
  goal: 'failed', end: 'finished', code: 'no_table', line: '作業台が 4.5m 以内に無い', ...extra });
const resultJson = (lines: ActHandLine[]): string => JSON.stringify({ v: 1, ok: false, done: 0, of: lines.length, lines,
  at: where, hp: 20, food: 20, ms: 100 } satisfies ActResult);
const input: ActInput = { hands: [{ do: 'make', item: 'shield', count: 1 }] };
const attempt = (line = stopped(), observation = frame(), sent: unknown = input): TypedFailureAttempt =>
  typedFailureAttemptsOf(resultJson([line]), observation, sent)[0]!;
const llmc: LlmcBodyParts = { plan: () => undefined, planView: () => null };

afterEach(() => forgetLlmcEvents());

describe('T8: a shield that cannot be made, over several turns', () => {
  const lacking = (line = 'make shield: missing: oak_log×2') => stopped({ code: 'missing', line });
  const carrying = (at: number) => frame({ inventory: ['birch_log×3'] }, at);
  it('says the same candidate was tried when the same words come again in a later frame, and not when the situation read differently', () => {
    const events = createLlmcEvents('t8-shield');
    events.noteFailures(resultJson([lacking()]), carrying(AT), input);
    const first = events.failureFacts(carrying(AT + 2000)).join('\n');
    expect(first).toContain('失敗 lack_material');
    expect(first).toContain('birch_planks');
    expect(first).not.toContain('同じ候補はもう試した');
    events.noteFailures(resultJson([lacking()]), carrying(AT + 8000), input);
    expect(events.failureFacts(carrying(AT + 9000)).join('\n')).toContain('同じ候補はもう試した');
    events.noteFailures(resultJson([lacking('make shield: missing: oak_log×1')]), carrying(AT + 20_000), input);
    expect(events.failureFacts(carrying(AT + 21_000)).join('\n')).not.toContain('同じ候補はもう試した');
  });
  it('starts again after a result without a failure', () => {
    const events = createLlmcEvents('t8-shield-reset');
    events.noteFailures(resultJson([lacking()]), carrying(AT), input);
    events.noteFailures(resultJson([stopped({ status: 'done', goal: 'done', code: undefined, line: '拾った' })]), carrying(AT + 5000), input);
    events.noteFailures(resultJson([lacking()]), carrying(AT + 9000), input);
    expect(events.failureFacts(carrying(AT + 9500)).join('\n')).not.toContain('同じ候補はもう試した');
  });
});

describe('the four typed body failures', () => {
  it('no_table keeps the body line and shares the exact distance/reach words of tableNote', () => {
    const observation = frame({ inventory: ['birch_planks×4'], utilities: {
      radius: 16, dim: 'overworld', scanned: true, found: [{ block: 'crafting_table', distance: 9.2 }],
    } });
    const failure = typedFailureOf(stopped(), observation)!;
    expect(failure).toMatchObject({ code: 'no_table', evidence: [stopped().line,
      '一番近い作業台は 9.2 m 先（作る手が届くのは 4.5 m 以内）'], cost: {}, checkedAt: AT });
    expect(tableNote(input, observation)).toContain(failure.evidence[1]);
    expect(failure.candidateArgs).toEqual([{ hand: { do: 'make', item: 'crafting_table', count: 1 }, verified: false,
      why: '持ち物に板 4。作成・設置場所・経路は未確認' }]);
    expect(typedFailureLines({ failure, hand: input.hands[0] as unknown as Record<string, unknown> }, observation).join('\n')).toContain('未確認');
  });

  it('does not invent absence from an unscanned table search or a table exactly within reach', () => {
    for (const utilities of [undefined, { radius: 16, scanned: false, found: [] },
      { radius: 16, scanned: true, found: [{ block: 'crafting_table', distance: TABLE_REACH_METERS }] }]) {
      const observation = frame({ utilities });
      expect(typedFailureOf(stopped(), observation)!.evidence).toEqual([stopped().line]);
      expect(tableNote(input, observation)).toBeNull();
    }
    const scanned = frame({ utilities: { radius: 16, scanned: true, found: [] } });
    expect(typedFailureOf(stopped(), scanned)!.evidence[1]).toBe('半径 16 m 内に作業台が見えない（作る手が届くのは 4.5 m 以内）');
    expect(tableNote(input, scanned)).toContain('先に go で作業台へ寄るか、持ち物の板 4 で作業台を place してから作る');
    expect(tableNote({ hands: [{ do: 'go', to: where }, ...input.hands] }, scanned)).toBeNull();
  });

  it('offers no invented placement coordinate, duplicate table, material, risk or time estimate', () => {
    for (const inventory of [[], ['oak_planks×3'], ['crafting_table×1', 'oak_planks×8']]) {
      const failure = typedFailureOf(stopped(), frame({ inventory }))!;
      expect(failure.candidateArgs).toEqual([]);
      expect(failure.cost).toEqual({});
    }
  });

  it.each(['permission', 'permit', 'permission_denied', 'no_permission', 'missing_permit'])('%s is a permission stop for dig/place/movement', code => {
    for (const kind of ['dig', 'place', 'go', 'walk', 'vertical', 'pillarUp'] as const) {
      const line = stopped({ do: kind, code, line: '体がこの操作を許可していない', where });
      const failure = typedFailureOf(line, frame())!;
      expect(failure.code).toBe('no_permission');
      expect(failure.evidence).toEqual([line.line]);
      expect(failure.candidateArgs).toEqual([{ hand: { do: 'look', to: where }, verified: false,
        why: '体が報告した停止位置。見え方・届く足場・掘り置きの許可は未確認' }]);
      expect(JSON.stringify(failure.candidateArgs)).not.toMatch(/canDig|canPlace|seconds|maxDig|maxPlace/u);
    }
  });

  it('cannot_dig needs explicit permission evidence; a bad tool/bedrock or no_place alone proves none', () => {
    const line = stopped({ do: 'vertical', code: 'cannot_dig', line: 'granite は canDig に無い。canDig に granite を足せば進む' });
    expect(typedFailureOf(line, frame())!.code).toBe('no_permission');
    for (const text of ['岩盤は壊せない', '今の道具では掘れない', 'granite は canDig に含まれているが道具が無い']) {
      expect(typedFailureOf({ ...line, line: text }, frame())).toBeNull();
    }
    expect(typedFailureOf(stopped({ do: 'place', code: 'no_place', line: '当てる面が無い' }), frame())).toBeNull();
  });

  it('make missing oak_log becomes lack_material; other carried wood is an unverified alternative, never a success', () => {
    const observation = frame({ inventory: ['spruce_log×2', 'birch_log×1'] });
    const line = stopped({ code: 'missing', line: 'make shield missing: oak_log×2' });
    const failure = typedFailureOf(line, observation)!;
    expect(failure.code).toBe('lack_material');
    expect(failure.evidence).toEqual([line.line]);
    expect(failure.candidateArgs.map(candidate => candidate.hand)).toEqual([
      { do: 'make', item: 'spruce_planks', count: 4 }, { do: 'make', item: 'birch_planks', count: 4 },
    ]);
    expect(failure.candidateArgs.every(candidate => candidate.verified === false)).toBe(true);
    for (const candidate of failure.candidateArgs) expect(actProblem({ hands: [candidate.hand as unknown as ActInput['hands'][number]] })).toBeNull();
    const words = typedFailureLines({ failure, hand: { do: 'make', item: 'shield' } }, observation).join('\n');
    expect(words).toContain('未確認');
    expect(words).not.toContain('通る');
    expect(typedFailureOf(line, frame())!.candidateArgs).toEqual([]);
  });

  it('recognizes missing in a body result line without interpreting every missing item as oak', () => {
    const line = stopped({ code: undefined, line: 'missing: iron_ingot×1' });
    expect(typedFailureOf(line, frame({ inventory: ['spruce_log×8'] }))).toMatchObject({ code: 'lack_material', evidence: [line.line], candidateArgs: [] });
    expect(typedFailureOf({ ...line, do: 'go' }, frame())).toBeNull();
  });

  it.each(['not_visible', 'unreachable'])('dig/mine %s becomes not_visible and only suggests observing the reported position', code => {
    for (const kind of ['dig', 'mine'] as const) {
      const line = stopped({ do: kind, code, line: `${kind} 見えない・届かない`, where });
      const failure = typedFailureOf(line, frame())!;
      expect(failure).toMatchObject({ code: 'not_visible', evidence: [line.line], candidateArgs: [{ hand: { do: 'look', to: where }, verified: false }] });
      expect(actProblem({ hands: [failure.candidateArgs[0]!.hand as unknown as ActInput['hands'][number]] })).toBeNull();
    }
    expect(typedFailureOf(stopped({ do: 'attack', code }), frame())).toBeNull();
    expect(typedFailureOf(stopped({ do: 'dig', code }), frame())!.candidateArgs).toEqual([]);
  });

  it('leaves successful, skipped, unknown, cut, gate-required and malformed results alone', () => {
    for (const extra of [{ status: 'done' }, { status: 'skipped' }, { goal: 'unknown' }, { end: 'cut' }, { end: 'not_run' },
      { do: 'go', code: 'gate_required', line: '必須の盾・食料・体力が不足。進む許可が無い' }] satisfies Partial<ActHandLine>[]) {
      expect(typedFailureOf(stopped(extra), frame())).toBeNull();
    }
    for (const json of [undefined, '{broken', '{}', '{"v":1,"done":0,"of":1,"lines":[null]}']) {
      expect(typedFailureAttemptsOf(json, frame(), input)).toEqual([]);
    }
    const gate = { hands: [{ do: 'portal' }] };
    const observation = frame();
    const before = gateHold(gate, observation);
    expect(before).not.toBeNull();
    typedFailureOf(stopped({ code: 'missing', line: 'make shield missing: oak_log×2' }), observation);
    expect(gateHold(gate, observation)).toEqual(before);
  });
});

describe('freshness and the record of actual attempts (pure arguments)', () => {
  it('uses stateAt, rejects unknown times, and never substitutes a receipt/head time', () => {
    expect(failureCheckedAt(frame())).toBe(AT);
    for (const observation of [null, { ...frame(), connected: false }, { ...frame(), stateAt: 'unknown' }]) {
      expect(typedFailureOf(stopped(), observation)).toBeNull();
    }
  });

  it('omits candidates that no longer hold: an older frame, 30 s later, what they use gone, disconnected, or no observation', () => {
    const observation = frame({ inventory: ['birch_planks×4'] });
    const current = attempt(stopped(), observation);
    expect(typedFailureLines(current, observation).join('\n')).toContain('候補:');
    expect(typedFailureLines(current, frame({ inventory: ['birch_planks×4'] }, AT + 1000)).join('\n')).toContain('候補:');
    const still = (at: number) => frame({ inventory: ['birch_planks×4'] }, at);
    for (const fresh of [frame({}, AT + 1), still(AT - 1), still(AT + 31_000), null, { ...observation, connected: false }]) {
      const lines = typedFailureLines(current, fresh);
      expect(lines).toHaveLength(1);
      expect(lines.join('\n')).not.toContain('crafting_table');
      expect(lines[0]).toContain(`観測 ${AT} ms`);
    }
  });

  it('adds the repeated-attempt fact from the second failure, without mutating input/history', () => {
    const observation = frame({ inventory: ['birch_planks×4'] });
    const current = attempt(stopped(), observation);
    const previous = [current];
    const before = JSON.stringify({ observation, input, previous });
    expect(typedFailureLines(current, observation)).toHaveLength(2);
    expect(typedFailureLines(current, observation, previous)).toHaveLength(3);
    expect(typedFailureLines(current, observation, previous)[1]).toContain('同じ候補はもう試した');
    expect(repeatedTypedFailure(current, [current, current])).toBe(true);
    expect(JSON.stringify({ observation, input, previous })).toBe(before);
  });

  it('different code, evidence, frame time, actual arguments, or an intervening failure breaks repetition', () => {
    const current = attempt();
    const different: TypedFailureAttempt[] = [
      { ...current, failure: { ...current.failure, code: 'lack_material' } },
      { ...current, failure: { ...current.failure, evidence: ['別の報告'] } },
      { ...current, hand: { do: 'make', item: 'iron_pickaxe' } },
      { ...current, hand: null },
    ];
    for (const old of different) {
      expect(repeatedTypedFailure(current, [old])).toBe(false);
      expect(repeatedTypedFailure(current, [current, old])).toBe(false);
      expect(typedFailureLines(current, frame(), [old]).join('\n')).not.toContain('同じ候補はもう試した');
    }
    expect(repeatedTypedFailure({ ...current, hand: { count: 1, item: 'shield', do: 'make' } }, [current])).toBe(true);
  });

  it('offered alternatives and absent/mismatched actual hands never become attempted facts', () => {
    const current = attempt();
    for (const sent of [undefined, { hands: ['make shield'] }, { hands: [{ do: 'craft', item: 'shield' }] }]) {
      const unknown = typedFailureAttemptsOf(resultJson([stopped()]), frame(), sent)[0]!;
      expect(unknown.hand).toBeNull();
      expect(repeatedTypedFailure(unknown, [current])).toBe(false);
    }
    const second = stopped({ i: 2 });
    const got = attempt(second, frame(), { hands: [{ do: 'look', to: where }, ...input.hands] });
    expect(got.hand).toEqual(input.hands[0]);
  });
});

describe('the head facts at decision time', () => {
  it('passes actual prepared hands through the queue callback into normal and urgent model facts without retrying', () => {
    let observation = frame({ inventory: ['birch_planks×4'] });
    const listeners: RanListener[] = [];
    // This narrow queue fake exposes no add/send method: observing its receipt must never execute a candidate.
    const queue = { onRan: (listener: RanListener) => listeners.push(listener), mark() {}, lines: () => [], ahead: () => [] } as unknown as LlmcQueue;
    const base: FcaBodyLifecycle = { start() {}, revision: () => 0, context: () => ({ revision: 0, observation }),
      guard: async () => true, toolSignal: (_name, signal) => signal, close: async () => {} };
    const body = withLlmcBody(base, { llmc, taskId: 'typed-wiring', createdAt: new Date(AT).toISOString(),
      observe: () => observation, arrival: () => ({ at: null, kind: null }), now: () => AT + 10, log() {}, queue,
      r4: { probe: () => null, planWhere: () => null } });
    // Exercise the real queue projection, which used to pass only call/why to these listeners.
    const progress = createQueueProgress({} as QueueDeps, { items: [], open: () => [], now: () => AT });
    const receipt: MinecraftControlReceipt = { id: 'receipt', connectionId: 'connection', outcome: 'failed', inputsReleased: true,
      observedAt: observation.stateAt, result: resultJson([stopped()]) };
    const queued = { input, call: { id: 'model-call', name: 'mc.act', input: { hands: ['make shield'] } }, why: '作る' } as QueueItem;
    for (let count = 0; count < 2; count += 1) {
      for (const listener of listeners) progress.tell(listener, queued, toolFailure('failed', '作業台が無い'), { ...receipt, id: `receipt-${count}` });
    }
    expect(tasks.get('typed-wiring')!.typedFailures).toHaveLength(2);
    body.context();
    const normal = body.transient!() as { facts: string[] };
    expect(normal.facts.join('\n')).toContain('同じ候補はもう試した');
    expect(normal.facts.join('\n')).toContain('未確認');
    observation = frame({ inventory: ['birch_planks×4'], nearbyThreats: [{ id: 7, name: 'zombie', kind: 'hostile',
      distance: 4, position: where, canSee: true }] }, AT + 31_000);
    body.context();
    const urgent = body.transient!() as { facts: string[] };
    expect(urgent).toHaveProperty('mode');
    expect(urgent.facts.join('\n')).toContain('失敗 no_table');
    expect(urgent.facts.join('\n')).not.toContain('候補:');
  });

  it('carries the same failure fact into normal, urgent and compressed facts; fresh candidates expire at use', () => {
    const observation = frame({ inventory: ['birch_planks×4'] });
    const events = createLlmcEvents('typed-facts');
    events.noteFailures(resultJson([stopped()]), observation, input);
    const first = events.failureFacts(observation);
    expect(first.join('\n')).not.toContain('同じ候補はもう試した');
    events.noteFailures(resultJson([stopped()]), observation, input);
    const failures = events.failureFacts(observation);
    expect(failures.join('\n')).toContain('同じ候補はもう試した');
    for (const urgent of [false, true]) {
      const facts = inputFacts(observation, factsContext(llmc, observation, {}, undefined, { failures }), urgent);
      for (const line of failures) {
        expect(facts.lines).toContain(line);
        expect(facts.compressed).toContain(line);
      }
    }
    expect(events.failureFacts(frame({}, AT + 1)).join('\n')).not.toContain('候補:');
    expect(events.failureFacts(frame({}, AT + 1)).join('\n')).toContain('失敗 no_table');
    events.take();
    expect(events.failureFacts(observation)).toEqual(failures);
    events.noteFailures(resultJson([stopped({ status: 'done', goal: 'done', code: undefined })]), observation, input);
    expect(events.failureFacts(observation)).toEqual([]);
    events.noteFailures(resultJson([stopped()]), observation, input);
    expect(events.failureFacts(observation).join('\n')).not.toContain('同じ候補はもう試した');
    expect(createLlmcEvents('other-task').failureFacts(observation)).toEqual([]);
  });
});
