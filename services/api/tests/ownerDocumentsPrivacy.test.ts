import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createInitialCompanionState } from '@shannon/cognition';
import { chatAudienceTurn } from '../src/chatAudience.js';
import { heldForOthers, noteProvenance } from '../src/autonomyLoopProvenance.js';
import type { AutonomyReachOuts } from '../src/autonomyLoopReachOutStep.js';
import { AutonomyToolResults } from '../src/autonomyLoopToolStep.js';
import type { ConversationStore } from '../src/mind/memory/store/conversationStore.js';
import { toolSessionMemory } from '../src/shannonToolTypes.js';
import type { ToolAudience } from '../src/shannonTools.js';
import { OWN_TIME_PRICES } from './ownerDocumentsScenario.js';
import { FakeAether } from './fakeAetherServer.js';
import { loopHarness, runUntilIdle, scope, type LoopHarnessOptions } from './autonomyLoopHarness.js';

/**
 * The provenance mark (owner decision 2026-10-06, Syzygy ADR-0007): what she writes after reading the owner's documents, or a
 * shared Notion page, is not read with anyone else present. The owner alone, and her own time, read it as before. Nothing of a
 * document is kept in Shannon's database.
 */
const SENTINEL = 'SENTINEL-OWNERDOC-7Q2X';
const FOLDER = 'project_shannon_folder';
const HOUR = 60 * 60_000;
const servers: FakeAether[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.stop()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** Her words reach the owner through this; `others` is whether anyone else may see or hear her body. */
function speaker() {
  const said: string[] = [];
  const state = { others: false };
  const reachOuts: AutonomyReachOuts = {
    sentOn: () => said.length, lastSentAt: () => null,
    audience: () => (state.others ? { instructions: '[ほかの人がいる場]', marker: '【機微:未分類】' } : null),
    say: (_scope, input) => { said.push(input.text); return 'sent'; },
  };
  return { said, state, reachOuts };
}

async function marked(flag: string | undefined, options: Partial<LoopHarnessOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-owner-documents-'));
  directories.push(directory);
  const fake = new FakeAether();
  servers.push(fake);
  const access = await fake.access();
  const owners = fake.ownerDocument('来月の計画', `湖のほとりの小さな宿に泊まる。${SENTINEL}`);
  const station = fake.put({ title: '駅のメモ', body: '夕方の駅の宿題は、音から書くこと。', projectIds: [FOLDER], tags: ['シャノン'], type: 'note' });
  const voice = speaker();
  const harness = loopHarness({
    path: join(directory, 'shannon.sqlite'), sessions: true, aether: access, toolResults: new AutonomyToolResults(), reachOuts: voice.reachOuts, ...options,
    environment: { ...OWN_TIME_PRICES, ...options.environment }, ...(flag === undefined ? {} : { loopEnvironment: { SHANNON_AUTONOMY_OWNER_DOCUMENTS: flag } }),
  });
  const call = (name: string, input: unknown, audience: ToolAudience) => harness.service.tools.call(name, JSON.stringify(input), {
    scopeKey: scope, surface: 'text', audience, memory: toolSessionMemory(),
    ...(audience === 'others' ? { othersText: { withheld: { carries: () => false }, guarded: { carries: () => false }, openOnly: true } } : {}),
  });
  const session = async (plans: unknown[]) => {
    harness.advance(3 * HOUR);
    harness.model.plans = [...plans];
    await runUntilIdle(harness.loop, 40);
    return harness.store.loop.sessions.latestClosed(scope)!.cycleId;
  };
  const document = (title: string) => fake.inFolder().find(item => item.title === title)!;
  const isMarked = (id: string) => harness.store.informed.marked(scope, id);
  return { directory, fake, owners, station, voice, harness, call, session, document, isMarked };
}

const rest = { action: 'rest', resumeInMinutes: 120, reason: 'ここまで' };

describe('what she writes after reading the owner\'s documents', () => {
  it('is marked, kept from anyone else present, read by the owner alone, passed on by reading, and never stored as text', async () => {
    const { directory, owners, station, voice, harness, call, session, document, isMarked } = await marked('on');
    const pursuit = harness.store.pursuits.list(scope, harness.clock.at)[0]!.id;
    let outreach: unknown = null;
    harness.model.during = kind => {
      // While the marked session is open: nothing reaches anyone else, not even with approval.
      if (kind === 'think' && harness.model.calls.length === 5) outreach = harness.service.authorize(scope, { domain: 'outreach', summary: '友人に送ります。', reachesOthers: true });
    };
    voice.state.others = true;
    const first = await session([
      { thought: '計画を読みます。', steps: [{ action: 'tool', name: 'ownerDocs.read', input: { documentId: owners.id, pursuitId: pursuit } }] },
      { thought: 'メモにします。', pursuits: [{ op: 'add', kind: 'question', title: '静かな宿のこと', why: '気になったからです。' }],
        steps: [{ action: 'tool', name: 'study.create', input: { kind: 'note', title: '宿のメモ', body: '静かな場所の話を書きたい。' } }] },
      { thought: '物語にします。', steps: [{ action: 'draft', idea: '湖のほとりの話' }] },
      { thought: 'フォルダにも。', steps: [{ action: 'tool', name: 'aetherFolder.create', input: { title: '宿の下調べ', body: '静かな宿の下調べ。' } }] },
      { thought: '話しかけます。', steps: [{ action: 'reach_out', reason: 'wonder' }] },
      { thought: '休みます。', steps: [rest] },
    ]);
    expect(harness.store.informed.sessionInformedAt(first)).not.toBeNull();
    expect(outreach).toMatchObject({ decision: 'forbidden', reason: 'owner_informed', domain: 'outreach' });
    // With someone else present she held her message.
    expect(voice.said).toEqual([]);
    const note = harness.store.study.list(scope).find(piece => piece.title === '宿のメモ')!;
    const story = harness.store.study.list(scope).find(piece => piece.kind === 'story')!;
    for (const id of [`shannon-study://${note.id}`, document('宿のメモ').id, `shannon-study://${story.id}`, document(story.title).id, document('宿の下調べ').id]) expect(isMarked(id), id).toBe(true);
    expect(isMarked(station.id)).toBe(false);
    const informedPursuit = harness.store.pursuits.list(scope, harness.clock.at).find(item => item.title === '静かな宿のこと')!;
    expect(harness.store.informed.informedPursuits(scope).has(informedPursuit.id)).toBe(true);

    // With anyone else present: not found, not listed, not read. Her other notes are, and the owner alone reads everything.
    const others = await call('aether.search', { query: '静か', scope: 'shannonFolder' }, 'others');
    expect(others.text).not.toContain(document('宿のメモ').id);
    expect(others.text).not.toContain(document('宿の下調べ').id);
    expect((await call('aether.search', { query: '宿題', scope: 'shannonFolder' }, 'others')).text).toContain(station.id);
    expect(await call('aether.read', { documentId: document('宿の下調べ').id }, 'others')).toMatchObject({ ok: false, failure: 'refused', text: expect.stringContaining('ライ氏の文書を読んだあとで書いたもの') });
    const listed = (await call('aetherFolder.list', {}, 'others')).text;
    expect(listed).toContain(station.id);
    expect(listed).not.toContain(document('宿の下調べ').id);
    expect(listed).not.toContain(document(story.title).id);
    expect((await call('aether.search', { query: '静か', scope: 'shannonFolder' }, 'owner_alone')).text).toContain(document('宿の下調べ').id);
    expect(await call('aether.read', { documentId: document('宿の下調べ').id }, 'owner_alone')).toMatchObject({ ok: true });
    expect((await call('aetherFolder.list', {}, 'owner_alone')).text).toContain(document('宿の下調べ').id);
    // Her study tools are the owner's alone to hear in any case.
    expect(await call('study.read', { id: note.id }, 'others')).toMatchObject({ ok: false, failure: 'not_offered' });
    // A turn with others present is given none of her pursuits, the marked one included; the owner alone is given it.
    const state = createInitialCompanionState(scope, harness.clock.at);
    const pursuits = harness.service.pursuitPrompt(scope);
    expect(pursuits).toContain('静かな宿のこと');
    expect(chatAudienceTurn('others')!.ownFocus('', pursuits, state, null as unknown as ConversationStore, scope)).not.toContain('静かな宿のこと');
    expect(chatAudienceTurn('owner')!.ownFocus('', pursuits, state, null as unknown as ConversationStore, scope)).toContain('静かな宿のこと');

    // A later session that reads a marked document is marked, and so is what it writes.
    voice.state.others = false;
    const second = await session([
      { thought: '読み返します。', steps: [{ action: 'tool', name: 'aether.read', input: { documentId: document('宿の下調べ').id } }] },
      { thought: '続きを。', steps: [{ action: 'tool', name: 'aetherFolder.create', input: { title: '二度目の下調べ', body: '続き。' } }] },
      { thought: '休みます。', steps: [rest] },
    ]);
    expect(harness.store.informed.sessionInformedAt(second)).not.toBeNull();
    expect(isMarked(document('二度目の下調べ').id)).toBe(true);
    // One that reads only what is not marked is not, and with someone else present she speaks up as before.
    voice.state.others = true;
    const third = await session([
      { thought: '駅のメモを読みます。', steps: [{ action: 'tool', name: 'aether.read', input: { documentId: station.id } }] },
      { thought: '書きます。', steps: [{ action: 'tool', name: 'aetherFolder.create', input: { title: '駅の続き', body: '音から。' } }, { action: 'reach_out', reason: 'wonder' }] },
      { thought: '休みます。', steps: [rest] },
    ]);
    expect(harness.store.informed.sessionInformedAt(third)).toBeNull();
    expect(isMarked(document('駅の続き').id)).toBe(false);
    expect(voice.said).toHaveLength(1);

    // Nothing of his document is in any file of Shannon's database; it was in front of her thinking, once.
    expect(harness.model.prompts('think').some(prompt => prompt.includes(SENTINEL))).toBe(true);
    harness.store.close();
    const files = readdirSync(directory);
    expect(files.some(name => name.endsWith('.sqlite'))).toBe(true);
    for (const name of files) expect(readFileSync(join(directory, name)).includes(Buffer.from(SENTINEL)), name).toBe(false);
  });

  it('marks a jot written in a marked session, and nothing in a session that is not marked', () => {
    const harness = loopHarness({ sessions: true });
    const cycle = harness.store.loop.startCycle(scope, '2026-10-02', 'activity', [], harness.clock.at);
    const jot = harness.store.study.create(scope, { kind: 'note', title: '話しかけたあとで', body: '返事がなくてもいい。', origin: 'reach_out' }, harness.clock.at);
    if (typeof jot === 'string') throw new Error(jot);
    const link = `shannon-study://${jot.id}`;
    noteProvenance(harness, cycle, { kind: 'jot' }, { outcome: 'done', summary: 'x' }, link, harness.clock.at);
    expect(harness.store.informed.marked(scope, link)).toBe(false);
    noteProvenance(harness, cycle, { kind: 'tool' }, { outcome: 'done', summary: 'x', documents: { informs: true } }, undefined, harness.clock.at);
    noteProvenance(harness, cycle, { kind: 'jot' }, { outcome: 'done', summary: 'x' }, link, harness.clock.at);
    expect(harness.store.informed.marked(scope, link)).toBe(true);
    // The mark is append-only.
    expect(() => (harness.store as unknown as { database: { exec(sql: string): void } }).database.exec('DELETE FROM owner_informed_documents')).toThrow(/OWNER_INFORMED_APPEND_ONLY/u);
  });
});

describe('a note written after reading a shared Notion page', () => {
  it('is marked, and its session holds her messages with others present and reaches nobody else, with the switch off too', async () => {
    const notion = { read: async () => ({ title: '登場人物', url: 'https://www.notion.so/p1', text: '白ウサギの話。時計を持って走っている。' }) };
    const { voice, harness, call, session, document, isMarked } = await marked(undefined, { notion });
    let outreach: unknown = null;
    harness.model.during = kind => { if (kind === 'think' && harness.model.calls.length === 3) outreach = harness.service.authorize(scope, { domain: 'outreach', summary: '友人に送ります。', reachesOthers: true }); };
    voice.state.others = true;
    const cycle = await session([
      { thought: 'Notionを読みます。', steps: [{ action: 'notion', query: 'ウサカテ' }, { action: 'note' }] },
      { thought: '話しかけます。', steps: [{ action: 'reach_out', reason: 'wonder' }] },
      { thought: '休みます。', steps: [rest] },
    ]);
    expect(harness.store.informed.sessionInformedAt(cycle)).not.toBeNull();
    const note = harness.store.study.list(scope).find(piece => piece.kind === 'note')!;
    expect(isMarked(`shannon-study://${note.id}`)).toBe(true);
    const written = document(note.title);
    expect(isMarked(written.id)).toBe(true);
    expect((await call('aether.search', { query: note.title.slice(0, 4), scope: 'shannonFolder' }, 'others')).text).not.toContain(written.id);
    expect((await call('aether.search', { query: note.title.slice(0, 4), scope: 'shannonFolder' }, 'owner_alone')).text).toContain(written.id);
    // The switch is off, and still (owner decision 2026-10-06): her message is held with someone else present, and outreach is refused.
    expect(harness.loopConfig.ownerDocuments).toBe(false);
    expect(voice.said).toEqual([]);
    expect(outreach).toMatchObject({ decision: 'forbidden', reason: 'owner_informed', domain: 'outreach' });
    // A message, a second call and a phone call share the one check; alone with him, and in a session that is not marked, she speaks.
    const open = harness.store.loop.startCycle(scope, '2026-10-02', 'activity', [], harness.clock.at);
    expect(heldForOthers(harness, open, harness.clock.at)).toBe(false);
    harness.store.informed.markSession(open.id, harness.clock.at);
    expect(heldForOthers({ ...harness, reachOuts: voice.reachOuts }, open, harness.clock.at)).toBe(true);
    voice.state.others = false;
    expect(heldForOthers({ ...harness, reachOuts: voice.reachOuts }, open, harness.clock.at)).toBe(false);
    voice.state.others = true;
    harness.store.loop.endCycle(open.id, 'test', harness.clock.at);
    const unmarked = await session([
      { thought: '話しかけます。', steps: [{ action: 'reach_out', reason: 'wonder' }] },
      { thought: '休みます。', steps: [rest] },
    ]);
    expect(harness.store.informed.sessionInformedAt(unmarked)).toBeNull();
    expect(voice.said).toHaveLength(1);
  });
});
