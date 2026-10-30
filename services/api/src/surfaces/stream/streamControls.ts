import type { StreamLedger, CommentRecord } from './streamLedger.js';
import type { StreamMouth } from './streamMouth.js';
import { StreamError } from './streamContract.js';

export function stopStreamLine(mouth: StreamMouth, ledger: StreamLedger,
  give: (record: CommentRecord | undefined, status: 'skipped') => void): void {
  const current = mouth.currentLine();
  if (!current) return;
  mouth.dropAnswering(current.commentIds);
  for (const id of current.commentIds) give(ledger.get(id), 'skipped');
}

export function ignoreStreamViewer(mouth: StreamMouth, ledger: StreamLedger, commentId: string): void {
  const record = ledger.get(commentId);
  if (!record) throw new StreamError(404, 'STREAM_COMMENT_UNKNOWN');
  mouth.dropAnswering(ledger.ignore(record.authorId).map(item => item.commentId));
}
