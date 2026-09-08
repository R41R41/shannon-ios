import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLocalApiKernel } from '../src/apiKernel.js';
import type { ShannonChatModel, ShannonChatModelRequest } from '../src/chatModel.js';
import {
  InMemoryOrganizeStore,
  HttpVoyagerTaskDestination,
  OrganizeError,
  SQLiteOrganizeStore,
  isOrganizeCommand,
  type OrganizeExtractor,
  type OrganizeItem,
  type OrganizeSession,
  type VoyagerTaskDestination,
  type VoyagerTaskReference,
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

describe('Shannon organize sessions', () => {
  it('recognizes only the standalone explicit command', () => {
    expect(isOrganizeCommand('整理して')).toBe(true);
    expect(isOrganizeCommand('  整理して。 ')).toBe(true);
    expect(isOrganizeCommand('要点を整理して')).toBe(false);
    expect(isOrganizeCommand('「整理して」と表示して')).toBe(false);
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
