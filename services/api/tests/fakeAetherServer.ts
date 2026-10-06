import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AETHER_SHANNON_ACCESS_CONTRACT, HttpAetherAccess } from '../src/integrations/aether/aetherAccess.js';
import { AETHER_KNOWLEDGE_SEARCH_CONTRACT } from '../src/integrations/aether/aetherKnowledgeSearch.js';

/**
 * A fake Aether provider of `syzygy.aether-shannon-access.v1` over real HTTP on 127.0.0.1, with the semantics of the
 * provider in the Aether repository (`scripts/aether_shannon_access.py`): one folder `project_shannon_folder`, the tag 書斎
 * for her study, revisions per write, `baseVersion` checks, idempotency keys, and `{ error, code }` errors. Synthetic data.
 */
export const TOKEN = 'test-shannon-token-0123456789';
const FOLDER = 'project_shannon_folder';

export interface FakeDocument {
  id: string; title: string; body: string; revision: number; projectIds: string[]; tags: string[]; type: string; status: string; updatedAt: string;
}

export class FakeAether {
  readonly documents = new Map<string, FakeDocument>();
  readonly requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  private readonly operations = new Map<string, { kind: string; documentId: string; version: number; fingerprint: string }>();
  private server: Server | null = null;
  private sequence = 0;
  /** Milliseconds to wait before answering (a timeout). */
  delay = 0;
  /** A contract to answer with instead of the right one (a contract mismatch). */
  contract: string | null = null;

  async start(): Promise<string> {
    this.server = createServer((request, response) => { void this.handle(request, response); });
    await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/aether`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>(resolve => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  async access(timeoutMilliseconds = 2_000): Promise<HttpAetherAccess> {
    return new HttpAetherAccess(new URL(`${await this.start()}/`), TOKEN, timeoutMilliseconds);
  }

  /** A document of the owner's, outside her folder. */
  ownerDocument(title: string, body: string): FakeDocument {
    return this.put({ title, body, projectIds: ['project_owner'], tags: [], type: 'note' });
  }

  /** The owner edits a document on his devices: a new revision. */
  ownerEdit(id: string, change: Partial<Pick<FakeDocument, 'title' | 'body' | 'status' | 'projectIds'>>): FakeDocument {
    const current = this.documents.get(id)!;
    const next = { ...current, ...change, revision: current.revision + 1, updatedAt: this.stamp() };
    this.documents.set(id, next);
    return next;
  }

  put(document: Pick<FakeDocument, 'title' | 'body' | 'projectIds' | 'tags' | 'type'>): FakeDocument {
    const created = { ...document, id: `doc_${++this.sequence}`, revision: 1, status: 'growing', updatedAt: this.stamp() };
    this.documents.set(created.id, created);
    return created;
  }

  inFolder(): FakeDocument[] {
    return [...this.documents.values()].filter(document => document.projectIds.includes(FOLDER));
  }

  private stamp(): string {
    return new Date(Date.UTC(2026, 9, 6, 1, 0, this.sequence++)).toISOString();
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    if (this.delay) await new Promise(resolve => setTimeout(resolve, this.delay));
    const reply = (status: number, body: unknown) => {
      if (response.destroyed) return;
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (request.headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { error: 'Shannon token required' });
    let body: Record<string, unknown>;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; } catch { return reply(400, { error: 'Invalid JSON' }); }
    const path = (request.url ?? '').replace(/^\/aether/u, '');
    this.requests.push({ path, body });
    try {
      if (path === '/api/shannon/v1/knowledge-search') return reply(200, this.search(body));
      if (path === '/api/shannon/v1/document') return reply(200, this.read(body));
      if (path === '/api/shannon/v1/folder') return reply(200, this.folder(body));
      return reply(404, { error: 'Not found' });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'DATABASE_UNAVAILABLE';
      const status = ({ INVALID_REQUEST: 400, NOT_FOUND: 404, OUTSIDE_SHANNON_FOLDER: 403, STALE_VERSION: 409, IDEMPOTENCY_KEY_REUSED: 409 } as Record<string, number>)[code] ?? 503;
      return reply(status, { error: 'failed', code });
    }
  }

  private placement(document: FakeDocument): { inShannonFolder: boolean; inStudy: boolean } {
    const inShannonFolder = document.projectIds.includes(FOLDER);
    return { inShannonFolder, inStudy: inShannonFolder && document.tags.includes('書斎') };
  }

  private search(body: Record<string, unknown>): unknown {
    if (body.contract !== AETHER_KNOWLEDGE_SEARCH_CONTRACT || body.access !== 'read-only') throw new Error('INVALID_REQUEST');
    const scope = body.scope ?? 'all';
    const query = String(body.query);
    const results = [...this.documents.values()].filter(document => document.status !== 'deleted' && `${document.title}\n${document.body}`.includes(query))
      .filter(document => scope === 'all' || (scope === 'shannonFolder' ? this.placement(document).inShannonFolder : this.placement(document).inStudy))
      .slice(0, Number(body.limit)).map(document => ({
        documentId: document.id, version: document.revision, sectionId: 's0', resourceType: 'document', headingPath: [document.title],
        excerpt: document.body.slice(0, 1_200), score: 0.9, updatedAt: document.updatedAt, href: `aether://documents/${document.id}#s0`,
        title: document.title, ...this.placement(document),
      }));
    return { contract: this.contract ?? AETHER_KNOWLEDGE_SEARCH_CONTRACT, kind: 'response', access: 'read-only', generatedAt: this.stamp(), results };
  }

  private read(body: Record<string, unknown>): unknown {
    if (body.contract !== AETHER_SHANNON_ACCESS_CONTRACT || body.kind !== 'read') throw new Error('INVALID_REQUEST');
    const document = this.documents.get(String(body.documentId));
    if (!document || document.status === 'deleted') throw new Error('NOT_FOUND');
    const offset = Number(body.offset ?? 0);
    const maxChars = Number(body.maxChars ?? 20_000);
    const characters = [...document.body];
    const part = body.sectionId ? document.body : characters.slice(offset, offset + maxChars).join('');
    return {
      contract: this.contract ?? AETHER_SHANNON_ACCESS_CONTRACT, kind: 'document', documentId: document.id, version: document.revision,
      title: document.title, body: part, bodyOffset: body.sectionId ? 0 : offset, bodyLength: characters.length,
      hasMore: !body.sectionId && offset + [...part].length < characters.length,
      section: body.sectionId ? { sectionId: body.sectionId, headingPath: [document.title] } : null,
      folder: document.projectIds.includes(FOLDER) ? { id: FOLDER, name: 'シャノン用フォルダ' } : { id: 'project_owner', name: 'ライ氏の仕事' },
      tags: document.tags, type: document.type, status: document.status, updatedAt: document.updatedAt, ...this.placement(document),
    };
  }

  private folder(body: Record<string, unknown>): unknown {
    if (body.contract !== AETHER_SHANNON_ACCESS_CONTRACT) throw new Error('INVALID_REQUEST');
    const contract = this.contract ?? AETHER_SHANNON_ACCESS_CONTRACT;
    if (body.kind === 'list') {
      return { contract, kind: 'list', folder: { id: FOLDER, name: 'シャノン用フォルダ' }, documents: this.inFolder().map(document => ({
        documentId: document.id, version: document.revision, title: document.title, updatedAt: document.updatedAt, inStudy: this.placement(document).inStudy,
      })) };
    }
    const kind = String(body.kind);
    const key = String(body.idempotencyKey ?? '');
    if (!/^[A-Za-z0-9._:-]{8,128}$/u.test(key)) throw new Error('INVALID_REQUEST');
    const fingerprint = JSON.stringify(body);
    const prior = this.operations.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error('IDEMPOTENCY_KEY_REUSED');
      return { contract, kind: prior.kind, documentId: prior.documentId, version: prior.version };
    }
    let document: FakeDocument;
    if (kind === 'create') {
      document = this.put({ title: String(body.title), body: String(body.body), projectIds: [FOLDER], tags: ['シャノン', ...(body.inStudy === true ? ['書斎'] : [])], type: body.inStudy === true ? 'story' : 'note' });
    } else if (kind === 'update' || kind === 'delete') {
      const current = this.documents.get(String(body.documentId));
      if (!current || current.status === 'deleted') throw new Error('NOT_FOUND');
      if (!current.projectIds.includes(FOLDER)) throw new Error('OUTSIDE_SHANNON_FOLDER');
      if (current.revision !== body.baseVersion) throw new Error('STALE_VERSION');
      const tags = body.inStudy === undefined ? current.tags : [...current.tags.filter(tag => tag !== '書斎'), ...(body.inStudy ? ['書斎'] : [])];
      document = {
        ...current, tags, revision: current.revision + 1, updatedAt: this.stamp(),
        ...(kind === 'update' ? { ...(typeof body.title === 'string' ? { title: body.title } : {}), ...(typeof body.body === 'string' ? { body: body.body } : {}) } : { status: 'deleted' }),
      };
      this.documents.set(document.id, document);
    } else {
      throw new Error('INVALID_REQUEST');
    }
    this.operations.set(key, { kind, documentId: document.id, version: document.revision, fingerprint });
    return { contract, kind, documentId: document.id, version: document.revision };
  }
}
