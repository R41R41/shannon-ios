/* The source walk on a copy of a real database (not a test): `DB=<copy> TASK=<id> node --import tsx tests/perf/sourceWalkCopy.ts` from services/api. */
import { DatabaseSync } from 'node:sqlite';
import { SQLiteShannonStore } from '../../src/infra/sqlite/sqliteStore.js';
import { SkillMemory } from '../../src/mind/memory/memoryPorts.js';
import { skillTurnPorts } from '../../src/wiring/skillMemoryWiring.js';
import { createFcaReadSources } from '../../src/wiring/fcaReadSources.js';
import { createTaskRuntimeWiring } from '../../src/wiring/taskRuntimeWiring.js';
import { createFcaSourceGuard } from '../../src/mind/action/fca/fcaConversationPorts.js';
import { peekedVisible } from '../../src/wiring/fcaPeekGates.js';
import { MemoryWithholding } from '../../src/mind/memory/memoryVisibility.js';
import { actionHarness } from '../support/actionThreadHarness.js';
import { printProfile, startCpuProfile } from '../support/perfMeasure.js';

/**
 * Where a check of a body task's provenance spends the API's thread, on a copy of the database it ran on (copied read-only, never the
 * live file: opening it writes). One decision's checks in the order production asks them (the scheduler's and the monitor's peeks,
 * the step's checks around the model and its tools, the evidence store's, the body's and the memory observation's), the monitor's
 * three peeks every second and a write every `WRITE_MS` (`MONITOR=0`: no monitor), `ROUNDS` times. Prints the checks' time by caller,
 * the guard's own slow-walk lines summed by caller and kind, and with `PROFILE=1` a CPU profile of the rounds. The skill checks keep
 * their own 2 s on the wall clock (`SKILL_CHECK_REUSE_MS`), not this one.
 */
const path = process.env.DB, taskId = process.env.TASK, scope = process.env.SCOPE ?? 'owner';
if (!path || !taskId) throw new Error('DB and TASK are required');
const clock = { at: Date.parse(process.env.AT ?? '2026-10-19T22:30:00.000Z') };
const now = () => new Date(clock.at).toISOString();
console.info = () => {};
const answerLines: string[] = [];
const store = new SQLiteShannonStore({ path, now, moodHistory: null, predictionShadow: false, decisionTraces: false, predictionLedger: false, choiceLedger: false });
const skillDb = new DatabaseSync(path);
skillDb.exec('PRAGMA busy_timeout = 5000');
const memory = new SkillMemory({ database: skillDb, createsSchema: false });
const skills = skillTurnPorts(memory, scopeKey => store.snapshot(scopeKey), store);
const ownerAlone = () => true;
const readSourceVisible = createFcaReadSources({ ownerScope: scope, ownerAlone, state: store, conversations: store, now,
  skill: (scopeKey, id, revision) => skills.readSource?.(scopeKey, id, revision) ?? null,
  skillChecks: (scopeKey, renew) => skills.readSourceChecks?.(scopeKey, renew) ?? null,
  answerCounts: { log: line => answerLines.push(line), clock: () => clock.at } });
store.readSourceVisible = readSourceVisible;
const runtime = createTaskRuntimeWiring({ db: store.fcaDatabase(), actions: actionHarness(now).actions, scopeKey: scope, ownerAlone, now,
  canRunTask: () => false, provenanceRefs: true, model: { async decide() { throw new Error('unused'); }, toolResults: results => ({ results }) } }).runtime;
const lines: string[] = [];
const guard = createFcaSourceGuard({ runtime, state: store, conversations: store, ownerScope: scope, ownerAlone, readSourceVisible,
  clock: () => clock.at, walkLogMilliseconds: 0, log: line => lines.push(line) });
const found = runtime.get(scope, taskId);
if (!found) throw new Error('no such task');
const task = found;
const sources = runtime.taskSources(scope, taskId);
console.log(`sources=${sources.length} recalled=${new Set(sources.flatMap(source => source.recalledMemoryIds)).size} reads=${new Set(sources.flatMap(source => source.readSourceIds ?? [])).size}`);
store.fcaDatabase().exec('CREATE TABLE IF NOT EXISTS bench_touch(x INTEGER)');
const touch = () => store.fcaDatabase().prepare('INSERT INTO bench_touch(x) VALUES (?)').run(clock.at);
const timed: Array<[string, number]> = [];
const time = (name: string, work: () => unknown) => { const started = performance.now(); const result = work(); timed.push([name, performance.now() - started]); return result; };
/**
 * Time passing while the step runs: the observation monitor reads every second (its two checks and its sources check: three peeks of
 * the step's sources), and the database changes as it did in run 18 (the lease renewed every 5 s, and `WRITE_MS` between other writes:
 * progress, the body's operations, the evidence). A write is made at the end too (the step's own progress at that point).
 */
const writeEvery = Number(process.env.WRITE_MS ?? 2_000), relevantEvery = Number(process.env.RELEVANT_MS ?? 10_000);
// A write to a row a source's visibility is read from (the state's, as a feeling or a turn writes it), every `RELEVANT_MS`.
const relevant = () => store.fcaDatabase().prepare('UPDATE companion_states SET updated_at = updated_at WHERE scope_key = ?').run(scope);
let nextMonitor = clock.at + 1_000, nextWrite = clock.at + writeEvery, nextRelevant = clock.at + relevantEvery;
const elapse = (ms: number) => {
  const end = clock.at + ms;
  while (Math.min(nextMonitor, nextWrite) <= end) {
    if (nextRelevant <= Math.min(nextMonitor, nextWrite)) { clock.at = nextRelevant; nextRelevant += relevantEvery; relevant(); }
    if (nextWrite <= nextMonitor) { clock.at = nextWrite; nextWrite += writeEvery; touch(); continue; }
    clock.at = nextMonitor; nextMonitor += 1_000;
    if (process.env.MONITOR !== '0') for (let read = 0; read < 3; read++) time('monitor', () => monitorVisible());
  }
  clock.at = end; touch();
};
// The provenance grows as the task goes on: each decision sees the sources observed up to it (`GROW` new ones a decision), as a step adds
// its recall and its skill index; the last decisions see all of it.
const ordered = [...sources].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
const rounds = Number(process.env.ROUNDS ?? 6), grow = Number(process.env.GROW ?? 2), bodyMs = Number(process.env.BODY_MS ?? 24_000);
let seen: typeof sources = ordered;
// `WRITE_EACH=1`: a write to a table no source is read from before every check (production run 19: a lease renewal, a step's progress,
// a body operation, the evidence between the checks of one decision).
const before = () => { if (process.env.WRITE_EACH === '1') touch(); };
const peek = () => { before(); return time('peek', () => guard.peek!(scope, task, seen)); };
/** The monitor's and the scheduler's gate, as production asks it (`fcaPeekGates.ts`). */
function monitorVisible() { return peekedVisible(guard, scope, task, seen, () => guard.sources(scope, task, seen, undefined, 'step')); }
const whole = (via: 'step' | 'evidence' | 'body' | 'memory' | 'tool') => { before(); return time(via, () => guard.sources(scope, task, seen, undefined, via)); };

/** One decision's checks (production run 18: 35 s a decision, 3.2 s of it the model and 24 s the body). */
function decision(round: number) {
  seen = ordered.slice(0, Math.max(1, ordered.length - (rounds - round) * grow));
  gate(); elapse(400);                           // the scheduler's gate
  whole('step'); peek(); whole('evidence');      // the step's start; the evidence prepare (its warming peek, then its check)
  whole('memory'); elapse(300);                  // the recall's memory observation
  whole('step'); elapse(3_200);                  // before the model; the model
  whole('step'); whole('body'); whole('tool'); elapse(bodyMs); // after the model, the body's check, the tool's; the body works
  whole('step'); whole('evidence'); whole('step'); elapse(1_000); // after the tool, the outcome, the commit
}
function gate() { return time('gate', () => monitorVisible()); }
decision(0); // the first: a full walk
lines.length = 0; timed.length = 0;
const profiling = process.env.PROFILE ? await startCpuProfile() : null;
for (let round = 1; round <= rounds; round++) decision(round);
const profile = profiling ? await profiling() : null;
const total = timed.reduce((sum, [, ms]) => sum + ms, 0);
console.log(`checks=${timed.length} total=${Math.round(total)}ms per-decision=${Math.round(total / rounds)}ms`);
const byName = new Map<string, number[]>();
for (const [name, ms] of timed) byName.set(name, [...byName.get(name) ?? [], ms]);
for (const [name, list] of byName) console.log(`  ${name}: n=${list.length} sum=${Math.round(list.reduce((a, b) => a + b, 0))} median=${Math.round(list.sort((a, b) => a - b)[list.length >> 1]!)} max=${Math.round(list.at(-1)!)}`);
const parts = { epoch: 0, provenance: 0, reads: 0, walk: 0 };
const modes = new Map<string, Array<Record<string, number>>>();
for (const line of lines) {
  const values: Record<string, number> = { total: Number(/total=(\d+)/.exec(line)?.[1] ?? 0) };
  for (const part of Object.keys(parts) as Array<keyof typeof parts>) parts[part] += values[part] = Number(new RegExp(` ${part}=(\\d+)`).exec(line)?.[1] ?? 0);
  const mode = /mode=(\w+) via=(\w+)/.exec(line);
  if (mode) modes.set(`${mode[2]}/${mode[1]}`, [...modes.get(`${mode[2]}/${mode[1]}`) ?? [], values]);
}
console.log(`parts ${JSON.stringify(parts)}`);
const sum = (list: Array<Record<string, number>>, name: string) => Math.round(list.reduce((total, values) => total + values[name]!, 0));
for (const [mode, list] of modes) console.log(`  ${mode}: n=${list.length} total=${sum(list, 'total')} epoch=${sum(list, 'epoch')} reads=${sum(list, 'reads')} walk=${sum(list, 'walk')}`);
if (profile) printProfile('rounds', profile, Number(process.env.TOP ?? 30));
for (const line of answerLines.slice(-3)) console.log(line);
// What the moment's parts cost when they are made anew: the skill checks (every 2 s), the state, the remembered turns.
const renew = skills.readSourceChecks;
if (renew) {
  const costs: Record<string, number[]> = { checks: [], snapshot: [], candidates: [], withheld: [] };
  for (let round = 0; round < 5; round++) {
    clock.at += 2_500; touch();
    let started = performance.now(); const state = store.snapshot(scope); costs.snapshot!.push(performance.now() - started);
    started = performance.now(); const candidates = store.experienceCandidates(scope); costs.candidates!.push(performance.now() - started);
    started = performance.now(); new MemoryWithholding(state, store, scope, candidates).withheldExperiences(); costs.withheld!.push(performance.now() - started);
    started = performance.now(); renew(scope, true); costs.checks!.push(performance.now() - started);
  }
  console.log(`candidates=${store.experienceCandidates(scope).length}`);
  console.log(`made anew (ms): ${Object.entries(costs).map(([name, list]) => `${name}=${list.map(Math.round).join('/')}`).join(' ')}`);
}
