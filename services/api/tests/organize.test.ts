import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createLocalApiKernel } from '../src/apiKernel.js';
import type { ShannonChatModel, ShannonChatModelRequest } from '../src/chatModel.js';
import {
  InMemoryOrganizeStore,
  HttpVoyagerCatalog,
  HttpVoyagerTaskDestination,
  OpenAIOrganizeExtractor,
  OrganizeError,
  SQLiteOrganizeStore,
  isExplicitVoyagerUpdateRequest,
  isOrganizeCommand,
  type OrganizeExtractor,
  type OrganizeItem,
  type OrganizeSession,
  type VoyagerTaskDestination,
  type VoyagerTaskReference,
  type VoyagerCatalog,
} from '../src/organize.js';

class RecordingChatModel implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'chat-test';
  readonly requests: ShannonChatModelRequest[] = [];
  async generate(request: ShannonChatModelRequest) {
    this.requests.push(request);
    return { mode: this.mode, model: this.model, reply: '通常返答' };
  }
}

class FixedExtractor implements OrganizeExtractor {
  readonly mode = 'test';
  readonly calls: Array<{ scopeKey: string; messages: readonly { role: string; content: string }[] }> = [];
  async extract(scopeKey: string, messages: readonly { role: 'user' | 'assistant'; content: string }[]) {
    this.calls.push({ scopeKey, messages });
    return [{ title: '連携テストを行う', details: '合成データでThinking Taskが1件作成されることを確認する。' }];
  }
}

class RecordingDestination implements VoyagerTaskDestination {
  readonly calls: Array<{ session: OrganizeSession; item: OrganizeItem }> = [];
  failOnce = false;
  async apply(session: OrganizeSession, item: OrganizeItem): Promise<VoyagerTaskReference> {
    this.calls.push(structuredClone({ session, item }));
    if (this.failOnce) {
      this.failOnce = false;
      throw new OrganizeError('DESTINATION_UNAVAILABLE', 503, true);
    }
    return {
      system: 'voyager', resourceType: 'task', resourceId: '00000000-0000-4000-8000-000000000003',
      title: item.title, summary: item.details || null, updatedAt: '2026-09-08T00:00:10.000Z', href: null,
    };
  }
}

class FixedCatalog implements VoyagerCatalog {
  readonly taskCalls: Array<{ query: string; limit: number }> = [];
  readonly projectCalls: number[] = [];
  async searchTasks(query: string, limit: number) {
    this.taskCalls.push({ query, limit });
    return [{
      id: '00000000-0000-4000-8000-000000000101', title: '既存Taskを確認する', details: '検索結果',
      status: 'pending', projectIds: [], revision: 1, updatedAt: '2026-09-08T23:00:00.000Z',
    }];
  }
  async listProjects(limit: number) {
    this.projectCalls.push(limit);
    return [{ id: '00000000-0000-4000-8000-000000000104', title: 'Syzygy Phase 2', revision: 1, updatedAt: '2026-09-08T22:00:00.000Z' }];
  }
}

describe('Shannon organize sessions', () => {
  it('recognizes only the standalone explicit command', () => {
    expect(isOrganizeCommand('整理して')).toBe(true);
    expect(isOrganizeCommand('  整理して。 ')).toBe(true);
    expect(isOrganizeCommand('要点を整理して')).toBe(false);
    expect(isOrganizeCommand('「整理して」と表示して')).toBe(false);
  });

  it('recognizes only the bounded explicit Voyager update form for proposal suppression', () => {
    expect(isExplicitVoyagerUpdateRequest(
      'Voyagerにある「既存Task」の詳細を「更新後」に更新して、合うProjectを選びたい。',
    )).toBe(true);
    expect(isExplicitVoyagerUpdateRequest('Shannonの入力欄を更新して')).toBe(false);
    expect(isExplicitVoyagerUpdateRequest('Voyagerの使い方を相談したい')).toBe(false);
  });

  it('turns the reported Japanese update request into field-level changes without calling the model', async () => {
    let modelCalled = false;
    const extractor = new OpenAIOrganizeExtractor({
      apiKey: 'synthetic-key',
      model: 'synthetic-model',
      fetcher: async () => {
        modelCalled = true;
        throw new Error('must not call model for an explicit update');
      },
    });
    const drafts = await extractor.extract('owner-a', [{
      role: 'user',
      content: 'Voyagerにある「シャノンとVoyagerの実機連携を確認する」の詳細を「Shannon Phase 2の実機確認に成功」に更新して、合うProjectを選びたい。',
    }]);

    expect(modelCalled).toBe(false);
    expect(drafts).toEqual([{
      operation: 'update',
      targetQuery: 'シャノンとVoyagerの実機連携を確認する',
      title: 'シャノンとVoyagerの実機連携を確認する',
      details: 'Shannon Phase 2の実機確認に成功',
      updateFields: ['details', 'projectIds'],
      projectSelectionRequired: true,
    }]);
  });

  it('extracts after the prior cursor and sends only after accepted review', async () => {
    let tick = 0;
    const now = () => `2026-09-08T00:00:${String(tick++).padStart(2, '0')}.000Z`;
    const chat = new RecordingChatModel();
    const extractor = new FixedExtractor();
    const destination = new RecordingDestination();
    const api = createLocalApiKernel(now, {
      chatModel: chat, organizeExtractor: extractor, organizeStore: new InMemoryOrganizeStore(), voyagerDestination: destination,
    });
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner-a', message: '連携確認をしたい' } });
    const organized = await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner-a', message: '整理して。' } });
    expect(chat.requests).toHaveLength(1);
    expect(destination.calls).toHaveLength(0);
    expect(extractor.calls[0]?.messages.map(message => message.content)).toEqual(['連携確認をしたい', '通常返答']);
    const session = ((organized.body as { uiBlocks: Array<{ session: OrganizeSession }> }).uiBlocks[0]?.session)!;
    expect(session.items[0]).toMatchObject({ decision: 'proposed', destinationStatus: 'pending' });

    const reviewed = await api.dispatch({
      method: 'POST', path: `/v1/organize/sessions/${session.id}/items/${session.items[0]!.id}/decision`,
      body: { scopeKey: 'owner-a', expectedRevision: session.revision, decision: 'accepted', title: '編集後のTask名', details: '確認済みの短い内容' },
    });
    const accepted = (reviewed.body as { session: OrganizeSession }).session;
    expect(destination.calls).toHaveLength(0);
    const applied = await api.dispatch({
      method: 'POST', path: `/v1/organize/sessions/${session.id}/apply`,
      body: { scopeKey: 'owner-a', expectedRevision: accepted.revision },
    });
    expect(applied).toMatchObject({ status: 200, body: { appliedCount: 1, tasks: [{ title: '編集後のTask名' }] } });
    expect(destination.calls[0]?.item).toMatchObject({ title: '編集後のTask名', details: '確認済みの短い内容' });
    const completed = (applied.body as { session: OrganizeSession }).session;
    const replay = await api.dispatch({
      method: 'POST', path: `/v1/organize/sessions/${session.id}/apply`,
      body: { scopeKey: 'owner-a', expectedRevision: completed.revision },
    });
    expect((replay.body as { session: OrganizeSession }).session.revision).toBe(completed.revision);
    expect(destination.calls).toHaveLength(1);
  });

  it('requires every proposal to be reviewed before final apply', async () => {
    const extractor: OrganizeExtractor = {
      mode: 'two-task-test',
      async extract() {
        return [
          { title: '一件目を確認する', details: '一件目' },
          { title: '二件目を確認する', details: '二件目' },
        ];
      },
    };
    const destination = new RecordingDestination();
    const api = createLocalApiKernel(() => '2026-09-08T00:00:00.000Z', { organizeExtractor: extractor, voyagerDestination: destination });
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner-a', message: '二件ある' } });
    const response = await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner-a', message: '整理して' } });
    const session = (response.body as { uiBlocks: Array<{ session: OrganizeSession }> }).uiBlocks[0]!.session;
    const first = await api.dispatch({
      method: 'POST', path: `/v1/organize/sessions/${session.id}/items/${session.items[0]!.id}/decision`,
      body: { scopeKey: 'owner-a', expectedRevision: session.revision, decision: 'accepted' },
    });
    const oneReviewed = (first.body as { session: OrganizeSession }).session;
    const incomplete = await api.dispatch({
      method: 'POST', path: `/v1/organize/sessions/${session.id}/apply`,
      body: { scopeKey: 'owner-a', expectedRevision: oneReviewed.revision },
    });
    expect(incomplete).toEqual({ status: 409, body: { error: 'REVIEW_INCOMPLETE' } });
    expect(destination.calls).toHaveLength(0);
    const second = await api.dispatch({
      method: 'POST', path: `/v1/organize/sessions/${session.id}/items/${session.items[1]!.id}/decision`,
      body: { scopeKey: 'owner-a', expectedRevision: oneReviewed.revision, decision: 'rejected' },
    });
    const allReviewed = (second.body as { session: OrganizeSession }).session;
    const applied = await api.dispatch({
      method: 'POST', path: `/v1/organize/sessions/${session.id}/apply`,
      body: { scopeKey: 'owner-a', expectedRevision: allReviewed.revision },
    });
    expect(applied).toMatchObject({ status: 200, body: { appliedCount: 1 } });
    expect(destination.calls).toHaveLength(1);
  });

  it('retries a failed destination with the same command identifiers', async () => {
    const extractor = new FixedExtractor();
    const destination = new RecordingDestination();
    destination.failOnce = true;
    const api = createLocalApiKernel(() => '2026-09-08T00:00:00.000Z', { organizeExtractor: extractor, voyagerDestination: destination });
    await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner-a', message: 'やること' } });
    const response = await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner-a', message: '整理して' } });
    const session = (response.body as { uiBlocks: Array<{ session: OrganizeSession }> }).uiBlocks[0]!.session;
    const decision = await api.dispatch({
      method: 'POST', path: `/v1/organize/sessions/${session.id}/items/${session.items[0]!.id}/decision`,
      body: { scopeKey: 'owner-a', expectedRevision: 1, decision: 'accepted' },
    });
    const accepted = (decision.body as { session: OrganizeSession }).session;
    const first = await api.dispatch({ method: 'POST', path: `/v1/organize/sessions/${session.id}/apply`, body: { scopeKey: 'owner-a', expectedRevision: accepted.revision } });
    expect(first).toMatchObject({ status: 200, body: { session: { state: 'partially_applied' } } });
    const retryRevision = (first.body as { session: OrganizeSession }).session.revision;
    const second = await api.dispatch({ method: 'POST', path: `/v1/organize/sessions/${session.id}/apply`, body: { scopeKey: 'owner-a', expectedRevision: retryRevision } });
    expect(second).toMatchObject({ status: 200, body: { session: { state: 'applied' }, appliedCount: 1 } });
    expect(destination.calls[0]?.item.requestId).toBe(destination.calls[1]?.item.requestId);
    expect(destination.calls[0]?.item.idempotencyKey).toBe(destination.calls[1]?.item.idempotencyKey);
  });

  it('persists sessions and cursors across SQLite reopen', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'shannon-organize-')), 'store.sqlite');
    const first = new SQLiteOrganizeStore(path);
    let session = first.create({ scopeKey: 'owner-a', threadId: 'thread-a', sourceMessageIds: ['message-a'], drafts: [{ title: 'Task', details: 'Details' }] }, '2026-09-08T00:00:00.000Z');
    session = first.setCommandThrough('owner-a', session.id, 'message-command', '2026-09-08T00:00:01.000Z');
    session = first.decide('owner-a', session.id, session.items[0]!.id, session.revision, 'rejected', {}, '2026-09-08T00:00:02.000Z');
    first.finishApply('owner-a', session.id, '2026-09-08T00:00:03.000Z');
    first.close();
    const reopened = new SQLiteOrganizeStore(path);
    expect(reopened.get('owner-a', session.id)).toMatchObject({ state: 'applied', items: [{ decision: 'rejected' }] });
    expect(reopened.cursor('owner-a', 'thread-a')).toBe('message-command');
    reopened.close();
  });

  it('does not accept a Project-selection update until a Project is chosen', () => {
    const store = new InMemoryOrganizeStore();
    const target = {
      id: 'task-existing', title: '既存Task', details: '変更前', status: 'thinking',
      projectIds: [], revision: 3, updatedAt: '2026-09-09T00:00:00.000Z',
    };
    const session = store.create({
      scopeKey: 'owner-a', threadId: 'thread-a', sourceMessageIds: ['message-a'], drafts: [{
        operation: 'update', targetQuery: '既存Task', title: '既存Task', details: '変更後',
        updateFields: ['details', 'projectIds'], projectSelectionRequired: true,
      }],
    }, '2026-09-09T00:00:00.000Z');

    expect(() => store.decide(
      'owner-a', session.id, session.items[0]!.id, session.revision, 'accepted',
      { operation: 'update', target, projectIds: [] }, '2026-09-09T00:00:01.000Z',
    )).toThrowError(expect.objectContaining({ code: 'PROJECT_SELECTION_REQUIRED' }));
    expect(store.decide(
      'owner-a', session.id, session.items[0]!.id, session.revision, 'accepted',
      { operation: 'update', target, projectIds: ['project-shannon'] }, '2026-09-09T00:00:02.000Z',
    )).toMatchObject({ items: [{ decision: 'accepted', projectIds: ['project-shannon'] }] });
  });

  it('migrates old SQLite rows as Phase 1 create items', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'shannon-organize-migration-')), 'store.sqlite');
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE organize_sessions (
        session_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, thread_id TEXT NOT NULL,
        state TEXT NOT NULL, revision INTEGER NOT NULL, source_message_ids_json TEXT NOT NULL,
        command_through_message_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, applied_at TEXT
      );
      CREATE TABLE organize_items (
        item_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES organize_sessions(session_id) ON DELETE CASCADE,
        position INTEGER NOT NULL, title TEXT NOT NULL, details TEXT NOT NULL, decision TEXT NOT NULL,
        destination_status TEXT NOT NULL, request_id TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
        result_json TEXT, error_code TEXT
      );
      INSERT INTO organize_sessions VALUES ('legacy-session','owner-a','thread-a','ready_for_review',1,'[]',NULL,'2026-09-08T00:00:00.000Z','2026-09-08T00:00:00.000Z',NULL);
      INSERT INTO organize_items VALUES ('legacy-item','legacy-session',0,'Legacy','','proposed','pending','legacy-request','legacy-key',NULL,NULL);
    `);
    legacy.close();
    const reopened = new SQLiteOrganizeStore(path);
    expect(reopened.get('owner-a', 'legacy-session')?.items[0]).toMatchObject({ operation: 'create', projectIds: [] });
    reopened.close();
  });

  it('proxies bounded Voyager task and Project projections without credentials', async () => {
    const catalog = new FixedCatalog();
    const api = createLocalApiKernel(() => '2026-09-09T00:00:00.000Z', { voyagerCatalog: catalog });
    const tasks = await api.dispatch({
      method: 'GET', path: '/v1/integrations/voyager/tasks',
      query: new URLSearchParams({ scopeKey: 'owner-a', query: '既存Task', limit: '8' }),
    });
    const projects = await api.dispatch({
      method: 'GET', path: '/v1/integrations/voyager/projects',
      query: new URLSearchParams({ scopeKey: 'owner-a', limit: '20' }),
    });
    expect(tasks).toMatchObject({ status: 200, body: { items: [{ title: '既存Taskを確認する', revision: 1 }] } });
    expect(projects).toMatchObject({ status: 200, body: { items: [{ title: 'Syzygy Phase 2' }] } });
    expect(catalog.taskCalls).toEqual([{ query: '既存Task', limit: 8 }]);
    expect(catalog.projectCalls).toEqual([20]);
    expect(JSON.stringify(tasks.body)).not.toContain('token');
  });

  it('uses the Voyager 1.1 search contract and bounded projection', async () => {
    const expected = JSON.parse(readFileSync(new URL('./fixtures/voyager-phase2/task-search.response.json', import.meta.url), 'utf8')) as Record<string, unknown>;
    const requests: Array<{ url: string; headers: Headers }> = [];
    const catalog = new HttpVoyagerCatalog({
      tasksEndpoint: 'http://127.0.0.1:41000/api/integrations/syzygy/v1/tasks/search',
      projectsEndpoint: 'http://127.0.0.1:41000/api/integrations/syzygy/v1/projects',
      token: 'synthetic-destination-token', workspaceId: 'configured-workspace',
      fetcher: async (input, init) => {
        requests.push({ url: String(input), headers: new Headers(init?.headers) });
        return new Response(JSON.stringify(expected), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const items = await catalog.searchTasks('既存Task', 8);
    const url = new URL(requests[0]!.url);
    expect(url.pathname).toBe('/api/integrations/syzygy/v1/tasks/search');
    expect(url.searchParams.get('workspaceId')).toBe('configured-workspace');
    expect(url.searchParams.get('query')).toBe('既存Task');
    expect(url.searchParams.get('limit')).toBe('8');
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer synthetic-destination-token');
    expect(requests[0]!.headers.get('x-syzygy-contract-version')).toBe('1.1');
    expect(items[0]).toMatchObject({ id: '00000000-0000-4000-8000-000000000101', revision: 1 });
  });

  it('sends a revision-guarded Voyager Phase 2 update fixture', async () => {
    const expectedRequest = JSON.parse(readFileSync(new URL('./fixtures/voyager-phase2/update.request.json', import.meta.url), 'utf8')) as Record<string, unknown>;
    let recordedBody = '';
    let recordedHeaders = new Headers();
    const destination = new HttpVoyagerTaskDestination({
      endpoint: 'http://127.0.0.1:41000/api/integrations/syzygy/v1/task-changes:apply',
      token: 'synthetic-destination-token', workspaceId: 'configured-workspace',
      fetcher: async (_input, init) => {
        recordedBody = String(init?.body);
        recordedHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ result: {
          system: 'voyager', resourceType: 'task', resourceId: '00000000-0000-4000-8000-000000000101',
          title: '既存Taskを安全に整理する', summary: 'title、details、projectIdsだけを原子的に更新する。', updatedAt: '2026-09-09T00:00:01.000Z', href: null,
        } }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const item: OrganizeItem = {
      id: 'phase2-item', title: '既存Taskを安全に整理する', details: 'title、details、projectIdsだけを原子的に更新する。',
      operation: 'update', target: {
        id: '00000000-0000-4000-8000-000000000101', title: '既存Taskを確認する', details: '検索候補に必要な説明だけを返す。',
        status: 'pending', projectIds: [], revision: 1, updatedAt: '2026-09-08T23:00:00.000Z',
      }, projectIds: ['00000000-0000-4000-8000-000000000104'],
      targetQuery: '既存Taskを確認する', updateFields: ['title', 'details', 'projectIds'], projectSelectionRequired: false,
      decision: 'accepted', destinationStatus: 'pending',
      requestId: '00000000-0000-4000-8000-000000000102', idempotencyKey: '00000000-0000-4000-8000-000000000103',
    };
    const session: OrganizeSession = {
      id: 'phase2-work-session-fixture', scopeKey: 'owner-fixture', threadId: 'phase2-thread-fixture', state: 'ready_for_review', revision: 2,
      sourceMessageIds: ['phase2-message-fixture'], items: [item], createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z',
    };
    await destination.apply(session, item);
    expect(JSON.parse(recordedBody)).toEqual(expectedRequest);
    expect(recordedHeaders.get('x-syzygy-contract-version')).toBe('1.1');
  });

  it('omits an unchanged title and requires the requested Project choice', async () => {
    const bodies: Record<string, unknown>[] = [];
    const destination = new HttpVoyagerTaskDestination({
      endpoint: 'http://127.0.0.1:41000/api/integrations/syzygy/v1/task-changes:apply',
      token: 'synthetic-destination-token', workspaceId: 'configured-workspace',
      fetcher: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ result: {
          system: 'voyager', resourceType: 'task', resourceId: 'task-existing',
          title: 'シャノンとVoyagerの実機連携を確認する', summary: 'Shannon Phase 2の実機確認に成功',
          updatedAt: '2026-09-09T00:00:01.000Z', href: null,
        } }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const item: OrganizeItem = {
      id: 'incident-item', title: 'シャノンとVoyagerの実機連携を確認する', details: 'Shannon Phase 2の実機確認に成功',
      operation: 'update', target: {
        id: 'task-existing', title: 'シャノンとVoyagerの実機連携を確認する', details: '変更前の詳細',
        status: 'thinking', projectIds: [], revision: 3, updatedAt: '2026-09-09T00:00:00.000Z',
      }, projectIds: [], targetQuery: 'シャノンとVoyagerの実機連携を確認する',
      updateFields: ['details', 'projectIds'], projectSelectionRequired: true,
      decision: 'accepted', destinationStatus: 'pending', requestId: 'request', idempotencyKey: 'key',
    };
    const session: OrganizeSession = {
      id: 'session', scopeKey: 'owner', threadId: 'thread', state: 'ready_for_review', revision: 2,
      sourceMessageIds: ['message'], items: [item], createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z',
    };

    await expect(destination.apply(session, item)).rejects.toMatchObject({ code: 'PROJECT_SELECTION_REQUIRED' });
    await destination.apply(session, { ...item, projectIds: ['project-shannon'] });
    expect((bodies[0]!.payload as { changes: Record<string, unknown> }).changes).toEqual({
      details: 'Shannon Phase 2の実機確認に成功',
      projectIds: ['project-shannon'],
    });
  });

  it('sends the Voyager Phase 1 fixture byte-equivalently on retry', async () => {
    const expectedRequest = JSON.parse(readFileSync(
      new URL('./fixtures/voyager-phase1/minimal-create.request.json', import.meta.url),
      'utf8',
    )) as Record<string, unknown>;
    const expectedResult = JSON.parse(readFileSync(
      new URL('./fixtures/voyager-phase1/minimal-create.result.json', import.meta.url),
      'utf8',
    )) as Record<string, unknown>;
    const bodies: string[] = [];
    const headers: Headers[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      bodies.push(String(init?.body));
      headers.push(new Headers(init?.headers));
      return new Response(JSON.stringify(expectedResult), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const destination = new HttpVoyagerTaskDestination({
      endpoint: 'http://127.0.0.1:41000/api/integrations/syzygy/v1/task-changes:apply',
      token: 'synthetic-destination-token',
      workspaceId: 'configured-workspace',
      fetcher,
    });
    const item: OrganizeItem = {
      id: 'organize-item-fixture',
      title: 'ShannonとVoyagerの連携を確認する',
      details: 'ローカル環境でThinking Taskが1件だけ同期されることを確認する。',
      operation: 'create',
      projectIds: [],
      targetQuery: '',
      updateFields: [],
      projectSelectionRequired: false,
      decision: 'accepted',
      destinationStatus: 'pending',
      requestId: '00000000-0000-4000-8000-000000000001',
      idempotencyKey: '00000000-0000-4000-8000-000000000002',
    };
    const session: OrganizeSession = {
      id: 'organize-session-fixture',
      scopeKey: 'owner-fixture',
      threadId: 'thread-fixture',
      state: 'ready_for_review',
      revision: 2,
      sourceMessageIds: ['message-fixture'],
      items: [item],
      createdAt: '2026-09-08T00:00:00.000Z',
      updatedAt: '2026-09-08T00:00:10.000Z',
    };

    const first = await destination.apply(session, item);
    const second = await destination.apply({ ...session, updatedAt: '2026-09-09T00:00:00.000Z' }, item);

    expect(JSON.parse(bodies[0]!)).toEqual(expectedRequest);
    expect(bodies[1]).toBe(bodies[0]);
    expect(headers[0]?.get('idempotency-key')).toBe(item.idempotencyKey);
    expect(headers[0]?.get('x-syzygy-contract-version')).toBe('1.0');
    expect(headers[0]?.get('authorization')).toBe('Bearer synthetic-destination-token');
    expect(first).toEqual(expectedResult.result);
    expect(second).toEqual(first);
  });
});
