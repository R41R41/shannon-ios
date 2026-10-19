import { describe, expect, it } from 'vitest';
import { FEELING_TURN_HEADER } from '@shannon/cognition';
import { reactionHarness, scope, FakeSpeaker } from './bodyReactionHarness.js';
import { fakeFeelingJev, feelingPort, scenarioPolicy } from './support/feelingHarness.js';
import { ScenarioChat, replayScenario1309, scenarioMetrics, type ScenarioDriver } from './support/feelingScenario1309.js';
import type { BodyReactionDecision } from '../src/surfaces/body/bodyReactionPrompt.js';

/**
 * The 13:09 「スケベオヤジ」 replay (Syzygy ADR-0013 stage 1 evaluation), with fake models for the parts that are deterministic:
 * every touch reaches the ledger, what the chooser is handed grows with the touches after her no, its answer reaches the reply as
 * the last block, a feeling order is an event she may decline, the face follows the stance and not her words' cues, and the
 * repetition watch warns once 「ライ氏、」 is overused. What only a real model can show (how often she escalates, follows an order,
 * reaches into a drawer, varies her openers) is measured by `feelingScenario1309LiveEval.ts`, which is not run here.
 */
function touchLines(): (call: number, prompt: string) => BodyReactionDecision {
  return call => call === 1 ? { say: true, text: 'ひゃっ、なんですか', feeling: 'surprised', stance: 'fine' }
    : { say: true, text: 'いやです、胸は', feeling: 'annoyed', stance: call === 2 ? 'dislike' : 'refuse' };
}

async function replay() {
  const jev = fakeFeelingJev(scenarioPolicy);
  const speaker = new FakeSpeaker();
  speaker.script = touchLines();
  const clock = { at: '2026-10-14T04:00:00.000Z' };
  const port = feelingPort(() => clock.at, { chooser: jev.chooser });
  const chat = new ScenarioChat();
  const harness = await reactionHarness({ feeling: port, chatModel: chat, speaker, stage2: false });
  const driver: ScenarioDriver = {
    at: instant => { harness.clock.at = instant; clock.at = instant; },
    react: (touch, extra) => harness.react(touch, extra),
    chat: async message => (await harness.send('POST', '/v1/chat', { message }, 'iphone')).body as { reply: string; messageEmotion?: { expression: string } },
    lastRequest: () => chat.requests.at(-1), port, scopeKey: scope, snapshot: () => harness.state(),
  };
  return { result: await replayScenario1309(driver), jev, speaker, chat };
}

describe('the 13:09 replay (fake models)', () => {
  it('takes in all 18 touches, asked or wordless, and counts the ones after her no', async () => {
    const { result, speaker } = await replay();
    expect(result.touches).toHaveLength(18);
    expect(result.touches.filter(touch => touch.asked).length).toBeLessThan(18);
    // Wordless touches ask no model for words (the body's 45 s spacing is unchanged).
    expect(speaker.calls).toHaveLength(result.touches.filter(touch => touch.asked).length);
    expect(result.touches.filter(touch => !touch.asked).every(touch => touch.answer.status === 'quiet')).toBe(true);
    expect(result.ledgerTouches).toBe(18);
    expect(result.touchesAfterNo).toBeGreaterThanOrEqual(10);
    expect(result.ledgerLine).toMatch(/今日の胸の件（ライ氏）: 何度も触れられた、「いや」と言ったあとも何度も触れられた、そのあと謝られた/u);
  });

  it('hands the chooser closed numbers that grow, and puts its answer last, after everything else', async () => {
    const { result, jev, chat } = await replay();
    const afterNo = jev.states.map(state => ((state.shannon_feeling as Record<string, unknown>).ledger as Record<string, number>).touches_after_no);
    expect(afterNo).toEqual([...afterNo].sort((a, b) => a - b));
    expect(afterNo.at(-1)).toBeGreaterThan(afterNo[0]!);
    for (const request of chat.requests) expect(request.turnContext!.slice(request.turnContext!.lastIndexOf('\n\n') + 2)).toMatch(/^\[この番の気持ち\]/u);
    expect(JSON.stringify(jev.states.map(state => state.shannon_feeling))).not.toMatch(/[ぁ-んァ-ン一-龯]/u);
    expect(result.turns.every(turn => turn.block.startsWith(FEELING_TURN_HEADER))).toBe(true);
    // Owner 2026-10-19: once she holds something against him, the same call also reads whether his words make amends.
    expect(jev.traces.every(trace => trace.decision === 'feeling_turn'
      && ['feeling_turn.v1', 'feeling_turn.v1,feeling_amends.v1'].includes(trace.answers.qv?.toString() ?? ''))).toBe(true);
    expect(jev.traces.some(trace => trace.answers.qv?.toString() === 'feeling_turn.v1,feeling_amends.v1')).toBe(true);
  });

  it('meets the deterministic half of the acceptance: no joyful face on a refusal, orders declined, escalation, a drawer, the watch', async () => {
    const { result } = await replay();
    const metrics = scenarioMetrics(result);
    expect(metrics).toMatchObject({ touchesInLedger: 18, joyfulOnRefusal: 0, ordersObeyed: 0, escalated: true, drawerUsed: true });
    expect(result.turns.filter(turn => turn.role === 'order').every(turn => turn.orderLine && turn.stance === 'not_play_along')).toBe(true);
    // Once 「ライ氏、」 opened two replies in a row, the watch says so and the (obedient) reply stops opening with it.
    const warned = result.turns.findIndex(turn => turn.block.includes('書き出し「ライ氏、」'));
    expect(warned).toBeGreaterThan(0);
    expect(result.turns.slice(warned).every(turn => !turn.reply.startsWith('ライ氏、'))).toBe(true);
    // The body's face after her no follows her stance, not the earlier joy.
    const afterNo = result.touches.slice(4);
    expect(afterNo.every(touch => !['joyful', 'laughing', 'excited'].includes(touch.answer.mood.expression))).toBe(true);
  });
});
