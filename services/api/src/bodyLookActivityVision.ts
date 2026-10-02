import { roomLookNotePrompt } from './autonomyLoopPrompts.js';
import { AUTONOMY_ROOM_LOOK_TOKENS, autonomyModel } from './autonomyModels.js';
import { dedicatedAutonomyCredential } from './autonomyTextModel.js';
import { boundedLookMessage, type RoomLookViewRequest, type RoomLookViewer } from './bodyLookVision.js';

/**
 * Seeing, for a look she takes in her own time (stage 2). The frame arrives at the API
 * process, so the call is made here, but it is her own activity: it uses the dedicated
 * autonomy key and never the conversation key, calls the one model the gate priced, and
 * hands the tokens back so the activity loop charges them to her daily budget. Nothing is
 * booked on the conversation account.
 *
 * The frame is the only material: no line of a Talk is sent with it. It is never written
 * anywhere; this module has no store and no log line.
 */
export interface ActivityRoomLookViewerOptions {
  /** The dedicated autonomy key of the provider. */
  apiKey: string;
  /** Receives what the provider counted, also when the call produced no usable text. */
  usage: (scopeKey: string, lookId: string, usage: { inputTokens: number; outputTokens: number }) => void;
  endpoint?: string;
  timeoutMilliseconds?: number;
  fetcher?: typeof fetch;
}

const MODEL_ID = /^[A-Za-z0-9._-]{1,100}$/u;

export class GeminiActivityRoomLookViewer implements RoomLookViewer {
  private readonly endpoint: string;
  private readonly timeoutMilliseconds: number;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: ActivityRoomLookViewerOptions) {
    if (!options.apiKey.trim()) throw new Error('SHANNON_AUTONOMY_GEMINI_API_KEY is required');
    this.endpoint = (options.endpoint ?? 'https://generativelanguage.googleapis.com/v1beta/models').replace(/\/$/u, '');
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 20_000;
    this.fetcher = options.fetcher ?? fetch;
  }

  async see(request: RoomLookViewRequest): Promise<string> {
    const own = request.activity;
    // Only a look her activity opened, and only the registry model the gate priced.
    if (!own || !MODEL_ID.test(own.model) || autonomyModel(own.model)?.provider !== 'google') throw new Error('ROOM_LOOK_MODEL_NOT_ALLOWED');
    const prompt = roomLookNotePrompt();
    let response: Response;
    try {
      response = await this.fetcher(`${this.endpoint}/${own.model}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': this.options.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: prompt.system }] },
          contents: [{ role: 'user', parts: [
            { text: prompt.prompt },
            { inlineData: { mimeType: request.image.mediaType, data: request.image.base64 } },
          ] }],
          generationConfig: { maxOutputTokens: AUTONOMY_ROOM_LOOK_TOKENS.output },
        }),
        signal: AbortSignal.timeout(this.timeoutMilliseconds),
      });
    } catch {
      // The cause may quote the request; only the fact of the failure leaves this function.
      throw new Error('ROOM_LOOK_UPSTREAM_FAILED');
    }
    let json: unknown = null;
    try { json = JSON.parse(await response.text()) as unknown; } catch { json = null; }
    if (!response.ok) throw new Error(`ROOM_LOOK_UPSTREAM_${response.status}`);
    const metadata = object(object(json)?.usageMetadata);
    // Reasoning tokens are billed as output. Without a count from the provider nothing is handed back, and the loop charges its estimate.
    if (count(metadata?.promptTokenCount) > 0) {
      this.options.usage(request.scopeKey, own.lookId, {
        inputTokens: count(metadata?.promptTokenCount),
        outputTokens: count(metadata?.candidatesTokenCount) + count(metadata?.thoughtsTokenCount),
      });
    }
    const candidates = object(json)?.candidates;
    const parts = Array.isArray(candidates) ? object(object(candidates[0])?.content)?.parts : undefined;
    const text = boundedLookMessage(Array.isArray(parts)
      ? parts.map(part => (object(part)?.thought === true ? '' : object(part)?.text)).filter((value): value is string => typeof value === 'string').join('')
      : '');
    if (!text) throw new Error('ROOM_LOOK_EMPTY');
    return text;
  }
}

/** Uses the dedicated autonomy key (`SHANNON_AUTONOMY_GEMINI_API_KEY`). Without it, or when it repeats the conversation key, there is no viewer. */
export function createConfiguredActivityRoomLookViewer(
  environment: Readonly<Record<string, string | undefined>>,
  usage: ActivityRoomLookViewerOptions['usage'],
  fetcher?: typeof fetch,
): RoomLookViewer | null {
  const apiKey = dedicatedAutonomyCredential('google', environment);
  if (!apiKey) return null;
  return new GeminiActivityRoomLookViewer({ apiKey, usage, endpoint: environment.SHANNON_AUTONOMY_GEMINI_ENDPOINT?.trim() || undefined, fetcher });
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}
