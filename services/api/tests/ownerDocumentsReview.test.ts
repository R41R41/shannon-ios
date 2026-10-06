import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareReachOut, type AutonomyReachOuts } from '../src/autonomyLoopReachOutStep.js';
import { AutonomyToolResults } from '../src/autonomyLoopToolStep.js';
import { toolSessionMemory } from '../src/shannonToolTypes.js';
import { OWN_TIME_PRICES } from './ownerDocumentsScenario.js';
import { FakeAether } from './fakeAetherServer.js';
import { FakeModel, loopHarness, runUntilIdle, scope, type LoopHarnessOptions } from './autonomyLoopHarness.js';

/** The provenance mark at its edges (ADR-0007; the review of 2026-10-06): what a marked session keeps, writes and may not do. */
const FOLDER = 'project_shannon_folder';
const rest = (reason = 'ここまで') => ({ action: 'rest', resumeInMinutes: 120, reason });
const servers: FakeAether[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(servers.splice(0).map(server => server.stop())); });

async function ownTime(options: Partial<LoopHarnessOptions> = {}, aether = true) {
  const fake = new FakeAether();
  servers.push(fake);
  const harness = loopHarness({
    sessions: true, toolResults: new AutonomyToolResults(), ...(aether ? { aether: await fake.access() } : {}), ...options,
    environment: { ...OWN_TIME_PRICES, ...options.environment }, loopEnvironment: { SHANNON_AUTONOMY_OWNER_DOCUMENTS: 'on' },
  });
  /** The session open now is marked from its first thought on, as if it had read something of the owner's. */
  const markFirstThought = () => {
    harness.model.during = kind => {
      const open = harness.store.loop.openCycle(scope);
      if (kind === 'think' && open && !harness.store.informed.sessionInformedAt(open.id)) harness.store.informed.markSession(open.id, harness.clock.at);
    };
  };
  const closed = () => harness.store.loop.sessions.latestClosed(scope)!;
  return { fake, harness, markFirstThought, closed };
}

describe('a marked session', () => {
  it('keeps no words of her thought or her reason for resting in the record', async () => {
    const { harness, markFirstThought, closed } = await ownTime({}, false);
    markFirstThought();
    harness.model.plans = [{ thought: '湖の宿のことを考えた。', steps: [rest('湖の宿の続きを考えたい')] }];
    await runUntilIdle(harness.loop);
    const words = JSON.stringify(harness.entries());
    expect(words).not.toContain('湖の宿');
    expect(words).toContain('次に何をするか考えました。');
    expect(closed().restReason).toBeUndefined();
    // A session that is not marked keeps them, as before.
    harness.model.during = undefined;
    harness.advance(3 * 60 * 60_000);
    harness.model.plans = [{ thought: '駅のことを考えた。', steps: [rest('駅の続き')] }];
    await runUntilIdle(harness.loop);
    expect(JSON.stringify(harness.entries())).toContain('駅のことを考えた。');
    expect(closed().restReason).toBe('駅の続き');
  });

  it('marks a document the moment Aether takes it, so a write whose report fails is still marked', async () => {
    const { fake, harness, markFirstThought } = await ownTime();
    markFirstThought();
    const record = harness.service.recordAction.bind(harness.service);
    vi.spyOn(harness.service, 'recordAction').mockImplementation((scopeKey, report) => {
      if (report.summary.includes('宿の下調べ')) throw new Error('RECORD_UNAVAILABLE');
      return record(scopeKey, report);
    });
    harness.model.plans = [{ thought: '書きます。', steps: [{ action: 'tool', name: 'aetherFolder.create', input: { title: '宿の下調べ', body: '下調べ。' } }] }, { thought: '休みます。', steps: [rest()] }];
    await runUntilIdle(harness.loop);
    const written = fake.inFolder().find(document => document.title === '宿の下調べ')!;
    expect(harness.entries().some(entry => entry.kind === 'action' && entry.summary === 'したことの結果を保存できませんでした。')).toBe(true);
    expect(harness.store.informed.marked(scope, written.id)).toBe(true);
  });

  it('writes nothing into her folder on his PC or Mac', async () => {
    const { harness, markFirstThought } = await ownTime({ environment: { SHANNON_AUTONOMY_HOST_FOLDERS_JSON: '{"owner-windows":{"deviceId":"0123456789abcdef"}}' } }, false);
    markFirstThought();
    harness.model.plans = [{ thought: '書きます。', steps: [{ action: 'tool', name: 'folder.create', input: { path: 'notes/宿.md', content: '下調べ。' } }] }, { thought: '休みます。', steps: [rest()] }];
    await runUntilIdle(harness.loop);
    expect(harness.model.prompts('think')[1]).toContain('PCのフォルダに書かない');
    expect(harness.entries().some(entry => entry.tool === 'folder.create')).toBe(false);
  });

  it('holds a message whose words were written while someone came in', async () => {
    const said: string[] = [];
    const state = { others: false };
    const reachOuts: AutonomyReachOuts = {
      sentOn: () => said.length, lastSentAt: () => null, say: (_scope, input) => { said.push(input.text); return 'sent'; },
      audience: () => (state.others ? { instructions: '[ほかの人がいる場]', marker: '【機微】' } : null),
    };
    const { harness } = await ownTime({ reachOuts }, false);
    const model = new FakeModel();
    model.during = kind => { if (kind === 'reach_out') state.others = true; };
    const cycle = harness.store.loop.startCycle(scope, '2026-10-02', 'activity', [], harness.clock.at);
    harness.store.informed.markSession(cycle.id, harness.clock.at);
    const dependencies = { ...harness, loop: harness.loopConfig, model, reachOuts };
    const prepared = prepareReachOut(dependencies, cycle, { kind: 'reach_out', reason: 'wonder' }, harness.clock.at)!;
    expect(prepared).not.toBeNull();
    const result = await prepared.perform({ model, reachOuts, showing: harness.showing }, harness.clock.at);
    expect(result).toMatchObject({ tool: 'owner.reach_out_held', reasonCode: 'others_present' });
    expect(said).toEqual([]);
  });
});

describe('what marks a session, and what the gate holds', () => {
  it('is marked by a search or a listing that shows a marked document, in Aether or in her study', async () => {
    const { fake, harness, closed } = await ownTime();
    const marked = fake.put({ title: '宿のメモ', body: '静かな宿。', projectIds: [FOLDER], tags: ['シャノン'], type: 'note' });
    const plain = fake.put({ title: '駅のメモ', body: '夕方の駅。', projectIds: [FOLDER], tags: ['シャノン'], type: 'note' });
    harness.store.informed.markDocuments(scope, [marked.id], 'earlier', harness.clock.at);
    const run = async (name: string, input: Record<string, unknown>) => {
      harness.advance(3 * 60 * 60_000);
      harness.model.plans = [{ thought: '探します。', steps: [{ action: 'tool', name, input }] }, { thought: '休みます。', steps: [rest()] }];
      await runUntilIdle(harness.loop);
      return harness.store.informed.sessionInformedAt(closed().cycleId) !== null;
    };
    expect(await run('aether.search', { query: '駅', scope: 'shannonFolder' })).toBe(false);
    expect(await run('aether.search', { query: '宿', scope: 'shannonFolder' })).toBe(true);
    expect(await run('aetherFolder.list', {})).toBe(true);
    const note = harness.store.study.create(scope, { kind: 'note', title: '湖のメモ', body: '湖の宿。' }, harness.clock.at);
    if (typeof note === 'string') throw new Error(note);
    harness.store.informed.markDocuments(scope, [`shannon-study://${note.id}`], 'earlier', harness.clock.at);
    expect(await run('study.search', { query: '駅' })).toBe(false);
    expect(await run('study.search', { query: '湖' })).toBe(true);
    expect(plain.id).toBeTruthy();
  });

  it('refuses outreach in a marked session, by its domain too; checks the pursuit in the runner; and stores ids as it looks them up', async () => {
    const { fake, harness } = await ownTime();
    const owners = fake.ownerDocument('来月の計画', '湖のほとり。');
    const cycle = harness.store.loop.startCycle(scope, '2026-10-02', 'activity', [], harness.clock.at);
    harness.store.informed.markSession(cycle.id, harness.clock.at);
    expect(harness.service.authorize(scope, { domain: 'outreach', summary: '友人に送ります。' })).toMatchObject({ decision: 'forbidden', reason: 'owner_informed' });
    harness.store.loop.endCycle(cycle.id, 'test', harness.clock.at);
    expect(harness.service.authorize(scope, { domain: 'outreach', summary: '友人に送ります。' })).toMatchObject({ decision: 'needs_approval', reason: 'approval_domain' });
    const context = { scopeKey: scope, surface: 'autonomy' as const, audience: 'owner_alone' as const, memory: toolSessionMemory() };
    expect(harness.service.tools.prepare('ownerDocs.read', { documentId: owners.id, pursuitId: 'no-such-pursuit' }, context)).toMatchObject({ result: { ok: false, failure: 'refused' } });
    const pursuit = harness.store.pursuits.list(scope, harness.clock.at)[0]!.id;
    expect(harness.service.tools.prepare('ownerDocs.read', { documentId: owners.id, pursuitId: pursuit }, context)).toHaveProperty('prepared');
    const long = `doc_${'x'.repeat(400)}`;
    harness.store.informed.markDocuments(scope, [long], 'earlier', harness.clock.at);
    expect(harness.store.informed.marked(scope, long)).toBe(true);
    expect(harness.store.informed.marked(scope, `${long.slice(0, 300)}-another`)).toBe(true);
  });
});
