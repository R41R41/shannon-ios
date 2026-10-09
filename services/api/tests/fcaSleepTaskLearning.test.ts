import { afterEach, describe, expect, it } from 'vitest';
import { OWNER_AUDIENCE, ownerSpoke } from '@shannon/cognition';
import { ShannonMemoryService } from '../src/mind/memory/memoryService.js';
import type { TaskExperienceRecord } from '../src/mind/memory/taskExperience.js';
import type { KnowledgeAnalysisInput, KnowledgeOperation } from '../src/mind/sleep/knowledgeConsolidation.js';
import { usableKnowledgeFor } from '../src/mind/recall/recallPorts.js';
import { createFcaSleepTaskEvidence } from '../src/wiring/fcaSleepTaskEvidence.js';
import { skillSeedSources } from '../src/wiring/skillMemoryWiring.js';
import { integratedFcaHarness, round } from './support/fcaIntegratedHarness.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const startAt = '2026-10-07T00:00:00.000Z', endAt = '2026-10-08T00:00:00.000Z';
const observation = '目標の石ブロックは採掘可能な距離の外にあり、破壊せずに停止した。';
const lessonTitle = '採掘前の射程確認';
function fixture(learn: (input: KnowledgeAnalysisInput) => readonly KnowledgeOperation[] = () => []) {
  const f = integratedFcaHarness({ sleep: {
    analyzer: { mode: 'local-rules', async analyze() { return []; } },
    knowledgeAnalyzer: { async analyze(_scope, input) { return learn(input); } },
  }, decide: input => {
    if (input.task.goal === '石の採掘を試す' && !input.history.length) return round({ kind: 'tools', calls: [{ id: 'dig', name: 'mc.dig', input: { count: 1 } }] });
    if (input.task.goal === lessonTitle) return round({ kind: 'wait', summary: input.recall?.items.some(item => item.id.startsWith('knowledge:') && item.summary.includes(lessonTitle))
      ? '前の失敗の仮説を踏まえ、座標と射程の確認から始める。' : '判断材料となる記憶が見つからない。' });
    return round({ kind: 'wait', summary: '次の指示を待つ' });
  } });
  cleanup.push(() => f.close()); return f;
}
async function observedFailure(f: ReturnType<typeof fixture>) {
  const turn = await f.talk('石の採掘を試してください。', async tools => {
    expect((await tools.call('minecraft.request', { goal: '石の採掘を試す' })).ok).toBe(true);
    return f.driver.runtime.list('owner').find(task => f.bodyStore.body(task.id))!.id;
  });
  await f.driver.tick(); const command = await f.command();
  expect(f.poll([{ id: command.id, connectionId: command.connectionId, outcome: 'failed', inputsReleased: true,
    observedAt: f.now(), result: observation }]).acknowledged).toEqual([command.id]);
  await f.driver.drain(); await f.tick();
  expect(f.driver.runtime.get('owner', turn.value)?.phase).toBe('waiting');
  expect(f.store.experienceCandidates('owner').filter(item => item.id.startsWith('task:'))).toEqual([]);
  await f.writeMemory();
  const row = f.actions.db.prepare("SELECT event_id,payload_json FROM experience_events WHERE scope_key='owner' AND json_extract(payload_json,'$.task.taskId')=? AND json_extract(payload_json,'$.task.status')='failure'").get(turn.value)!;
  expect(row).toBeDefined();
  const payload = JSON.parse(String(row.payload_json)) as { task: TaskExperienceRecord };
  expect(payload.task).toMatchObject({ status: 'failure', observedResult: observation, sourceIds: expect.arrayContaining([turn.sourceId]) });
  return { ...turn, episodeId: String(row.event_id), payload, rawPayload: String(row.payload_json) };
}

describe('observed common task outcomes enter the existing nightly learning and next FCA recall', () => {
  it('learns from an actual failed Minecraft receipt through both writer barriers, without turning it into owner speech, and follows original-source forgetting', async () => {
    const inputs: KnowledgeAnalysisInput[] = [];
    let episodeId = '';
    const f = fixture(input => {
      inputs.push(structuredClone(input));
      expect(input.experiences.find(item => item.id === episodeId)?.summary).toContain(observation);
      return [{ operation: 'create', knowledgeId: '', expectedVersion: 0, title: lessonTitle,
        applicability: '石を掘る作業を計画し、身体を動かす前。',
        bodyMarkdown: '## 状況\n対象に届かない操作は成果を生まない。\n## 行動\nまず座標と射程を照合し、安全な接近経路を選ぶ。\n## 結果\n届く地点から実行する。\n## 注意\n一度の失敗からの仮説であり、一般的な保証ではない。',
        status: 'confirmed', sourceExperienceIds: [episodeId], reason: '身体から確定した失敗の結果を再利用できる仮説に整理した。' }];
    });
    const failed = await observedFailure(f); episodeId = failed.episodeId;
    const episode = f.store.experiencesById('owner', [episodeId])[0]!;
    expect(episode.disclosure?.speaker).toBe('unknown'); expect(ownerSpoke(episode.disclosure)).toBe(false);
    expect(episode.userMessage).toBe(`task-evidence-${episodeId}`); expect(episode.shannonReply).toBe('');
    expect(episode.recalledMemoryIds).toContain(failed.sourceId);
    expect(createFcaSleepTaskEvidence(f.actions.db)('owner', episodeId)).toBe(true);
    const seeds = skillSeedSources(f.store, null);
    expect(seeds.experiences('owner', startAt, endAt).find(item => item.id === episodeId))
      .toMatchObject({ summary: episode.summary, text: episode.summary });
    expect(f.store.dailyUserMessages('owner', startAt, endAt).some(item => item.sourceExperienceId === episodeId)).toBe(false);

    f.advance(24 * 60 * 60 * 1000);
    expect(f.store.enqueueSleepConsolidations('2026-10-07', startAt, endAt, f.now())).toBe(1);
    for (let n = 0; n < 8 && inputs.length === 0; n++) { await f.writeMemory(); await f.tick(); }
    expect(inputs).toHaveLength(1);
    expect(f.rows().filter(row => row.kind === 'knowledge.create')).toMatchObject([{ status: 'pending' }]);
    expect(f.store.listShannonKnowledge('owner')).toEqual([]);
    await f.tick(); expect(inputs).toHaveLength(1);
    expect(f.store.listShannonKnowledge('owner')).toEqual([]);
    await f.writeMemory();
    const [lesson] = f.store.listShannonKnowledge('owner');
    expect(lesson).toMatchObject({ title: lessonTitle, sourceExperienceIds: [episodeId], status: 'hypothesis' });
    const night = f.driver.runtime.list('owner').find(task => task.kind === 'sleep')!;
    for (let n = 0; n < 8 && f.driver.runtime.get('owner', night.id)?.phase !== 'completed'; n++) { await f.tick(); await f.writeMemory(); }
    expect(f.driver.runtime.get('owner', night.id)?.phase).toBe('completed'); expect(inputs).toHaveLength(1);

    const next = await f.talk('採掘前の射程確認を計画してください。', async tools => {
      const result = await tools.call('task.create', { title: lessonTitle, goal: lessonTitle, completionCriteria: '既存の仮説を確認する' });
      expect(result.ok).toBe(true); return JSON.parse(result.text).id as string;
    });
    await f.tick();
    const remembered = f.calls.find(input => input.task.id === next.value)!;
    expect(remembered.recall?.items.find(item => item.id === `knowledge:${lesson!.id}`)?.summary).toContain(lessonTitle);
    expect(remembered.recall?.sourceIds).toEqual(expect.arrayContaining([`knowledge:${lesson!.id}`, episodeId, failed.sourceId]));
    expect(f.driver.runtime.get('owner', next.value)?.summary).toBe('前の失敗の仮説を踏まえ、座標と射程の確認から始める。');

    new ShannonMemoryService(f.store, f.store, f.now).mutate('owner', { memoryId: failed.sourceId, action: 'forget' });
    expect(seeds.experiences('owner', startAt, endAt).some(item => item.id === episodeId)).toBe(false);
    expect(usableKnowledgeFor(f.store, 'owner', f.store.snapshot('owner')).some(item => item.id === lesson!.id)).toBe(false);
    expect(f.shared.memory.read('owner', [episodeId, `knowledge:${lesson!.id}`], OWNER_AUDIENCE)).toEqual([]);
    expect(f.visible('owner', next.value)).toBe(false);
  });

  it('rejects private-read, cancelled, unobserved and fabricated proofs instead of treating their summaries as ordinary owner speech', async () => {
    const f = fixture(), failed = await observedFailure(f), db = f.actions.db;
    const proof = createFcaSleepTaskEvidence(db), seeds = skillSeedSources(f.store, null);
    const changeRecord = (patch: Partial<TaskExperienceRecord>) => db.prepare('UPDATE experience_events SET payload_json=? WHERE event_id=?')
      .run(JSON.stringify({ ...JSON.parse(failed.rawPayload), task: { ...failed.payload.task, ...patch } }), failed.episodeId);
    const cases: Array<[string, () => unknown]> = [
      ['private document lineage', () => changeRecord({ readSourceIds: ['aether-document://private'] })],
      ['unobserved result', () => changeRecord({ status: 'unobserved' })],
      ['cancelled result', () => changeRecord({ status: 'cancelled' })],
      ['fabricated observation', () => changeRecord({ observedResult: '未実行なのに成功したという架空の結果' })],
      ['missing canonical outcome', () => changeRecord({ outcomeId: 'invented-outcome' })],
      ['uncommitted history', () => db.prepare('DELETE FROM fca_task_history WHERE task_id=?').run(failed.value)],
      ['unobserved evidence', () => db.prepare("UPDATE fca_action_evidence SET observation='pending' WHERE event_id=?").run(failed.payload.task.outcomeId)],
      ['non-owner origin', () => db.prepare("UPDATE agent_tasks SET fca_origin='own_time' WHERE task_id=?").run(failed.value)],
    ];
    for (const [reason, change] of cases) {
      db.exec('SAVEPOINT invalid_learning_source');
      try {
        change();
        expect(proof('owner', failed.episodeId), reason).toBe(false);
        expect(seeds.experiences('owner', startAt, endAt).some(item => item.id === failed.episodeId), reason).toBe(false);
        expect(ownerSpoke(f.store.experiencesById('owner', [failed.episodeId])[0]!.disclosure), reason).toBe(false);
      } finally { db.exec('ROLLBACK TO invalid_learning_source'); db.exec('RELEASE invalid_learning_source'); }
    }
    expect(proof('owner', failed.episodeId)).toBe(true);
    expect(proof('other-scope', failed.episodeId)).toBe(false);
  });
});
