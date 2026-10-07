import type { ApiRequest, ApiResponse } from '../../contracts/contracts.js';
import type { SelfRewriteCandidate } from './selfRewritePorts.js';
import type { SelfRewriteService } from './selfRewriteService.js';

/** Owner-authenticated/private surface. Stored grants cannot be written by a model/tool payload. */
export function selfRewriteRoute(service: SelfRewriteService | null, ownerScope: string, now: () => string) {
  return async (request: ApiRequest): Promise<ApiResponse | undefined> => {
    const prefix = '/v1/autonomy/self-rewrite/'; if (!request.path.startsWith(prefix)) return undefined;
    if (!service) return { status: 503, body: { error: 'SELF_REWRITE_DISABLED' } };
    const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body as Record<string, unknown> : {};
    const scope = request.method === 'GET' ? request.query?.get('scopeKey') : body.scopeKey;
    if (scope !== ownerScope) return { status: 403, body: { error: 'SELF_REWRITE_OWNER_ONLY' } };
    const suffix = request.path.slice(prefix.length);
    const candidate = suffix.match(/^candidates\/([^/]+)(?:\/(approve|dispatch))?$/u);
    const work = suffix.match(/^work\/([^/]+)(?:\/(resume))?$/u);
    try {
      if (request.method === 'POST' && suffix === 'candidates' && body.candidate && typeof body.candidate === 'object') {
        const input = body.candidate as SelfRewriteCandidate;
        if (input.scopeKey !== ownerScope) return { status: 403, body: { error: 'SELF_REWRITE_OWNER_ONLY' } };
        service.submit(input); return { status: 201, body: { candidate: service.store.candidate(ownerScope, input.id) } };
      }
      if (candidate && request.method === 'GET' && !candidate[2]) {
        const value = service.store.candidate(ownerScope, candidate[1]!);
        return value ? { status: 200, body: { candidate: value, work: service.store.work(ownerScope, value.workId) } } : { status: 404, body: { error: 'REWRITE_CANDIDATE_NOT_FOUND' } };
      }
      if (candidate && request.method === 'POST' && candidate[2] === 'approve' && typeof body.diffHash === 'string'
        && typeof body.baseRevision === 'string' && Number.isSafeInteger(body.expectedGeneration)) {
        const granted = service.store.grant(ownerScope, candidate[1]!, body.diffHash, body.baseRevision, body.expectedGeneration as number, now());
        return { status: granted ? 200 : 409, body: { granted } };
      }
      if (candidate && request.method === 'POST' && candidate[2] === 'dispatch') return { status: 200, body: await service.dispatch(ownerScope, candidate[1]!) };
      if (work && request.method === 'GET' && !work[2]) return { status: 200, body: { work: service.store.work(ownerScope, work[1]!) } };
      if (work && request.method === 'POST' && work[2] === 'resume' && Number.isSafeInteger(body.expectedGeneration)) {
        const resumed = service.store.ownerResume(ownerScope, work[1]!, body.expectedGeneration as number, now());
        return { status: resumed ? 200 : 409, body: { resumed } };
      }
      return { status: 400, body: { error: 'REWRITE_REQUEST_INVALID' } };
    } catch (error) {
      const code = error instanceof Error ? error.message : 'REWRITE_REQUEST_INVALID';
      if (!code.startsWith('REWRITE_')) throw error;
      return { status: 409, body: { error: code } };
    }
  };
}
