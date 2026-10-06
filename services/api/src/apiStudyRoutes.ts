import type { ApiRequest, ApiResponse } from './contracts/contracts.js';
import { badRequest, objectBody, validScopeKey } from './apiValidation.js';
import type { StudyDesk } from './studyDesk.js';
import { STUDY_LIMITS, STUDY_REACTION_LABEL, type StudyReaction, type StudyRejection } from './studyStore.js';

/**
 * Owner-facing routes of Shannon's study. The owner reads what she is willing to show,
 * leaves a reaction, or asks her to put a piece away. No route writes or edits her text,
 * and none lets a client write as Shannon.
 *
 * With Aether configured (Syzygy ADR-0007 revised) her stories are served from Aether through this server: the reads
 * bring in what Aether has first, the shapes stay what they were with additive fields (`source`, `aetherDocumentId`,
 * `aetherVersion`), and `{id}` may be the piece's id or its Aether document id. A reaction stays in Shannon, keyed by the
 * Aether document and version the owner read.
 */
export function dispatchStudyRequest(request: ApiRequest, study: StudyDesk): ApiResponse | Promise<ApiResponse> | undefined {
  if (request.method === 'GET') {
    const scopeKey = request.query?.get('scopeKey');
    if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');
    if (request.path === '/v1/autonomy/study') {
      return study.aetherCovers(scopeKey) ? study.overviewFresh(scopeKey).then(body => ({ status: 200, body })) : { status: 200, body: study.overview(scopeKey) };
    }
    const pieceMatch = request.path.match(/^\/v1\/autonomy\/study\/pieces\/([^/]+)$/u);
    if (!pieceMatch) return undefined;
    const id = decodeURIComponent(pieceMatch[1] ?? '');
    return study.aetherCovers(scopeKey) ? study.pieceFresh(scopeKey, id).then(result) : result(study.piece(scopeKey, id));
  }

  if (request.method !== 'POST') return undefined;
  if (!objectBody(request.body)) return badRequest('JSON object body is required');
  const scopeKey = request.body.scopeKey;
  if (!validScopeKey(scopeKey)) return badRequest('scopeKey is required');

  const reactionMatch = request.path.match(/^\/v1\/autonomy\/study\/pieces\/([^/]+)\/reaction$/u);
  if (reactionMatch) {
    const reaction = request.body.reaction;
    if (typeof reaction !== 'string' || !(reaction in STUDY_REACTION_LABEL)) return badRequest('reaction is invalid');
    const comment = request.body.comment;
    if (comment !== undefined && (typeof comment !== 'string' || comment.length > STUDY_LIMITS.comment)) return badRequest('comment is invalid');
    return result(study.react(scopeKey, study.resolve(scopeKey, decodeURIComponent(reactionMatch[1] ?? '')), reaction as StudyReaction, comment?.trim() || undefined));
  }

  const putAwayMatch = request.path.match(/^\/v1\/autonomy\/study\/pieces\/([^/]+)\/put-away$/u);
  if (putAwayMatch) return result(study.putAway(scopeKey, study.resolve(scopeKey, decodeURIComponent(putAwayMatch[1] ?? ''))));
  return undefined;
}

function result(value: object | StudyRejection): ApiResponse {
  if (typeof value !== 'string') return { status: 200, body: value };
  if (value === 'STUDY_NOT_FOUND') return { status: 404, body: { error: value } };
  if (value === 'STUDY_INVALID') return { status: 400, body: { error: value } };
  return { status: 409, body: { error: value } };
}
