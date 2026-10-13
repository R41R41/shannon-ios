import { describe, expect, it } from 'vitest';
import { BODY_REACTION_LIMITS } from '../src/contracts/bodyReactionContract.js';
import { structuredBody } from '../src/infra/models/claude/claudeStructured.js';
import { OpenAIBodyReactionSpeaker, TOUCH_OUTPUT_TOKENS } from '../src/surfaces/body/bodyReactionModel.js';

/**
 * Production 2026-10-14 08:08 and 08:10 JST: two chest pokes of the Windows body went quiet. Their decisions took 3.99 s and
 * 3.81 s, past the 3.8 s deadline, and were aborted (no usage row); answered ones took 2.1–3.4 s. The touch asked for effort
 * `none`, which the background route maps to adaptive thinking at `low` with a ceiling of at least 1,024 tokens.
 */
describe('a touch is decided without thinking', () => {
  it('asks the model for no thinking and a small ceiling', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const fetcher: typeof fetch = async (_input, init) => {
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'synthetic' } }),
        { status: 500, headers: { 'content-type': 'application/json' } });
    };
    const speaker = new OpenAIBodyReactionSpeaker({ apiKey: 'synthetic-key', model: 'claude-haiku-5-5', fetcher });
    await expect(speaker.decide({ scopeKey: 'owner', prompt: '合成された指示', signal: new AbortController().signal, stance: true }))
      .rejects.toThrow(/BODY_REACTION_UPSTREAM/u);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0]).toMatchObject({ thinking: { type: 'disabled' }, max_tokens: TOUCH_OUTPUT_TOKENS });
    expect(TOUCH_OUTPUT_TOKENS).toBeLessThan(1_024);
  });

  it('leaves every other caller of the background route as it was', () => {
    // `none` still means adaptive thinking at `low` with at least 1,024 tokens for the turn checker, sleep, memory and the rest.
    const body = structuredBody('claude-haiku-5-5', '指示', '入力', { type: 'object', properties: {}, additionalProperties: false }, 'none', 160);
    expect(body).toMatchObject({ thinking: { type: 'adaptive' }, max_tokens: 1_024, output_config: { effort: 'low' } });
    const quick = structuredBody('claude-haiku-5-5', '指示', '入力', null, 'none', 200, false, 'disabled');
    expect(quick).toMatchObject({ thinking: { type: 'disabled' }, max_tokens: 200, output_config: { effort: 'low' } });
  });

  it('keeps the deadline inside the body\'s own wait', () => {
    // The body waits 4.5 s and discards anything later: the server answers by 3.8 s (at most 4.0) whatever the model does.
    expect(BODY_REACTION_LIMITS.deadlineMillisecondsDefault).toBe(3_800);
    expect(BODY_REACTION_LIMITS.deadlineMillisecondsMaximum).toBeLessThan(4_500);
  });
});
