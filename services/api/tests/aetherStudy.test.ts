import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AetherAccessError, HttpAetherAccess, aetherIdempotencyKey, configuredAetherAccess } from '../src/aetherAccess.js';
import { FileAetherProposalStore } from '../src/aetherProposal.js';
import { configuredAutonomy } from '../src/autonomyBudget.js';
import { ShannonAutonomyService } from '../src/autonomyService.js';
import { SQLiteAutonomyStore } from '../src/autonomyStore.js';
import { createLocalApiKernel } from '../src/apiKernel.js';
import { dispatchStudyRequest } from '../src/apiStudyRoutes.js';
import { toolInstructions } from '../src/chatModelTools.js';
import { conversationTools, type ConversationToolServer } from '../src/shannonToolSession.js';
import { toolSessionMemory } from '../src/shannonToolTypes.js';
import type { ToolAudience, ToolSurface } from '../src/shannonTools.js';
import { AETHER_SIDE_CHANGE } from '../src/studyAetherLinks.js';
import { applyMigration, migrationPlan, migrationReport } from '../src/studyMigration.js';
import type { StudyPiece } from '../src/studyStore.js';
import { TEXT_TURN_DEADLINE, TurnDeadline } from '../src/turnDeadline.js';
import { FakeAether, TOKEN } from './fakeAetherServer.js';
import { STORY_BODY, loopHarness, runUntilIdle } from './autonomyLoopHarness.js';

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

describe('moving her study to Aether', () => {
  it('shows the owner what moves, as metadata only, then moves it once and keeps the mapping', async () => {
    const { fake, access, store, clock, call } = await harness();
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
    // The moved story is revised in Aether from now on, by the id the apps and her messages already use.
    expect(await call('study.update', { id: story.id, body: `${STORY}続き。`, changeNote: '続き。' })).toMatchObject({ ok: true });
    expect(fake.documents.get(store.study.aether.current(scope, story.id)!.documentId)!.body).toBe(`${STORY}続き。`);
  });
});
