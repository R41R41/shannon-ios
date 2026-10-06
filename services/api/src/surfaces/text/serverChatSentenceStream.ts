import type { ServerResponse } from 'node:http';
import {
  chatSentenceStreamLines,
  chatSentenceStreamRequested,
  chatStreamEarlyEnabled,
  sameChatStreamLine,
} from './chatSentenceStream.js';
import type { ApiRequest, ApiResponse, ChatStreamLine } from '../../contracts/contracts.js';
import { startStream, writeEvent } from '../voice/serverLiveVoiceStreamRoute.js';
import { serverEnvironment } from '../../infra/config/serverEnvironment.js';

/**
 * `kernel.dispatch` for the generic route, answering an opted-in `/v1/chat` turn as NDJSON.
 *
 * Returns the kernel's response for the caller to send as JSON — every request that did not
 * opt in, and every opted-in one that failed before a line was written — or null when the
 * response was written here. An exception before the first line is thrown on, as before.
 *
 * The turn never waits for the reader and is never stopped by it: lines are queued, a reader
 * that goes away loses only lines, and nothing here throws once the headers are out.
 */
export async function dispatchWithChatSentences(
  kernel: { dispatch(request: ApiRequest): Promise<ApiResponse> },
  response: ServerResponse,
  request: ApiRequest,
  environment: Readonly<Record<string, string | undefined>> = serverEnvironment(),
): Promise<ApiResponse | null> {
  if (!chatSentenceStreamRequested(request.path, request.body)) return kernel.dispatch(request);

  const sent: ChatStreamLine[] = [];
  let failed = false;
  let queue = Promise.resolve();
  const write = (line: ChatStreamLine): void => {
    queue = queue.then(async () => {
      // A write to a closed connection would wait for a drain that never comes.
      if (failed || response.destroyed) return;
      try {
        startStream(response);
        await writeEvent(response, line);
        sent.push(line);
      } catch {
        failed = true;
      }
    });
  };
  const finish = async (error?: { status: number; error: string }): Promise<null> => {
    await queue;
    if (response.destroyed) return null;
    if (error || failed) {
      if (failed) console.warn('Shannon chat sentence stream failed', { name: 'WriteError' });
      await writeEvent(response, { type: 'error', ...(error ?? { status: 502, error: 'STREAM_FAILED' }) }).catch(() => {});
    }
    response.end();
    return null;
  };

  let result: ApiResponse;
  try {
    result = await kernel.dispatch(chatStreamEarlyEnabled(environment) ? { ...request, chatSentences: { write } } : request);
  } catch (error) {
    await queue;
    if (!response.headersSent) throw error;
    // Sentences of this turn were shown and the turn was rejected: nothing of it is stored.
    console.error('Shannon request failed', error instanceof Error ? error.name : 'UnknownError');
    return finish({ status: 502, error: 'MODEL_UNAVAILABLE' });
  }
  await queue;
  if (result.status !== 200) {
    if (!response.headersSent && !failed) return result;
    return finish({ status: result.status, error: 'STREAM_FAILED' });
  }
  if (response.destroyed) return null;
  const lines = chatSentenceStreamLines(result);
  // What went out while the model wrote must be the beginning of the finished turn's lines.
  if (!sent.every((line, index) => sameChatStreamLine(line, lines[index]))) {
    console.warn('Shannon chat sentence stream failed', { name: 'EarlyLinesDiffer' });
    return finish({ status: 502, error: 'STREAM_FAILED' });
  }
  if (!failed) for (const line of lines.slice(sent.length)) write(line);
  return finish();
}
