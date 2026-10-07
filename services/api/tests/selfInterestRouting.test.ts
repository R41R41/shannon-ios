import { afterEach, describe, expect, it } from 'vitest';
import { disclosureFor } from '@shannon/cognition';
import { TurnRefinementProcessor } from '../src/mind/sleep/backgroundUpdates.js';
import { consolidateSleepMemory, OpenAISleepMemoryAnalyzer } from '../src/mind/sleep/sleepConsolidation.js';
import { parseSleepSelfInterests } from '../src/mind/sleep/sleepSelfInterests.js';
import { selfInterestWorld } from './support/selfInterestWorld.js';

const worlds: ReturnType<typeof selfInterestWorld>[] = [];
const world = (enabled = true) => { const result = selfInterestWorld(enabled); worlds.push(result); return result; };
afterEach(() => { for (const current of worlds.splice(0)) current.close(); });

describe('self interest producer and memory-writer routing', () => {
  it('routes resonance to a candidate while ON, adopting only at night and retaining the OFF legacy lane', async () => {
    for (const enabled of [false, true]) {
      const w = world(enabled);
      w.source('量子物理の入門を読んでみたい。');
      const source = w.source('量子物理');
      new TurnRefinementProcessor(w.store, w.store, w.proposals, enabled).process('owner', '量子物理', source, w.now());
      await w.writer().drain();
      expect(w.store.snapshot('owner').interests.includes('量子物理')).toBe(!enabled);
      if (enabled) {
        expect(w.memory!.store.all('owner')).toEqual([]);
        expect(w.memory!.store.candidates('owner')).toMatchObject([{ proposal: { title: '量子物理', kind: 'add', evidenceRefs: [source] } }]);
        await w.night();
        expect(w.memory!.projection('owner')).toContain('量子物理');
        expect(w.store.snapshot('owner').interests).toEqual([]);
      }
    }
  });

  it('preserves verified explicit owner observations without letting old, quoted or third-party ops bypass self caps', async () => {
    const w = world();
    w.store.apply('owner', { type: 'interest-observed', interest: '混在した旧関心' });
    const sentence = '僕は水色が好き。最近エージェント設計に興味がある。';
    const source = w.source(sentence);
    new TurnRefinementProcessor(w.store, w.store, w.proposals, true).process('owner', sentence, source, w.now());
    const propose = (opId: string, interest: string, text: string, provenance?: 'owner_explicit') => {
      w.proposals.propose({ opId, scopeKey: 'owner', kind: 'interest.change', origin: 'turn', subjectKey: `interest:${interest}`,
        payload: { interest, ...(provenance ? { provenance } : {}) }, episodeIds: [w.source(text)] });
    };
    propose('legacy-unverified', '天文', '天文の本を読んでいた。');
    propose('legacy-verified', '地理', '最近地理に興味がある。');
    propose('quoted-owner', '陶芸', '「陶芸に興味がある」と友達が言った。', 'owner_explicit');
    propose('third-party', '園芸', '友達は園芸に興味がある。', 'owner_explicit');
    await w.writer().drain();
    expect(w.store.snapshot('owner').interests).toContain('エージェント設計');
    expect(w.store.snapshot('owner').interests).toContain('混在した旧関心');
    expect(w.store.snapshot('owner').interests).toContain('地理');
    for (const title of ['天文', '陶芸', '園芸']) expect(w.store.snapshot('owner').interests).not.toContain(title);
    expect(w.outbox.rows().filter(row => ['legacy-unverified', 'quoted-owner', 'third-party'].includes(row.opId)))
      .toMatchObject([{ status: 'superseded', outcomeCode: 'candidate_held' }, { status: 'superseded', outcomeCode: 'candidate_held' }, { status: 'superseded', outcomeCode: 'candidate_held' }]);
    await w.night();
    expect(w.memory!.store.candidates('owner', false).filter(candidate => candidate.code === 'provenance_unknown')).toHaveLength(3);
  });

  it('adopts bounded sleep proposals through durable sleep completion and rechecks originals', async () => {
    const w = world();
    const at = '2026-10-07T01:00:00.000Z';
    const original = w.store.appendTurn('owner', 'thread', '天文と音楽と鉱物を調べたい。', 'いいですね。', at).id;
    const messages = w.store.dailyUserMessages('owner', '2026-10-06T15:00:00.000Z', '2026-10-07T15:00:00.000Z');
    const analyzer = new OpenAISleepMemoryAnalyzer({ apiKey: 'synthetic', fetcher: async () => new Response(JSON.stringify({ output_text: JSON.stringify({
      facts: [], relationships: [], interests: [], selfInterests: ['天文', '音楽', '鉱物'].map(title => ({ kind: 'add', itemId: null, title,
        description: `${title}を調べる`, reason: '会話から考えた', weight: 0.5, evidence: messages[0]!.content })),
    }) }), { status: 200 }) });
    const outcome = await consolidateSleepMemory(analyzer, messages, w.store.snapshot('owner'), at, { scopeKey: 'owner', occurredAt: w.now(), stage5: true, selfInterests: [] });
    expect(outcome.interests).toEqual([]);
    expect(outcome.selfInterestDrafts).toHaveLength(3);
    expect(outcome.selfInterestDrafts![0]!.proposal.evidenceRefs).toEqual([original]);
    w.store.enqueueSleepConsolidations('2026-10-07', '2026-10-06T15:00:00.000Z', '2026-10-07T15:00:00.000Z', w.now());
    const job = w.store.claimNextBackgroundJob('sleep-writer', w.now(), '2026-10-07T19:02:00.000Z')!;
    expect(job.payload.kind).toBe('sleep-consolidation');
    w.store.applySleepOutcome(job, 'sleep-writer', w.now(), outcome);
    expect(w.memory!.store.all('owner')).toEqual([]);
    await w.writer().drain();
    expect(w.memory!.snapshot('owner').capacity.used).toBe(2);
    expect(w.store.snapshot('owner').interests).toEqual([]);
    expect(w.memory!.store.candidates('owner', false).at(-1)).toMatchObject({ status: 'held', code: 'night_limit' });
    expect(w.outbox.rows().filter(row => row.kind === 'self.interest.night')).toMatchObject([{ status: 'applied', outcomeCode: 'night_adopted' }]);
  });

  it('uses exact current item revision and canonical owner quotes rather than generated self reasons as evidence', async () => {
    const w = world(); w.add('天文'); await w.night();
    const current = w.memory!.snapshot('owner').items;
    const input = { kind: 'patch', itemId: current[0]!.id, title: '天文', description: '観測方法を学ぶ', reason: '観測を続けたい', weight: 0.6, evidence: '天文を観測したい。' };
    const parsed = parseSleepSelfInterests([input], [{ content: input.evidence, observedAt: w.now(), sourceExperienceId: 'canonical-turn' }], current);
    expect(parsed).toMatchObject([{ proposal: { itemId: current[0]!.id, expectedRevision: current[0]!.revision, ownerGeneration: current[0]!.ownerGeneration, evidenceRefs: ['canonical-turn'] } }]);
    expect(parseSleepSelfInterests([{ ...input, itemId: 'foreign' }], [{ content: input.evidence, observedAt: w.now(), sourceExperienceId: 'canonical-turn' }], current)).toEqual([]);
    expect(parseSleepSelfInterests([input], [{ content: '別の発言', observedAt: w.now(), sourceExperienceId: 'canonical-turn' }], current)).toEqual([]);
    expect(parseSleepSelfInterests([input], [{ content: input.evidence, observedAt: w.now() }], current)).toEqual([]);
    const op = w.propose({ ...parsed[0]!.proposal, reason: '元の記録がない', evidenceRefs: ['canonical-turn'] });
    await w.night();
    expect(w.memory!.store.candidates('owner', false).find(candidate => candidate.proposal.candidateId === op)).toMatchObject({ status: 'rejected', code: 'source_hidden' });
  });

  it('preserves OFF model request bytes and output shape, and reuses the same monthly usage gate while ON', async () => {
    const calls: string[] = [];
    let monthlyCost = 0;
    const analyzer = new OpenAISleepMemoryAnalyzer({ apiKey: 'synthetic', now: () => new Date('2026-10-07T19:00:00.000Z'),
      usageStore: { backgroundLlmCostUsd: () => monthlyCost, recordLlmUsage: () => {} },
      fetcher: async (_url, init) => { calls.push(String(init?.body)); return new Response(JSON.stringify({ output_text: JSON.stringify({ facts: [], relationships: [], interests: [] }) }), { status: 200 }); } });
    const messages = [{ content: '天文を調べたい。', observedAt: '2026-10-07T10:00:00.000Z', sourceExperienceId: 'turn' }];
    const context = { scopeKey: 'owner', occurredAt: '2026-10-07T19:00:00.000Z' };
    await analyzer.analyze(messages, context);
    await analyzer.analyze(messages, { ...context, stage5: false, selfInterests: [] });
    expect(calls[0]).toBe(calls[1]);
    expect(JSON.parse(calls[0]!)).toMatchObject({ max_output_tokens: 400 });
    expect(calls[0]).not.toContain('selfInterests');
    await analyzer.analyze(messages, { ...context, stage5: true, selfInterests: [] });
    expect(calls[2]).toContain('selfInterests');
    const before = calls.length;
    monthlyCost = 1;
    expect(await analyzer.analyze(messages, { ...context, stage5: true })).toEqual([]);
    expect(calls).toHaveLength(before);
    const w = world(false);
    const off = await consolidateSleepMemory(analyzer, messages, w.store.snapshot('owner'), context.occurredAt, context);
    expect(off).not.toHaveProperty('interestEvidence');
    expect(off).not.toHaveProperty('selfInterestDrafts');
  });

  it('carries guarded labels and honors owner sensitivity controls in the shared projection', async () => {
    const w = world(); const source = w.source('僕の住所について調べたい。'); w.add('地域の地理', [source]); await w.night();
    const audience = { kind: 'people' as const, personIds: ['guest'] };
    expect(w.memory!.projection('owner', audience)).toContain('【機微:');
    w.store.apply('owner', { type: 'memory-control-upserted', control: { memoryId: source, kind: 'experience', status: 'active', pinned: false,
      updatedAt: w.now(), changeReason: 'owner', sensitivity: 'sensitive' } });
    expect(w.memory!.projection('owner', audience)).toBe('');
    expect(w.memory!.projection('owner')).toContain('地域の地理');
  });
});
