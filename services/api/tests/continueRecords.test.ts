import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { buildModel, joinCommands, loadFixtures, stageChain, type Input, type ReceiptRecord, type Row, type TraceLine } from '../../../tools/continue-verify/judge.js';
import type { BodyObservation } from '../src/contracts/bodyControlContract.js';
import { configuredMinecraftBody } from '../src/contracts/minecraftBodyContract.js';
import type { ActInput } from '../src/contracts/minecraftActContract.js';
import type { MinecraftControlCommand, MinecraftControlPoll, MinecraftControlReceipt } from '../src/contracts/minecraftControlContract.js';
import { DecisionRecorder, thinkingDroppedOf } from '../src/infra/decisionRecords/decisionRecorder.js';
import { installDecisionRecorder, noteBodyCommand, noteDecisionOutcome, noteHeadBoot, noteHistoryChange, noteResultsRead, noteStageRow, recordRequest, recordResponse } from '../src/infra/decisionRecords/decisionRecordNotes.js';
import { readRun } from '../src/infra/decisionRecords/decisionRecordRead.js';
import { renderStages } from '../src/infra/decisionRecords/decisionRecordMarkdown.js';
import { withDecisionScope } from '../src/infra/decisionRecords/decisionRecordScope.js';
import { prefetchErrors, stageTimes, STAGE_NAMES } from '../src/infra/decisionRecords/decisionRecordStages.js';
import { createFcaPlanTools } from '../src/mind/action/fca/fcaPlanTools.js';
import { MinecraftControl } from '../src/surfaces/minecraft/minecraftControl.js';
import { minecraftBodyVersion } from '../src/surfaces/minecraft/minecraftBodyVersion.js';
import { recordedLedger } from '../src/surfaces/minecraft/minecraftLedgerRows.js';
import { createLlmcQueue, forgetLlmcQueues, type QueueAdd } from '../src/surfaces/minecraft/minecraftLlmcQueue.js';
import { minecraftV2Hooks } from '../src/surfaces/minecraft/minecraftLlmcV2.js';
import { correctedRow, eventsRow, receivedRow, releasedRow, unknownNotifiedRow, wokeRow, type RowContext } from '../src/surfaces/minecraft/minecraftOperationRows.js';
import { MinecraftControlStore } from '../src/surfaces/minecraft/store/minecraftControlStore.js';

/**
 * Continue contract 8, the head's side of the measure: the rows the recorder writes (`received`, `released`, `corrected`, `woke`, `live`, `input_change`, the request's `reads`,
 * the sent row's numbers, `head_boot`, `kind_raw`), the stages of time computed from them, and the judge (`tools/continue-verify/judge.ts`) joining what the recorder
 * really wrote. The fixtures are `measure/trace-ids.json`, `prefetch-woke.json`, `input-change.json`, `evidence-by-command-kind.json` and `plan/unknown-kind.json`.
 */
const FIXTURES = new URL('./fixtures/continue/', import.meta.url);
const fixture = (path: string) => JSON.parse(readFileSync(new URL(path, FIXTURES), 'utf8')) as Record<string, any>;
const fixtures = loadFixtures();
const RUN = 'run-rec';
const BASE = Date.parse('2026-10-28T04:10:50.000Z');
const at = (offset: number) => new Date(BASE + offset).toISOString();

const directories: string[] = [];
afterEach(() => {
  installDecisionRecorder(null);
  forgetLlmcQueues();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
/** A recorder that reads its clock from `clock.now` (set it before each write) and is installed for the notes. */
function recorded() {
  const root = mkdtempSync(join(tmpdir(), 'continue-records-'));
  directories.push(root);
  const clock = { now: BASE };
  const made = new DecisionRecorder({ root, now: () => clock.now, head: { revision: 'head-1', source: 'git', node: 'v24' }, log: () => undefined });
  installDecisionRecorder(made);
  return { made, root, clock, events: () => readRun(join(root, RUN)).events };
}
const MESSAGE = (extra: Record<string, unknown> = {}) => ({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'tool_use', stop_sequence: null,
  content: [{ type: 'tool_use', id: 'toolu_1', name: 'mc_act', input: { why: 'x', hands: ['walk 1,2,3'] } }],
  usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, ...extra });
const BODY = (messages: unknown[], system = 'あなたは体を動かす') => ({ model: 'claude-opus-5-5', max_tokens: 4_000, system: [{ type: 'text', text: system }], messages,
  tools: [{ name: 'mc_act', description: '動く', input_schema: { type: 'object' } }], tool_choice: { type: 'auto' } });
const observation = (sequence: number, life = 1): BodyObservation => ({ schemaVersion: 1, bodyId: 'minecraft:world', sequence, stateAt: at(0), receivedAt: at(0), connected: true,
  state: { world: { position: { x: 0, y: 64, z: 0 }, health: 20, inventory: [] }, life: { life, alive: true, since: at(0), dimension: 'overworld', dimensionSince: at(0) }, bodyRun: { bodyBoot: 'bb-1', connectionId: 'c-1' } }, facts: {} } as unknown as BodyObservation);
const scoped = <T>(work: () => T, versions?: () => Record<string, unknown>) => withDecisionScope({ taskId: RUN, stepId: 'step-1', record: true, ...(versions ? { versions } : {}) }, work);
const seen = (life = 1, sequence = 5) => () => ({ observed: { life, obsSeq: sequence, obsAt: at(0), bodyBoot: 'bb-1', headBoot: 'hb-1' } });

/** A command as the control hands it to the body, with the queue's envelope (the numbers `noteBodyCommand` writes). */
const command = (id: string, item: string, life = 1): MinecraftControlCommand => ({ schemaVersion: 1, id, serverId: 'world', connectionId: 'c-1', kind: 'skill', skill: 'act',
  arguments: { hands: [] }, deadlineAt: at(60_000), lease: { id: 'lease', holder: 'h', generation: 1 },
  context: { scopeKey: 'o', taskId: RUN, taskRevision: 1, bodyId: 'minecraft:world', sessionId: 's', generation: 1, goal: 'g', completionCondition: 'c', life, headBoot: 'hb-1' },
  queue: { item, after: null, node: null, maxMs: 60_000, startBy: at(60_000), queue: `${RUN}:hb-1:1`, dependsOn: [],
    madeIn: { life, dim: 'overworld', dimSince: at(0), bodyBoot: 'bb-1', connectionId: 'c-1', headBoot: 'hb-1', obsSeq: 5 } } }) as unknown as MinecraftControlCommand;
const context = (command_: string, item: string, when: string, life = 1): RowContext => ({ run: RUN, queue: `${RUN}:hb-1:1`, item, command: command_, headBoot: 'hb-1', observation: observation(5, life), at: when });

describe('measure/trace-ids.json and prefetch-woke.json: the stages of time from the rows', () => {
  const sample = fixture('measure/trace-ids.json');
  it('counts the seven stages of the fixture and the wall clock once (7,070 ms), joined by run, life and the decision that read the command', () => {
    const chains = stageTimes(sample.input.records);
    expect(chains).toEqual([{ failed: 'skill:q11', decision: 'd0153', next: 'skill:q12', linked: true, stagesMs: sample.expected.stagesMs, totalMs: sample.expected.totalMs, overlapMs: 0 }]);
    expect(Object.keys(chains[0]!.stagesMs!)).toEqual([...STAGE_NAMES]);
    expect(sample.expected.joinedBy).toEqual(['run', 'life', 'decision.reads', 'decision → sent.command']);
  });
  it('is not joined by the command alone: another life, or a request that read nothing, leaves the failure unlinked', () => {
    const records = sample.input.records as Row[];
    const lifeTwo = records.map(row => row.ev === 'request' ? { ...row, ids: { ...row.ids, life: 2 } } : row);
    expect(stageTimes(lifeTwo)[0]).toMatchObject({ failed: 'skill:q11', linked: false, why: 'no decision read it (same run and life)' });
    const noReads = records.map(row => row.ev === 'request' ? { ...row, reads: [] } : row);
    expect(stageTimes(noReads)[0]).toMatchObject({ linked: false });
    expect(stageTimes(records, { only: 'q11' })).toHaveLength(1);
    expect(stageTimes(records, { only: 'q12' })).toEqual([]);
  });
  it('takes the body\'s times of the next command from the receipts when the rows have none, and tells which time is missing otherwise', () => {
    const records = sample.input.records as Row[];
    const bare = records.map(row => row.ev === 'received' && row.ids?.command === 'skill:q12' ? { ...row, bodyTimes: {} } : row);
    expect(stageTimes(bare)[0]).toMatchObject({ linked: false, next: 'skill:q12', why: expect.stringContaining('lacks a time') });
    const fromReceipts = stageTimes(bare, { bodyTimesOf: id => id === 'skill:q12' ? { acceptedAt: '2026-10-28T04:10:57.000Z', lockAt: '2026-10-28T04:10:57.020Z', firstMotorAt: '2026-10-28T04:10:57.070Z' } : undefined });
    expect(fromReceipts[0]).toMatchObject({ linked: true, totalMs: 7070 });
  });
  it('counts a prefetch sent before the failure ended as 0 with its overlap, and the wall clock once', () => {
    const records = (sample.input.records as Row[]).map(row => row.ev === 'sent' ? { ...row, at: '2026-10-28T04:10:50.100Z' } : row);
    const chain = stageTimes(records)[0]!;
    expect(chain.stagesMs!['4_reply_to_send']).toBe(0);
    expect(chain.overlapMs).toBe(6800);
  });
  it('shows the stages as a table and the prefetch\'s error beside it', () => {
    const text = renderStages(stageTimes(sample.input.records), [{ command: 'skill:q7', wokeAt: at(0), predictedRemainingMs: 4000, endedAt: at(9500), errorMs: 5500 }]);
    expect(text).toContain('| skill:q11 | d0153 | skill:q12 | 150 | 250 | 6500 | 50 | 50 | 20 | 50 | 7070 | 0 |');
    expect(text).toContain('差 5500 ms');
    expect(renderStages([])).toContain('失敗した命令');
  });
  it('measures a prefetch: the item\'s real end minus the end the queue predicted when it woke (5,500 ms)', () => {
    const woke = fixture('measure/prefetch-woke.json');
    const rows: Row[] = [{ ev: 'woke', at: woke.input.woke.at, ids: { run: RUN, command: 'skill:q7', life: 1 }, why: woke.input.woke.why, predictedRemainingMs: woke.input.woke.predictedRemainingMs },
      { ev: 'received', ids: { run: RUN, command: 'skill:q7', life: 1 }, bodyTimes: { endedAt: woke.input.itemEndedAt } },
      { ev: 'woke', at: woke.input.woke.at, ids: { run: RUN, life: 1 }, why: 'remaining', predictedRemainingMs: 100 }];
    expect(prefetchErrors(rows).map(error => error.errorMs)).toEqual([woke.expected.errorMs]);
  });
});

describe('the recorder: a request carries its numbers, what it read, and the live state it stood on', () => {
  it('numbers a request by run, decision, the frame and its life, and names the commands whose words its input holds, in the order they were put there (not the dropped ones)', () => {
    const { events, clock } = recorded();
    scoped(() => {
      noteResultsRead([{ command: 'skill:a1', probe: 'q1 [p1] 木を切る: ' }, { command: 'skill:a2', probe: 'q2 [p1] 石を掘る: ' }, { command: 'skill:a3', probe: 'q3 [p1] 鉄を掘る: ' }]);
      clock.now = BASE + 400;
      const first = recordRequest('decision', BODY([{ role: 'user', content: '（列の知らせ）\nq3 [p1] 鉄を掘る: 失敗\nq1 [p1] 木を切る: 済んだ' }]))!;
      // The history was squeezed: q1's words are gone, q2's and q3's are there (q2 first).
      clock.now = BASE + 900;
      const second = recordRequest('decision', BODY([{ role: 'user', content: 'q2 [p1] 石を掘る: 済んだ q3 [p1] 鉄を掘る: 失敗 "quote"' }]))!;
      expect([first, second]).toEqual(['d0001', 'd0002']);
    }, seen(2, 9));
    const [one, two] = events().filter(event => event.ev === 'request');
    expect(one).toMatchObject({ id: 'd0001', reads: ['skill:a1', 'skill:a3'], ids: { run: RUN, decision: 'd0001', life: 2, obsSeq: 9, bodyBoot: 'bb-1', headBoot: 'hb-1' } });
    expect(two).toMatchObject({ id: 'd0002', reads: ['skill:a2', 'skill:a3'] });
    expect(one!.version.body).toEqual({});
  });
  it('has no `reads` when nothing was told, and a life of -1 when no frame was read (a step with no body)', () => {
    const { events } = recorded();
    scoped(() => { recordRequest('decision', BODY([{ role: 'user', content: 'こんにちは' }])); });
    const [request] = events().filter(event => event.ev === 'request');
    expect(request).not.toHaveProperty('reads');
    expect(request!.ids).toMatchObject({ run: RUN, decision: 'd0001', life: -1, obsSeq: -1 });
  });
  it('writes the live state the rewrite made (raw, shown, what it left out) with the bytes of the request that carried it', () => {
    const { events } = recorded();
    const live = { ownerClock: { now: 1 }, waiting: [], plan: { now: 'p1' }, recall: { items: [1, 2, 3] } };
    scoped(() => {
      const shown = minecraftV2Hooks().rewriteLive(live);
      recordRequest('decision', BODY([{ role: 'user', content: JSON.stringify(shown) }]));
    }, seen());
    const row = events().find(event => event.ev === 'live')!;
    expect(row).toMatchObject({ ids: { run: RUN, decision: 'd0001' } });
    expect(JSON.parse(row.raw)).toEqual(live);
    expect(JSON.parse(row.shown)).toEqual({ plan: { now: 'p1' } });
    expect(row.dropped).toEqual([{ field: 'ownerClock', count: 1, why: 'left_out' }, { field: 'waiting', count: 1, why: 'left_out' }, { field: 'recall(3)', count: 3, why: 'left_out' }]);
    expect(row.bytes).toBeGreaterThan(100);
    // One row for one request: the next request has none until a live state is built again.
    scoped(() => { recordRequest('decision', BODY([{ role: 'user', content: 'x' }])); }, seen());
    expect(events().filter(event => event.ev === 'live')).toHaveLength(1);
  });
});

describe('measure/input-change.json: what changed in the input beside the experiment', () => {
  const sample = fixture('measure/input-change.json');
  const transformations = (count: number) => Array.from({ length: count }, () => ({ type: 'thinking_dropped', reason: 'prefix_binding_mismatch' }));
  it('reads the provider\'s dropped thinking (run 45: 17 of prefix_binding_mismatch) and a history made again by a resume', () => {
    const { events } = recorded();
    const event = sample.input.events[0];
    expect(thinkingDroppedOf(MESSAGE({ input_transformations: transformations(event.thinkingDropped.count) }))).toEqual(event.thinkingDropped);
    expect(thinkingDroppedOf(MESSAGE({ input_transformations: [{ type: 'other', reason: 'x' }] }))).toBeNull();
    expect(thinkingDroppedOf(MESSAGE())).toBeNull();
    scoped(() => {
      const first = recordRequest('decision', BODY([{ role: 'user', content: 'a' }]))!;
      recordResponse(first, { message: MESSAGE() });
      noteHistoryChange(RUN, 'resume');
      const second = recordRequest('decision', BODY([{ role: 'user', content: 'a' }]))!;
      recordResponse(second, { message: MESSAGE({ input_transformations: transformations(event.thinkingDropped.count) }) });
    }, seen());
    const changes = events().filter(row => row.ev === 'input_change');
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ ...sample.expected.row, ids: { run: RUN, decision: 'd0002' }, thinkingDropped: event.thinkingDropped, promptHash: expect.stringMatching(/^[0-9a-f]{12}$/u) });
  });
  it('says a changed prompt (its hash), a summary before the decision, and nothing when the input is as the last decision\'s', () => {
    const { events } = recorded();
    scoped(() => {
      const ask = (system: string, kind: 'decision' | 'summary' = 'decision') => { const id = recordRequest(kind, BODY([{ role: 'user', content: 'a' }], system))!; recordResponse(id, { message: MESSAGE() }); };
      ask('A');            // the first decision of a task: nothing to differ from
      ask('A');            // the same prompt: nothing
      ask('B');            // the prompt changed
      ask('B', 'summary'); // the history is squeezed
      ask('B');            // the decision after it
    }, seen());
    const changes = events().filter(row => row.ev === 'input_change');
    expect(changes.map(row => [row.ids.decision, row.historyChanged])).toEqual([['d0003', 'none'], ['d0004', 'summary']]);
    expect(changes[1]!.promptHash).toBe(changes[0]!.promptHash);
  });
});

describe('the rows the head writes: through the installed recorder, each in the run its numbers name', () => {
  it('writes received, released, corrected, woke, unknown_notified and events with the time they carry, and never throws', () => {
    const { events } = recorded();
    const receipt = { id: 'skill:q1', connectionId: 'c-1', outcome: 'failed', inputsReleased: true, observedAt: at(0), bodyTimes: { acceptedAt: at(1), endedAt: at(9), failedAt: at(9), motorOps: 2 } } as MinecraftControlReceipt;
    for (const row of [receivedRow(context('skill:q1', 'q1', at(10)), receipt), releasedRow(context('skill:q1', 'q1', at(11)), 'cleanup', true), correctedRow(context('skill:q1', 'q1', at(12)), { goal: 'done', end: 'finished', released: true }),
      wokeRow(context('skill:q2', 'q2', at(13)), 'remaining', 4000.4), unknownNotifiedRow(context('skill:q1', 'q1', at(14))), eventsRow(context('skill:q1', 'q1', at(15)), true)]) noteStageRow(row);
    noteStageRow({ ev: 'received', ids: { run: undefined } } as never);
    expect(() => noteStageRow({ ev: 'received' })).not.toThrow();
    const written = events().filter(row => row.ev !== 'run');
    expect(written.map(row => [row.ev, row.at])).toEqual([['received', at(10)], ['released', at(11)], ['corrected', at(12)], ['woke', at(13)], ['unknown_notified', at(14)], ['events', at(15)]]);
    expect(written[0]).toMatchObject({ ids: { run: RUN, command: 'skill:q1', item: 'q1', life: 1, obsSeq: 5, bodyBoot: 'bb-1', headBoot: 'hb-1' }, receipt: { outcome: 'failed', unit: { goal: 'failed' } }, bodyTimes: { failedAt: at(9) } });
    expect(written[3]).toMatchObject({ why: 'remaining', predictedRemainingMs: 4000 });
    expect(written[5]).toMatchObject({ lost: true });
  });
  it('gives the head\'s boot to every run the recorder has open and to a run that opens after it', () => {
    const { made, root } = recorded();
    made.append('run-one', { ev: 'note' });
    noteHeadBoot('minecraft:world', run => ({ ev: 'head_boot', at: at(5), headBoot: 'hb-1', ids: { run, life: -1, obsSeq: -1, obsAt: at(5), headBoot: 'hb-1' } }));
    made.append('run-two', { ev: 'note' });
    expect(readRun(join(root, 'run-one')).events.map(row => row.ev)).toEqual(['run', 'note', 'head_boot']);
    expect(readRun(join(root, 'run-two')).events.map(row => row.ev)).toEqual(['run', 'head_boot', 'note']);
    expect(readRun(join(root, 'run-two')).events[1]).toMatchObject({ headBoot: 'hb-1', ids: { run: 'run-two' } });
  });
  it('keeps what no recorder is installed for: nothing, and no error', () => {
    installDecisionRecorder(null);
    expect(() => { noteStageRow(wokeRow(context('skill:q1', 'q1', at(1)), 'alert')); noteHeadBoot('b', () => ({})); noteHistoryChange(RUN, 'resume'); }).not.toThrow();
  });
});

describe('the sent row: the numbers the judge joins, and the reasons a decision\'s answer was discarded', () => {
  it('names the decision, the command, the queue, the item, the life and the resumed command; the queue\'s dependsOn and madeIn stay', () => {
    const { events } = recorded();
    scoped(() => {
      recordRequest('decision', BODY([{ role: 'user', content: 'a' }]));
      noteBodyCommand(command('skill:q9', 'q9'), { resumeOf: 'skill:q4' });
    }, seen());
    const sent = events().find(row => row.ev === 'sent')!;
    expect(sent).toMatchObject({ commandId: 'skill:q9', decisionId: 'd0001', resumeOf: 'skill:q4', context: { life: 1, headBoot: 'hb-1' }, queue: { item: 'q9', dependsOn: [], madeIn: { life: 1, obsSeq: 5 } },
      ids: { run: RUN, decision: 'd0001', command: 'skill:q9', queue: `${RUN}:hb-1:1`, item: 'q9', life: 1, bodyBoot: 'bb-1', headBoot: 'hb-1', obsSeq: 5 } });
  });
  it('writes the reason a decision\'s answer was not used: life_changed, dimension_changed, connection_changed (what the judge reads as `discarded`)', () => {
    const { events } = recorded();
    const reasons = ['life_changed', 'dimension_changed', 'connection_changed'] as const;
    scoped(() => {
      for (const reason of reasons) {
        recordRequest('decision', BODY([{ role: 'user', content: reason }]));
        noteDecisionOutcome('discarded', { reason });
      }
    }, seen());
    const discarded = events().filter(row => row.ev === 'discarded');
    expect(discarded.map(row => [row.id, row.reason])).toEqual([['d0001', 'life_changed'], ['d0002', 'dimension_changed'], ['d0003', 'connection_changed']]);
    const model = buildModel({ meta: { run: RUN, scene: 'x', benches: ['A'], headRev: 'h', bodyRev: 'b' }, rows: events() as Row[], receipts: [], trace: [], probes: [] }, fixtures);
    expect([...model.decisions.values()].map(view => view.discarded.map(row => row.reason))).toEqual([['life_changed'], ['dimension_changed'], ['connection_changed']]);
  });
});

describe('plan/unknown-kind.json: a kind outside the list is kept as the model wrote it', () => {
  it('puts kindRaw and the word in the decision\'s record when plan.update takes it as other, once', async () => {
    const sample = fixture('plan/unknown-kind.json');
    const { events } = recorded();
    const tools = createFcaPlanTools({ taskId: RUN, checkpoint: null, rules: true, log: () => undefined, now: () => at(0) });
    const call = (input: unknown) => tools.tools.execute({ scopeKey: 'o', taskId: RUN, operationId: 'op', name: 'plan.update', input, signal: new AbortController().signal } as never);
    await scoped(async () => {
      recordRequest('decision', BODY([{ role: 'user', content: 'a' }]));
      await call({ ops: [{ op: 'add', title: '食料', kind: 'food' }] });
      await call(sample.input.planUpdate);
      await call({ ops: [{ op: 'add', title: '畑のとなり', kind: 'iron' }] });
    }, seen());
    const rows = events().filter(row => row.ev === 'kind_raw');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ decisionId: 'd0001', ids: { run: RUN, decision: 'd0001' }, nodes: [{ kind: sample.expected.node.kind, kindRaw: sample.expected.node.kindRaw }] });
    expect(JSON.stringify(rows[0])).toContain(sample.expected.decisionRecord.mustContain[1]);
  });
});

describe('the body\'s version: what the body says, and the frame a request stands on', () => {
  const poll = (extra: Record<string, unknown> = {}) => ({ serverId: 'world', connectionId: 'c-1', schemaVersion: 1, observation: observation(7, 3), skills: [{ name: 'act' }, { name: 'view' }], ...extra });
  const control = (value: unknown) => ({ frame: () => ({ poll: value }) }) as never;
  it('names the body\'s revision and catalog hash from the poll first, and the head\'s own hash of the catalog only for a body that sends none', () => {
    const own = minecraftBodyVersion(control(poll({ bodyVersion: { revision: 'ab12cd3', catalogHash: 'feedbeef0001' } })), 'minecraft:world');
    expect(own).toMatchObject({ revision: 'ab12cd3', catalogHash: 'feedbeef0001', catalog: 'feedbeef0001', catalogSource: 'body', connected: true });
    const bare = minecraftBodyVersion(control(poll()), 'minecraft:world');
    expect(bare).toMatchObject({ catalogSource: 'head', catalog: expect.stringMatching(/^[0-9a-f]{12}$/u) });
    expect(bare).not.toHaveProperty('revision');
    expect(minecraftBodyVersion({ frame: () => null } as never, 'minecraft:world')).toEqual({ bodyId: 'minecraft:world', connected: false });
  });
  it('tells the frame the decision read (its life and number), else the newest one; the recorder takes it out of the version', () => {
    const newest = minecraftBodyVersion(control(poll()), 'minecraft:world') as { observed: Record<string, unknown> };
    expect(newest.observed).toMatchObject({ life: 3, obsSeq: 7, bodyBoot: 'bb-1', obsAt: at(0) });
    const read = { life: 2, dim: 'overworld', dimSince: at(0), bodyBoot: 'bb-0', connectionId: 'c-0', headBoot: 'hb-1', obsSeq: 4 } as const;
    const earlier = minecraftBodyVersion(control(poll()), 'minecraft:world', read) as { observed: Record<string, unknown> };
    expect(earlier.observed).toEqual({ life: 2, obsSeq: 4, bodyBoot: 'bb-0', headBoot: 'hb-1' });
    const { events } = recorded();
    scoped(() => { recordRequest('decision', BODY([{ role: 'user', content: 'a' }])); }, () => minecraftBodyVersion(control(poll({ bodyVersion: { revision: 'ab12cd3', catalogHash: 'feedbeef0001' } })), 'minecraft:world', read));
    const request = events().find(row => row.ev === 'request')!;
    expect(request.ids).toMatchObject({ life: 2, obsSeq: 4, bodyBoot: 'bb-0' });
    expect(request.version.body).toMatchObject({ revision: 'ab12cd3', catalogHash: 'feedbeef0001' });
    expect(request.version.body).not.toHaveProperty('observed');
  });
});

describe('the ledger\'s rows: the events it applied once, the counts it holds against the observation, and what no event explains', () => {
  const lastObs = { bodyBoot: 'bb-1', connectionId: 'c-1', obsSeq: 5 };
  function port(options: { eventIds?: string[]; lastObs?: typeof lastObs | null; added?: Array<Record<string, unknown>>; promises?: Array<Record<string, unknown>> } = {}) {
    let calls = 0;
    return { ledgerSeen: () => ({ eventIds: calls > 0 ? [...(options.eventIds ?? []), 'e-new'] : options.eventIds ?? [], lastObs: options.lastObs === undefined ? lastObs : options.lastObs }),
      applyLedger: () => { calls += 1; return (options.added ?? []) as never; }, tree: () => ({ promises: options.promises ?? [] }) as never };
  }
  const input = (ids: string[]) => ({ events: ids.map(id => ({ id, item: 'cobblestone', delta: 1, reason: 'mined' })), by: { command: 'skill:q1', item: 'q1' }, observation: observation(5), uses: [] } as never);
  it('applies once each event id (an id the ledger had is not applied again), has/observed per promise, and the revision it was booked on', () => {
    const rows: Record<string, unknown>[] = [];
    const promises = [{ id: 1, rev: 3, item: 'cobblestone', count: 8, use: '家', state: 'open', ledger: [], have: 4 }, { id: 2, rev: 1, item: 'oak_log', count: 2, use: '板', state: 'closed', ledger: [], have: 0 }];
    const added = recordedLedger(port({ eventIds: ['e-old'], promises, added: [{ promise: 1, id: 'e-new', kind: 'gained', count: 1, declared: true, promiseRev: 2 }] }), input(['e-old', 'e-new']),
      { run: RUN, headBoot: 'hb-1', record: row => rows.push(row as never), now: () => BASE });
    expect(added).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ev: 'ledger', at: at(0), ids: { run: RUN, command: 'skill:q1', item: 'q1' }, applied: ['e-new'], have: { cobblestone: 4 }, observed: { cobblestone: 0 }, promiseRev: 2 });
  });
  it('tells no counts when the ledger did not take this observation, and a row for an unexplained difference only for kind unexplained (not a death\'s loss)', () => {
    const rows: Record<string, unknown>[] = [];
    const recording = { run: RUN, headBoot: 'hb-1', record: (row: unknown) => rows.push(row as never), now: () => BASE };
    recordedLedger(port({ lastObs: { ...lastObs, obsSeq: 9 }, promises: [{ id: 1, rev: 1, item: 'cobblestone', count: 8, use: '家', state: 'open', ledger: [], have: 4 }] }), input(['e-new']), recording);
    expect(rows[0]).toMatchObject({ ev: 'ledger', have: {}, observed: {} });
    rows.length = 0;
    recordedLedger(port({ added: [{ promise: 1, id: 'u1', kind: 'unexplained', count: -3 }, { promise: 1, id: 'death:1', kind: 'lost_death', count: 5 }] }), input([]), recording);
    expect(rows.map(row => row.ev)).toEqual(['ledger', 'ledger_unexplained']);
    expect(rows[1]).toMatchObject({ count: 3, ids: { command: 'skill:q1' } });
  });
  it('never fails the ledger when its memory cannot be read, and returns what the ledger returned', () => {
    const broken = { ledgerSeen: () => { throw new Error('x'); }, applyLedger: () => [{ promise: 1 }] as never, tree: () => ({ promises: [] }) as never };
    expect(recordedLedger(broken, input(['a']), { run: RUN, headBoot: 'hb-1', record: () => { throw new Error('y'); } })).toEqual([{ promise: 1 }]);
  });
});

// ---- the queue, the control and the judge together ------------------------------------------------------------------------------------------------------------------
const LOOSE = { type: 'object', properties: {}, required: [], additionalProperties: false };
function rig(connection = 'connection') {
  const db = new DatabaseSync(':memory:'), store = new MinecraftControlStore(db);
  const configuration = configuredMinecraftBody({ SHANNON_MINECRAFT_BODY_JSON: JSON.stringify({ deviceId: 'minebot', servers: [{ serverId: 'world', title: 'world',
    onlineMode: true, ownerUuid: 'b9191317-c52d-4d67-85fe-ab831e6db146' }] }) })!;
  const control = new MinecraftControl(store, configuration, { now: () => Date.now(), ownerAlone: () => true, leaseValid: () => true, pollMilliseconds: 1, cancelWaitMilliseconds: 50,
    frameMilliseconds: 60_000, headBoot: 'hb-1' });
  let sequence = 0;
  const running: string[] = [], queued: string[] = [], receipts: MinecraftControlReceipt[] = [], handed: MinecraftControlCommand[] = [];
  const poll = () => {
    const reply = control.poll({ scopeKey: 'owner', deviceId: 'minebot' }, { schemaVersion: 1, serverId: 'world', connectionId: connection,
      observation: { schemaVersion: 1, bodyId: 'minecraft:world', sequence: sequence++, stateAt: new Date().toISOString(), receivedAt: new Date().toISOString(), connected: true,
        state: { world: { position: { x: 0.5, y: 64, z: 0.5 }, health: 20 }, life: { life: 3, alive: true, since: at(0), dimension: 'overworld', dimensionSince: at(0) }, bodyRun: { bodyBoot: 'bb-1', connectionId: connection } }, facts: {} },
      candidates: [], skills: [{ name: 'act', description: 'act', readOnly: false, inputSchema: LOOSE }, { name: 'events', description: 'events', readOnly: true, inputSchema: LOOSE }],
      receipts: [...receipts], activeOperationIds: [...running], queuedOperationIds: [...queued] } as never);
    for (const id of reply.acknowledged) { const index = receipts.findIndex(item => item.id === id); if (index >= 0) receipts.splice(index, 1); }
    handed.push(...reply.commands);
    return reply;
  };
  return { db, store, control, poll, running, queued, receipts, handed, context: { scopeKey: 'owner', taskId: RUN, taskRevision: 1, bodyId: 'minecraft:world', sessionId: 'session-1', generation: 1, goal: 'g', completionCondition: 'c' } };
}

describe('the queue records by itself: its rows reach the recorder, and the results it takes are what a request reads', () => {
  it('writes received for a failed item (the body\'s times with it), then names the item in the next request\'s reads, and the head\'s boot of the first poll', async () => {
    const root = mkdtempSync(join(tmpdir(), 'continue-records-queue-'));
    directories.push(root);
    installDecisionRecorder(new DecisionRecorder({ root, head: { revision: 'head-1', source: 'git', node: 'v24' }, log: () => undefined }));
    const f = rig();
    f.poll();
    const queue = createLlmcQueue({ control: f.control, taskId: RUN, lease: { id: 'lease-1', generation: 1, holder: 'test' }, bodyId: () => 'minecraft:world',
      observe: () => f.control.observe('minecraft:world'), log: () => undefined, context: () => f.context, headBoot: 'hb-1', step: 41 });
    const input: ActInput = { hands: [{ do: 'wait', seconds: 1 }], why: '[p1] 木を切る' };
    const spec: QueueAdd = { call: { id: 'c1', name: 'mc.act', input }, operationId: 'step:c1', input, arguments: input as unknown as Record<string, unknown>, skill: 'act', node: 'p1', why: input.why!, fixes: [], maxMs: 20_000 };
    await queue.add(spec);
    f.poll();
    const id = f.handed.find(item => item.skill === 'act')!.id;
    f.running.push(id);
    f.poll();
    f.running.shift();
    f.receipts.push({ id, connectionId: 'connection', outcome: 'failed', inputsReleased: true, observedAt: at(0), unit: { goal: 'failed', end: 'finished', released: true },
      bodyTimes: { acceptedAt: at(1), startedAt: at(2), lockAt: at(3), firstMotorAt: at(4), failedAt: at(9), endedAt: at(9), motorOps: 2 },
      result: JSON.stringify({ v: 1, ok: false, done: 0, of: 1, ms: 1500, at: { x: 1, y: 64, z: 1 }, hp: 20, food: 20, lines: [{ i: 1, do: 'wait', line: '', status: 'failed', goal: 'failed', end: 'finished', motorOps: 2 }] }) } as MinecraftControlReceipt);
    f.poll();
    await delay(60);
    let reads: string[] | undefined;
    scoped(() => {
      const news = queue.take();
      expect(news.map(item => [item.item, item.kind])).toEqual([['q1', 'ran']]);
      recordRequest('decision', BODY([{ role: 'user', content: `（列の知らせ）\n${news[0]!.label}: ${news[0]!.result.text}` }]));
      recordRequest('decision', BODY([{ role: 'user', content: '圧縮のあと: 列の知らせは落ちた' }]));
    }, () => ({}));
    queue.stop();
    const run = readRun(join(root, RUN));
    const received = run.events.find(row => row.ev === 'received')!;
    expect(received).toMatchObject({ ids: { run: RUN, command: id, item: 'q1', life: 3 }, receipt: { outcome: 'failed', unit: { goal: 'failed' } }, bodyTimes: { failedAt: at(9), motorOps: 2 } });
    const requests = run.events.filter(row => row.ev === 'request');
    reads = requests.map(row => row.reads);
    expect(reads).toEqual([[id], undefined]);
    expect(run.events.find(row => row.ev === 'head_boot')).toMatchObject({ headBoot: 'hb-1', ids: { run: RUN, life: 3 } });
    f.db.close();
  });
});

describe('the judge reads what the recorder wrote: received -> request(reads) -> response -> sent -> received join, and the stages come out', () => {
  /** What the body would leave for a command (its receipt, its hand's start) beside the head's rows. */
  const body = (id: string, times: Record<string, string | number>, unit: Record<string, unknown>, outcome: 'completed' | 'failed'): { receipt: ReceiptRecord; trace: TraceLine } => ({
    receipt: { id, outcome, ids: { run: RUN, command: id, life: 1 }, unit: unit as never, bodyTimes: times as never },
    trace: { kind: 'hand_start', at: String(times.lockAt), ids: { run: RUN, command: id, hand: 1, life: 1 }, pos: { x: 0, y: 64, z: 0 }, hp: 20, food: 20, saturation: 5, inventory: '', holder: { kind: 'idle' } as never, lastOps: [] } });

  it('joins every command and gives the stages 150 / 250 / 6,500 / 50 / 50 / 20 / 50 ms, the same as the fixture', () => {
    const { clock, events } = recorded();
    const failedTimes = { acceptedAt: at(-28_800), lockAt: at(-28_790), firstMotorAt: at(-28_780), failedAt: at(0), endedAt: at(0), motorOps: 3 };
    const nextTimes = { acceptedAt: at(7000), lockAt: at(7020), firstMotorAt: at(7070), endedAt: at(9000), motorOps: 31 };
    scoped(() => {
      // d0001 sends q11.
      clock.now = BASE - 30_000;
      const first = recordRequest('decision', BODY([{ role: 'user', content: '始め' }]))!;
      clock.now = BASE - 29_000;
      recordResponse(first, { message: MESSAGE() });
      clock.now = BASE - 28_900;
      noteBodyCommand(command('skill:q11', 'q11'));
      // q11 fails at 0; the head's queue gets the receipt 150 ms later.
      noteStageRow(receivedRow(context('skill:q11', 'q11', at(150)), { id: 'skill:q11', connectionId: 'c-1', outcome: 'failed', inputsReleased: true, observedAt: at(0), bodyTimes: failedTimes } as never));
      // The step puts its result in the history; d0002 asks at 400, answers at 6,900 and sends q12 at 6,950.
      noteResultsRead([{ command: 'skill:q11', probe: 'q11 [p5] 近い鉄を掘る: ' }]);
      clock.now = BASE + 400;
      const second = recordRequest('decision', BODY([{ role: 'user', content: '（列の知らせ）\nq11 [p5] 近い鉄を掘る: 失敗した' }]))!;
      clock.now = BASE + 6_900;
      recordResponse(second, { message: MESSAGE() });
      clock.now = BASE + 6_950;
      noteBodyCommand(command('skill:q12', 'q12'));
      noteStageRow(receivedRow(context('skill:q12', 'q12', at(9_100)), { id: 'skill:q12', connectionId: 'c-1', outcome: 'completed', inputsReleased: true, observedAt: at(9_000), bodyTimes: nextTimes } as never));
    }, seen());
    const rows = events() as Row[];
    expect(rows.map(row => row.ev)).toEqual(['run', 'request', 'response', 'sent', 'received', 'request', 'response', 'sent', 'received']);
    const q11 = body('skill:q11', failedTimes, { goal: 'failed', end: 'finished', released: true }, 'failed'), q12 = body('skill:q12', nextTimes, { goal: 'done', end: 'finished', released: true }, 'completed');
    const input: Input = { meta: { run: RUN, scene: 'boundary-3', benches: ['C'], headRev: 'h', bodyRev: 'b' }, rows, receipts: [q11.receipt, q12.receipt], trace: [q11.trace, q12.trace], probes: [] };
    const model = buildModel(input, fixtures), joined = joinCommands(model);
    expect(joined.unlinked).toEqual([]);
    expect(joined.linked).toEqual(['skill:q11', 'skill:q12']);
    const chain = stageChain(model, model.commands.get('skill:q11')!);
    expect(chain).toMatchObject({ linked: true, decision: 'd0002', next: 'skill:q12', totalMs: 7070, overlapMs: 0,
      stagesMs: fixture('measure/trace-ids.json').expected.stagesMs });
    // The head's own computation over the same rows gives the same chain without the judge's receipts.
    expect(stageTimes(rows, { run: RUN })[0]).toEqual(chain);
  });

  it('the four kinds of command have their evidence in what the head and the body write (measure/evidence-by-command-kind.json)', () => {
    const sample = fixture('measure/evidence-by-command-kind.json');
    expect(fixtures.evidence).toEqual(sample.expected);
    recorded();
    const times = { acceptedAt: at(1), lockAt: at(2), firstMotorAt: at(3), endedAt: at(9), motorOps: 2 };
    const kinds: Record<string, { receipt: MinecraftControlReceipt; extra?: Row[]; trace?: boolean; lines?: unknown[] }> = {
      refused_before_start: { receipt: { id: 'skill:r1', connectionId: 'c-1', outcome: 'failed', inputsReleased: true, observedAt: at(0), unit: { goal: 'not_started', end: 'not_run', released: true },
        bodyTimes: { acceptedAt: at(1), endedAt: at(2), motorOps: 0 } } as never },
      already: { receipt: { id: 'skill:a1', connectionId: 'c-1', outcome: 'completed', inputsReleased: true, observedAt: at(0), unit: { goal: 'already', end: 'finished', released: true }, bodyTimes: { acceptedAt: at(1), endedAt: at(2), motorOps: 0 } } as never,
        lines: [{ i: 1, goal: 'already', status: 'done' }] },
      normal: { receipt: { id: 'skill:n1', connectionId: 'c-1', outcome: 'completed', inputsReleased: true, observedAt: at(0), unit: { goal: 'done', end: 'finished', released: true }, bodyTimes: times } as never, trace: true },
      unknown: { receipt: { id: 'skill:u1', connectionId: 'c-1', outcome: 'unknown', inputsReleased: false, observedAt: at(0) } as never },
    };
    for (const { receipt } of Object.values(kinds)) noteStageRow(receivedRow(context(receipt.id, receipt.id.slice(6), at(10)), receipt));
    noteStageRow(releasedRow(context('skill:u1', 'u1', at(11)), 'cleanup', true));
    const rows = readRun(join(directories[0]!, RUN)).events as Row[];
    const receipts: ReceiptRecord[] = Object.values(kinds).map(({ receipt, lines }) => ({ id: receipt.id, outcome: receipt.outcome, ids: { run: RUN, command: receipt.id, life: 1 }, ...(receipt.unit ? { unit: receipt.unit } : {}),
      ...(receipt.bodyTimes ? { bodyTimes: receipt.bodyTimes } : {}), ...(lines ? { lines: lines as never } : {}) }));
    const trace: TraceLine[] = [body('skill:n1', times, { goal: 'done', end: 'finished', released: true }, 'completed').trace];
    const model = buildModel({ meta: { run: RUN, scene: 'boundary-1', benches: ['A'], headRev: 'h', bodyRev: 'b' }, rows, receipts, trace, probes: [] }, fixtures);
    const joined = joinCommands(model);
    expect(joined.unlinked).toEqual([]);
    expect(joined.kinds).toEqual({ 'skill:r1': 'refused_before_start', 'skill:a1': 'already', 'skill:n1': 'normal', 'skill:u1': 'unknown' });
  });
});
