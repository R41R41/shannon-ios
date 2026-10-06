import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareFollowUp } from '../src/mind/action/ownTime/autonomyLoopFollowUpStep.js';
import { preparePhoneCall, type AutonomyPhone } from '../src/mind/action/ownTime/autonomyLoopPhoneStep.js';
import { prepareReachOut, type AutonomyReachOuts } from '../src/mind/action/ownTime/autonomyLoopReachOutStep.js';
import { AutonomyToolResults } from '../src/mind/action/ownTime/autonomyLoopToolStep.js';
import { toolSessionMemory } from '../src/mind/tools/shannonToolTypes.js';
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

  it('marks a note of a marked Notion page the moment Aether takes it, also from a session that was not marked', async () => {
    const notion = { read: async () => ({ title: '登場人物', url: 'https://www.notion.so/p1', text: '白ウサギの話。時計を持って走っている。' }) };
    const { fake, harness } = await ownTime({ notion });
    // The page is read in a marked session whose note does not come out, so it stays unwritten; the next session writes it up.
    harness.model.replies.note = { title: '', body: '' };
    harness.model.plans = [{ thought: '読みます。', steps: [{ action: 'notion', query: 'ウサカテ' }] }, { thought: '休みます。', steps: [rest()] }];
    await runUntilIdle(harness.loop);
    delete harness.model.replies.note;
    const reading = harness.store.loop.unnotedReadings(scope)[0]!;
    const cycle = harness.store.loop.startCycle(scope, '2026-10-02', 'activity', [], harness.clock.at);
    // The step is performed and never reported, as when the report fails: what Aether took is marked all the same.
    const { prepareStep, adaptersFor } = await import('../src/mind/action/ownTime/autonomyLoopSteps.js');
    const dependencies = { ...harness, loop: harness.loopConfig, model: harness.model, reader: harness.reader, showing: harness.showing, notion };
    const prepared = prepareStep(dependencies, cycle, { kind: 'note', readingId: reading.id }, harness.clock.at)!;
    await prepared.perform(adaptersFor({ decision: 'allow', domain: 'aether_study' }, dependencies), harness.clock.at);
    const written = fake.inFolder().find(document => document.title === '夕方の駅が懐かしい理由')!;
    expect(written).toBeTruthy();
    expect(harness.store.informed.marked(scope, written.id)).toBe(true);
    expect(harness.store.informed.sessionInformedAt(cycle.id)).not.toBeNull();
  });

  it('writes nothing into her folder on his PC or Mac', async () => {
    const { harness, markFirstThought } = await ownTime({ environment: { SHANNON_AUTONOMY_HOST_FOLDERS_JSON: '{"owner-windows":{"deviceId":"0123456789abcdef"}}' } }, false);
    markFirstThought();
    harness.model.plans = [{ thought: '書きます。', steps: [{ action: 'tool', name: 'folder.create', input: { path: 'notes/宿.md', content: '下調べ。' } }] }, { thought: '休みます。', steps: [rest()] }];
    await runUntilIdle(harness.loop);
    expect(harness.model.prompts('think')[1]).toContain('PCやMacのフォルダに書かない');
    expect(harness.entries().some(entry => entry.tool === 'folder.create')).toBe(false);
  });

  it('never copies a marked piece into her folder, from any session, so it cannot be read back unmarked', async () => {
    const { harness } = await ownTime({ environment: { SHANNON_AUTONOMY_HOST_FOLDERS_JSON: '{"owner-windows":{"deviceId":"0123456789abcdef"}}' } }, false);
    const at = harness.clock.at;
    const marked = harness.store.study.create(scope, { kind: 'note', title: '宿のメモ', body: '静かな宿のこと。' }, at);
    if (typeof marked === 'string') throw new Error(marked);
    harness.store.informed.markDocuments(scope, [`shannon-study://${marked.id}`], 'earlier', at);
    expect(harness.service.folder.nextCopy(scope, at, marked.id)).toBeNull();
    expect(() => harness.service.folder.enqueue(scope, { host: 'owner-windows', pieceId: marked.id, pieceVersion: marked.version }, at)).toThrow('HOST_STEP_PIECE_NOT_COPYABLE');
    const plain = harness.store.study.create(scope, { kind: 'note', title: '駅のメモ', body: '夕方の駅のこと。' }, at);
    if (typeof plain === 'string') throw new Error(plain);
    expect(harness.service.folder.nextCopy(scope, at)).toMatchObject({ pieceId: plain.id });
  });

  it('refuses a write and a copy for her folder on the Mac as for the PC, with both hosts bound (A18)', async () => {
    const hosts = '{"owner-windows":{"deviceId":"0123456789abcdef"},"owner-mac":{"deviceId":"fedcba9876543210"}}';
    const { harness, markFirstThought } = await ownTime({ environment: { SHANNON_AUTONOMY_HOST_FOLDERS_JSON: hosts } }, false);
    markFirstThought();
    harness.model.plans = [
      { thought: '書きます。', steps: [{ action: 'tool', name: 'folder.create', input: { host: 'owner-mac', path: 'notes/宿.md', content: '下調べ。' } }] },
      { thought: '休みます。', steps: [rest()] },
    ];
    await runUntilIdle(harness.loop);
    expect(harness.model.prompts('think')[1]).toContain('ライ氏の文書やNotionを読んだこの時間には、PCやMacのフォルダに書かない');
    expect(harness.entries().some(entry => entry.tool === 'folder.create')).toBe(false);
    const at = harness.clock.at;
    const marked = harness.store.study.create(scope, { kind: 'note', title: '宿のメモ', body: '静かな宿のこと。' }, at);
    if (typeof marked === 'string') throw new Error(marked);
    harness.store.informed.markDocuments(scope, [`shannon-study://${marked.id}`], 'earlier', at);
    expect(harness.service.folder.nextCopy(scope, at, marked.id)).toBeNull();
    for (const host of ['owner-windows', 'owner-mac']) {
      expect(() => harness.service.folder.enqueue(scope, { host, pieceId: marked.id, pieceVersion: marked.version }, at)).toThrow('HOST_STEP_PIECE_NOT_COPYABLE');
    }
  });

  it('refuses every change to her folder on the Mac in a marked session, now that the Mac writes (A18 S3)', async () => {
    const hosts = '{"owner-windows":{"deviceId":"0123456789abcdef"},"owner-mac":{"deviceId":"fedcba9876543210"}}';
    const changes: Array<[string, Record<string, unknown>]> = [
      ['folder.update', { host: 'owner-mac', path: 'notes/宿.md', content: '下調べ。' }],
      ['folder.rename', { host: 'owner-mac', path: 'notes/宿.md', newName: '宿2.md' }],
      ['folder.move', { host: 'owner-mac', path: 'notes/宿.md', to: 'old/宿.md' }],
      ['folder.delete', { host: 'owner-mac', path: 'notes/宿.md' }],
      ['folder.create', { path: 'notes/宿.md', content: '下調べ。' }],
    ];
    for (const [name, input] of changes) {
      const { harness, markFirstThought } = await ownTime({ environment: { SHANNON_AUTONOMY_HOST_FOLDERS_JSON: hosts } }, false);
      markFirstThought();
      harness.model.plans = [{ thought: '直します。', steps: [{ action: 'tool', name, input }] }, { thought: '休みます。', steps: [rest()] }];
      await runUntilIdle(harness.loop);
      expect(harness.model.prompts('think')[1], name).toContain(`${name}: できなかった（refused）`);
      expect(harness.entries().some(entry => entry.tool === name), name).toBe(false);
      expect(harness.store.hostOperations.leased(scope, 'owner-mac'), name).toBeNull();
    }
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

describe('telling the owner a marked story is ready', () => {
  it('waits while anyone else may see her words, starts no step meanwhile, and tells once they are gone', async () => {
    const state = { others: true };
    const reachOuts: AutonomyReachOuts = {
      sentOn: () => 0, lastSentAt: () => null, say: () => 'sent', audience: () => (state.others ? { instructions: '[ほかの人がいる場]', marker: '【機微】' } : null),
    };
    const { harness } = await ownTime({ reachOuts }, false);
    const at = harness.clock.at;
    const story = harness.store.study.create(scope, { kind: 'story', title: 'SENTINEL-STORY-TITLE', body: '湖のほとりの宿の話。'.repeat(12) }, at);
    if (typeof story === 'string') throw new Error(story);
    harness.store.informed.markDocuments(scope, [`shannon-study://${story.id}`], 'earlier', at);
    harness.model.plans = [{ thought: '見せます。', steps: [{ action: 'ready', pieceId: story.id }] }, { thought: '休みます。', steps: [rest()] }];
    await runUntilIdle(harness.loop);
    expect(harness.showing.told).toEqual([]);
    expect(harness.store.study.get(scope, story.id)?.status).toBe('ready');
    expect(harness.entries().some(entry => entry.tool === 'study.ready' && entry.summary.includes('ほかの人がいるため'))).toBe(true);
    // While someone is there, no showing step is started for it.
    harness.advance(60 * 60_000);
    const before = harness.entries().length;
    expect(await runUntilIdle(harness.loop)).not.toContain('stepped');
    expect(harness.entries().filter(entry => entry.kind === 'action' && (entry.tool === 'study.show' || entry.tool === 'study.ready'))).toHaveLength(1);
    expect(harness.entries().length).toBe(before);
    state.others = false;
    harness.advance(60 * 60_000);
    await runUntilIdle(harness.loop);
    expect(harness.showing.told.map(piece => piece.id)).toEqual([story.id]);
  });
});

describe('a second call and a phone call of a marked session', () => {
  it('are held when someone comes in while their words are written, and go when nobody does', async () => {
    const said: string[] = [];
    const state = { others: false };
    const reachOuts: AutonomyReachOuts = {
      sentOn: () => 0, lastSentAt: () => null, audience: () => (state.others ? { instructions: '[ほかの人がいる場]', marker: '【機微】' } : null),
      say: () => 'sent', sayByPhone: (_scope, input) => { said.push(input.text); return 'sent'; },
      sayAgain: (_scope, input) => { said.push(input.text); return 'sent'; },
      latest: () => null, followUpsOn: () => 0, followedUp: () => false, text: () => 'ライ氏、いま何をしていますか。',
    };
    const phone: AutonomyPhone = { facts: () => ({ switchedOn: true, serverReady: true, ringing: false, waitMinutes: 0, earphones: false }) as never, request: () => 'requested', outcome: () => 'answered' };
    for (const comes of [true, false]) {
      const { harness } = await ownTime({ reachOuts, phone, agentic: true }, false);
      const at = harness.clock.at;
      const cycle = harness.store.loop.startCycle(scope, '2026-10-02', 'activity', [], at);
      harness.store.loop.observations.add(scope, { cycleId: cycle.id, ordinal: 0, step: 'reach_out', outcome: 'done', reachOut: { id: 'initiative-1', reason: 'wonder', sentAt: at, waitedSeconds: 180, replied: false, delivery: 'unknown', windowVisible: false, owner: 'unknown', others: false } }, at);
      harness.store.informed.markSession(cycle.id, at);
      const model = new FakeModel();
      model.during = () => { state.others = comes; };
      const dependencies = { ...harness, loop: harness.loopConfig, model, reachOuts, phone, now: () => harness.clock.at, wait: async () => undefined };
      said.length = 0;
      state.others = false;
      const again = prepareFollowUp(dependencies, cycle, { kind: 'reach_out', reason: 'follow_up', originId: 'initiative-1' }, at)!;
      const call = preparePhoneCall(dependencies, cycle, { kind: 'reach_out', reason: 'wonder', call: true }, at)!;
      const results = [await again.perform({ model, reachOuts, phone, showing: harness.showing }, at), await call.perform({ model, reachOuts, phone, showing: harness.showing }, at)];
      if (comes) {
        for (const result of results) expect(result).toMatchObject({ tool: 'owner.reach_out_held', reasonCode: 'others_present' });
        expect(said).toEqual([]);
      } else {
        expect(said).toHaveLength(2);
      }
    }
  });
});

describe('what marks a session, and what the gate holds', () => {
  it('is marked by a search that shows a marked document, and not by a listing, which leaves it out instead', async () => {
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
    const lastResult = () => harness.model.prompts('think').at(-1)!;
    expect(await run('aether.search', { query: '駅', scope: 'shannonFolder' })).toBe(false);
    expect(await run('aether.search', { query: '宿', scope: 'shannonFolder' })).toBe(true);
    const note = harness.store.study.create(scope, { kind: 'note', title: '湖のメモ', body: '湖の宿。' }, harness.clock.at);
    if (typeof note === 'string') throw new Error(note);
    harness.store.informed.markDocuments(scope, [`shannon-study://${note.id}`], 'earlier', harness.clock.at);
    expect(await run('study.search', { query: '駅' })).toBe(false);
    expect(await run('study.search', { query: '湖' })).toBe(true);
    // A listing does not mark the session: a session that is not marked is not shown what is marked (option (a)).
    expect(await run('aetherFolder.list', {})).toBe(false);
    expect(lastResult()).toContain(plain.id);
    expect(lastResult()).not.toContain(marked.id);
    expect(await run('study.list', {})).toBe(false);
    expect(lastResult()).not.toContain(note.id);
    // A marked session lists everything.
    const open = async (name: string) => {
      harness.advance(3 * 60 * 60_000);
      harness.model.plans = [{ thought: '読みます。', steps: [{ action: 'tool', name: 'study.read', input: { id: note.id } }] }, { thought: '見ます。', steps: [{ action: 'tool', name, input: {} }] }, { thought: '休みます。', steps: [rest()] }];
      await runUntilIdle(harness.loop);
      return lastResult();
    };
    expect(await open('aetherFolder.list')).toContain(marked.id);
    expect(await open('study.list')).toContain(note.id);
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
