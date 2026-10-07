import { afterEach, describe, expect, it } from 'vitest';
import { ImpressionUpdater, type ImpressionAnalyzer } from '../src/mind/memory/impressionUpdater.js';
import { ShannonKnowledgeConsolidator, type KnowledgeAnalyzer, type KnowledgeOperation } from '../src/mind/sleep/knowledgeConsolidation.js';
import { PeopleMemory } from '../src/mind/memory/peopleMemory.js';
import { memoryWriterOf } from '../src/wiring/memoryOutboxWiring.js';
import { memoryKernel } from './support/memoryKernel.js';

/**
 * Syzygy ADR-0008 stage 3, step F5: the writers of phase 3a propose, and only the one writer writes. Each is run with the outbox
 * on: nothing is written until the writer runs; then what it wrote is what the writer of afb38c28 would have written; and a
 * decision of the owner's that came in between wins.
 */
const kernels: Array<ReturnType<typeof memoryKernel>> = [];
const kernel = () => { const created = memoryKernel(); kernels.push(created); return created; };
afterEach(() => { for (const created of kernels.splice(0)) created.close(); });

const CUTE = 'ボクのことをよく「可愛い」と言う';

describe('the phase-3a writers propose', () => {
  it('impressions: the analysis is proposed and applied by the writer to the rows as they are then', async () => {
    const k = kernel();
    const analyzer: ImpressionAnalyzer = { analyze: async (_scopeKey, input) => {
      const held = input.impressions.find(item => item.pattern === CUTE);
      return held ? { observations: [{ key: held.key, stance: 'support', keyTerms: ['可愛い'], feeling: '', feelingTag: '' }], candidates: [] }
        : { observations: [], candidates: [{ kind: 'speech_habit', pattern: CUTE, keyTerms: ['可愛い'], feeling: 'くすぐったい', feelingTag: '' }] };
    } };
    const impressions = new ImpressionUpdater(k.store, k.store, k.store.impressionStore(), analyzer, { backgroundLlmCostUsd: () => 0 },
      { now: k.now, backgroundBudgetUsd: 1, environment: {}, memory: k.ports.proposals });
    const writer = memoryWriterOf(k.store, { now: k.now, impressions, log: () => {} })!;
    const first = await k.chat('シャノンは可愛いね');
    expect(await impressions.observeTurn('owner', first)).toBe('proposed');
    expect(k.store.impressionStore().impressions('owner')).toHaveLength(0);
    await writer.drain();
    expect(k.store.impressionStore().impressions('owner')).toMatchObject([{ pattern: CUTE, status: 'candidate', supportCount: 1 }]);
    const second = await k.chat('今日も可愛い');
    expect(await impressions.observeTurn('owner', second)).toBe('proposed');
    await writer.drain();
    expect(k.store.impressionStore().impressions('owner')).toMatchObject([{ pattern: CUTE, supportCount: 2 }]);
    expect(k.outbox.rows().filter(row => row.kind === 'impression.observe').map(row => row.status)).toEqual(['applied', 'applied']);
  });

  it('knowledge: a note is proposed and created by the writer; an update against an older version is superseded', async () => {
    const k = kernel();
    const first = await k.chat('写真の整理を手伝ってほしい');
    const second = await k.chat('写真の整理、アルバム単位だと進んだ');
    const draft = { title: '写真整理の進め方', bodyMarkdown: '## 状況\n整理を頼まれた\n## 行動\n月ごとに分けて示す\n## 結果\n進んだ', applicability: '整理を頼まれた時',
      status: 'hypothesis' as const, sourceExperienceIds: [first, second] };
    const operations: KnowledgeOperation[][] = [[{ operation: 'create', knowledgeId: '', expectedVersion: 0, ...draft, reason: '繰り返し' }]];
    const analyzer: KnowledgeAnalyzer = { analyze: async () => operations.shift() ?? [] };
    const consolidator = new ShannonKnowledgeConsolidator(k.store, k.store, k.store, analyzer, { backgroundLlmCostUsd: () => 0 }, { now: k.now, memory: k.ports.proposals });
    expect(await consolidator.consolidate('owner', '2026-10-07T00:00:00.000Z', '2026-10-08T00:00:00.000Z')).toMatchObject({ status: 'applied', created: 1 });
    expect(k.store.listShannonKnowledge('owner')).toHaveLength(0);
    await k.writer.drain();
    const [note] = k.store.listShannonKnowledge('owner');
    expect(note).toMatchObject({ title: '写真整理の進め方', version: 1 });
    // Two updates proposed against version 1: the first is applied, the second finds version 2 and is superseded.
    operations.push([{ operation: 'update', knowledgeId: note!.id, expectedVersion: 1, ...draft, status: 'confirmed', reason: '二度目' }]);
    await consolidator.consolidate('owner', '2026-10-07T00:00:00.000Z', '2026-10-08T00:00:00.000Z');
    operations.push([{ operation: 'update', knowledgeId: note!.id, expectedVersion: 1, ...draft, title: '別の題', reason: '古い版から' }]);
    await new ShannonKnowledgeConsolidator(k.store, k.store, k.store, analyzer, { backgroundLlmCostUsd: () => 0 }, { now: () => '2026-10-07T05:00:00.000Z', memory: k.ports.proposals })
      .consolidate('owner', '2026-10-07T00:00:00.000Z', '2026-10-08T00:00:00.000Z');
    await k.writer.drain();
    expect(k.store.listShannonKnowledge('owner')[0]).toMatchObject({ version: 2, status: 'confirmed', title: '写真整理の進め方' });
    expect(k.outbox.rows().filter(row => row.kind === 'knowledge.update').map(row => row.status)).toEqual(['applied', 'superseded']);
  });

  it('people memory: a remembered call is proposed and written; 「今回は残さない」 before the writer wins', async () => {
    const k = kernel();
    const people = new PeopleMemory(k.people, k.store, k.ports);
    const turns = [{ role: 'participant' as const, text: 'はじめまして、ミナです' }, { role: 'shannon' as const, text: 'ミナさん、はじめまして！次は好きな本の話を聞かせてください' },
      { role: 'participant' as const, text: '私は猫が好き' }, { role: 'shannon' as const, text: '猫、いいですね' }];
    const remembered = await people.rememberCall('owner', { callId: 'call-0001', turns }, k.now());
    expect(remembered.status).toBe('remembered');
    expect(k.people.items('owner')).toHaveLength(0);
    await k.writer.drain();
    const kinds = k.people.items('owner').map(item => item.kind).sort();
    expect(kinds).toEqual(['fact', 'summary', 'topic', 'turn', 'turn']);
    expect(k.people.items('owner').find(item => item.kind === 'fact')?.text).toContain('ミナさんは猫が好き');

    await people.rememberCall('owner', { callId: 'call-0002', turns }, k.now());
    people.discardCall('owner', 'call-0002', k.now());
    await k.writer.drain();
    expect(k.people.items('owner').filter(item => item.callId === 'call-0002')).toHaveLength(0);
    expect(k.outbox.rows().filter(row => row.subjectKey === 'call:call-0002').every(row => row.status === 'superseded' && row.outcomeCode === 'discarded')).toBe(true);
  });

  it('sleep: what the batch learned is proposed in its transaction and learned by the writer, the profile written again', async () => {
    const k = kernel();
    await k.chat('今日は散歩した');
    k.store.enqueueSleepConsolidations('2026-10-07', '2026-10-07T00:00:00.000Z', '2026-10-08T00:00:00.000Z', k.now());
    const job = k.store.claimNextBackgroundJob('worker-1', k.now(), '2026-10-07T04:00:00.000Z')!;
    expect(job.payload.kind).toBe('sleep-consolidation');
    k.store.applySleepOutcome(job, 'worker-1', k.now(), {
      facts: [{ id: 'user-fact-sleep', statement: 'ユーザーは散歩が好き', confidence: 0.7, observedAt: k.now(), evidence: '今日は散歩した' }],
      relationships: [], interests: ['散歩'],
      report: { learned: [], updated: [], interestChanges: [], contradictions: [] },
    });
    expect(k.store.snapshot('owner').userFacts).toHaveLength(0);
    expect(k.outbox.rows({ status: 'pending' }).map(row => [row.kind, row.origin])).toEqual([['fact.upsert', 'sleep'], ['interest.change', 'sleep']]);
    await k.writer.drain();
    expect(k.store.snapshot('owner').userFacts.map(fact => fact.id)).toEqual(['user-fact-sleep']);
    expect(k.store.snapshot('owner').interests).toContain('散歩');
    expect(k.store.promptProjection('owner')).toContain('散歩');
  });
});
