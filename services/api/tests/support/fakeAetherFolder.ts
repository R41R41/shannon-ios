import { AetherAccessError, type AetherAccess, type AetherDocument, type AetherFolderEntry } from '../../src/integrations/aether/aetherAccess.js';

/**
 * A fake シャノン用フォルダ for tests: documents with versions, the folder API of `syzygy.aether-shannon-access.v1` (list, read,
 * create, update with `baseVersion`, delete), idempotency keys honoured, and every write counted. `edit` and `remove` act as
 * the owner does in Aether.
 */
export class FakeAetherFolder implements AetherAccess {
  readonly documents = new Map<string, { title: string; body: string; version: number; updatedAt: string }>();
  readonly writes: Array<{ kind: 'create' | 'update' | 'delete'; documentId: string }> = [];
  private readonly keys = new Map<string, { documentId: string; version: number }>();
  private next = 1;

  async search(): Promise<never[]> { return []; }

  async read(input: { documentId: string; offset?: number; maxChars?: number } | { documentId: string; sectionId: string }): Promise<AetherDocument> {
    const document = this.documents.get(input.documentId);
    if (!document) throw new AetherAccessError('NOT_FOUND');
    const offset = 'offset' in input ? input.offset ?? 0 : 0;
    const maxChars = 'maxChars' in input ? input.maxChars ?? 20_000 : 20_000;
    const body = document.body.slice(offset, offset + maxChars);
    return { documentId: input.documentId, version: document.version, title: document.title, body, bodyOffset: offset, bodyLength: document.body.length,
      hasMore: offset + body.length < document.body.length, section: null, folder: { id: 'shannon', name: 'シャノン用フォルダ' }, tags: [], type: 'note', status: '',
      updatedAt: document.updatedAt, inShannonFolder: true, inStudy: false };
  }

  async list(): Promise<readonly AetherFolderEntry[]> {
    return [...this.documents].map(([documentId, document]) => ({ documentId, version: document.version, title: document.title, updatedAt: document.updatedAt, inStudy: false }));
  }

  async create(input: { title: string; body: string; idempotencyKey: string }) {
    const known = this.keys.get(input.idempotencyKey);
    if (known) return known;
    const documentId = `doc-${this.next++}`;
    this.documents.set(documentId, { title: input.title, body: input.body, version: 1, updatedAt: '2026-10-07T00:00:00.000Z' });
    this.writes.push({ kind: 'create', documentId });
    const written = { documentId, version: 1 };
    this.keys.set(input.idempotencyKey, written);
    return written;
  }

  async update(input: { documentId: string; baseVersion: number; title?: string; body?: string; idempotencyKey: string }) {
    const known = this.keys.get(input.idempotencyKey);
    if (known) return known;
    const document = this.documents.get(input.documentId);
    if (!document) throw new AetherAccessError('NOT_FOUND');
    if (document.version !== input.baseVersion) throw new AetherAccessError('STALE_VERSION');
    const next = { ...document, ...(input.title !== undefined ? { title: input.title } : {}), ...(input.body !== undefined ? { body: input.body } : {}), version: document.version + 1 };
    this.documents.set(input.documentId, next);
    this.writes.push({ kind: 'update', documentId: input.documentId });
    const written = { documentId: input.documentId, version: next.version };
    this.keys.set(input.idempotencyKey, written);
    return written;
  }

  async delete(input: { documentId: string; baseVersion: number; idempotencyKey: string }) {
    const document = this.documents.get(input.documentId);
    if (!document) throw new AetherAccessError('NOT_FOUND');
    this.documents.delete(input.documentId);
    this.writes.push({ kind: 'delete', documentId: input.documentId });
    return { documentId: input.documentId, version: document.version + 1 };
  }

  /** The owner edits a document in Aether: a new version. */
  edit(documentId: string, body: string): void {
    const document = this.documents.get(documentId)!;
    this.documents.set(documentId, { ...document, body, version: document.version + 1 });
  }

  /** The owner deletes a document in Aether. */
  remove(documentId: string): void { this.documents.delete(documentId); }
}
