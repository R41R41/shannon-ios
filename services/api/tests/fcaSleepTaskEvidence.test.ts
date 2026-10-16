import { afterEach, expect, it, vi } from 'vitest';
import { OWNER_AUDIENCE, ownerSpoke } from '@shannon/cognition';
import { actionResource, leaseOf } from '../src/contracts/actionThreadContract.js';
import { SQLiteTaskRuntimeStore } from '../src/mind/action/taskRuntime/store/taskRuntimeStore.js';
import { SQLiteFcaTaskAuthority } from '../src/mind/action/agentTasks/store/fcaTaskAuthority.js';
import { migrateAgentTasks } from '../src/mind/action/agentTasks/store/agentTaskPersistenceSupport.js';
import { SQLiteFcaEvidenceStore } from '../src/mind/action/fca/store/fcaEvidenceStore.js';
import { taskExperienceDraft, taskExperienceId, taskExperienceSummary, type TaskExperienceRecord } from '../src/mind/memory/taskExperience.js';
import { ShannonMemoryService } from '../src/mind/memory/memoryService.js';
import { createTaskMemory } from '../src/mind/memory/taskMemory.js';
import { SkillMemory } from '../src/mind/memory/skillMemory.js';
import { SQLitePeopleMemoryStore } from '../src/mind/memory/store/peopleMemoryStore.js';
import { ShannonKnowledgeConsolidator } from '../src/mind/sleep/knowledgeConsolidation.js';
import { createFcaSleepTaskEvidence, fcaSleepTaskEvidenceFor } from '../src/wiring/fcaSleepTaskEvidence.js';
import { skillSeedSources, skillSourcesPass } from '../src/wiring/skillMemoryWiring.js';
import { sleepSourcesVisible } from '../src/wiring/fcaSleepSources.js';
import { isProvenanceReference } from '../src/infra/sqlite/fcaProvenanceSets.js';
import { skillGistSource } from '../src/wiring/fcaSkillGistSource.js';
import { actionHarness } from './support/actionThreadHarness.js';
import { memoryWorld } from './support/memoryWorld.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

/** The real Task Hub and evidence store commit a failed body operation; the existing memory writer indexes it. */
async function fixture(provenanceRefs = false) {
  const world = memoryWorld(); cleanup.push(world.close);
  const h = actionHarness(world.now, world.path); cleanup.push(h.close); migrateAgentTasks(h.db);
  const runtime = new SQLiteTaskRuntimeStore(h.db, { authority: new SQLiteFcaTaskAuthority(h.db), now: world.now,
    leaseValid: (_scope, _task, lease, at) => !!h.store.check(lease, at), ...(provenanceRefs ? { provenanceRefs: true } : {}) });
  const root = runtime.ensureRoot('owner');
  const task = runtime.createChild('owner', root.id, { title: '採掘', goal: '石を一つ集める' }, 'body-request');
  const source = world.store.appendTurn('owner', 'request-thread', '石を採ってきてください', '承知しました', world.now());
  const action = await h.actions.claim((await h.actions.enqueue({ scopeKey: 'owner', kind: 'agentTask', origin: 'owner_request',
    sourceId: `fca:${task.id}:${task.revision}`, resources: [actionResource('owner', `fca:${task.id}`)] })).id);
  const step = runtime.beginStep('owner', task.id, leaseOf(action!))!;
  expect(runtime.observeSources(step, { observationId: 'owner-input', recalledMemoryIds: [source.id] })).toBe(true);
  step.snapshot.sources = runtime.taskSources('owner', task.id, step.messageIds);
  let record!: TaskExperienceRecord;
  const evidence = new SQLiteFcaEvidenceStore({ db: h.db, state: world.store, now: world.now,
    validStep: () => true, sourcesVisible: () => true, taskVisible: () => true, ...(provenanceRefs ? { provenanceRefs: true } : {}),
    onOutcome: outcome => {
      record = { scopeKey: outcome.scopeKey, taskId: outcome.taskId, outcomeId: outcome.outcomeId, observedAt: outcome.observedAt,
        status: outcome.result?.ok ? 'success' : 'failure', goal: outcome.goal.slice(0, 1000), context: `task:${outcome.taskId}`,
        action: JSON.stringify(outcome.action).slice(0, 1000), prediction: '', observedResult: outcome.result!.text.slice(0, 4000),
        interpretation: '結果はこの操作の観測であり、目的全体の達成や原因の証明ではない。',
        sourceIds: [...new Set(outcome.sources.flatMap(value => [...value.experienceId ? [value.experienceId] : [], ...value.recalledMemoryIds]))], readSourceIds: [] };
      world.ports.proposals.propose(taskExperienceDraft(record));
    } });
  const call = { id: 'dig', name: 'mc.dig', input: { count: 1 } };
  evidence.beforeActions(step, { decision: { kind: 'tools', calls: [call] }, history: [] });
  evidence.observed(step, call, { ok: false, text: '対象ブロックが届く範囲にありません。移動して再確認が必要です。', retryable: false });
  expect(runtime.commitStep(step, { disposition: 'continue', history: [{ role: 'assistant', content: 'body operation observed' }] })).not.toBeNull();
  await h.actions.finish(step.lease, 'completed', 'fca_segment_committed'); runtime.acknowledgeReceipt('owner', step.id);
  evidence.committed(step);
  const writer = world.writer(); await writer.runOnce(); writer.releaseLease();
  const id = taskExperienceId('owner', task.id, record.outcomeId);
  expect(world.store.experiencesById('owner', [id])).toHaveLength(1);
  const proof = createFcaSleepTaskEvidence(h.db);
  const payload = () => JSON.parse(String(h.db.prepare('SELECT payload_json FROM experience_events WHERE event_id=?').get(id)!.payload_json));
  const patch = (change: (value: ReturnType<typeof payload>) => void) => { const value = payload(); change(value);
    h.db.prepare('UPDATE experience_events SET payload_json=? WHERE event_id=?').run(JSON.stringify(value), id); };
  return { ...world, ...h, store: world.store, runtime, task, source, record, id, step, proof, patch, payload };
}

it('admits a committed observed Minecraft failure without claiming the owner spoke it', async () => {
  const f = await fixture();
  expect(f.proof('owner', f.id)).toBe(true);
  expect(f.proof('other', f.id)).toBe(false);
  const episode = f.store.experiencesById('owner', [f.id])[0]!;
  expect(ownerSpoke(episode.disclosure)).toBe(false);
  const sources = skillSeedSources(f.store, null);
  expect(sources.experiences('owner', '2026-10-07T00:00:00Z', '2026-10-08T00:00:00Z').map(value => value.id)).toContain(f.id);
  const analyze = vi.fn(async () => []);
  const knowledge = new ShannonKnowledgeConsolidator(f.store, f.store, f.store, { analyze }, f.store,
    { now: f.now, taskEvidence: f.proof, memory: f.ports.proposals });
  await knowledge.consolidate('owner', '2026-10-07T00:00:00Z', '2026-10-08T00:00:00Z');
  expect(analyze).toHaveBeenCalledTimes(1);
  expect((analyze.mock.calls[0] as unknown[])[1]).toMatchObject({ experiences: expect.arrayContaining([{ id: f.id, observedAt: f.now(), summary: episode.summary }]) });
});

it.each(['unknown', 'uncommitted', 'own_time', 'bad_id', 'wrong_result', 'wrong_status'] as const)('refuses %s evidence', async kind => {
  const f = await fixture();
  if (kind === 'unknown') f.db.prepare("UPDATE fca_action_evidence SET observation='unknown' WHERE event_id=?").run(f.record.outcomeId);
  if (kind === 'uncommitted') f.db.prepare('DELETE FROM fca_task_history WHERE step_id=?').run(f.step.id);
  if (kind === 'own_time') f.db.prepare("UPDATE agent_tasks SET fca_origin='own_time' WHERE task_id=?").run(f.task.id);
  if (kind === 'bad_id') f.patch(value => { value.task.outcomeId = 'forged'; });
  if (kind === 'wrong_result') f.patch(value => { value.task.observedResult = '採掘できました'; });
  if (kind === 'wrong_status') f.patch(value => { value.task.status = 'success'; });
  expect(f.proof('owner', f.id)).toBe(false);
});

it.each(['private_payload', 'private_proof', 'private_history', 'stripped_sources', 'forged_action', 'forged_summary', 'forged_time'] as const)('refuses %s provenance', async kind => {
  const f = await fixture();
  if (kind === 'private_payload') f.patch(value => { value.task.readSourceIds = ['aether-document://private']; });
  if (kind === 'private_proof') {
    const sources = f.step.snapshot.sources.map(source => ({ ...source, readSourceIds: ['aether-document://private'] }));
    f.db.prepare('UPDATE fca_action_evidence SET sources_json=? WHERE event_id=?').run(JSON.stringify(sources), f.record.outcomeId);
  }
  if (kind === 'private_history') f.db.prepare('UPDATE fca_task_history SET sources_json=? WHERE step_id=?')
    .run(JSON.stringify(f.step.snapshot.sources.map(source => ({ ...source, readSourceIds: ['aether-document://private'] }))), f.step.id);
  if (kind === 'forged_time') f.db.prepare('UPDATE experience_events SET observed_at=? WHERE event_id=?').run('2030-01-01T00:00:00Z', f.id);
  if (kind === 'stripped_sources') f.patch(value => { value.task.sourceIds = []; value.recalledMemoryIds = []; });
  if (kind === 'forged_action') f.patch(value => { value.task.action = '所有者の個人文書を読んだ'; });
  if (kind === 'forged_summary') f.patch(value => { value.summary = '捏造された別の手順と個人情報'; });
  expect(f.proof('owner', f.id)).toBe(false);
});

it('treats a skill gist pin as the pointer-only case for sleep evidence, and a skill read pin as a private read (review of release/16a, M1)', async () => {
  const gist = skillGistSource('skill_mc-x', 'skill_mc-x:v2'), read = 'shannon-skill://skill_mc-x/revision/skill_mc-x%3Av2';
  const pin = async (ids: string[]) => {
    const f = await fixture();
    const sources = f.step.snapshot.sources.map(source => ({ ...source, readSourceIds: ids }));
    f.db.prepare('UPDATE fca_action_evidence SET sources_json=? WHERE event_id=?').run(JSON.stringify(sources), f.record.outcomeId);
    f.db.prepare('UPDATE fca_task_history SET sources_json=? WHERE step_id=?').run(JSON.stringify(sources), f.step.id);
    f.patch(value => { value.task.readSourceIds = ids; value.readSourceIds = ids; });
    return f.proof('owner', f.id);
  };
  expect(await pin([])).toBe(true);
  expect(await pin([gist])).toBe(true);
  expect(await pin([gist, 'aether-document://private'])).toBe(false);
  expect(await pin([read])).toBe(false);
});

it('forgetting any inherited source stops knowledge, skill seeds/export and the sleep task source guard', async () => {
  const f = await fixture(), skills = new SkillMemory({ database: f.db, createsSchema: true, defer: task => task(), log: () => {} });
  const people = new SQLitePeopleMemoryStore(f.db), at = f.now();
  const sources = [{ kind: 'memory' as const, stepId: 'sleep-step', experienceId: null, threadId: null, observedAt: at, recalledMemoryIds: [f.id] }];
  expect(skillSourcesPass(f.store, skills, 'owner')([`experience:${f.id}`])).toBe(true);
  expect(sleepSourcesVisible(f.store, 'owner', sources, skills, people)).toBe(true);
  f.advance(1000); new ShannonMemoryService(f.store, f.store, f.now).mutate('owner', { memoryId: f.source.id, action: 'forget' });
  expect(skillSourcesPass(f.store, skills, 'owner')([`experience:${f.id}`])).toBe(false);
  expect(skillSeedSources(f.store, null, skills).experiences('owner', '2026-10-07T00:00:00Z', '2026-10-08T00:00:00Z')).toEqual([]);
  expect(sleepSourcesVisible(f.store, 'owner', sources, skills, people)).toBe(false);
  const analyze = vi.fn(async () => []);
  await new ShannonKnowledgeConsolidator(f.store, f.store, f.store, { analyze }, f.store, { now: f.now, taskEvidence: f.proof })
    .consolidate('owner', '2026-10-07T00:00:00Z', '2026-10-08T00:00:00Z');
  expect(analyze).not.toHaveBeenCalled();
  expect(fcaSleepTaskEvidenceFor({})('owner', f.id)).toBe(false);
});

it('rejects a completion request whose committed task status is still running', async () => {
  const f = await fixture(), action = { id: 'dig', name: 'fca.complete', input: { summary: '採掘を完了したつもり' } };
  const result = JSON.stringify({ requestedDecision: 'complete', actualStatus: 'running', summary: action.input.summary });
  f.db.prepare('UPDATE fca_action_evidence SET name=?,action_json=?,result_json=? WHERE event_id=?')
    .run(action.name, JSON.stringify(action), JSON.stringify({ ok: true, text: result }), f.record.outcomeId);
  f.patch(value => { value.task.action = JSON.stringify(action); value.task.observedResult = result;
    value.task.status = 'failure'; value.summary = taskExperienceSummary(value.task); });
  expect(f.proof('owner', f.id)).toBe(false);
});

it('excludes a committed outcome whose ancestor read a private document even while that document remains readable', async () => {
  const f = await fixture(); f.store.readSourceVisible = () => true;
  const original = JSON.parse(String(f.db.prepare('SELECT payload_json FROM experience_events WHERE event_id=?').get(f.source.id)!.payload_json));
  f.db.prepare('UPDATE experience_events SET payload_json=? WHERE event_id=?')
    .run(JSON.stringify({ ...original, readSourceIds: ['aether-document://private'] }), f.source.id);
  const memory = createTaskMemory({ state: f.store, conversations: f.store, ownerScope: 'owner', ownerAlone: () => true,
    now: f.now, readSourceVisible: () => true });
  expect(memory.read('owner', [f.id], OWNER_AUDIENCE).map(item => item.id)).toContain(f.id);
  expect(f.proof('owner', f.id)).toBe(false);
  expect(skillSeedSources(f.store, null).experiences('owner', '2026-10-07T00:00:00Z', '2026-10-08T00:00:00Z').map(item => item.id)).not.toContain(f.id);
});

it('retains a task-derived retired knowledge source with skills disabled, until its inherited evidence is forgotten', async () => {
  const f = await fixture(), people = new SQLitePeopleMemoryStore(f.db);
  const knowledge = f.store.createShannonKnowledge('owner', { title: '届かない採掘対象の扱い', applicability: '採掘対象に距離がある時',
    bodyMarkdown: '## 手順\n先に距離を確かめて位置を調整する。', status: 'confirmed', sourceExperienceIds: [f.id] }, f.now(), '整理');
  expect(f.store.retireShannonKnowledge('owner', knowledge.id, '新しい手順へ統合', f.now(), [f.id]))
    .toMatchObject({ id: knowledge.id, status: 'retired', sourceExperienceIds: [f.id] });
  const sources = [knowledge.id, `knowledge:${knowledge.id}`].map(id => [{ kind: 'memory' as const, stepId: 'sleep-step', experienceId: null, threadId: null,
    observedAt: f.now(), recalledMemoryIds: [id] }]);
  for (const source of sources) expect(sleepSourcesVisible(f.store, 'owner', source, null, people)).toBe(true);
  f.advance(1000); new ShannonMemoryService(f.store, f.store, f.now).mutate('owner', { memoryId: f.source.id, action: 'forget' });
  for (const source of sources) expect(sleepSourcesVisible(f.store, 'owner', source, null, people)).toBe(false);
});

// The nightly proof reads the evidence row's and the history row's sources through their provenance sets (`fcaProvenanceSets.ts`).
it('admits a committed outcome whose evidence and history sources are stored by reference, and refuses one whose reference cannot be resolved', async () => {
  const f = await fixture(true);
  const stored = (table: string, key: string, value: string) => String((f.db.prepare(`SELECT sources_json FROM ${table} WHERE ${key}=?`).get(value) as { sources_json: string }).sources_json);
  const evidenceJson = stored('fca_action_evidence', 'event_id', f.record.outcomeId), historyJson = stored('fca_task_history', 'step_id', f.step.id);
  expect(isProvenanceReference(evidenceJson)).toBe(true);
  expect(isProvenanceReference(historyJson)).toBe(true);
  expect(f.proof('owner', f.id)).toBe(true);
  expect(f.proof('other', f.id)).toBe(false);
  for (const [label, table, key, value] of [['evidence', 'fca_action_evidence', 'event_id', f.record.outcomeId], ['history', 'fca_task_history', 'step_id', f.step.id]] as const) {
    const original = stored(table, key, value);
    f.db.prepare(`UPDATE ${table} SET sources_json=? WHERE ${key}=?`).run(JSON.stringify({ set: `sha256:${'0'.repeat(64)}` }), value);
    expect(f.proof('owner', f.id), `${label}: unknown set`).toBe(false);
    f.db.prepare(`UPDATE ${table} SET sources_json=? WHERE ${key}=?`).run(original, value);
    expect(f.proof('owner', f.id), `${label}: restored`).toBe(true);
  }
});
