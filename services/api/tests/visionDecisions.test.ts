import { describe, expect, it } from 'vitest';
import {
  OpenAIVisionDecisions, VisionDecisionsError, parsedVisionAnswers, visionDecisionsBody, visionDecisionsUsage,
} from '../src/infra/models/openAIVisionDecisions.js';
import { syntheticJpeg } from './support/visionWorld.js';

// The wire shape of the Decisions call, as the synthetic measurement of 2026-10-14 received it (docs: shannon-model-routing-cost.md).
const request = {
  context: 'closed context', image: { mimeType: 'image/jpeg' as const, bytes: syntheticJpeg(64) },
  predicate: { name: 'needs_response', instructions: 'p' },
  choice: { name: 'vision_notice', instructions: 'c', candidates: [{ id: 'quiet', description: 'q' }, { id: 'react:smile', description: 's' }] },
};
const measured = {
  model: 'gpt-6-luna',
  usage: { input_tokens: 602, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 602 },
  answers: [
    { type: 'predicate', name: 'needs_response', probability: 0.01 },
    { type: 'choice', name: 'vision_notice', choice: 'quiet', probabilities: [{ value: 'quiet', probability: 0.56 }, { value: 'react:smile', probability: 0.03 }], confidence: 0.54 },
  ],
};

describe('Decisions: predicate and choice in one request', () => {
  it('sends one user message with the text and one low-detail data-URL image, and the two questions', () => {
    const body = visionDecisionsBody(request) as { input: Array<{ content: Array<Record<string, unknown>> }>; questions: Array<Record<string, unknown>> };
    expect(body).toMatchObject({ model: 'gpt-6-luna' });
    expect(body.input[0]!.content[1]).toMatchObject({ type: 'input_image', detail: 'low' });
    expect(String(body.input[0]!.content[1]!.image_url)).toMatch(/^data:image\/jpeg;base64,/u);
    expect(body.questions.map(question => question.type)).toEqual(['predicate', 'choice']);
    // /v1/decisions refuses `store` (400 unknown_parameter, probed 2026-10-14); its retention is the account's (docs/vision-contract.md).
    expect(Object.keys(body).sort()).toEqual(['input', 'model', 'questions']);
  });

  it('reads the measured answer and usage', () => {
    expect(parsedVisionAnswers(measured, request)).toEqual({ predicate: 0.01, refused: false,
      choice: { id: 'quiet', confidence: 0.54, probabilities: [{ id: 'quiet', probability: 0.56 }, { id: 'react:smile', probability: 0.03 }] } });
    expect(visionDecisionsUsage(measured, 0.001)).toEqual({ usageComplete: true, inputTokens: 602, estimatedCostUsd: 602 * 0.1 / 1_000_000 });
    expect(visionDecisionsUsage({ ...measured, usage: { input_tokens: 602 } }, 0.001)).toMatchObject({ usageComplete: false, estimatedCostUsd: 0.001 });
  });

  it('refuses an answer outside the candidates and treats a refusal as none', () => {
    const outside = { ...measured, answers: [measured.answers[0], { ...measured.answers[1], choice: 'speak' }] };
    expect(() => parsedVisionAnswers(outside, request)).toThrow(VisionDecisionsError);
    const refusal = { ...measured, answers: [measured.answers[0], { type: 'refusal', name: 'vision_notice' }] };
    expect(parsedVisionAnswers(refusal, request)).toEqual({ predicate: null, choice: null, refused: true });
  });

  it('never retries, and keeps the usage it knows on failure', async () => {
    let calls = 0;
    const client = new OpenAIVisionDecisions({ apiKey: 'test-key', unknownCostUpperBoundUsd: 0.001,
      fetcher: async () => { calls += 1; return new Response(JSON.stringify({ error: 'x' }), { status: 500 }); } });
    await expect(client.decide({ ...request, signal: new AbortController().signal })).rejects.toMatchObject({ code: 'http_error' });
    expect(calls).toBe(1);
    const ok = new OpenAIVisionDecisions({ apiKey: 'test-key', unknownCostUpperBoundUsd: 0.001, fetcher: async () => new Response(JSON.stringify(measured)) });
    await expect(ok.decide({ ...request, signal: new AbortController().signal })).resolves.toMatchObject({ predicate: 0.01, usage: { inputTokens: 602 } });
  });
});
