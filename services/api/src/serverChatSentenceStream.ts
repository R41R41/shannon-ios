import type { ServerResponse } from 'node:http';
import { chatSentenceStreamLines, chatSentenceStreamRequested } from './chatSentenceStream.js';
import type { ApiResponse } from './contracts.js';
import { startStream, writeEvent } from './serverLiveVoiceStreamRoute.js';

/**
 * Answers an opted-in, successful `/v1/chat` turn as NDJSON and returns true. Returns false,
 * having written nothing, for every other request; the caller then sends the JSON document
 * as before. The turn is already stored when this is called, so a reader that goes away
 * loses only the lines, and nothing here may throw into the request handler once the
 * headers are out.
 */
export async function sendChatSentenceStream(
  response: ServerResponse, path: string, body: unknown, result: ApiResponse,
): Promise<boolean> {
  if (result.status !== 200 || !chatSentenceStreamRequested(path, body)) return false;
  const lines = chatSentenceStreamLines(result);
  if (response.destroyed) return true;
  startStream(response);
  try {
    for (const line of lines) {
      // A write to a closed connection would wait for a drain that never comes.
      if (response.destroyed) return true;
      await writeEvent(response, line);
    }
  } catch (error) {
    // A reader that went away is not a failure; anything else ends the stream with one error line.
    if (response.destroyed) return true;
    console.warn('Shannon chat sentence stream failed', { name: error instanceof Error ? error.name : 'UnknownError' });
    await writeEvent(response, { type: 'error', status: 502, error: 'STREAM_FAILED' }).catch(() => {});
  } finally {
    if (!response.destroyed) response.end();
  }
  return true;
}
