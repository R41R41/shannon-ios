import { recordRequest, recordResponse } from './decisionRecordNotes.js';
import type { RequestKind } from './decisionRecorder.js';

/** What a model adapter calls: the provider's `messages.create`. */
export interface RecordableClient {
  messages: { create(...args: never[]): PromiseLike<unknown> };
}
interface CallOptions { signal?: AbortSignal; headers?: Record<string, string> }

/**
 * The model's client, seen by the decision records: the request that goes out is written first (all of it, as it goes), and the answer or the error
 * when the call ends. Everything else passes through unchanged, and the call is made exactly as before, in the same turn; a record that cannot be
 * written changes nothing. Without a recorder, or outside a recorded step, it is the client itself.
 */
export function recordedClient<T extends RecordableClient>(client: T, kind: RequestKind): T {
  const wrapped = { messages: { create(body: never, options: never): PromiseLike<unknown> {
    const settings = options as CallOptions | undefined, beta = settings?.headers?.['anthropic-beta'];
    const id = recordRequest(kind, body as Readonly<Record<string, unknown>>, beta ? { 'anthropic-beta': beta } : undefined);
    if (!id) return client.messages.create(body, options);
    let call: PromiseLike<unknown>;
    try { call = client.messages.create(body, options); } catch (error) {
      recordResponse(id, { error, signal: settings?.signal });
      throw error;
    }
    return Promise.resolve(call).then(message => {
      recordResponse(id, { message: message as Readonly<Record<string, unknown>> });
      return message;
    }, (error: unknown) => {
      recordResponse(id, { error, signal: settings?.signal });
      throw error;
    });
  } } };
  return wrapped as unknown as T;
}
