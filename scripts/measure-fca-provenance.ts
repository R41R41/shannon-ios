// Deterministic before/after measure of FCA provenance by reference (owner decision 2026-10-15, SHANNON_FCA_PROVENANCE_REFS).
// Synthetic only: a temporary remembered world (tests/support/run6RecallShape.ts), no production data, model or network.
//
//   node --import tsx scripts/measure-fca-provenance.ts [steps=40] [rootSources=600]
//
// The fixture is the Minecraft shape of runs 7–11: the root has accumulated `rootSources` memory sources from earlier tasks'
// reports; an in-game request creates a body task under the root; each of its steps recalls 33 of ~100 ids and reads the skill
// index (two new memory sources a step), records three body actions and commits one history round; then the next step prepares
// (`evidence.prepare`, the newest 24 rows, eight shown). Three runs: the switch off (before: the root's whole set inherited, each
// row a copy), references alone (the whole set still inherited), and the switch on (after). Prints bytes per step record (the
// sets amortized over the records) and the source walk and prepare time per step.
import { actionResource, leaseOf } from '../services/api/src/contracts/actionThreadContract.js';
import { createFcaSourceGuard } from '../services/api/src/mind/action/fca/fcaConversationPorts.js';
import { SQLiteFcaEvidenceStore } from '../services/api/src/mind/action/fca/store/fcaEvidenceStore.js';
import type { FcaModelOutput } from '../services/api/src/mind/action/fca/fcaPorts.js';
import { migrateAgentTasks } from '../services/api/src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { createTaskRuntimeWiring } from '../services/api/src/wiring/taskRuntimeWiring.js';
import { actionHarness } from '../services/api/tests/support/actionThreadHarness.js';
import { run6RecallShape } from '../services/api/tests/support/run6RecallShape.js';

const steps = Number(process.argv[2] ?? 40), rootSources = Number(process.argv[3] ?? 600);
console.info = () => {};
console.warn = () => {};

async function measure(provenanceRefs: boolean, asking = true) {
  const f = run6RecallShape({ turns: 400, recallingTurns: 10, tasks: 6, recalledPerTask: 10, taskRecallsOfTasks: 2, readsPerTask: 4, skills: 4 });
  const h = actionHarness(f.world.now); migrateAgentTasks(h.db);
  const driver = createTaskRuntimeWiring({ db: h.db, actions: h.actions, scopeKey: 'owner', ownerAlone: f.ownerAlone, now: f.world.now,
    canRunTask: () => false, provenanceRefs, model: { async decide() { throw new Error('unused'); }, toolResults: results => ({ results }) } });
  const runtime = driver.runtime;
  const guard = createFcaSourceGuard({ runtime, state: f.world.store, conversations: f.world.store, ownerScope: 'owner',
    ownerAlone: f.ownerAlone, readSourceVisible: f.readSourceVisible, clock: () => Date.parse(f.world.now()) });
  const evidence = new SQLiteFcaEvidenceStore({ db: h.db, state: f.world.store, now: f.world.now, validStep: () => true, provenanceRefs,
    sourcesVisible: (scope, id, sources) => { const view = runtime.get(scope, id); return Boolean(view && guard.sources(scope, view, sources)); },
    sourcesCovered: (scope, id, verified, candidate) => { const view = runtime.get(scope, id); return Boolean(view && guard.covers!(scope, view, verified, candidate)); },
    sourcesResidual: (scope, id, verified, candidate) => { const view = runtime.get(scope, id); return view ? guard.residual!(scope, view, verified, candidate) : null; },
    walkCounts: guard.walks, taskVisible: (scope, id) => guard(scope, id), observeContext: () => true });
  const pool = [...f.tasks, ...f.turns.slice(20, 380)].slice(0, 100);
  const root = runtime.ensureRoot('owner');
  // The root's accumulated sources: earlier tasks that reported to it, one memory source each (a recall of 5 ids).
  const earlier = runtime.createChild('owner', root.id, { title: '前', goal: '前の作業', completionCriteria: '確かめる' }, 'earlier');
  for (let index = 0; index < rootSources; index++) {
    h.db.prepare("INSERT INTO fca_task_sources(step_id,scope_key,thread_id,observed_at,recalled_ids_json,state,source_kind) VALUES(?,?,'',?,?,'bound','memory')")
      .run(`memory:earlier:${String(index).padStart(4, '0')}`, 'owner', f.world.now(), JSON.stringify(Array.from({ length: 5 }, (_, k) => pool[(index + k * 7) % pool.length]).sort()));
    h.db.prepare('INSERT INTO fca_task_source_links(task_id,step_id) VALUES(?,?)').run(earlier.id, `memory:earlier:${String(index).padStart(4, '0')}`);
  }
  runtime.send('owner', earlier.id, root.id, '前の作業: completed', 'report');
  const task = runtime.createChild('owner', root.id, { title: '木のツルハシ', goal: '木のツルハシを作る', completionCriteria: '確かめる' }, 'mc', asking ? { sources: 'asking' } : {});
  runtime.observeExternal('owner', task.id, { eventId: 'mc', experienceIds: [pool[0]!], observedAt: f.world.now(), text: 'ゲーム内の本人の依頼' });
  const prepareMs: number[] = [], walkMs: number[] = [];
  for (let index = 0; index < steps; index++) {
    f.world.advance(15_000);
    const action = await h.actions.claim((await h.actions.enqueue({ scopeKey: 'owner', kind: 'agentTask', origin: 'owner_request',
      sourceId: `fca:${task.id}:${index}`, resources: [actionResource('owner', `fca:${task.id}`)] })).id);
    const step = runtime.beginStep('owner', task.id, leaseOf(action!));
    if (!step) throw new Error(`step ${index} not begun: ${JSON.stringify(runtime.get('owner', task.id))}`);
    const known = 33 + Math.floor(index * 66 / Math.max(1, steps - 1));
    runtime.observeSources(step, { observationId: 'recall', recalledMemoryIds: pool.slice(known - 33, known) });
    runtime.observeSources(step, { observationId: 'skills', recalledMemoryIds: [], readSourceIds: f.skillSources });
    step.snapshot.sources = runtime.taskSources('owner', task.id, step.messageIds);
    // The step's own check (the source walk), then the prepare of the step's shared context.
    f.world.advance(6_000);
    let at = performance.now();
    guard.sources('owner', step.snapshot.task, step.snapshot.sources);
    walkMs.push(performance.now() - at);
    at = performance.now();
    await evidence.prepare(step);
    prepareMs.push(performance.now() - at);
    const calls = ['a', 'b', 'c'].map(id => ({ id, name: 'mc.observe', input: { at: index } }));
    evidence.beforeActions(step, { decision: { kind: 'tools', calls }, history: [] } as unknown as FcaModelOutput);
    for (const call of calls) evidence.observed(step, call, { ok: true, text: `observed ${index}${call.id}`, retryable: false });
    runtime.commitStep(step, { history: [{ role: 'assistant', content: `step ${index}` }], disposition: 'continue' });
    await h.actions.finish(step.lease, 'completed', 'fca_segment_committed');
    for (const receipt of runtime.pendingReceipts('owner')) runtime.acknowledgeReceipt('owner', receipt.id);
  }
  const bytes = (sql: string) => Number((h.db.prepare(sql).get() as { n: number | null }).n ?? 0);
  const evidenceRows = bytes('SELECT COUNT(*) AS n FROM fca_action_evidence');
  const evidenceBytes = bytes('SELECT SUM(length(sources_json)) AS n FROM fca_action_evidence');
  const historyRows = bytes('SELECT COUNT(*) AS n FROM fca_task_history');
  const historyBytes = bytes('SELECT SUM(length(sources_json)) AS n FROM fca_task_history');
  const hasSets = bytes("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='fca_provenance_sets'") > 0;
  const setBytes = hasSets ? bytes('SELECT SUM(length(set_id)+length(scope_key)+length(step_ids_json)+length(created_at)+8) AS n FROM fca_provenance_sets') : 0;
  const sets = hasSets ? bytes('SELECT COUNT(*) AS n FROM fca_provenance_sets') : 0;
  const lastSources = runtime.taskSources('owner', task.id).length;
  driver.close(); h.close(); f.close();
  const stat = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b), mean = values.reduce((a, b) => a + b, 0) / values.length;
    return `mean=${mean.toFixed(1)}ms p50=${sorted[Math.floor(sorted.length / 2)]!.toFixed(1)}ms max=${sorted.at(-1)!.toFixed(1)}ms`;
  };
  return { label: !provenanceRefs ? 'before (switch off)' : asking ? 'after (switch on)' : 'refs only (whole set inherited)', lastSources, evidenceRows, historyRows, sets,
    evidenceBytesPerRow: Math.round(evidenceBytes / evidenceRows), historyBytesPerRow: Math.round(historyBytes / historyRows),
    setBytesTotal: setBytes, bytesPerStepRecordAmortized: Math.round((evidenceBytes + historyBytes + setBytes) / (evidenceRows + historyRows)),
    sourceWalk: stat(walkMs), prepare: stat(prepareMs), prepareLast10: stat(prepareMs.slice(-10)) };
}

for (const [on, asking] of [[false, true], [true, false], [true, true]] as const) console.log(JSON.stringify(await measure(on, asking)));
