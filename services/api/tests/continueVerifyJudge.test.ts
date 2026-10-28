import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildModel, judge, judgeAll, loadFixtures, loadFolder, sceneIds, stageChain, type DeathMark, type Input, type ProbeLine, type ReceiptRecord, type Row, type TraceLine } from '../../../tools/continue-verify/judge.js';

/**
 * The judge of the end-to-end checks (tools/continue-verify/judge.ts) against HAND-MADE records. Each folder here is built from the contract's
 * fixtures (life/death-at-each-moment.json, e2e/boundaries.json, measure/trace-ids.json); nothing here is a real run.
 */
const fixtures = loadFixtures();
const RUN = 'd468250d';
const t = (second: number, milli = 0) => new Date(Date.UTC(2026, 9, 28, 4, 0, second, milli)).toISOString();

interface Made { rows: Row[]; receipts: ReceiptRecord[]; trace: TraceLine[] }
const none = (): Made => ({ rows: [], receipts: [], trace: [] });
const merge = (...parts: Made[]): Made => ({ rows: parts.flatMap(p => p.rows), receipts: parts.flatMap(p => p.receipts), trace: parts.flatMap(p => p.trace) });

/** A command the head decided and sent, the body ran (lock, first motor, one hand), with the operations it did. */
function ran(n: number, life: number, opts: { at: number; ops?: { at: string; op?: string }[]; decision?: string } ): Made {
  const id = `skill:q${n}`, decision = opts.decision ?? `d${String(n).padStart(4, '0')}`, ids = { run: RUN, command: id, item: `q${n}`, life };
  return {
    rows: [
      { ev: 'request', at: t(opts.at), ids: { run: RUN, decision, life }, reads: [] },
      { ev: 'response', at: t(opts.at, 500), ids: { run: RUN, decision, life } },
      { ev: 'sent', at: t(opts.at, 600), ids: { ...ids, decision }, context: { life }, skill: 'act' },
      { ev: 'received', at: t(opts.at + 3), ids, receipt: { outcome: 'completed' }, bodyTimes: { acceptedAt: t(opts.at, 700), lockAt: t(opts.at, 710), firstMotorAt: t(opts.at, 720), motorOps: 4 } },
    ],
    receipts: [{ id, outcome: 'completed', ids, unit: { goal: 'done', end: 'finished', released: true, startedAt: t(opts.at, 705) },
      bodyTimes: { acceptedAt: t(opts.at, 700), lockAt: t(opts.at, 710), firstMotorAt: t(opts.at, 720), endedAt: t(opts.at + 3), motorOps: 4 } }],
    trace: [
      { kind: 'hand_start', ids: { ...ids, hand: 1 }, at: t(opts.at, 715), pos: { x: 0, y: 64, z: 0 }, hp: 20, food: 20, saturation: 5, inventory: '', holder: { kind: 'idle' }, lastOps: [] },
      ...(opts.ops ?? []).map(op => ({ kind: 'op' as const, at: op.at, command: id, hand: 1, life, op: op.op ?? 'key' })),
    ],
  };
}
/** A command that was queued behind another and was refused before it started (death, stale life): the receipt alone is its evidence. */
function refused(n: number, life: number, acceptedAt: string, at: number): Made {
  const id = `skill:q${n}`, decision = `d${String(n).padStart(4, '0')}`, ids = { run: RUN, command: id, item: `q${n}`, life };
  return {
    rows: [
      { ev: 'request', at: t(at), ids: { run: RUN, decision, life }, reads: [] }, { ev: 'response', at: t(at, 500), ids: { run: RUN, decision, life } },
      { ev: 'sent', at: t(at, 600), ids: { ...ids, decision }, context: { life } },
      { ev: 'received', at: t(at + 8), ids, receipt: { outcome: 'failed', unit: { goal: 'not_started', end: 'not_run', released: true } }, bodyTimes: { acceptedAt, endedAt: t(at + 8), motorOps: 0 } },
    ],
    receipts: [{ id, outcome: 'failed', ids, unit: { goal: 'not_started', end: 'not_run', released: true, droppedBecause: { code: 'death' } }, bodyTimes: { acceptedAt, endedAt: t(at + 8), motorOps: 0 } }],
    trace: [],
  };
}

/** Boundary 5: four deaths, one in each moment, nothing old acts after any of them. */
function boundary5(): Input {
  const deaths: DeathMark[] = [
    { at: t(10), lifeBefore: 1, lifeAfter: 2, moment: 'running_hand' },
    { at: t(20), lifeBefore: 2, lifeAfter: 3, moment: 'waiting_for_reflex', waiting: ['q12'] },
    { at: t(30), lifeBefore: 3, lifeAfter: 4, moment: 'queued', waiting: ['q13'] },
    { at: t(40), lifeBefore: 4, lifeAfter: 5, moment: 'awaiting_model', decision: 'd0014' },
  ];
  const awaiting: Made = {
    rows: [{ ev: 'request', at: t(38), ids: { run: RUN, decision: 'd0014', life: 4 }, reads: [] }, { ev: 'response', at: t(42), ids: { run: RUN, decision: 'd0014', life: 4 } },
      { ev: 'discarded', at: t(42, 100), id: 'd0014', reason: 'life_changed' }],
    receipts: [], trace: [],
  };
  const made = merge(
    ran(11, 1, { at: 5, ops: [{ at: t(6) }, { at: t(9, 900) }] }),                 // the running hand: acts until just before the death
    refused(12, 2, t(19), 17), refused(13, 3, t(29), 27),                          // accepted before the death, never started
    awaiting,
    { rows: [], receipts: [], trace: [{ kind: 'trace_open', at: t(0), source: 'continuous' }] },
  );
  made.trace.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { meta: { run: RUN, scene: 'boundary-5', benches: ['B', 'C'], headRev: 'a1b2c3d', bodyRev: 'e4f5a6b', deaths }, ...made, probes: [] };
}

describe('the judge: boundary 5 (death and the async moments)', () => {
  it('(a) passes when every command is joined and nothing old acts after a death', () => {
    const verdict = judge(boundary5(), fixtures);
    expect(verdict.commands.unlinked, verdict.text).toEqual([]);
    expect(verdict.commands.judged).toBe(3);
    expect(verdict.commands.linked).toBe(3);
    expect(verdict.pass, verdict.text).toBe(true);
  });

  it('(b) fails when one command does not join (a normal command with no hand_start), and names it', () => {
    const input = boundary5();
    input.trace = input.trace.filter(line => line.kind !== 'hand_start');
    const verdict = judge(input, fixtures);
    expect(verdict.pass).toBe(false);
    expect(verdict.commands.linked).toBe(verdict.commands.judged - 1);
    expect(verdict.commands.unlinked).toEqual([{ command: 'skill:q11', reasons: ['missing:hand_start'] }]);
  });

  it('(b) fails when a command has no sent row although the real head sends (bench C), and when its decision has no reply', () => {
    const input = boundary5();
    input.rows = input.rows.filter(row => !(row.ev === 'sent' && row.ids?.command === 'skill:q12') && !(row.ev === 'response' && row.ids?.decision === 'd0013'));
    const verdict = judge(input, fixtures);
    expect(verdict.pass).toBe(false);
    expect(verdict.commands.unlinked.map(item => [item.command, item.reasons])).toEqual([['skill:q12', ['no_sent']], ['skill:q13', ['no_response:d0013']]]);
  });

  it('(b) fails when a record of another run is mixed in', () => {
    const input = boundary5();
    input.rows = input.rows.map(row => (row.ev === 'received' && row.ids?.command === 'skill:q11' ? { ...row, ids: { ...row.ids, run: 'someone-else' } } : row));
    const verdict = judge(input, fixtures);
    expect(verdict.commands.unlinked).toEqual([{ command: 'skill:q11', reasons: ['run_mismatch'] }]);
  });

  it('(c) fails when an old-life command acts after the death, even by one operation', () => {
    const input = boundary5();
    input.trace.push({ kind: 'op', at: t(10, 300), command: 'skill:q11', hand: 1, life: 1, op: 'attack' });
    const verdict = judge(input, fixtures);
    const check = verdict.checks.find(item => item.id.startsWith('no old-life operation after death running_hand'));
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('skill:q11:attack');
    expect(verdict.pass).toBe(false);
  });

  it('(c) an operation the motor port refused, or a place held back, does not count', () => {
    const input = boundary5();
    input.trace.push({ kind: 'op', at: t(10, 300), command: 'skill:q11', hand: 1, life: 1, op: 'key', refused: true });
    input.trace.push({ kind: 'op', at: t(10, 400), command: 'skill:q11', hand: 1, life: 1, op: 'place_held_back' });
    expect(judge(input, fixtures).pass).toBe(true);
  });

  it('(c) fails when a waiting old command starts after the death', () => {
    const input = boundary5();
    const q12 = input.receipts.find(receipt => receipt.id === 'skill:q12')!;
    q12.unit = { goal: 'done', end: 'finished', released: true, startedAt: t(20, 400) };
    q12.bodyTimes = { ...q12.bodyTimes!, startedAt: t(20, 400), lockAt: t(20, 410), firstMotorAt: t(20, 420), motorOps: 2 };
    input.trace.push({ kind: 'hand_start', ids: { run: RUN, command: 'skill:q12', hand: 1, life: 2 }, at: t(20, 415), pos: { x: 0, y: 64, z: 0 }, hp: 20, food: 20, saturation: 5, inventory: '', holder: { kind: 'idle' }, lastOps: [] });
    const verdict = judge(input, fixtures);
    expect(verdict.checks.find(item => item.id.startsWith('waiting old commands never start waiting_for_reflex'))?.ok).toBe(false);
  });

  it('(c) fails when the answer awaited at the death was not discarded as life_changed', () => {
    const input = boundary5();
    input.rows = input.rows.filter(row => row.ev !== 'discarded');
    expect(judge(input, fixtures).checks.find(item => item.id.startsWith('the answer awaited is discarded life_changed'))?.ok).toBe(false);
  });

  it('(c) fails when the log is the ring, or when a moment was not killed in', () => {
    const ring = boundary5();
    ring.trace = ring.trace.map(line => (line.kind === 'trace_open' ? { ...line, source: 'ring' as const } : line));
    expect(judge(ring, fixtures).checks.find(item => item.id.startsWith('the log is continuous'))?.ok).toBe(false);
    const short = boundary5();
    short.meta.deaths = short.meta.deaths!.filter(death => death.moment !== 'queued');
    expect(judge(short, fixtures).checks.find(item => item.id === 'every moment was killed in')?.detail).toContain('queued');
  });
});

describe('the judge: boundary 8 scene b8-dup-poll', () => {
  function dupPoll(): Input {
    const made = ran(1, 1, { at: 5 });
    made.receipts.push({ ...made.receipts[0], delivery: { pollId: 'poll-2', at: t(9) } });   // the same receipt on a second poll
    made.receipts[0].delivery = { pollId: 'poll-1', at: t(8) };
    made.rows.push({ ev: 'ledger', at: t(8, 100), ids: { run: RUN, command: 'skill:q1', life: 1 }, applied: ['skill:q1:1:1:1'], have: { oak_planks: 2 }, observed: { oak_planks: 2 } });
    return { meta: { run: RUN, scene: 'b8-dup-poll', benches: ['B', 'C'], headRev: 'a1b2c3d', bodyRev: 'e4f5a6b' }, ...made, trace: [{ kind: 'trace_open', at: t(0), source: 'continuous' }, ...made.trace], probes: [] };
  }
  it('(d) passes: two deliveries of the receipt, one applied, the ledger event booked once', () => {
    const verdict = judge(dupPoll(), fixtures);
    expect(verdict.pass, verdict.text).toBe(true);
    expect(verdict.commands.judged).toBe(1);
  });
  it('(d) fails when the receipt was applied twice', () => {
    const input = dupPoll();
    input.rows.push({ ...input.rows.find(row => row.ev === 'received')!, at: t(9, 100) });
    const check = judge(input, fixtures).checks.find(item => item.id === 'the receipt came twice and was applied once');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('2 applied');
  });
  it('(d) fails when the ledger booked the event twice', () => {
    const input = dupPoll();
    input.rows.push({ ev: 'ledger', at: t(9, 100), ids: { run: RUN, command: 'skill:q1', life: 1 }, applied: ['skill:q1:1:1:1'], have: { oak_planks: 4 }, observed: { oak_planks: 4 } });
    const verdict = judge(input, fixtures);
    expect(verdict.checks.find(item => item.id === 'ledger event ids applied once')?.detail).toContain('skill:q1:1:1:1');
    expect(verdict.pass).toBe(false);
  });
  it('(d) fails when the lab never sent the second delivery (the scene did not happen)', () => {
    const input = dupPoll();
    input.receipts.pop();
    expect(judge(input, fixtures).checks.find(item => item.id === 'the receipt came twice and was applied once')?.ok).toBe(false);
  });
  it('(d) fails when a correction was made where none is expected', () => {
    const input = dupPoll();
    input.rows.push({ ev: 'corrected', at: t(10), ids: { run: RUN, command: 'skill:q1', life: 1 }, was: 'unknown', now: { goal: 'done', end: 'finished', released: true } });
    expect(judge(input, fixtures).checks.find(item => item.id === 'corrections = 0')?.ok).toBe(false);
  });
});

describe('the judge: an unknown needs the cleanup\'s release (b8-lost-receipt)', () => {
  function lost(): Input {
    const made = ran(1, 1, { at: 5 });
    made.rows = made.rows.filter(row => row.ev !== 'received');
    made.receipts = [];
    const ids = { run: RUN, command: 'skill:q1', item: 'q1', life: 1 };
    const unit = { goal: 'unknown' as const, end: 'unknown' as const, released: false };
    made.rows.push({ ev: 'received', at: t(10), ids, receipt: { outcome: 'unknown', unit }, bodyTimes: { acceptedAt: t(5, 700), lockAt: t(5, 710), firstMotorAt: t(5, 720), endedAt: t(10), motorOps: 4 } },
      { ev: 'released', at: t(12), ids, by: 'cleanup', ok: true },
      { ev: 'corrected', at: t(15), ids, was: 'unknown', now: { goal: 'done', end: 'finished', released: true } });
    made.receipts.push({ id: 'skill:q1', outcome: 'unknown', ids, unit, bodyTimes: { acceptedAt: t(5, 700), endedAt: t(10) } });
    return { meta: { run: RUN, scene: 'b8-lost-receipt', benches: ['B', 'C'], headRev: 'a1b2c3d', bodyRev: 'e4f5a6b' }, ...made, probes: [] };
  }
  it('passes: unknown, released by the cleanup in 5 s, then corrected once', () => {
    const verdict = judge(lost(), fixtures);
    expect(verdict.pass, verdict.text).toBe(true);
  });
  it('fails (the command does not join) without the cleanup\'s released row', () => {
    const input = lost();
    input.rows = input.rows.filter(row => row.ev !== 'released');
    const verdict = judge(input, fixtures);
    expect(verdict.commands.unlinked).toEqual([{ command: 'skill:q1', reasons: ['missing:released(cleanup)'] }]);
    expect(verdict.pass).toBe(false);
  });
  it('fails when the release came later than 5 s', () => {
    const input = lost();
    input.rows = input.rows.map(row => (row.ev === 'released' ? { ...row, at: t(16) } : row));
    expect(judge(input, fixtures).checks.find(item => item.id.startsWith('unknown, then released'))?.ok).toBe(false);
  });
});

describe('the judge: the stages of time (measure/trace-ids.json)', () => {
  it('(e) reproduces stages 1 to 7 and the total of the fixture', () => {
    const fixture = JSON.parse(readFileSync(join(fixtures.dir, 'measure/trace-ids.json'), 'utf8')) as { input: { records: Row[] }; expected: { stagesMs: Record<string, number>; totalMs: number } };
    const model = buildModel({ meta: { run: 'd468250d', scene: 'boundary-1', benches: ['C'], headRev: 'x', bodyRev: 'y' }, rows: fixture.input.records, receipts: [], trace: [], probes: [] }, fixtures);
    const chain = stageChain(model, model.commands.get('skill:q11')!);
    expect(chain.linked, chain.why).toBe(true);
    expect(chain.stagesMs).toEqual(fixture.expected.stagesMs);
    expect(chain.totalMs).toBe(fixture.expected.totalMs);
    expect([chain.failed, chain.decision, chain.next]).toEqual(['skill:q11', 'd0153', 'skill:q12']);
  });
  it('is not joined by the command alone: another life\'s decision is not the reader', () => {
    const fixture = JSON.parse(readFileSync(join(fixtures.dir, 'measure/trace-ids.json'), 'utf8')) as { input: { records: Row[] } };
    const rows = fixture.input.records.map(row => (row.ev === 'request' ? { ...row, ids: { ...row.ids, life: 2 } } : row));
    const model = buildModel({ meta: { run: 'd468250d', scene: 'boundary-1', benches: ['C'], headRev: 'x', bodyRev: 'y' }, rows, receipts: [], trace: [], probes: [] }, fixtures);
    expect(stageChain(model, model.commands.get('skill:q11')!).linked).toBe(false);
  });
  it('counts a prefetch that overlaps the failure once on the wall clock', () => {
    const fixture = JSON.parse(readFileSync(join(fixtures.dir, 'measure/trace-ids.json'), 'utf8')) as { input: { records: Row[] } };
    // the next command was accepted 2 s BEFORE the failed one failed: stage 5 runs backwards and is told as overlap, never as a negative time
    const rows = fixture.input.records.map(row => {
      const times = row.bodyTimes as Record<string, string> | undefined;
      return row.ev === 'received' && times?.acceptedAt ? { ...row, bodyTimes: { ...times, acceptedAt: '2026-10-28T04:10:49.000Z', lockAt: '2026-10-28T04:10:49.020Z', firstMotorAt: '2026-10-28T04:10:49.070Z' } } : row;
    });
    const model = buildModel({ meta: { run: 'd468250d', scene: 'boundary-1', benches: ['C'], headRev: 'x', bodyRev: 'y' }, rows, receipts: [], trace: [], probes: [] }, fixtures);
    const chain = stageChain(model, model.commands.get('skill:q11')!);
    expect(chain.linked, chain.why).toBe(true);
    expect(Object.values(chain.stagesMs!).every(value => value >= 0)).toBe(true);
    expect(chain.overlapMs).toBeGreaterThan(0);
    expect(chain.totalMs).toBe(7020);   // 6,950 ms from the failure to the answer's send, plus the 70 ms the next command spent locking and moving on the clock before it
  });
});

describe('the judge: the folder, the scenes and the versions', () => {
  it('reads a folder written as files and judges it like the objects', () => {
    const input = boundary5(), dir = mkdtempSync(join(tmpdir(), 'cv-judge-'));
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(input.meta));
    writeFileSync(join(dir, 'events.jsonl'), input.rows.map(row => JSON.stringify(row)).join('\n'));
    writeFileSync(join(dir, 'receipts.jsonl'), input.receipts.map(row => JSON.stringify(row)).join('\n'));
    writeFileSync(join(dir, 'body-trace.jsonl'), input.trace.map(row => JSON.stringify(row)).join('\n') + '\n');
    const loaded = loadFolder(dir);
    expect(judge(loaded, fixtures).pass).toBe(true);
    expect(judge(loaded, fixtures).text).toContain('合格');
  });
  it('lists every scene the contract names: 9 boundaries (8 is its 7 scenes), 8 seams, 7 boundary-8 scenes', () => {
    const ids = sceneIds(fixtures);
    expect(ids).toHaveLength(9 + 8 + 7);
    expect(ids).toContain('b8-lease-swap');
    expect(ids).not.toContain('boundary-8');
  });
  it('an --all run fails when a scene was not run, and says which', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cv-all-'));
    const result = judgeAll(dir, fixtures);
    expect(result.pass).toBe(false);
    expect(result.missing).toHaveLength(24);
  });
  it('a produced file of another body version fails the folder (chapter 9), a missing revision too', () => {
    const input = boundary5();
    expect(judge({ ...input, meta: { ...input.meta, producedRev: 'ffffff0' } }, fixtures).checks[0]).toMatchObject({ id: 'versions', ok: false });
    expect(judge({ ...input, meta: { ...input.meta, producedRev: input.meta.bodyRev } }, fixtures).pass).toBe(true);
    expect(judge({ ...input, meta: { ...input.meta, bodyRev: '' } }, fixtures).pass).toBe(false);
  });
  it('an unknown scene fails; a folder with no commands and no checks does not pass by being empty', () => {
    const empty: Input = { meta: { run: RUN, scene: 'boundary-5', benches: ['B'], headRev: 'a', bodyRev: 'b' }, rows: [], receipts: [], trace: [], probes: [] };
    expect(judge(empty, fixtures).pass).toBe(false);
    expect(judge({ ...empty, meta: { ...empty.meta, scene: 'nonsense' } }, fixtures).pass).toBe(false);
  });
  it('does not know a piece of evidence it was not taught (measure/evidence-by-command-kind.json)', () => {
    const odd = { ...fixtures, evidence: { ...fixtures.evidence, normal: [...fixtures.evidence.normal, 'something.new'] } };
    expect(() => judge(boundary5(), odd)).toThrow(/does not know the evidence "something.new"/u);
  });
});

// ---- boundary 2: the five numbers, each by its own evidence (vertical/boundary2-evidence.json) -----------------------------------------------------------
describe('the judge: boundary 2 (progress, each number by its own evidence)', () => {
  const evidence = JSON.parse(readFileSync(join(fixtures.dir, 'vertical/boundary2-evidence.json'), 'utf8')) as { input: { log: { stepChanges: number; placeSends: number; placeHeldBack: number; placeConfirmedUpdates: number; digSends: number; blockUpdatesUsedForCorrection: { at: number[]; to: string }[] }; result: { progress: { done: number; work: { dug: number; placeAttempts: number; placedConfirmed: number } } } } };
  const { log, result } = evidence.input;
  const cell = (x: number, y: number, z: number): [number, number, number] => [x, y, z];
  const opsOf = (command: string, life: number, fromY: number, digFrom: number): TraceLine[] => {
    const ops: TraceLine[] = [];
    let at = 0;
    const push = (op: string, extra: Record<string, unknown> = {}) => { at += 1; ops.push({ kind: 'op', at: t(at, 0), command, hand: 1, life, op, ...extra } as TraceLine); };
    for (let step = 0; step < log.stepChanges; step += 1) push('foot', { from: cell(161, fromY - step, 220), to: cell(161, fromY - step - 1, 220) });
    for (let place = 0; place < log.placeSends; place += 1) push('place', { pos: cell(161, 40 + place, 220) });
    for (let held = 0; held < log.placeHeldBack; held += 1) push('place_held_back', { pos: cell(161, 50, 220) });
    for (let confirmed = 0; confirmed < log.placeConfirmedUpdates; confirmed += 1) push('place_confirmed', { pos: cell(161, 40 + confirmed, 220) });
    for (let dig = 0; dig < log.digSends; dig += 1) push('dig', { pos: cell(160, digFrom + dig, 220) });
    for (const update of log.blockUpdatesUsedForCorrection) push('block_update', { pos: update.at as [number, number, number], block: update.to, usedForCorrection: true });
    return ops;
  };
  function vertical(opts: { reportedDone?: number; secondDigFrom?: number } = {}): Input {
    const first = ran(1, 1, { at: 1 }), second = ran(2, 1, { at: 40 });
    first.receipts[0].lines = [{ i: 1, do: 'vertical', status: 'stopped', goal: 'partial', end: 'finished', progress: { done: opts.reportedDone ?? result.progress.done, at: { x: 161, y: 26, z: 220 }, work: result.progress.work } }];
    second.receipts[0].lines = [{ i: 1, do: 'vertical', status: 'done', goal: 'done', end: 'finished', progress: { done: 3, work: { dug: 4, placeAttempts: 0, placedConfirmed: 0 } } }];
    const secondOps: TraceLine[] = [
      ...[0, 1, 2].map(index => ({ kind: 'op', at: t(41 + index), command: 'skill:q2', hand: 1, life: 1, op: 'foot', from: cell(161, 26 - index, 220), to: cell(161, 25 - index, 220) }) as TraceLine),
      ...[0, 1, 2, 3].map(index => ({ kind: 'op', at: t(45 + index), command: 'skill:q2', hand: 1, life: 1, op: 'dig', pos: cell(160, (opts.secondDigFrom ?? 100) + index, 220) }) as TraceLine),
    ];
    const trace: TraceLine[] = [{ kind: 'trace_open', at: t(0), source: 'continuous' }, ...first.trace.filter(line => line.kind === 'hand_start'), ...opsOf('skill:q1', 1, 35, 60),
      ...second.trace.filter(line => line.kind === 'hand_start').map(line => ({ ...line, pos: { x: 161.5, y: 26, z: 220.5 } }) as TraceLine), ...secondOps];
    return { meta: { run: RUN, scene: 'boundary-2', benches: ['A'], headRev: 'a1b2c3d', bodyRev: 'e4f5a6b', resumes: [{ from: 'q1', to: 'q2' }] },
      rows: [...first.rows.filter(row => row.ev === 'received'), ...second.rows.filter(row => row.ev === 'received')], receipts: [...first.receipts, ...second.receipts], trace, probes: [] };
  }
  it('passes: moved 10, stepsValid 9, 2 place sends (the held-back one not counted), 2 confirmed, 27 digs; the next hand starts at progress.at and digs nothing again', () => {
    const verdict = judge(vertical(), fixtures);
    expect(verdict.pass, verdict.text).toBe(true);
    expect(verdict.checks.find(item => item.id === 'numbers skill:q1')?.detail).toContain('moved 10 (feet), stepsValid 9');
  });
  it('fails when the result reads moved steps as the valid ones (10 where the correction leaves 9)', () => {
    const verdict = judge(vertical({ reportedDone: 10 }), fixtures);
    expect(verdict.checks.find(item => item.id === 'numbers skill:q1')?.ok).toBe(false);
    expect(verdict.checks.find(item => item.id === 'moved is not valid skill:q1')?.ok).toBe(false);
  });
  it('fails when the next hand digs a step that was dug already', () => {
    const verdict = judge(vertical({ secondDigFrom: 60 }), fixtures);
    expect(verdict.checks.find(item => item.id === 'resume q1 -> q2')?.ok).toBe(false);
    expect(verdict.checks.find(item => item.id === 'resume q1 -> q2')?.detail).toContain('dug again: 4');
  });
});

// ---- boundaries 9 and 10: no command, the probes of the head's bench ------------------------------------------------------------------------------------
describe('the judge: boundaries 9 and 10 (probes)', () => {
  const nodes = [{ id: 'p1', kind: 'stone_tools', prep: null }, { id: 'p3', kind: 'prep_descent', prep: null }, { id: 'p5', kind: 'diamond', prep: null }];
  const snapshot = (stage: string, list: { id: string; kind?: string; prep?: unknown }[] = nodes): ProbeLine => ({ kind: 'plan_snapshot', at: t(1), stage: stage as never, nodes: list });
  const decisionValues = Object.fromEntries(fixtures.sameDecisions.map((name, index) => [name, index]));
  function plan(): Input {
    return { meta: { run: RUN, scene: 'boundary-9', benches: ['C'], headRev: 'a1b2c3d', bodyRev: 'e4f5a6b' }, rows: [], receipts: [], trace: [],
      probes: [snapshot('first_plan'), snapshot('plan_update'), snapshot('saved'), snapshot('head_restart'), snapshot('read_back'),
        { kind: 'plan_decisions', at: t(2), variant: 'original', values: decisionValues }, { kind: 'plan_decisions', at: t(3), variant: 'renamed', values: decisionValues },
        { kind: 'plan_write', at: t(4), by: 'head', node: 'p5', fields: ['state'] }] };
  }
  it('boundary 9 passes when kind and prep survive every stage, a rename leaves the decisions alone, and the head writes no prep', () => {
    const verdict = judge(plan(), fixtures);
    expect(verdict.pass, verdict.text).toBe(true);
  });
  it('boundary 9 fails when kind is lost after the head restart, when a rename changes a decision, and when the head writes prep', () => {
    const lost = plan();
    lost.probes = lost.probes.map(line => (line.kind === 'plan_snapshot' && line.stage === 'head_restart' ? snapshot('head_restart', nodes.map(node => ({ id: node.id, prep: node.prep }))) : line));
    expect(judge(lost, fixtures).checks.find(item => item.id.startsWith('kind and prep survive'))?.ok).toBe(false);
    const renamed = plan();
    renamed.probes = renamed.probes.map(line => (line.kind === 'plan_decisions' && line.variant === 'renamed' ? { ...line, values: { ...line.values, [fixtures.sameDecisions[0]]: 'other' } } : line));
    expect(judge(renamed, fixtures).checks.find(item => item.id.startsWith('a renamed title'))?.ok).toBe(false);
    const wrote = plan();
    wrote.probes.push({ kind: 'plan_write', at: t(5), by: 'head', node: 'p3', fields: ['prep'] });
    expect(judge(wrote, fixtures).checks.find(item => item.id === 'the head does not write prep')?.ok).toBe(false);
  });
  function bytes(drop?: string): Input {
    const text = fixtures.urgentNeedles.filter(needle => needle !== drop).join(' / ');
    const one: ProbeLine = { kind: 'one_time_fact', at: t(2), fact: '約束 #3', perDecision: [{ d: 'd0300', compressedOut: true, inLastRequest: false }, { d: 'd0301', compressedOut: false, inLastRequest: true }, { d: 'd0302', compressedOut: false, inLastRequest: false }] };
    return { meta: { run: RUN, scene: 'boundary-10', benches: ['D'], headRev: 'a1b2c3d', bodyRev: 'e4f5a6b' }, rows: [], receipts: [], trace: [],
      probes: [...(['normal', 'urgent', 'compressed'] as const).map((variant): ProbeLine => ({ kind: 'request_bytes', at: t(1), variant, bytes: text })), one] };
  }
  it('boundary 10 passes when every fact of the table is in the bytes of each version and the one-time fact is carried until it arrives', () => {
    const verdict = judge(bytes(), fixtures);
    expect(verdict.pass, verdict.text).toBe(true);
  });
  it('boundary 10 fails when one concrete value is missing from one version, and when the one-time fact is shown again after it arrived', () => {
    const verdict = judge(bytes('cod #501'), fixtures);
    expect(verdict.pass).toBe(false);
    expect(verdict.checks.find(item => item.id === 'last request (urgent)')?.detail).toContain('cod #501');
    const again = bytes();
    (again.probes[3] as { perDecision: { inLastRequest: boolean }[] }).perDecision[2].inLastRequest = true;
    expect(judge(again, fixtures).checks.find(item => item.id.startsWith('a one-time fact'))?.ok).toBe(false);
  });
});

// ---- the command line -------------------------------------------------------------------------------------------------------------------------------------
const tsx = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
describe.skipIf(!existsSync(tsx))('the judge as a command', () => {
  const cli = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tools', 'continue-verify', 'judge.ts');
  it('exits 0 and says 合格 for a folder that passes, 1 for one that does not, 2 for a folder it cannot read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cv-cli-')), input = boundary5();
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(input.meta));
    writeFileSync(join(dir, 'events.jsonl'), input.rows.map(row => JSON.stringify(row)).join('\n'));
    writeFileSync(join(dir, 'receipts.jsonl'), input.receipts.map(row => JSON.stringify(row)).join('\n'));
    writeFileSync(join(dir, 'body-trace.jsonl'), input.trace.map(row => JSON.stringify(row)).join('\n'));
    const good = spawnSync(process.execPath, [tsx, cli, dir], { encoding: 'utf8' });
    expect(good.status, good.stderr).toBe(0);
    expect(good.stdout).toContain('合格');
    const json = spawnSync(process.execPath, [tsx, cli, dir, '--json'], { encoding: 'utf8' });
    expect(JSON.parse(json.stdout)).toMatchObject({ pass: true, commands: { judged: 3, linked: 3, unlinked: [] } });
    writeFileSync(join(dir, 'body-trace.jsonl'), input.trace.filter(line => line.kind !== 'hand_start').map(row => JSON.stringify(row)).join('\n'));
    const bad = spawnSync(process.execPath, [tsx, cli, dir], { encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain('つながらない: skill:q11');
    expect(spawnSync(process.execPath, [tsx, cli, join(dir, 'nowhere')], { encoding: 'utf8' }).status).toBe(2);
  });
});
