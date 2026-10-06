import type { HostOperation } from './store/hostFolderOperationsStore.js';

/**
 * The `result` a v2 device reports for an operation (`docs/host-folder-contract.md`, 「Operations」), checked
 * field by field against its shape and bounds. Anything else is refused, so nothing but these values can come
 * back from her folder. Pure.
 */
export const HOST_RESULT_LIMITS = Object.freeze({
  readBytes: 262_144, listEntries: 500, searchHits: 50, snippetCharacters: 160, pathCharacters: 240, trashCharacters: 400,
  /** A report body: a read of 256 KiB, escaped. */
  reportBodyBytes: 640 * 1024,
});

export interface ListResult { entries: readonly { path: string; type: 'file' | 'folder'; bytes?: number; modifiedAt: string }[]; truncated: boolean }
export interface ReadResult { content: string; offset: number; nextOffset: number | null; totalBytes: number; sha256: string; modifiedAt: string }
export interface SearchResult { hits: readonly { path: string; line: number | null; snippet: string }[]; filesScanned: number; truncated: boolean }
export interface WriteResult { sha256?: string; trashedAs?: string }
export type HostOperationResult = ListResult | ReadResult | SearchResult | WriteResult;

export function validHostOperationResult(operation: HostOperation, value: unknown): { result: HostOperationResult } | { problem: string } {
  const object = record(value);
  if (!object) return { problem: 'result must be an object' };
  const only = (...keys: string[]) => Object.keys(object).find(key => !keys.includes(key));
  switch (operation) {
    case 'list': {
      const extra = only('entries', 'truncated');
      if (extra) return { problem: `${extra.slice(0, 40)} is not allowed` };
      if (!Array.isArray(object.entries) || object.entries.length > HOST_RESULT_LIMITS.listEntries || typeof object.truncated !== 'boolean') return { problem: 'entries or truncated is invalid' };
      const entries: ListResult['entries'][number][] = [];
      for (const raw of object.entries) {
        const entry = record(raw);
        if (!entry || Object.keys(entry).some(key => !['path', 'type', 'bytes', 'modifiedAt'].includes(key))) return { problem: 'an entry is invalid' };
        if (!pathString(entry.path) || (entry.type !== 'file' && entry.type !== 'folder') || !timestamp(entry.modifiedAt)
          || (entry.bytes !== undefined && !count(entry.bytes))) return { problem: 'an entry is invalid' };
        entries.push({ path: entry.path as string, type: entry.type, ...(entry.bytes !== undefined ? { bytes: entry.bytes as number } : {}), modifiedAt: entry.modifiedAt as string });
      }
      return { result: { entries, truncated: object.truncated } };
    }
    case 'read': {
      const extra = only('content', 'offset', 'nextOffset', 'totalBytes', 'sha256', 'modifiedAt');
      if (extra) return { problem: `${extra.slice(0, 40)} is not allowed` };
      if (typeof object.content !== 'string' || Buffer.byteLength(object.content, 'utf8') > HOST_RESULT_LIMITS.readBytes) return { problem: 'content is invalid' };
      if (!count(object.offset) || !count(object.totalBytes) || (object.nextOffset !== null && !count(object.nextOffset))
        || !sha(object.sha256) || !timestamp(object.modifiedAt)) return { problem: 'read fields are invalid' };
      return { result: { content: object.content, offset: object.offset as number, nextOffset: object.nextOffset as number | null, totalBytes: object.totalBytes as number, sha256: object.sha256 as string, modifiedAt: object.modifiedAt as string } };
    }
    case 'search': {
      const extra = only('hits', 'filesScanned', 'truncated');
      if (extra) return { problem: `${extra.slice(0, 40)} is not allowed` };
      if (!Array.isArray(object.hits) || object.hits.length > HOST_RESULT_LIMITS.searchHits || !count(object.filesScanned) || typeof object.truncated !== 'boolean') return { problem: 'search fields are invalid' };
      const hits: SearchResult['hits'][number][] = [];
      for (const raw of object.hits) {
        const hit = record(raw);
        if (!hit || Object.keys(hit).some(key => !['path', 'line', 'snippet'].includes(key)) || !pathString(hit.path)
          || (hit.line !== null && !count(hit.line)) || typeof hit.snippet !== 'string' || hit.snippet.length > HOST_RESULT_LIMITS.snippetCharacters) return { problem: 'a hit is invalid' };
        hits.push({ path: hit.path as string, line: hit.line as number | null, snippet: hit.snippet });
      }
      return { result: { hits, filesScanned: object.filesScanned as number, truncated: object.truncated } };
    }
    case 'create': case 'update': case 'move': case 'delete': {
      const allowed = operation === 'create' ? ['sha256'] : operation === 'update' ? ['sha256', 'trashedAs'] : operation === 'delete' ? ['trashedAs'] : [];
      const extra = only(...allowed);
      if (extra) return { problem: `${extra.slice(0, 40)} is not allowed` };
      if ((operation === 'create' || operation === 'update') && !sha(object.sha256)) return { problem: 'sha256 is invalid' };
      if ((operation === 'update' || operation === 'delete') && !trash(object.trashedAs)) return { problem: 'trashedAs is invalid' };
      return { result: { ...(object.sha256 !== undefined ? { sha256: object.sha256 as string } : {}), ...(object.trashedAs !== undefined ? { trashedAs: object.trashedAs as string } : {}) } };
    }
  }
}

/** What the owner's record may say about a result: counts and the trash location, never content. */
export function resultFacts(operation: HostOperation, result: HostOperationResult | undefined): string {
  if (!result) return '';
  if (operation === 'list') return `（${(result as ListResult).entries.length}件${(result as ListResult).truncated ? '以上' : ''}）`;
  if (operation === 'read') return `（${(result as ReadResult).totalBytes}バイト）`;
  if (operation === 'search') return `（${(result as SearchResult).hits.length}件）`;
  const trashed = (result as WriteResult).trashedAs;
  return trashed ? `。元のものは「${trashed}」にあります` : '';
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function count(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}
function pathString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= HOST_RESULT_LIMITS.pathCharacters && !/[\u0000-\u001f]/u.test(value);
}
function timestamp(value: unknown): boolean {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}
function sha(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}
function trash(value: unknown): boolean {
  return typeof value === 'string' && value.length <= HOST_RESULT_LIMITS.trashCharacters && /^\.shannon\/trash\//u.test(value) && !/[\u0000-\u001f]/u.test(value);
}
