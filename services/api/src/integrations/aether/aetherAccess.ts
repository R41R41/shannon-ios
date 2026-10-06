import { createHash } from 'node:crypto';
import {
  AETHER_KNOWLEDGE_SEARCH_CONTRACT, aetherKnowledgeSearchRequest, parseAetherKnowledgeSearchResponse,
  type AetherSearchScope, type AetherSectionHit,
} from './aetherKnowledgeSearch.js';
import { FileAetherProposalStore } from './aetherProposal.js';
import { serverEnvironment } from '../../infra/config/serverEnvironment.js';

/**
 * Shannon's client of Aether (Syzygy contract `syzygy.aether-shannon-access.v1`, `contracts/aether-shannon/` in the hub;
 * Syzygy ADR-0007 with its revision of 2026-10-06). Aether is the provider; Shannon only consumes:
 *
 * - `knowledge-search` (knowledge search v1 envelope, optional `scope`) over every active document, her folder, or her study;
 * - `document` `read`, the body in parts (`offset`/`maxChars`, at most 20,000 code points) or one heading section;
 * - `folder` `list`/`create`/`update`/`delete` inside 「シャノン用フォルダ」 (`project_shannon_folder`), with `baseVersion`,
 *   `idempotencyKey` and `inStudy` (her stories, 「シャノンの書斎」, are the documents tagged 書斎 there).
 *
 * Configured by `SHANNON_AETHER_API_URL` and `SHANNON_AETHER_SHANNON_TOKEN` (a Shannon-scoped token issued on the VM); either
 * unset, there is no client and nothing of this runs (`configuredAetherAccess` returns null). Every request has a timeout
 * (`SHANNON_AETHER_TIMEOUT_MS`, default 8 s) and every response is checked against the contract before anything of it is used;
 * a response of another contract or shape fails closed. Errors are codes only: never the token, a request or a body.
 *
 * Who may see what is not decided here: the tool gate hands an executor a narrowed client (`gatedAether`, `shannonToolGate.ts`).
 */
export const AETHER_SHANNON_ACCESS_CONTRACT = 'syzygy.aether-shannon-access.v1';

export type AetherAccessErrorCode =
  | 'STALE_VERSION' | 'OUTSIDE_SHANNON_FOLDER' | 'NOT_FOUND' | 'INVALID_REQUEST' | 'IDEMPOTENCY_KEY_REUSED'
  | 'UNAUTHORIZED' | 'UNAVAILABLE' | 'TIMEOUT' | 'CONTRACT_MISMATCH'
  /** Not from Aether: the gate refused a document outside her folder while someone else may see or hear (`gatedAether`). */
  | 'OUTSIDE_AUDIENCE'
  /** Not from Aether: with anyone else present, a document she wrote after reading the owner's (`ownerInformedMarks.ts`, ADR-0007). */
  | 'OWNER_INFORMED'
  /** Not from Aether: a study document longer than Shannon reads whole (`STUDY_AETHER_SYNC.readCharacters`); never adopted cut short. */
  | 'TOO_LONG';

export class AetherAccessError extends Error {
  /** `version`: for `TOO_LONG`, the Aether version that was too long. */
  constructor(readonly code: AetherAccessErrorCode, readonly version?: number) { super(`AETHER_${code}`); }
}

export function aetherErrorCode(error: unknown): AetherAccessErrorCode {
  return error instanceof AetherAccessError ? error.code : 'UNAVAILABLE';
}

export interface AetherDocument {
  documentId: string;
  version: number;
  title: string;
  /** At most the asked part of the body (or the one section asked for). */
  body: string;
  bodyOffset: number;
  bodyLength: number;
  hasMore: boolean;
  section: { sectionId: string; headingPath: readonly string[] } | null;
  folder: { id: string; name: string } | null;
  tags: readonly string[];
  type: string;
  status: string;
  updatedAt: string;
  inShannonFolder: boolean;
  inStudy: boolean;
}

export interface AetherFolderEntry { documentId: string; version: number; title: string; updatedAt: string; inStudy: boolean }
export interface AetherWriteResult { documentId: string; version: number }

export type AetherReadInput = { documentId: string; offset?: number; maxChars?: number } | { documentId: string; sectionId: string };

export interface AetherAccess {
  search(input: { query: string; limit?: number; scope?: AetherSearchScope }, signal?: AbortSignal): Promise<readonly AetherSectionHit[]>;
  read(input: AetherReadInput, signal?: AbortSignal): Promise<AetherDocument>;
  list(signal?: AbortSignal): Promise<readonly AetherFolderEntry[]>;
  create(input: { title: string; body: string; inStudy?: boolean; idempotencyKey: string }, signal?: AbortSignal): Promise<AetherWriteResult>;
  update(input: { documentId: string; baseVersion: number; title?: string; body?: string; inStudy?: boolean; idempotencyKey: string }, signal?: AbortSignal): Promise<AetherWriteResult>;
  delete(input: { documentId: string; baseVersion: number; idempotencyKey: string }, signal?: AbortSignal): Promise<AetherWriteResult>;
}

export const AETHER_LIMITS = Object.freeze({ readCharacters: 20_000, titleCharacters: 500, bodyBytes: 1_000_000, responseBytes: 4_000_000 });

/** An idempotency key from the parts that make a write the same write: 8–128 characters of `A-Z a-z 0-9 . _ : -`. */
export function aetherIdempotencyKey(...parts: readonly string[]): string {
  return `shannon.${createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 48)}`;
}

const IDEMPOTENCY = /^[A-Za-z0-9._:-]{8,128}$/u;
const DOCUMENT_ID = /^[^\u0000-\u001f\u007f]{1,160}$/u;
type Environment = Readonly<Record<string, string | undefined>>;
type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** The client when both variables are set and the address is http(s); otherwise null (Aether is not configured). */
export function configuredAetherAccess(environment: Environment = serverEnvironment(), fetcher: Fetch = fetch): AetherAccess | null {
  const address = environment.SHANNON_AETHER_API_URL?.trim();
  const token = environment.SHANNON_AETHER_SHANNON_TOKEN?.trim();
  if (!address || !token) return null;
  let base: URL;
  try { base = new URL(address.endsWith('/') ? address : `${address}/`); } catch { return null; }
  // https, except to this machine (the VM's 127.0.0.1:3007): the token never crosses a network in the clear.
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) return null;
  const timeout = Number(environment.SHANNON_AETHER_TIMEOUT_MS ?? '');
  return new HttpAetherAccess(base, token, Number.isInteger(timeout) && timeout >= 500 && timeout <= 60_000 ? timeout : 8_000, fetcher);
}

export class HttpAetherAccess implements AetherAccess {
  constructor(private readonly base: URL, private readonly token: string, private readonly timeoutMilliseconds: number, private readonly fetcher: Fetch = fetch) {}

  async search(input: { query: string; limit?: number; scope?: AetherSearchScope }, signal?: AbortSignal): Promise<readonly AetherSectionHit[]> {
    if (!input.query.trim() || input.query.length > 500) throw new AetherAccessError('INVALID_REQUEST');
    const body = await this.post('api/shannon/v1/knowledge-search', aetherKnowledgeSearchRequest(input.query, input.limit ?? 5, input.scope), signal);
    if (!isRecord(body) || body.contract !== AETHER_KNOWLEDGE_SEARCH_CONTRACT) throw new AetherAccessError('CONTRACT_MISMATCH');
    const hits = parseAetherKnowledgeSearchResponse(body);
    if (!hits) throw new AetherAccessError('CONTRACT_MISMATCH');
    return hits;
  }

  async read(input: AetherReadInput, signal?: AbortSignal): Promise<AetherDocument> {
    if (!DOCUMENT_ID.test(input.documentId)) throw new AetherAccessError('INVALID_REQUEST');
    const part = 'sectionId' in input ? { sectionId: input.sectionId } : {
      ...(input.offset !== undefined ? { offset: integerIn(input.offset, 0, Number.MAX_SAFE_INTEGER) } : {}),
      ...(input.maxChars !== undefined ? { maxChars: integerIn(input.maxChars, 1, AETHER_LIMITS.readCharacters) } : {}),
    };
    return documentOf(this.expect(await this.post('api/shannon/v1/document', { ...envelope('read'), documentId: input.documentId, ...part }, signal), 'document'));
  }

  async list(signal?: AbortSignal): Promise<readonly AetherFolderEntry[]> {
    const body = this.expect(await this.post('api/shannon/v1/folder', envelope('list'), signal), 'list');
    if (!Array.isArray(body.documents)) throw new AetherAccessError('CONTRACT_MISMATCH');
    return Object.freeze(body.documents.map(entry => {
      if (!isRecord(entry) || typeof entry.documentId !== 'string' || !positive(entry.version) || typeof entry.title !== 'string'
        || typeof entry.updatedAt !== 'string' || typeof entry.inStudy !== 'boolean') throw new AetherAccessError('CONTRACT_MISMATCH');
      return Object.freeze({ documentId: entry.documentId, version: entry.version as number, title: entry.title, updatedAt: entry.updatedAt, inStudy: entry.inStudy });
    }));
  }

  create(input: { title: string; body: string; inStudy?: boolean; idempotencyKey: string }, signal?: AbortSignal): Promise<AetherWriteResult> {
    checkedText(input);
    return this.write('create', { title: input.title, body: input.body, ...(input.inStudy !== undefined ? { inStudy: input.inStudy } : {}), idempotencyKey: key(input.idempotencyKey) }, signal);
  }

  update(input: { documentId: string; baseVersion: number; title?: string; body?: string; inStudy?: boolean; idempotencyKey: string }, signal?: AbortSignal): Promise<AetherWriteResult> {
    checkedText(input);
    return this.write('update', {
      documentId: documentId(input.documentId), baseVersion: integerIn(input.baseVersion, 1, Number.MAX_SAFE_INTEGER),
      ...(input.title !== undefined ? { title: input.title } : {}), ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.inStudy !== undefined ? { inStudy: input.inStudy } : {}), idempotencyKey: key(input.idempotencyKey),
    }, signal);
  }

  delete(input: { documentId: string; baseVersion: number; idempotencyKey: string }, signal?: AbortSignal): Promise<AetherWriteResult> {
    return this.write('delete', { documentId: documentId(input.documentId), baseVersion: integerIn(input.baseVersion, 1, Number.MAX_SAFE_INTEGER), idempotencyKey: key(input.idempotencyKey) }, signal);
  }

  private async write(kind: 'create' | 'update' | 'delete', fields: Record<string, unknown>, signal?: AbortSignal): Promise<AetherWriteResult> {
    const body = this.expect(await this.post('api/shannon/v1/folder', { ...envelope(kind), ...fields }, signal), kind);
    if (typeof body.documentId !== 'string' || !positive(body.version)) throw new AetherAccessError('CONTRACT_MISMATCH');
    return Object.freeze({ documentId: body.documentId, version: body.version as number });
  }

  /** A response of this contract and kind; anything else fails closed. */
  private expect(body: unknown, kind: string): Record<string, unknown> {
    if (!isRecord(body) || body.contract !== AETHER_SHANNON_ACCESS_CONTRACT || body.kind !== kind) throw new AetherAccessError('CONTRACT_MISMATCH');
    return body;
  }

  private async post(path: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.timeoutMilliseconds);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, this.base).toString(), {
        method: 'POST', redirect: 'error', signal: combined,
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch {
      throw new AetherAccessError(timeout.aborted ? 'TIMEOUT' : 'UNAVAILABLE');
    }
    let text: string;
    try {
      const length = Number(response.headers.get('content-length') ?? '0');
      if (length > AETHER_LIMITS.responseBytes) throw new Error('too large');
      text = await response.text();
      if (text.length > AETHER_LIMITS.responseBytes) throw new Error('too large');
    } catch {
      throw new AetherAccessError(timeout.aborted ? 'TIMEOUT' : 'UNAVAILABLE');
    }
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    if (response.ok) {
      if (body === null) throw new AetherAccessError('CONTRACT_MISMATCH');
      return body;
    }
    throw new AetherAccessError(errorCode(response.status, isRecord(body) && typeof body.code === 'string' ? body.code : ''));
  }
}

/** The status and the provider's code (`{ error, code }`) as one of ours; an unknown failure is `UNAVAILABLE`. */
function errorCode(status: number, code: string): AetherAccessErrorCode {
  if (code === 'STALE_VERSION' || code === 'OUTSIDE_SHANNON_FOLDER' || code === 'NOT_FOUND' || code === 'IDEMPOTENCY_KEY_REUSED') return code;
  if (status === 409) return 'STALE_VERSION';
  if (status === 404) return 'NOT_FOUND';
  if (status === 401 || status === 403) return 'UNAUTHORIZED';
  if (status === 400 || status === 413 || status === 422 || code === 'INVALID_REQUEST' || code === 'INVALID_ENTITY') return 'INVALID_REQUEST';
  return 'UNAVAILABLE';
}

function envelope(kind: string): { contract: typeof AETHER_SHANNON_ACCESS_CONTRACT; kind: string } {
  return { contract: AETHER_SHANNON_ACCESS_CONTRACT, kind };
}

function documentOf(body: Record<string, unknown>): AetherDocument {
  const section = body.section;
  const folder = body.folder;
  if (typeof body.documentId !== 'string' || !positive(body.version) || typeof body.title !== 'string' || typeof body.body !== 'string'
    || !nonNegative(body.bodyOffset) || !nonNegative(body.bodyLength) || typeof body.hasMore !== 'boolean'
    || !Array.isArray(body.tags) || !body.tags.every(tag => typeof tag === 'string') || typeof body.updatedAt !== 'string'
    || (section !== null && section !== undefined && !(isRecord(section) && typeof section.sectionId === 'string' && Array.isArray(section.headingPath)))
    || (folder !== null && folder !== undefined && !(isRecord(folder) && typeof folder.id === 'string' && typeof folder.name === 'string'))) {
    throw new AetherAccessError('CONTRACT_MISMATCH');
  }
  return Object.freeze({
    documentId: body.documentId, version: body.version as number, title: body.title, body: body.body,
    bodyOffset: body.bodyOffset as number, bodyLength: body.bodyLength as number, hasMore: body.hasMore,
    section: isRecord(section) ? Object.freeze({ sectionId: section.sectionId as string, headingPath: Object.freeze((section.headingPath as unknown[]).filter((item): item is string => typeof item === 'string')) }) : null,
    folder: isRecord(folder) ? Object.freeze({ id: folder.id as string, name: folder.name as string }) : null,
    tags: Object.freeze([...body.tags as string[]]), type: typeof body.type === 'string' ? body.type : 'note',
    status: typeof body.status === 'string' ? body.status : '', updatedAt: body.updatedAt,
    // Placement that is not stated counts as outside her folder: the audience rule then holds without it.
    inShannonFolder: body.inShannonFolder === true, inStudy: body.inShannonFolder === true && body.inStudy === true,
  });
}

function checkedText(input: { title?: string; body?: string }): void {
  if (input.title !== undefined && (typeof input.title !== 'string' || [...input.title].length > AETHER_LIMITS.titleCharacters)) throw new AetherAccessError('INVALID_REQUEST');
  if (input.body !== undefined && (typeof input.body !== 'string' || Buffer.byteLength(input.body, 'utf8') > AETHER_LIMITS.bodyBytes)) throw new AetherAccessError('INVALID_REQUEST');
}

function key(value: string): string {
  if (!IDEMPOTENCY.test(value)) throw new AetherAccessError('INVALID_REQUEST');
  return value;
}

function documentId(value: string): string {
  if (!DOCUMENT_ID.test(value)) throw new AetherAccessError('INVALID_REQUEST');
  return value;
}

function integerIn(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new AetherAccessError('INVALID_REQUEST');
  return value;
}

function positive(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function nonNegative(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The one scope whose study lives in Aether: the owner's (`SHANNON_OWNER_SCOPE_KEY`, default `owner`, the variable the owner's
 * other single-scope features use). Aether has one シャノン用フォルダ, so only one scope's study can move there; every other
 * scope keeps the SQLite study, and the migration moves this scope only.
 */
export function aetherStudyScope(environment: Environment): string {
  return environment.SHANNON_OWNER_SCOPE_KEY?.trim() || 'owner';
}

/**
 * Aether as the API process wires it: the client (null while `SHANNON_AETHER_API_URL` or `SHANNON_AETHER_SHANNON_TOKEN` is
 * unset) and the owner's proposal inbox (null while `SHANNON_AETHER_PROPOSAL_DIR` is unset).
 */
export function configuredAetherPorts(environment: Environment, now: () => string): { access: AetherAccess | null; proposals: FileAetherProposalStore | null; studyScopeKey: string } {
  const directory = environment.SHANNON_AETHER_PROPOSAL_DIR?.trim();
  return { access: configuredAetherAccess(environment), proposals: directory ? new FileAetherProposalStore(directory, now) : null, studyScopeKey: aetherStudyScope(environment) };
}
