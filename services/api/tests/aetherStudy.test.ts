import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AetherAccessError, HttpAetherAccess, type AetherAccess, aetherIdempotencyKey, configuredAetherAccess, configuredAetherPorts } from '../src/aetherAccess.js';
import { SHANNON_AETHER_ACCESS_CAPABILITY, SHANNON_MINECRAFT_BODY_CAPABILITY, shannonCapabilityPrompt } from '@shannon/cognition';
import { withToolCapabilityLines } from '../src/shannonAetherTools.js';
import { FileAetherProposalStore } from '../src/aetherProposal.js';
import { configuredAutonomy } from '../src/autonomyBudget.js';
import { ShannonAutonomyService } from '../src/autonomyService.js';
import { SQLiteAutonomyStore } from '../src/autonomyStore.js';
import { createLocalApiKernel } from '../src/apiKernel.js';
import { dispatchStudyRequest } from '../src/apiStudyRoutes.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonChatModelResult, ShannonVoiceModelRequest } from '../src/chatModel.js';
import { asksForParallelCalls, toolInstructions } from '../src/chatModelTools.js';
import { runToolStep } from '../src/chatModelToolStep.js';
import { chatTurnRequestBody, offersTools } from '../src/chatModelTurn.js';
import { conversationTools, type ConversationToolServer } from '../src/shannonToolSession.js';
import { gatedAether } from '../src/shannonToolGate.js';
import { toolSessionMemory } from '../src/shannonToolTypes.js';
import type { ToolAudience, ToolSurface } from '../src/shannonTools.js';
import { AETHER_SIDE_CHANGE } from '../src/studyAetherLinks.js';
import { applyMigration, migrationPlan, migrationReport, readOnlyMigrationPlan } from '../src/studyMigration.js';
import type { StudyPiece } from '../src/studyStore.js';
import { TEXT_TURN_DEADLINE, TurnDeadline } from '../src/turnDeadline.js';
import { FakeAether, TOKEN } from './fakeAetherServer.js';
import { STORY_BODY, loopHarness, runUntilIdle } from './autonomyLoopHarness.js';
import { promptOf } from './modelPrompt.js';
import { prepareStep } from '../src/autonomyLoopSteps.js';

const scope = 'owner';
const STORY = `雨の日の図書館で、だれも借りない本が一冊だけ光っていた。${'ページをめくる音が、静かな部屋に少しずつ広がっていく。'.repeat(4)}`;
const servers: FakeAether[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.stop()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function harness(options: { aether?: boolean; proposals?: boolean } = {}) {
  const fake = new FakeAether();
  servers.push(fake);
  const access = options.aether === false ? null : await fake.access();
  const clock = { at: '2026-10-06T01:00:00.000Z' };
  const store = new SQLiteAutonomyStore(':memory:');
  const directory = mkdtempSync(join(tmpdir(), 'shannon-aether-'));
  directories.push(directory);
  const proposals = options.proposals ? new FileAetherProposalStore(directory, () => clock.at) : null;
  const service = new ShannonAutonomyService({ store, config: configuredAutonomy({}), now: () => clock.at, aether: { access, proposals } });
  const memory = toolSessionMemory('thread-1\nお願い');
  const call = (name: string, input: unknown, audience: ToolAudience = 'owner_alone', surface: ToolSurface = 'text') =>
    service.tools.call(name, JSON.stringify(input), { scopeKey: scope, surface, audience, memory });
  const api = createLocalApiKernel(() => clock.at, { autonomy: service });
  const get = (path: string) => api.dispatch({ method: 'GET', path, query: new URLSearchParams({ scopeKey: scope }) });
  const post = (path: string, body: Record<string, unknown>) => api.dispatch({ method: 'POST', path, body: { scopeKey: scope, ...body } });
  return { fake, access, clock, store, service, call, get, post, directory };
}

describe('the Aether client (syzygy.aether-shannon-access.v1)', () => {
  it('is off unless both variables are set, and never reads anything else of the environment', () => {
    expect(configuredAetherAccess({})).toBeNull();
    expect(configuredAetherAccess({ SHANNON_AETHER_API_URL: 'http://127.0.0.1:3007' })).toBeNull();
    expect(configuredAetherAccess({ SHANNON_AETHER_SHANNON_TOKEN: TOKEN })).toBeNull();
    expect(configuredAetherAccess({ SHANNON_AETHER_API_URL: 'ftp://example.org', SHANNON_AETHER_SHANNON_TOKEN: TOKEN })).toBeNull();
    // https, except to this machine.
    expect(configuredAetherAccess({ SHANNON_AETHER_API_URL: 'http://aether.example.org/aether', SHANNON_AETHER_SHANNON_TOKEN: TOKEN })).toBeNull();
    expect(configuredAetherAccess({ SHANNON_AETHER_API_URL: 'https://aether.example.org/aether', SHANNON_AETHER_SHANNON_TOKEN: TOKEN })).toBeInstanceOf(HttpAetherAccess);
    expect(configuredAetherAccess({ SHANNON_AETHER_API_URL: 'http://localhost:3007', SHANNON_AETHER_SHANNON_TOKEN: TOKEN })).toBeInstanceOf(HttpAetherAccess);
    expect(configuredAetherAccess({ SHANNON_AETHER_API_URL: 'http://127.0.0.1:3007', SHANNON_AETHER_SHANNON_TOKEN: TOKEN })).toBeInstanceOf(HttpAetherAccess);
  });

  it('sends the contract with every request, reads documents in parts, and maps the provider codes', async () => {
    const fake = new FakeAether();
    servers.push(fake);
    const access = await fake.access();
    const created = await access.create({ title: 'メモ', body: 'あ'.repeat(25_000), idempotencyKey: aetherIdempotencyKey('t', '1') });
    expect(fake.requests.at(-1)!.body).toMatchObject({ contract: 'syzygy.aether-shannon-access.v1', kind: 'create' });
    // A retry with the same key is the same write; the same key with another body is refused.
    expect(await access.create({ title: 'メモ', body: 'あ'.repeat(25_000), idempotencyKey: aetherIdempotencyKey('t', '1') })).toEqual(created);
    await expect(access.create({ title: 'メモ', body: 'い', idempotencyKey: aetherIdempotencyKey('t', '1') })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    const first = await access.read({ documentId: created.documentId });
    expect(first).toMatchObject({ bodyOffset: 0, bodyLength: 25_000, hasMore: true, inShannonFolder: true, inStudy: false });
    expect([...first.body]).toHaveLength(20_000);
    expect(await access.read({ documentId: created.documentId, offset: 20_000 })).toMatchObject({ hasMore: false, bodyOffset: 20_000 });
    // A stale base version and a document outside her folder.
    await expect(access.update({ documentId: created.documentId, baseVersion: 7, body: 'x', idempotencyKey: aetherIdempotencyKey('t', '2') })).rejects.toMatchObject({ code: 'STALE_VERSION' });
    const owners = fake.ownerDocument('ライ氏の仕様', '本文');
    await expect(access.update({ documentId: owners.id, baseVersion: 1, body: 'x', idempotencyKey: aetherIdempotencyKey('t', '3') })).rejects.toMatchObject({ code: 'OUTSIDE_SHANNON_FOLDER' });
    await expect(access.read({ documentId: 'doc_none' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // Nothing of the token or a request is in an error.
    const error = await access.read({ documentId: 'doc_none' }).then(() => new Error('read'), (caught: unknown) => caught as Error);
    expect(error.message).toBe('AETHER_NOT_FOUND');
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    await expect(new HttpAetherAccess(new URL(`${(await fake.start())}/`), 'wrong-token', 2_000).list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('fails closed on another contract and on a provider that does not answer in time', async () => {
    const fake = new FakeAether();
    servers.push(fake);
    const access = await fake.access(300);
    fake.contract = 'syzygy.aether-shannon-access.v2';
    await expect(access.list()).rejects.toMatchObject({ code: 'CONTRACT_MISMATCH' });
    await expect(access.search({ query: 'x' })).rejects.toMatchObject({ code: 'CONTRACT_MISMATCH' });
    fake.contract = null;
    fake.delay = 800;
    await expect(access.list()).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(new AetherAccessError('TIMEOUT').message).toBe('AETHER_TIMEOUT');
  });
});

describe('who may read what (owner decision 2026-10-06, enforced at the gate)', () => {
  it('reads the owner\'s documents only with him alone; with others present and in her own time only inside her folder', async () => {
    const { fake, call } = await harness();
    const owners = fake.ownerDocument('ライ氏の仕様メモ', '鍵となる言葉: 灯台。ライ氏だけの話。');
    const mine = fake.put({ title: 'ボクの灯台メモ', body: '灯台の光の数え方。', projectIds: ['project_shannon_folder'], tags: ['シャノン'], type: 'note' });

    const alone = await call('aether.search', { query: '灯台' });
    expect(alone.ok).toBe(true);
    expect(alone.text).toContain(owners.id);
    expect((await call('aether.read', { documentId: owners.id })).text).toContain('ライ氏だけの話');

    for (const [audience, surface] of [['others', 'text'], ['others', 'voice'], ['owner_alone', 'autonomy']] as const) {
      const all = await call('aether.search', { query: '灯台' }, audience, surface);
      expect(all).toMatchObject({ ok: false, failure: 'refused', refusal: { wouldWork: expect.stringContaining('shannonFolder') } });
      const folder = await call('aether.search', { query: '灯台', scope: 'shannonFolder' }, audience, surface);
      expect(folder.ok).toBe(true);
      expect(folder.text).toContain(mine.id);
      expect(folder.text).not.toContain(owners.id);
      const read = await call('aether.read', { documentId: owners.id }, audience, surface);
      expect(read).toMatchObject({ ok: false, failure: 'refused' });
      expect(read.text).not.toContain('ライ氏だけの話');
      expect((await call('aether.read', { documentId: mine.id }, audience, surface)).text).toContain('灯台の光の数え方');
    }
    // A search held to her folder sent the scope to Aether; a read outside it asked for one character only.
    expect(fake.requests.filter(request => request.path.endsWith('knowledge-search')).at(-1)!.body.scope).toBe('shannonFolder');
    expect(fake.requests.filter(request => request.body.documentId === owners.id && request.body.maxChars === 1).length).toBeGreaterThanOrEqual(3);
    // Writing stays the owner's alone to hear about.
    expect(await call('aetherFolder.create', { title: 't', body: 'b' }, 'others')).toMatchObject({ ok: false, failure: 'not_offered' });
  });

  it('offers a turn with others present her Aether reading tools only, and tells her what they are for', async () => {
    const { service } = await harness();
    const server: Partial<ConversationToolServer> = { audience: { othersKnown: () => true, noteOthers: () => undefined }, now: () => '2026-10-06T01:00:00.000Z' };
    const offered = conversationTools(service, scope, 'text', true, server, 'thread\n灯台のメモある？', new TurnDeadline(TEXT_TURN_DEADLINE));
    expect(offered.tools?.definitions.map(tool => tool.name)).toEqual(['aether.search', 'aether.read', 'aetherFolder.list']);
    expect(toolInstructions(offered.tools!, false)).toContain('シャノン用フォルダ（書斎を含む）の中を探して読む道具だけ');
    // Without Aether: nothing, as before, and the one withheld line.
    const plain = await harness({ aether: false });
    expect(conversationTools(plain.service, scope, 'text', true, server, 'thread\nx', new TurnDeadline(TEXT_TURN_DEADLINE))).toEqual({ toolsWithheld: true });
    expect(plain.service.tools.offered('text', 'owner_alone').some(tool => tool.name.startsWith('aether'))).toBe(false);
  });

  it('holds a turn with others present to her folder through the session, one call at a time and reads run together (ADR-0003 stage 4)', async () => {
    const { fake, service } = await harness({ proposals: true });
    const owners = fake.ownerDocument('ライ氏の仕様メモ', '鍵となる言葉: 灯台。ライ氏だけの話。');
    const mine = fake.put({ title: 'ボクの灯台メモ', body: '灯台の光の数え方。', projectIds: ['project_shannon_folder'], tags: ['シャノン'], type: 'note' });
    const now = () => '2026-10-06T01:00:00.000Z';
    const others = conversationTools(service, scope, 'text', true, { audience: { othersKnown: () => true, noteOthers: () => undefined }, now }, 'thread\n灯台のメモある？', new TurnDeadline(TEXT_TURN_DEADLINE)).tools!;
    const text = (output: string) => (JSON.parse(output) as { text: string }).text;
    // One call at a time: the session hands the runner the audience the turn has, so the gate holds it to her folder.
    expect(JSON.parse(await others.call('aether_search', JSON.stringify({ query: '灯台' })))).toMatchObject({ ok: false, failure: 'refused' });
    const refused = await others.call('aether_read', JSON.stringify({ documentId: owners.id }));
    expect(JSON.parse(refused)).toMatchObject({ ok: false, failure: 'refused' });
    expect(refused).not.toContain('ライ氏だけの話');
    // Reads of one response run together through `start`, each with its own gated client, the same way.
    const outputs = (await runToolStep([
      { callId: 'c1', name: 'aether_read', arguments: JSON.stringify({ documentId: owners.id }) },
      { callId: 'c2', name: 'aether_read', arguments: JSON.stringify({ documentId: mine.id }) },
      { callId: 'c3', name: 'aether_search', arguments: JSON.stringify({ query: '灯台', scope: 'shannonFolder' }) },
    ], others, { used: 0, toolsOff: false }, { parallel: true }) as { type: string; output?: string }[]).filter(item => item.type === 'function_call_output').map(item => item.output!);
    expect(JSON.parse(outputs[0]!)).toMatchObject({ ok: false, failure: 'refused' });
    expect(outputs[0]).not.toContain('ライ氏だけの話');
    expect(text(outputs[1]!)).toContain('灯台の光の数え方');
    expect(text(outputs[2]!)).toContain(mine.id);
    expect(text(outputs[2]!)).not.toContain(owners.id);
    // Only reads are offered with others present, so that request may ask for several calls; with the owner alone her
    // Aether writes are offered and count as writes, so it asks for one at a time.
    expect(asksForParallelCalls(others.definitions)).toBe(true);
    const alone = conversationTools(service, scope, 'text', true, { audience: { othersKnown: () => false, noteOthers: () => undefined }, now }, 'thread\n灯台のメモある？', new TurnDeadline(TEXT_TURN_DEADLINE)).tools!;
    expect(alone.definitions.filter(tool => tool.name.startsWith('aether')).map(tool => [tool.name, tool.effect])).toEqual([
      ['aether.search', 'read'], ['aether.read', 'read'], ['aetherFolder.list', 'read'],
      ['aetherFolder.create', 'write'], ['aetherFolder.update', 'write'], ['aetherFolder.delete', 'write'], ['aether.propose', 'write'],
    ]);
    expect(asksForParallelCalls(alone.definitions)).toBe(false);
  });
});

describe('a server with only part of Aether configured', () => {
  it('offers, says and describes exactly what main does with the inbox and the token set and the address unset', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-aether-inbox-'));
    directories.push(directory);
    const now = () => '2026-10-06T01:00:00.000Z';
    const partial = configuredAetherPorts({ SHANNON_AETHER_PROPOSAL_DIR: directory, SHANNON_AETHER_SHANNON_TOKEN: TOKEN }, now);
    expect(partial.access).toBeNull();
    expect(partial.proposals?.configured).toBe(true);
    const withInbox = new ShannonAutonomyService({ store: new SQLiteAutonomyStore(':memory:'), config: configuredAutonomy({}), now, aether: partial });
    const plain = new ShannonAutonomyService({ store: new SQLiteAutonomyStore(':memory:'), config: configuredAutonomy({}), now });
    for (const surface of ['text', 'voice', 'autonomy'] as const) {
      for (const audience of ['owner_alone', 'others'] as const) expect(withInbox.tools.offered(surface, audience, scope)).toEqual(plain.tools.offered(surface, audience, scope));
    }
    const server: Partial<ConversationToolServer> = { audience: { othersKnown: () => false, noteOthers: () => undefined }, now };
    const session = (service: ShannonAutonomyService) => conversationTools(service, scope, 'text', true, server, 'thread\nメモを作って', new TurnDeadline(TEXT_TURN_DEADLINE)).tools!;
    expect(session(withInbox).definitions).toEqual(session(plain).definitions);
    expect(toolInstructions(session(withInbox), false)).toBe(toolInstructions(session(plain), false));
    const prompt = shannonCapabilityPrompt('owner');
    expect(withToolCapabilityLines({ systemPrompt: prompt, tools: session(withInbox) }).systemPrompt).toBe(prompt);
    expect(conversationTools(withInbox, scope, 'text', true, { ...server, audience: { othersKnown: () => true, noteOthers: () => undefined } }, 'thread\nx', new TurnDeadline(TEXT_TURN_DEADLINE))).toEqual({ toolsWithheld: true });
  });
});

describe('a call of an Aether tool without the Aether client', () => {
  it('is refused and recorded exactly like a name that does not exist, as before Aether', async () => {
    const { service } = await harness({ aether: false });
    const entries = () => service.activityDays(scope, 30).flatMap(day => day.entries).map(entry => entry.summary);
    const memory = toolSessionMemory();
    const call = (name: string) => service.tools.call(name, '{}', { scopeKey: scope, surface: 'text', audience: 'owner_alone', memory });
    for (const name of ['aether.search', 'aetherFolder.create', 'aether.propose']) expect(await call(name)).toEqual(await call('no.such'));
    expect(new Set(entries())).toEqual(new Set(['会話の中で道具「不明」を使おうとしましたが、使えませんでした。']));
    const server: Partial<ConversationToolServer> = { audience: { othersKnown: () => false, noteOthers: () => undefined }, now: () => '2026-10-06T01:00:00.000Z' };
    const session = conversationTools(service, scope, 'text', true, server, 'thread\nメモを作って', new TurnDeadline(TEXT_TURN_DEADLINE)).tools!;
    expect(await session.call('aether_search', '{}')).toBe(await session.call('no_such_tool', '{}'));
    expect(new Set(entries())).toEqual(new Set(['会話の中で道具「不明」を使おうとしましたが、使えませんでした。']));
  });
});

describe('her folder in Aether and proposals v2', () => {
  it('writes her own documents, refuses a stale version and the owner\'s documents, and proposes instead', async () => {
    const { fake, call, directory } = await harness({ proposals: true });
    const created = await call('aetherFolder.create', { title: '調べたこと', body: '灯台は夜に光る。' });
    expect(created.ok).toBe(true);
    const id = /id: (doc_\d+)/u.exec(created.text)![1]!;
    expect(fake.documents.get(id)).toMatchObject({ projectIds: ['project_shannon_folder'], tags: ['シャノン'] });
    expect(await call('aetherFolder.update', { documentId: id, baseVersion: 1, body: '灯台は夜に光る。昼は眠る。' })).toMatchObject({ ok: true });
    expect(await call('aetherFolder.update', { documentId: id, baseVersion: 1, body: '古い版から' })).toMatchObject({ ok: false, failure: 'conflict', refusal: { wouldWork: expect.stringContaining('読み直') } });
    const owners = fake.ownerDocument('ライ氏の仕様', '古い本文');
    expect(await call('aetherFolder.update', { documentId: owners.id, baseVersion: 1, body: '新しい本文' })).toMatchObject({ ok: false, failure: 'refused', refusal: { wouldWork: expect.stringContaining('aether.propose') } });
    expect(fake.documents.get(owners.id)!.body).toBe('古い本文');

    expect(await call('aether.propose', { operation: 'update', documentId: owners.id, content: '新しい本文の全文', reason: '古くなったため' })).toMatchObject({ ok: true });
    expect(await call('aether.propose', { operation: 'delete', documentId: owners.id, content: '重複しているので消す案' })).toMatchObject({ ok: true });
    expect(await call('aether.propose', { operation: 'update', content: '対象なし' })).toMatchObject({ ok: false, failure: 'invalid_input' });
    const files = readdirSync(directory).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(directory, name), 'utf8')) as Record<string, unknown>);
    expect(files.map(file => file.operation).sort()).toEqual(['delete', 'update']);
    expect(files.every(file => file.targetNoteId === owners.id && file.expectedUpdatedAt === owners.updatedAt)).toBe(true);
  });
});

describe('her study in Aether', () => {
  it('writes a story to the 書斎 and a note to her folder, and serves both to the apps from Aether', async () => {
    const { fake, call, store, get, clock } = await harness();
    const story = await call('study.create', { kind: 'story', title: '灯台の話', body: STORY });
    const note = await call('study.create', { kind: 'note', title: '光のメモ', body: '光は数えられる。' });
    expect(story.ok && note.ok).toBe(true);
    const [storyDocument, noteDocument] = fake.inFolder();
    expect(storyDocument).toMatchObject({ title: '灯台の話', tags: ['シャノン', '書斎'], type: 'story' });
    expect(noteDocument).toMatchObject({ title: '光のメモ', tags: ['シャノン'] });
    const storyId = /id: ([0-9a-f-]{36})/u.exec(story.text)![1]!;
    expect(store.study.aether.current(scope, storyId)).toMatchObject({ documentId: storyDocument!.id, aetherVersion: 1, version: 1 });

    // The apps read through Shannon: the shape is what it was, with additive fields; a story not shown stays without title or text.
    const overview = await get('/v1/autonomy/study');
    expect(overview.status).toBe(200);
    const body = overview.body as { pieces: Array<Record<string, unknown>>; source: unknown };
    expect(body.source).toEqual({ kind: 'aether', reached: true });
    const hidden = body.pieces.find(piece => piece.kind === 'story')!;
    expect(hidden).toMatchObject({ hidden: true, title: null, excerpt: null });
    expect(hidden).not.toHaveProperty('aetherDocumentId');
    expect(body.pieces.find(piece => piece.kind === 'note')).toMatchObject({ title: '光のメモ', aetherDocumentId: noteDocument!.id, aetherVersion: 1 });

    // The owner edits the story in Aether: Shannon adopts it as her next version; he keeps reading the version she showed.
    store.study.markReady(scope, storyId, clock.at);
    store.study.markShown(scope, storyId, clock.at);
    fake.ownerEdit(storyDocument!.id, { body: `${STORY}ライ氏が一行足した。` });
    const detail = (await get(`/v1/autonomy/study/pieces/${storyDocument!.id}`)).body as Record<string, unknown>;
    expect(detail).toMatchObject({ id: storyId, title: '灯台の話', body: STORY, version: 1, revising: true, aetherDocumentId: storyDocument!.id, aetherVersion: 1 });
    expect(store.study.versions(scope, storyId).at(-1)).toMatchObject({ version: 2, changeNote: AETHER_SIDE_CHANGE, body: `${STORY}ライ氏が一行足した。` });
    expect(store.study.aether.current(scope, storyId)).toMatchObject({ version: 2, aetherVersion: 2 });
  });

  it('revises from the version she read, brings in what changed when that is stale, and deletes into Recently Deleted', async () => {
    const { fake, call, store, service } = await harness();
    const created = await call('study.create', { kind: 'story', title: '灯台の話', body: STORY });
    const id = /id: ([0-9a-f-]{36})/u.exec(created.text)![1]!;
    const document = fake.inFolder()[0]!;
    expect(await call('study.update', { id, body: `${STORY}続き。`, changeNote: '続きを足しました。' })).toMatchObject({ ok: true });
    expect(fake.documents.get(document.id)).toMatchObject({ revision: 2, body: `${STORY}続き。` });

    // Stale: the owner changed it after Shannon last saw it, and the write is refused; the newer text is in her study now.
    fake.ownerEdit(document.id, { body: `${STORY}ライ氏の直し。` });
    const piece = store.study.get(scope, id) as StudyPiece;
    await expect(service.studyAether!.update(scope, piece, { body: 'ボクの直し' }, aetherIdempotencyKey('stale'))).rejects.toMatchObject({ code: 'STALE_VERSION' });
    expect(store.study.get(scope, id)).toMatchObject({ body: `${STORY}ライ氏の直し。`, version: 3 });
    // Through her tool the sync comes first, so she writes on top of his change.
    expect(await call('study.update', { id, mode: 'append', body: 'ボクの続き。', changeNote: '足しました。' })).toMatchObject({ ok: true });
    expect(fake.documents.get(document.id)!.body).toBe(`${STORY}ライ氏の直し。\n\nボクの続き。`);

    expect(await call('study.delete', { id })).toMatchObject({ ok: true, text: expect.stringContaining('最近削除した項目') });
    expect(fake.documents.get(document.id)!.status).toBe('deleted');
    expect(store.study.find(scope, id, true)!.deletedAt).toBeDefined();
    expect(await call('study.restore', { id })).toMatchObject({ ok: false, failure: 'refused' });
    // The owner restores it in Aether: her study takes it back out at the next call.
    fake.ownerEdit(document.id, { status: 'growing' });
    expect((await call('study.list', {})).text).toContain(id);
    expect(store.study.get(scope, id)).not.toBeNull();
  });

  it('treats a document the owner moved out of her folder as gone: nothing of it is adopted, and the piece stays in her trash', async () => {
    const { fake, call, store, get, clock } = await harness();
    const created = await call('study.create', { kind: 'story', title: '灯台の話', body: STORY });
    const id = /id: ([0-9a-f-]{36})/u.exec(created.text)![1]!;
    const document = fake.inFolder()[0]!;
    store.study.markReady(scope, id, clock.at);
    // The owner moves it into one of his projects and rewrites it there: Aether answers 200 with inShannonFolder false.
    fake.ownerEdit(document.id, { projectIds: ['project_owner'], body: 'ライ氏の仕事の本文。' });
    for (const path of [`/v1/autonomy/study/pieces/${document.id}`, `/v1/autonomy/study/pieces/${id}`]) {
      expect((await get(path)).status).toBe(404);
    }
    expect(store.study.find(scope, id, true)!.deletedAt).toBeDefined();
    expect(store.study.versions(scope, id).map(version => version.body)).toEqual([STORY]);
    // Her tools and the overview do not bring it back either, and restoring says who can.
    expect((await call('study.list', {})).text).not.toContain(id);
    expect(((await get('/v1/autonomy/study')).body as { pieces: unknown[] }).pieces).toEqual([]);
    expect(await call('study.restore', { id })).toMatchObject({ ok: false, failure: 'refused', text: expect.stringContaining('フォルダの外') });
    expect(store.study.find(scope, id, true)!.deletedAt).toBeDefined();
    expect(JSON.stringify(store.study.versions(scope, id))).not.toContain('ライ氏の仕事');
    // Moved back into her folder: it comes back out of her trash at the next read.
    fake.ownerEdit(document.id, { projectIds: ['project_shannon_folder'] });
    expect((await get(`/v1/autonomy/study/pieces/${id}`)).status).toBe(200);
  });

  it('stops writing to a document the owner moved out of her folder: the piece goes to her trash and nothing is adopted', async () => {
    const { fake, call, store, service } = await harness();
    const first = /id: ([0-9a-f-]{36})/u.exec((await call('study.create', { kind: 'story', title: '一つめ', body: STORY })).text)![1]!;
    const second = /id: ([0-9a-f-]{36})/u.exec((await call('study.create', { kind: 'story', title: '二つめ', body: STORY })).text)![1]!;
    const [one, two] = fake.inFolder();
    fake.ownerEdit(one!.id, { projectIds: ['project_owner'] });
    fake.ownerEdit(two!.id, { projectIds: ['project_owner'] });
    await expect(service.studyAether!.update(scope, store.study.get(scope, first)!, { body: 'ボクの直し' }, aetherIdempotencyKey('outside-1'))).rejects.toMatchObject({ code: 'OUTSIDE_SHANNON_FOLDER' });
    expect(store.study.find(scope, first, true)!.deletedAt).toBeDefined();
    expect(store.study.versions(scope, first)).toHaveLength(1);
    // A delete of hers is done in Shannon, and Aether (his now) is left as it is.
    expect(await service.studyAether!.remove(scope, store.study.get(scope, second)!, aetherIdempotencyKey('outside-2'))).toMatchObject({ documentId: two!.id });
    expect(fake.documents.get(two!.id)!.status).toBe('growing');
  });

  it('links a write of hers whose local half was lost as hers: her kind, her change note, within the open-story limit', async () => {
    const { fake, call, store, service, clock } = await harness();
    const aether = service.studyAether!;
    // A note Aether took, and the process stopped before Shannon's commit.
    await aether.create(scope, { kind: 'note', title: '光のメモ', body: '光は数えられる。', changeNote: '読んだあとのメモ。' }, aetherIdempotencyKey('lost-note'));
    // A revision of a story Aether took, also without its commit.
    const created = await call('study.create', { kind: 'story', title: '灯台の話', body: STORY });
    const storyId = /id: ([0-9a-f-]{36})/u.exec(created.text)![1]!;
    await aether.update(scope, store.study.get(scope, storyId)!, { body: `${STORY}続き。`, changeNote: 'ボクが続きを足しました。' }, aetherIdempotencyKey('lost-revise'));
    // Her open stories are at their limit when a lost story draft is found.
    for (let index = 0; index < 11; index += 1) store.study.create(scope, { kind: 'story', title: `下書き${index}`, body: STORY }, clock.at);
    await aether.create(scope, { kind: 'story', title: '迷子の下書き', body: STORY, changeNote: '最初の稿です。' }, aetherIdempotencyKey('lost-story'));

    // While they are fresh, a sync leaves them to their own commit; once that is clearly lost, it takes them in.
    await call('study.list', {});
    expect(store.study.list(scope).some(piece => piece.title === '光のメモ')).toBe(false);
    expect(store.study.versions(scope, storyId)).toHaveLength(1);
    clock.at = '2026-10-06T01:05:00.000Z';
    await call('study.list', {});
    const note = store.study.list(scope).find(piece => piece.title === '光のメモ')!;
    expect(note).toMatchObject({ kind: 'note', status: 'ready', readableVersion: 1 });
    expect(store.study.versions(scope, note.id)[0]!.changeNote).toBe('読んだあとのメモ。');
    expect(store.study.versions(scope, storyId).at(-1)).toMatchObject({ version: 2, changeNote: 'ボクが続きを足しました。', body: `${STORY}続き。` });
    const lost = store.study.list(scope).find(piece => piece.title === '迷子の下書き')!;
    expect(lost).toMatchObject({ kind: 'story', status: 'put_away', putAwayBy: 'shannon' });
    expect(store.study.list(scope).filter(piece => piece.kind === 'story' && (piece.status === 'draft' || piece.status === 'ready'))).toHaveLength(12);
    expect(JSON.stringify(store.study.list(scope).flatMap(piece => store.study.versions(scope, piece.id)))).not.toContain(AETHER_SIDE_CHANGE);
    // Each was linked once, and nothing is pending any more.
    expect(fake.inFolder()).toHaveLength(3);
    for (const document of fake.inFolder()) expect(store.study.aether.pendingCreate(scope, document.id)).toBeNull();
  });

  it('never links a second piece or a second version when a sync and her own commit race', async () => {
    const { fake, store, service, clock } = await harness();
    const aether = service.studyAether!;
    // Her create was taken by Aether and is committing: a sync now leaves it alone, and her commit links it once.
    const written = await aether.create(scope, { kind: 'note', title: '光のメモ', body: '光は数えられる。' }, aetherIdempotencyKey('race-1'));
    await aether.sync(scope);
    expect(store.study.list(scope)).toEqual([]);
    const note = store.transaction(() => {
      const created = store.study.create(scope, { kind: 'note', title: '光のメモ', body: '光は数えられる。' }, clock.at) as StudyPiece;
      aether.commit(scope, created, written);
      return created;
    });
    expect(store.study.aether.pieceFor(scope, written.documentId)).toBe(note.id);
    // A second piece for the same document is refused, and its transaction leaves nothing.
    expect(() => store.transaction(() => {
      const twin = store.study.create(scope, { kind: 'note', title: '光のメモ', body: '光は数えられる。' }, clock.at) as StudyPiece;
      aether.commit(scope, twin, written);
    })).toThrow('STUDY_AETHER_LINKED');
    expect(store.study.list(scope)).toHaveLength(1);
    // Her update was taken and a sync ran before its commit: one new version, not two.
    const updated = (await aether.update(scope, note, { body: '光は数えられる。夜も。', changeNote: '足しました。' }, aetherIdempotencyKey('race-2')))!;
    await aether.sync(scope);
    expect(store.study.versions(scope, note.id)).toHaveLength(1);
    store.transaction(() => aether.commit(scope, store.study.revise(scope, note.id, { body: '光は数えられる。夜も。', changeNote: '足しました。' }, clock.at) as StudyPiece, updated));
    expect(store.study.versions(scope, note.id).map(version => version.changeNote)).toEqual(['最初の稿です。', '足しました。']);
    // Had the sync taken it in first (once it looked lost), her late commit is refused rather than doubled.
    const again = (await aether.update(scope, store.study.get(scope, note.id)!, { body: 'もう一度。', changeNote: 'また直しました。' }, aetherIdempotencyKey('race-3')))!;
    clock.at = '2026-10-06T01:05:00.000Z';
    await aether.sync(scope);
    expect(() => store.transaction(() => aether.commit(scope, store.study.revise(scope, note.id, { body: 'もう一度。', changeNote: 'また直しました。' }, clock.at) as StudyPiece, again))).toThrow('STUDY_AETHER_LINKED');
    expect(store.study.versions(scope, note.id).map(version => version.changeNote)).toEqual(['最初の稿です。', '足しました。', 'また直しました。']);
    expect(fake.inFolder()).toHaveLength(1);
  });

  it('takes in her own change made with aetherFolder.update as hers, and never adopts a document cut short', async () => {
    const { fake, call, store, service } = await harness();
    const id = /id: ([0-9a-f-]{36})/u.exec((await call('study.create', { kind: 'story', title: '灯台の話', body: STORY })).text)![1]!;
    const document = fake.inFolder()[0]!;
    expect(await call('aetherFolder.update', { documentId: document.id, baseVersion: 1, body: `${STORY}フォルダの道具で足した。` })).toMatchObject({ ok: true });
    expect(store.study.versions(scope, id).at(-1)).toMatchObject({ version: 2, changeNote: 'シャノン用フォルダの道具で書き換えました。', body: `${STORY}フォルダの道具で足した。` });
    // Longer than Shannon reads whole: neither a new version of a piece nor a new piece is taken in cut short.
    fake.ownerEdit(document.id, { body: 'あ'.repeat(120_000) });
    const long = fake.put({ title: '長い話', body: 'い'.repeat(120_000), projectIds: ['project_shannon_folder'], tags: ['シャノン', '書斎'], type: 'story' });
    const counts = await service.studyAether!.sync(scope);
    expect(counts.skipped?.map(item => item.documentId).sort()).toEqual([document.id, long.id].sort());
    expect(store.study.versions(scope, id)).toHaveLength(2);
    expect(store.study.aether.pieceFor(scope, long.id)).toBeNull();
    expect(store.study.aether.tooLongVersion(scope, long.id)).toBe(1);
    // The unknown long story is shortened in Aether: the next sync adopts it whole and lifts its note.
    fake.ownerEdit(long.id, { body: `${STORY}短い長い話。` });
    await service.studyAether!.sync(scope);
    expect(store.study.aether.tooLongVersion(scope, long.id)).toBeNull();
    const adoptedLong = store.study.aether.pieceFor(scope, long.id)!;
    expect(store.study.get(scope, adoptedLong)!.body).toBe(`${STORY}短い長い話。`);
    // It is noted for every process, her write is refused and she is told why, and the longer document is never overwritten.
    expect(store.study.aether.tooLongPiece(scope, id)).toBe(true);
    const refused = await call('study.update', { id, body: '短い本文。', changeNote: '直しました。' });
    expect(refused).toMatchObject({ ok: false, failure: 'limit', text: expect.stringContaining('長すぎて') });
    expect([...fake.documents.get(document.id)!.body]).toHaveLength(120_000);
    // Her own folder-tool write that turns out too long leaves nothing pending; the document stays noted as too long.
    await expect(service.studyAether!.adoptOwnWrite(scope, { documentId: document.id, version: fake.documents.get(document.id)!.revision }, 'シャノン用フォルダの道具で書き換えました。'))
      .rejects.toMatchObject({ code: 'TOO_LONG' });
    expect(store.study.aether.pending(scope, document.id, fake.documents.get(document.id)!.revision)).toBeNull();
    expect(store.study.aether.tooLongPiece(scope, id)).toBe(true);
    // She shortens it herself with her folder tool: it reads whole again, is taken in as hers, and the note is gone at once.
    expect(await call('aetherFolder.update', { documentId: document.id, baseVersion: fake.documents.get(document.id)!.revision, body: `${STORY}ボクが短くした。` })).toMatchObject({ ok: true });
    expect(store.study.aether.tooLongPiece(scope, id)).toBe(false);
    expect(store.study.get(scope, id)).toMatchObject({ body: `${STORY}ボクが短くした。` });
    expect(store.study.versions(scope, id).at(-1)!.changeNote).toBe('シャノン用フォルダの道具で書き換えました。');
    // Too long again, then shortened in Aether by the owner: the next sync reads it whole, takes it in, and clears the note.
    fake.ownerEdit(document.id, { body: 'う'.repeat(120_000) });
    await call('study.list', {});
    expect(store.study.aether.tooLongPiece(scope, id)).toBe(true);
    fake.ownerEdit(document.id, { body: `${STORY}短くした。` });
    await call('study.list', {});
    expect(store.study.aether.tooLongPiece(scope, id)).toBe(false);
    expect(store.study.get(scope, id)!.body).toBe(`${STORY}短くした。`);
  });

  it('holds a study search with others present to hits placed in her study inside her folder', async () => {
    const hit = (documentId: string, inShannonFolder?: boolean, inStudy?: boolean) => ({
      documentId, version: 1, sectionId: 's0', headingPath: ['x'], excerpt: 'x', updatedAt: '2026-10-06T01:00:00.000Z', href: `aether://documents/${documentId}`,
      ...(inShannonFolder === undefined ? {} : { inShannonFolder }), ...(inStudy === undefined ? {} : { inStudy }),
    });
    const access = { search: async () => [hit('both', true, true), hit('study-only', false, true), hit('folder-only', true, false), hit('neither')] } as unknown as AetherAccess;
    const others = gatedAether(access, { surface: 'text', audience: 'others' });
    expect((await others.search({ query: 'x', scope: 'study' })).map(item => item.documentId)).toEqual(['both']);
    expect((await others.search({ query: 'x', scope: 'shannonFolder' })).map(item => item.documentId)).toEqual(['both', 'folder-only']);
  });

  it('runs one sync per scope at a time and adopts a version once, however many callers race', async () => {
    const { fake, call, store, service } = await harness();
    const created = await call('study.create', { kind: 'story', title: '灯台の話', body: STORY });
    const id = /id: ([0-9a-f-]{36})/u.exec(created.text)![1]!;
    const document = fake.inFolder()[0]!;
    const lists = () => fake.requests.filter(request => request.body.kind === 'list').length;
    fake.ownerEdit(document.id, { body: `${STORY}一。` });
    const before = lists();
    fake.delay = 50;
    await Promise.all([service.studyAether!.sync(scope), service.studyAether!.sync(scope), service.studyAether!.sync(scope)]);
    expect(lists() - before).toBe(1);
    // A sync asked for right after one finished is a new run, not the finished one handed back.
    await service.studyAether!.sync(scope);
    fake.ownerEdit(document.id, { body: `${STORY}一と半。` });
    expect((await service.studyAether!.sync(scope)).changed).toBe(1);
    fake.ownerEdit(document.id, { body: `${STORY}二。` });
    await Promise.all([service.studyAether!.refresh(scope, id), service.studyAether!.refresh(scope, id), service.studyAether!.sync(scope)]);
    fake.delay = 0;
    expect(store.study.versions(scope, id).map(version => version.body)).toEqual([STORY, `${STORY}一。`, `${STORY}一と半。`, `${STORY}二。`]);
    expect(store.study.aether.current(scope, id)).toMatchObject({ version: 4, aetherVersion: 4 });
  });

  it('leaves no unhandled rejection when the only caller of a failing sync stopped waiting at once', async () => {
    const { fake, service } = await harness();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      await fake.stop();
      const aborted = AbortSignal.abort();
      await expect(service.studyAether!.sync(scope, aborted)).rejects.toMatchObject({ code: 'TIMEOUT' });
      // The shared run fails afterwards (Aether is gone), with nobody waiting for it.
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(unhandled).toEqual([]);
      // And a later caller starts a new run, which fails as such.
      await expect(service.studyAether!.sync(scope)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('lets app reads share a sync that just finished, while her tools still sync first', async () => {
    const { fake, call, get } = await harness();
    await call('study.create', { kind: 'note', title: '光のメモ', body: '光は数えられる。' });
    const lists = () => fake.requests.filter(request => request.body.kind === 'list').length;
    const before = lists();
    for (let index = 0; index < 3; index += 1) expect(((await get('/v1/autonomy/study')).body as { source: unknown }).source).toEqual({ kind: 'aether', reached: true });
    // The tool's sync a moment ago serves all three.
    expect(lists() - before).toBe(0);
    await call('study.list', {});
    expect(lists() - before).toBe(1);
    // Aether away: the read answers from Shannon's copy and says so.
    await fake.stop();
    await new Promise(resolve => setTimeout(resolve, 2_100));
    expect(((await get('/v1/autonomy/study')).body as { source: unknown; pieces: unknown[] })).toMatchObject({ source: { kind: 'aether', reached: false }, pieces: [expect.objectContaining({ title: '光のメモ' })] });
  });

  it('keeps the owner\'s reaction keyed by the Aether document and version he read', async () => {
    const { fake, call, store, post, clock } = await harness();
    const created = await call('study.create', { kind: 'story', title: '灯台の話', body: STORY });
    const id = /id: ([0-9a-f-]{36})/u.exec(created.text)![1]!;
    const document = fake.inFolder()[0]!;
    store.study.markReady(scope, id, clock.at);
    const reacted = await post(`/v1/autonomy/study/pieces/${document.id}/reaction`, { reaction: 'like', comment: '灯台がいい。' });
    expect(reacted.status).toBe(200);
    expect((reacted.body as { feedback: unknown[] }).feedback).toEqual([expect.objectContaining({ reaction: 'like', version: 1, aetherDocumentId: document.id, aetherVersion: 1 })]);
    expect(store.study.feedback(scope, id)[0]).toMatchObject({ aetherDocumentId: document.id, aetherVersion: 1 });
  });

  it('keeps every scope but the owner\'s on the SQLite study', async () => {
    const { fake, service, store } = await harness();
    const other = 'friend-scope';
    const memory = toolSessionMemory();
    const created = await service.tools.call('study.create', JSON.stringify({ kind: 'story', title: '友だちの話', body: STORY }), { scopeKey: other, surface: 'text', audience: 'owner_alone', memory });
    expect(created.ok).toBe(true);
    const id = /id: ([0-9a-f-]{36})/u.exec(created.text)![1]!;
    expect(fake.requests).toEqual([]);
    expect(store.study.aether.current(other, id)).toBeNull();
    expect(service.tools.offered('text', 'owner_alone', other).find(tool => tool.name === 'study.list')!.description).toContain('正本はシャノンのデータベース');
    // Nor any Aether tool, on any surface, offered or called; the owner's scope has them.
    for (const surface of ['text', 'voice', 'autonomy'] as const) {
      for (const audience of ['owner_alone', 'others'] as const) expect(service.tools.offered(surface, audience, other).some(tool => tool.name.startsWith('aether'))).toBe(false);
    }
    expect(service.tools.offered('text', 'owner_alone', scope).some(tool => tool.name === 'aether.search')).toBe(true);
    expect(await service.tools.call('aether.search', JSON.stringify({ query: '灯台' }), { scopeKey: other, surface: 'text', audience: 'owner_alone', memory })).toMatchObject({ ok: false, failure: 'not_offered' });
    expect(conversationTools(service, other, 'text', true, { audience: { othersKnown: () => true, noteOthers: () => undefined }, now: () => '2026-10-06T01:00:00.000Z' }, 'thread\nx', new TurnDeadline(TEXT_TURN_DEADLINE))).toEqual({ toolsWithheld: true });
    await service.studyAether!.sync(other);
    expect(fake.requests).toEqual([]);
    const response = dispatchStudyRequest({ method: 'GET', path: '/v1/autonomy/study', query: new URLSearchParams({ scopeKey: other }) }, service.study);
    expect(response).not.toBeInstanceOf(Promise);
    expect((response as { body: object }).body).not.toHaveProperty('source');
  });

  it('falls back to the SQLite study, unchanged, while Aether is not configured', async () => {
    const { call, store, service } = await harness({ aether: false });
    const created = await call('study.create', { kind: 'story', title: '灯台の話', body: STORY });
    const id = /id: ([0-9a-f-]{36})/u.exec(created.text)![1]!;
    expect(store.study.get(scope, id)).toMatchObject({ title: '灯台の話' });
    expect(store.study.aether.current(scope, id)).toBeNull();
    // The route answers at once, from Shannon's study, without the fields of Aether.
    const response = dispatchStudyRequest({ method: 'GET', path: '/v1/autonomy/study', query: new URLSearchParams({ scopeKey: scope }) }, service.study);
    expect(response).not.toBeInstanceOf(Promise);
    expect((response as { body: object }).body).not.toHaveProperty('source');
    expect(((response as { body: { pieces: object[] } }).body.pieces[0])).not.toHaveProperty('aetherDocumentId');
  });
});

describe('her own time with Aether', () => {
  it('drafts into the 書斎 first, never offers the folder copy, and records nothing it could not write', async () => {
    const fake = new FakeAether();
    servers.push(fake);
    const access = await fake.access();
    const { loop, model, store, entries } = loopHarness({ aether: access, environment: { SHANNON_AUTONOMY_HOST_FOLDERS_JSON: '{"mac":{"deviceId":"0123456789abcdef"}}' } });
    model.plans = [{ thought: '書きます。', steps: [{ action: 'draft', idea: '傘の話' }, { action: 'copy' }] }];
    await runUntilIdle(loop);
    expect(model.prompts('think')[0]).not.toContain('copy（');
    const story = store.study.list(scope).find(piece => piece.kind === 'story')!;
    expect(fake.inFolder()).toEqual([expect.objectContaining({ tags: ['シャノン', '書斎'], body: STORY_BODY })]);
    expect(store.study.aether.current(scope, story.id)).toMatchObject({ documentId: fake.inFolder()[0]!.id });
    expect(entries().some(entry => entry.tool === 'folder.copy')).toBe(false);

    // Aether away: the draft is not kept in Shannon either, and the step says why in a closed code.
    const away = new FakeAether();
    servers.push(away);
    away.delay = 2_000;
    const slow = loopHarness({ aether: await away.access(200) });
    slow.model.plans = [{ thought: '書きます。', steps: [{ action: 'draft', idea: '傘の話' }] }];
    await runUntilIdle(slow.loop);
    expect(slow.store.study.list(scope)).toEqual([]);
    expect(slow.entries().find(entry => entry.tool === 'study.draft')).toMatchObject({ outcome: 'failed', reasonCode: expect.stringMatching(/^aether_/u) });
  });
});

describe('her own time and a document too long to read whole', () => {
  it('plans no paid revision of such a story', async () => {
    const fake = new FakeAether();
    servers.push(fake);
    const { store, service, config, loopConfig, model, reader, showing, clock } = loopHarness({ aether: await fake.access() });
    const piece = store.study.create(scope, { kind: 'story', title: '長い話', body: STORY_BODY }, clock.at) as StudyPiece;
    store.study.aether.link(scope, piece.id, 1, 'doc_long', 1, clock.at);
    const cycle = store.loop.startCycle(scope, '2026-10-02', 'activity', [], clock.at);
    expect(prepareStep({ store, service, config, loop: loopConfig, model, reader, showing }, cycle, { kind: 'revise', pieceId: piece.id, intent: '直す' }, clock.at)).not.toBeNull();
    store.study.aether.noteTooLong(scope, 'doc_long', 2, piece.id, clock.at);
    expect(prepareStep({ store, service, config, loop: loopConfig, model, reader, showing }, cycle, { kind: 'revise', pieceId: piece.id, intent: '直す' }, clock.at)).toBeNull();
    expect(model.calls).toEqual([]);
    store.loop.endCycle(cycle.id, 'test', clock.at);
  });
});

describe('moving her study to Aether', () => {
  it('plans the dry run through a read-only connection that changes nothing, with every piece and no body', () => {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-migration-'));
    directories.push(directory);
    // A database from before the study's Aether tables (and before its later columns).
    const path = join(directory, 'old.sqlite');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE study_pieces (scope_key TEXT, piece_id TEXT, kind TEXT, title TEXT, body TEXT, status TEXT, version INTEGER,
      readable_version INTEGER, pursuit_id TEXT, sources_json TEXT, created_at TEXT, updated_at TEXT, shown_at TEXT, put_away_by TEXT)`);
    const insert = old.prepare(`INSERT INTO study_pieces VALUES ('owner', ?, ?, ?, ?, ?, 1, ?, NULL, '[]', 'x', ?, NULL, NULL)`);
    for (let index = 0; index < 520; index += 1) insert.run(`p${index}`, 'note', `メモ${index}`, 'ひみつの本文', 'ready', 1, String(index).padStart(4, '0'));
    insert.run('s1', 'story', '灯台の話', STORY, 'draft', null, '9999');
    const schema = () => old.prepare(`SELECT name, sql FROM sqlite_master ORDER BY name`).all();
    const before = JSON.stringify(schema());
    old.close();
    const plan = readOnlyMigrationPlan(path);
    expect([...plan.keys()]).toEqual(['owner']);
    expect(plan.get('owner')).toHaveLength(521);
    expect(plan.get('owner')![0]).toMatchObject({ pieceId: 's1', kind: 'story', characters: [...STORY].length, shown: false, target: 'study' });
    expect(migrationReport('owner', plan.get('owner')!)).not.toContain('ひみつの本文');
    const after = new DatabaseSync(path, { readOnly: true });
    expect(JSON.stringify(after.prepare(`SELECT name, sql FROM sqlite_master ORDER BY name`).all())).toBe(before);
    after.close();
    // A path with no database is not created.
    expect(() => readOnlyMigrationPlan(join(directory, 'none.sqlite'))).toThrow();
    expect(existsSync(join(directory, 'none.sqlite'))).toBe(false);
  });

  it('shows the owner what moves, as metadata only, then moves it once and keeps the mapping', async () => {
    const { fake, access, store, clock, call, service } = await harness();
    const story = store.study.create(scope, { kind: 'story', title: '灯台の話', body: STORY }, clock.at) as StudyPiece;
    store.study.markReady(scope, story.id, clock.at);
    store.study.addFeedback(scope, story.id, { reaction: 'like' }, clock.at);
    const draft = store.study.create(scope, { kind: 'story', title: 'まだの話', body: STORY }, clock.at) as StudyPiece;
    const note = store.study.create(scope, { kind: 'note', title: '光のメモ', body: 'ひみつの本文です。' }, clock.at) as StudyPiece;
    const look = store.study.create(scope, { kind: 'note', title: '見たこと（10月6日 10時）', body: '机に本。', origin: 'room_look' }, clock.at) as StudyPiece;

    const report = migrationReport(scope, migrationPlan(store, scope));
    expect(report).toContain('確認用。まだ何も移していません');
    expect(report).toContain(`物語｜「灯台の話」｜${[...STORY].length}字｜見せてもいい｜見せている｜→ Aetherの書斎（シャノン用フォルダ・タグ「書斎」）｜${story.id}`);
    expect(report).toContain(`物語｜「まだの話」｜${[...STORY].length}字｜下書き｜まだ見せていない｜→ Aetherの書斎`);
    expect(report).toContain(`メモ｜「光のメモ」｜9字｜見せてもいい｜見せている｜→ Aetherのシャノン用フォルダ｜${note.id}`);
    expect(report).toContain(`Shannonに残す（部屋を見たメモ）｜${look.id}`);
    expect(report).not.toContain('ひみつの本文');
    // What stays in Shannon is listed without its title; an unshown draft keeps its title, for the owner to see what moves.
    expect(report).not.toContain('見たこと（10月6日 10時）');
    expect(report).toContain(`メモ｜（題名は伏せる）｜4字｜見せてもいい｜見せている｜Shannonに残す（部屋を見たメモ）｜${look.id}`);
    expect(report).not.toContain('雨の日の図書館');
    expect(fake.requests).toEqual([]);

    const dayKey = (at: string) => at.slice(0, 10);
    const first = await applyMigration(store, access!, scope, { now: () => clock.at, dayKey });
    expect(first.moved).toHaveLength(3);
    expect(first.failed).toEqual([]);
    expect(fake.inFolder().map(document => [document.title, document.tags.includes('書斎')]).sort()).toEqual([['まだの話', true], ['光のメモ', false], ['灯台の話', true]]);
    expect(store.study.aether.current(scope, look.id)).toBeNull();
    expect(store.study.feedback(scope, story.id)[0]!.aetherDocumentId).toBe(store.study.aether.current(scope, story.id)!.documentId);
    expect(store.study.aether.pieceFor(scope, store.study.aether.current(scope, draft.id)!.documentId)).toBe(draft.id);
    // Again: nothing moves twice.
    expect((await applyMigration(store, access!, scope, { now: () => clock.at, dayKey })).moved).toEqual([]);
    expect(fake.inFolder()).toHaveLength(3);
    expect(migrationReport(scope, migrationPlan(store, scope), true)).toContain('移動済み 3件');
    // Between --apply and setting the address, she revised one moved piece and put another in her trash, in Shannon only:
    // the next --apply sends both to Aether from the version Aether has, once.
    store.study.revise(scope, draft.id, { body: `${STORY}その後の直し。`, changeNote: '直しました。' }, clock.at);
    store.study.softDelete(scope, note.id, clock.at);
    const plan = migrationPlan(store, scope);
    expect(plan.find(item => item.pieceId === draft.id)).toMatchObject({ note: 'moved', catchUp: 'update' });
    expect(plan.find(item => item.pieceId === note.id)).toMatchObject({ note: 'moved', catchUp: 'delete' });
    expect(migrationReport(scope, plan)).toContain('移したあとの直しをAetherへ送る');
    const caught = await applyMigration(store, access!, scope, { now: () => clock.at, dayKey });
    expect(caught.failed).toEqual([]);
    const draftDocument = store.study.aether.current(scope, draft.id)!;
    expect(draftDocument).toMatchObject({ version: 2, aetherVersion: 2 });
    expect(fake.documents.get(draftDocument.documentId)!.body).toBe(`${STORY}その後の直し。`);
    expect(fake.documents.get(store.study.aether.current(scope, note.id)!.documentId)!.status).toBe('deleted');
    expect(caught).toMatchObject({ moved: [], caughtUp: [expect.anything(), expect.anything()] });
    // The owner restores the deleted note from Recently Deleted; a later run neither deletes it again nor sends anything else,
    // the dry run plans nothing more, and the activity record gains no line.
    const noteDocument = store.study.aether.current(scope, note.id)!.documentId;
    fake.ownerEdit(noteDocument, { status: 'growing' });
    const writes = fake.requests.filter(request => request.body.kind === 'update' || request.body.kind === 'delete').length;
    const lines = service.activityDays(scope, 30).flatMap(day => day.entries).filter(entry => entry.summary.startsWith('書斎の移行')).length;
    expect(migrationPlan(store, scope).filter(item => item.catchUp)).toEqual([]);
    expect(migrationReport(scope, migrationPlan(store, scope))).not.toContain('Aetherでも消す');
    expect(await applyMigration(store, access!, scope, { now: () => clock.at, dayKey })).toMatchObject({ moved: [], caughtUp: [], failed: [] });
    expect(fake.requests.filter(request => request.body.kind === 'update' || request.body.kind === 'delete').length).toBe(writes);
    expect(fake.documents.get(noteDocument)!.status).toBe('growing');
    expect(service.activityDays(scope, 30).flatMap(day => day.entries).filter(entry => entry.summary.startsWith('書斎の移行'))).toHaveLength(lines);
    // The moved story is revised in Aether from now on, by the id the apps and her messages already use.
    expect(await call('study.update', { id: story.id, body: `${STORY}続き。`, changeNote: '続き。' })).toMatchObject({ ok: true });
    expect(fake.documents.get(store.study.aether.current(scope, story.id)!.documentId)!.body).toBe(`${STORY}続き。`);
  });
});

describe('the Aether capability line in the layered request (merge of prompt-cache and aether-study, 2026-10-06)', () => {
  class CapturingModel implements ShannonChatModel {
    readonly mode = 'openai' as const;
    readonly model = 'test-model';
    readonly requests: Array<ShannonChatModelRequest | ShannonVoiceModelRequest> = [];
    async generate(request: ShannonChatModelRequest): Promise<ShannonChatModelResult> {
      this.requests.push(request);
      return { mode: this.mode, model: this.model, reply: 'うん。' };
    }
    async generateVoice(request: ShannonVoiceModelRequest): Promise<ShannonChatModelResult> {
      this.requests.push(request);
      return { mode: this.mode, model: this.model, reply: 'うん。' };
    }
  }
  const line = SHANNON_AETHER_ACCESS_CAPABILITY.text;

  it('is in her identity (systemPrompt), never in the turn context, and keeps the text instructions the same turn to turn', async () => {
    const { service, clock } = await harness();
    const model = new CapturingModel();
    const api = createLocalApiKernel(() => clock.at, { autonomy: service, chatModel: model });
    const chat = (message: string, extra: Record<string, unknown> = {}) =>
      api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: scope, threadId: 'aether-layers', message, ...extra } });

    await chat('おはよう');
    clock.at = '2026-10-06T01:00:20.000Z';
    await chat('灯台の話の続きをしよう');
    const [first, second] = model.requests.slice(-2) as ShannonChatModelRequest[];
    for (const request of [first!, second!]) {
      expect(request.tools?.definitions.map(tool => tool.name)).toContain('aether.search');
      expect(request.systemPrompt).toContain(line);
      expect(request.turnContext ?? '').not.toContain(line);
      expect(request.profilePrompt ?? '').not.toContain(line);
    }
    // Two consecutive owner-alone text turns: the instructions, the cached prefix's start, are the same bytes.
    const instructions = (request: ShannonChatModelRequest) => (chatTurnRequestBody('gpt-5.6-luna', request, 'shannon-mac') as { instructions: string }).instructions;
    expect(instructions(second!)).toBe(instructions(first!));
    expect(instructions(first!)).toContain(line);

    // A voice turn whose words name Aether is offered her Aether tools, and the line goes to her identity only.
    clock.at = '2026-10-06T01:00:40.000Z';
    const transcript = 'Aetherの灯台の文書を読んで';
    const spoken = await api.dispatch({ method: 'POST', path: '/v1/voice/gemini/cascade/delegations', body: {
      scopeKey: scope, threadId: 'aether-voice', transcript,
      deviceContext: { timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null,
        userUtterance: { id: 'u-aether-voice', text: transcript, source: 'speech', rawText: transcript } },
    } });
    expect(spoken.status).toBe(200);
    const voice = model.requests.at(-1) as ShannonVoiceModelRequest;
    expect(voice.tools?.definitions.map(tool => tool.name)).toContain('aether.search');
    expect(voice.systemPrompt).toContain(line);
    expect(voice.turnContext ?? '').not.toContain(line);
    expect(voice.profilePrompt ?? '').not.toContain(line);
    expect(voice.history.map(item => item.content).join('\n')).not.toContain(line);
  });

  it('is left out of a turn that searches the web, which the adapter sends without tools', async () => {
    const { service, clock } = await harness();
    const model = new CapturingModel();
    const api = createLocalApiKernel(() => clock.at, { autonomy: service, chatModel: model });
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: scope, threadId: 'aether-web', message: '今日の天気は？', webSearch: true } });
    const request = model.requests.at(-1) as ShannonChatModelRequest;
    expect(request.useWebSearch).toBe(true);
    expect(offersTools(request)).toBe(false);
    expect(promptOf(request)).not.toContain(line);
    // The rule itself, as voice applies it: the tools are dropped by the adapter on a web-search turn, so is the line.
    const prompt = shannonCapabilityPrompt('owner');
    const tools = { definitions: [{ name: 'aether.search' }, { name: 'minecraft.request' }] };
    expect(withToolCapabilityLines({ systemPrompt: prompt, tools }).systemPrompt).toContain(line);
    expect(withToolCapabilityLines({ systemPrompt: prompt, tools }).systemPrompt).toContain(SHANNON_MINECRAFT_BODY_CAPABILITY.text);
    expect(withToolCapabilityLines({ systemPrompt: prompt, tools, useWebSearch: true }).systemPrompt).toBe(prompt);
    expect(withToolCapabilityLines({ systemPrompt: prompt, tools, placeSearch: { spoken: false } }).systemPrompt).toBe(prompt);
  });
});
