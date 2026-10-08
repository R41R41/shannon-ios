import type { ApiRequest, ApiResponse } from '../../../contracts/contracts.js';
import type { TaskNodeDraft, TaskTree, TaskTreeOperations, TaskTreeOwnerChange } from './taskTreePorts.js';

/** Installed only in the existing owner-authenticated/private-audience route chain. */
export function taskTreeRoute(trees: TaskTreeOperations | undefined, ownerScope: string, now: () => string) {
  return (request: ApiRequest): ApiResponse | undefined => {
    const match = request.path.match(/^\/v1\/agent\/tasks\/([^/]+)\/tree(?:\/(replan|proposals|approve))?$/u);
    if (!match) return undefined;
    if (!trees) return { status: 503, body: { error: 'TASK_TREE_DISABLED' } };
    const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body as Record<string, unknown> : {};
    const scope = request.method === 'GET' ? request.query?.get('scopeKey') : body.scopeKey;
    if (scope !== ownerScope) return { status: 403, body: { error: 'TASK_TREE_OWNER_ONLY' } };
    const requestTaskId = match[1]!;
    // Only the response's taskId adopts the request spelling. All linked IDs, hashes and stored receipts remain original.
    const publicTree = (tree: TaskTree | null) => tree ? { ...tree, taskId: requestTaskId } : null;
    try {
      return trees.withRequestTaskId(ownerScope, requestTaskId, taskId => {
        if (request.method === 'GET' && !match[2]) {
          const tree = trees.get(ownerScope, taskId);
          const proof = tree ? trees.proofStatus(ownerScope, taskId) : null;
          const verification = proof?.status === 'verified' ? { status: 'verified', evidenceIds: proof.proof.evidenceIds } : { status: proof?.status ?? 'invalid' };
          return tree ? { status: 200, body: { tree: publicTree(tree), verification } } : { status: 404, body: { error: 'TREE_NOT_FOUND' } };
        }
        if (request.method === 'GET' && match[2] === 'proposals') return { status: 200, body: {
          proposals: trees.proposals(ownerScope, taskId).map(proposal => ({ ...proposal, taskId: requestTaskId })) } };
        if (request.method !== 'POST' || !Number.isSafeInteger(body.expectedRevision)) return { status: 400, body: { error: 'TREE_REQUEST_INVALID' } };
        const revision = body.expectedRevision as number;
        if (match[2] === 'replan' && Array.isArray(body.nodes)) return { status: 200, body: { tree: publicTree(trees.replan(ownerScope, taskId, revision, body.nodes as TaskNodeDraft[], now())) } };
        if (match[2] === 'proposals' && body.change && typeof body.change === 'object'
          && (body.operationId === undefined || typeof body.operationId === 'string')) return { status: 201, body: {
            proposal: { ...trees.propose(ownerScope, taskId, revision, body.change as TaskTreeOwnerChange, now(), body.operationId as string | undefined), taskId: requestTaskId } } };
        if (match[2] === 'approve' && typeof body.proposalId === 'string' && typeof body.diffHash === 'string') return { status: 200, body: { tree: publicTree(trees.approve(ownerScope, taskId, body.proposalId, revision, body.diffHash, now())) } };
        return { status: 400, body: { error: 'TREE_REQUEST_INVALID' } };
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'TREE_REQUEST_INVALID';
      if (!code.startsWith('TREE_')) throw error;
      let tree: TaskTree | null = null;
      try { tree = trees.withRequestTaskId(ownerScope, requestTaskId, taskId => trees.get(ownerScope, taskId)); }
      catch (lookupError) { if (!(lookupError instanceof Error) || lookupError.message !== 'TREE_NOT_FOUND') throw lookupError; }
      return { status: code.endsWith('NOT_FOUND') ? 404 : 409, body: { error: code, tree: publicTree(tree) } };
    }
  };
}
