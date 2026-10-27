import { encodePng, type RgbaImage } from './png.js';

/**
 * The three OpenAI calls of a mini pose: drawing (images/edits with reference pictures), reading (a small vision model that writes
 * a pose's description or inspects a drawing) and embedding (to find the closest pictures). Each reports its seconds and its cost.
 */
export const MINI_IMAGE_MODEL = 'gpt-image-2.5-flare';
export const MINI_READ_MODEL = 'gpt-5.6-luna';
export const MINI_EMBED_MODEL = 'text-embedding-3-small';
const EMBED_DIMENSIONS = 256;

/** gpt-image-2.5 token prices (USD per million): text in 5, image in 8, image out 30. */
const IMAGE_PRICE = { text: 5, imageIn: 8, imageOut: 30 };
/** gpt-5.6-luna (`llmUsage.ts`): in 0.2, out 1.2. text-embedding-3-small: 0.02. */
const READ_PRICE = { input: 0.2, output: 1.2 };
const EMBED_PRICE = 0.02;

export interface Measured<T> { value: T; seconds: number; costUsd: number }

export interface MiniModels {
  /** `size` defaults to 1024x1024 (a walk's sheet is wider). */
  draw(request: { prompt: string; images: readonly Uint8Array[]; quality: 'low' | 'medium' | 'high'; size?: string }): Promise<Measured<Uint8Array>>;
  read(request: { instructions: string; text: string; images?: readonly RgbaImage[] }): Promise<Measured<unknown>>;
  embed(texts: readonly string[]): Promise<Measured<number[][]>>;
}

export class OpenAIMiniModels implements MiniModels {
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: { apiKey: string; fetcher?: typeof fetch; imageModel?: string; readModel?: string }) {
    if (!options.apiKey.trim()) throw new Error('OPENAI_API_KEY is required');
    this.fetcher = options.fetcher ?? fetch;
  }

  async draw(request: { prompt: string; images: readonly Uint8Array[]; quality: 'low' | 'medium' | 'high'; size?: string }): Promise<Measured<Uint8Array>> {
    const form = new FormData();
    form.append('model', this.options.imageModel ?? MINI_IMAGE_MODEL);
    form.append('prompt', request.prompt);
    form.append('quality', request.quality);
    form.append('size', request.size ?? '1024x1024');
    form.append('background', 'transparent');
    form.append('output_format', 'png');
    request.images.forEach((bytes, index) => form.append('image[]', new Blob([bytes], { type: 'image/png' }), `ref${index}.png`));
    const started = performance.now();
    const response = await retried(() => this.fetcher('https://api.openai.com/v1/images/edits', {
      method: 'POST', headers: { Authorization: `Bearer ${this.options.apiKey}` }, body: form, signal: AbortSignal.timeout(180_000),
    }));
    const body = await response.json() as { data?: { b64_json?: string }[]; usage?: ImageUsage; error?: { code?: string } };
    const seconds = (performance.now() - started) / 1000;
    const b64 = body.data?.[0]?.b64_json;
    if (!response.ok || !b64) throw new Error(`MINI_DRAW_FAILED:${response.status}:${body.error?.code ?? 'no_image'}`);
    return { value: Buffer.from(b64, 'base64'), seconds, costUsd: imageCost(body.usage) };
  }

  async read(request: { instructions: string; text: string; images?: readonly RgbaImage[] }): Promise<Measured<unknown>> {
    // The JSON format needs the word in the input itself, not only in the instructions.
    const content: unknown[] = [{ type: 'input_text', text: `${request.text}

Answer in JSON.` }];
    for (const image of request.images ?? []) content.push({ type: 'input_image', image_url: `data:image/png;base64,${encodePng(image).toString('base64')}` });
    const started = performance.now();
    const response = await retried(() => this.fetcher('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.options.readModel ?? MINI_READ_MODEL, instructions: request.instructions, input: [{ role: 'user', content }],
        text: { format: { type: 'json_object' } }, store: false }),
      signal: AbortSignal.timeout(60_000),
    }));
    const raw = await response.text();
    const seconds = (performance.now() - started) / 1000;
    if (!response.ok) throw new Error(`MINI_READ_FAILED:${response.status}:${raw.slice(0, 200)}`);
    const body = parseJson(raw) as { usage?: { input_tokens?: number; output_tokens?: number } };
    const costUsd = ((body.usage?.input_tokens ?? 0) * READ_PRICE.input + (body.usage?.output_tokens ?? 0) * READ_PRICE.output) / 1e6;
    return { value: parseJson(extractOutputText(body)), seconds, costUsd };
  }

  async embed(texts: readonly string[]): Promise<Measured<number[][]>> {
    const started = performance.now();
    const response = await retried(() => this.fetcher('https://api.openai.com/v1/embeddings', {
      method: 'POST', headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MINI_EMBED_MODEL, input: texts, dimensions: EMBED_DIMENSIONS }), signal: AbortSignal.timeout(20_000),
    }));
    const body = await response.json() as { data?: { embedding: number[]; index: number }[]; usage?: { total_tokens?: number } };
    const seconds = (performance.now() - started) / 1000;
    if (!response.ok || !body.data) throw new Error(`MINI_EMBED_FAILED:${response.status}`);
    const vectors = [...body.data].sort((a, b) => a.index - b.index).map(item => item.embedding);
    return { value: vectors, seconds, costUsd: (body.usage?.total_tokens ?? 0) * EMBED_PRICE / 1e6 };
  }
}

/**
 * A connection reset while a picture uploads happens (a few in a hundred calls from a home line); two more tries before the
 * call counts as failed. Only the network's failures are retried: an answer, even an error status, is final.
 */
async function retried(send: () => Promise<Response>): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try { return await send(); } catch (error) {
      if (!(error instanceof TypeError) || attempt >= 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 2_000 * (attempt + 1)));
    }
  }
}

interface ImageUsage {
  input_tokens_details?: { image_tokens?: number; text_tokens?: number };
  output_tokens?: number;
}

export function imageCost(usage: ImageUsage | undefined): number {
  if (!usage) return 0;
  const imageIn = usage.input_tokens_details?.image_tokens ?? 0, textIn = usage.input_tokens_details?.text_tokens ?? 0;
  return (textIn * IMAGE_PRICE.text + imageIn * IMAGE_PRICE.imageIn + (usage.output_tokens ?? 0) * IMAGE_PRICE.imageOut) / 1e6;
}

// The Responses helpers of `chatModelSupport.ts`, kept here so this folder imports nothing of the conversation (the seed script
// bundles it alone).
function parseJson(raw: string): unknown {
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new Error('OPENAI_RESPONSE_NON_JSON'); }
}

function extractOutputText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const direct = (value as { output_text?: unknown }).output_text;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const output = (value as { output?: unknown }).output;
  if (!Array.isArray(output)) return '';
  const parts: string[] = [];
  for (const item of output) {
    const content = item && typeof item === 'object' ? (item as { content?: unknown }).content : null;
    if (!Array.isArray(content)) continue;
    for (const row of content as { type?: unknown; text?: unknown }[]) if (row?.type === 'output_text' && typeof row.text === 'string') parts.push(row.text);
  }
  return parts.join('').trim();
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { dot += a[i]! * b[i]!; na += a[i]! ** 2; nb += b[i]! ** 2; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
