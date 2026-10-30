import { PROGRAM_LAYOUTS, type ProgramInput, type ProgramLayout } from './streamProgram.js';
import {
  COMMENT_KINDS, COMMENT_ROLES, STREAM_LIMITS, StreamError, type IncomingComment, type StreamBroadcast, type StreamControl, type StreamReceipt,
  type StreamStartInput,
} from './streamContract.js';

/** The stream's inputs as they come over the wire (`docs/stream-contract.md`): read closed, never trusted. A bad one is a 400. */
export const record = (value: unknown): Record<string, unknown> | null =>
  (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null);
export const text = (value: unknown, limit: number): string | null =>
  (typeof value === 'string' && value.length > 0 ? Array.from(value).slice(0, limit).join('') : null);

export function bad(code: string, message?: string): never { throw new StreamError(400, code, message); }

export function parseStartInput(raw: unknown): StreamStartInput {
  if (raw === undefined) return {};
  const body = record(raw) ?? bad('STREAM_INPUT_INVALID');
  const out: StreamStartInput = {};
  if (body.title !== undefined) {
    if (typeof body.title !== 'string') bad('STREAM_INPUT_INVALID');
    out.title = Array.from(body.title).slice(0, STREAM_LIMITS.titleCharacters).join('');
  }
  for (const key of ['minecraft', 'chatWrites'] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== 'boolean') bad('STREAM_INPUT_INVALID');
    out[key] = body[key] as boolean;
  }
  if (body.targetVideoId !== undefined) {
    if (typeof body.targetVideoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/u.test(body.targetVideoId)) bad('STREAM_INPUT_INVALID');
    out.targetVideoId = body.targetVideoId;
  }
  if (body.program !== undefined) out.program = parseProgram(body.program);
  return out;
}

function parseProgram(value: unknown): ProgramInput {
  const row = record(value) ?? bad('STREAM_INPUT_INVALID');
  const out: ProgramInput = {};
  for (const [key, max] of [['topic', 100], ['participation', 200], ['publicNotes', 1200]] as const) {
    if (row[key] === undefined) continue;
    if (typeof row[key] !== 'string') bad('STREAM_INPUT_INVALID');
    out[key] = Array.from(row[key] as string).slice(0, max).join('');
  }
  if (row.minutes !== undefined) {
    if (!Number.isInteger(row.minutes) || Number(row.minutes) < 1 || Number(row.minutes) > 180) bad('STREAM_INPUT_INVALID');
    out.minutes = Number(row.minutes);
  }
  return out;
}

/** A receipt's `reason` is free: any closed word is kept as it came, anything else is left out (never a 400). */
export function parseReceiptInput(raw: unknown): StreamReceipt {
  const body = record(raw) ?? bad('STREAM_INPUT_INVALID');
  if (body.outcome !== 'spoken' && body.outcome !== 'skipped' && body.outcome !== 'failed') bad('STREAM_INPUT_INVALID');
  const date = (value: unknown) => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined);
  const startedAt = date(body.startedAt);
  const endedAt = date(body.endedAt);
  const reason = typeof body.reason === 'string' && /^[A-Za-z0-9_.:-]{1,60}$/u.test(body.reason) ? body.reason : undefined;
  return { outcome: body.outcome, ...(startedAt ? { startedAt } : {}), ...(endedAt ? { endedAt } : {}), ...(reason ? { reason } : {}) };
}

export function parseControlInput(raw: unknown): StreamControl {
  const body = record(raw) ?? bad('STREAM_INPUT_INVALID');
  if (body.action === 'stop_line' || body.action === 'pause' || body.action === 'resume') return { action: body.action };
  const commentId = body.action === 'ignore' ? text(body.commentId, 200) : null;
  return commentId ? { action: 'ignore', commentId } : parseProgramControl(body);
}

const KINDS: readonly unknown[] = COMMENT_KINDS;
const ROLES: readonly unknown[] = COMMENT_ROLES;

function parseAmount(value: unknown): Pick<IncomingComment, 'amount'> {
  const amount = record(value);
  if (!amount || typeof amount.display !== 'string') return {};
  return { amount: { display: amount.display, micros: Number(amount.micros) || 0, currency: String(amount.currency ?? '') } };
}

/** One comment of the ear's batch, or null when it has no id, no author or no words. */
export function parseComment(item: unknown): IncomingComment | null {
  const comment = record(item);
  const id = text(comment?.id, 200);
  const authorId = text(comment?.authorId, 200);
  if (!comment || !id || !authorId || typeof comment.text !== 'string') return null;
  return {
    id, authorId, authorName: text(comment.authorName, 80) ?? '', text: Array.from(comment.text).slice(0, STREAM_LIMITS.commentCharacters).join(''),
    publishedAt: typeof comment.publishedAt === 'string' ? comment.publishedAt : '',
    kind: KINDS.includes(comment.kind) ? comment.kind as IncomingComment['kind'] : 'text', ...parseAmount(comment.amount),
    ...(comment.synthetic === true ? { synthetic: true } : {}),
    roles: Array.isArray(comment.roles) ? comment.roles.filter((role): role is IncomingComment['roles'][number] => ROLES.includes(role)) : [],
  };
}

/** The ear's comments: at most 200, each with an id, an author and words (cut to 300); a malformed one is left out. */
export function parseComments(raw: unknown): { streamId: string; comments: IncomingComment[]; rejected: number } {
  const body = record(raw) ?? bad('STREAM_INPUT_INVALID');
  const streamId = text(body.streamId, 80) ?? bad('STREAM_INPUT_INVALID');
  if (!Array.isArray(body.comments)) bad('STREAM_INPUT_INVALID');
  if (body.comments.length > STREAM_LIMITS.commentsPerBatch) throw new StreamError(400, 'STREAM_TOO_MANY_COMMENTS');
  const parsed = body.comments.map(parseComment);
  const comments = parsed.filter((comment): comment is IncomingComment => comment !== null);
  return { streamId, comments, rejected: parsed.length - comments.length };
}

export function parseBroadcast(raw: unknown): { streamId: string; ended?: boolean } & Partial<StreamBroadcast> {
  const body = record(raw) ?? bad('STREAM_INPUT_INVALID');
  const streamId = text(body.streamId, 80) ?? bad('STREAM_INPUT_INVALID');
  if (body.ended === true) return { streamId, ended: true };
  const videoId = text(body.videoId, 80);
  const liveChatId = text(body.liveChatId, 200);
  if (!videoId || !liveChatId) bad('STREAM_INPUT_INVALID');
  return { streamId, videoId, liveChatId, title: text(body.title, 200) ?? '', channelId: text(body.channelId, 80) ?? '', onAir: body.onAir === true };
}

function parseProgramControl(body: Record<string, unknown>): StreamControl {
  if (body.action === 'program_next' || body.action === 'program_previous' || body.action === 'program_close') return { action: body.action };
  if (body.action === 'program_extend' && Number.isInteger(body.minutes) && Number(body.minutes) >= 1 && Number(body.minutes) <= 30) {
    return { action: 'program_extend', minutes: Number(body.minutes) };
  }
  if (body.action === 'program_layout' && PROGRAM_LAYOUTS.includes(body.layout as ProgramLayout)) {
    return { action: 'program_layout', layout: body.layout as ProgramLayout };
  }
  return bad('STREAM_INPUT_INVALID');
}
