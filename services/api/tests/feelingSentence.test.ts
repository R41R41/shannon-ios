import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { FEELING_SENTENCE_HEADER, type FeelingSentenceFacts } from '@shannon/cognition';
import { switchOn } from '@shannon/switches';
import { reactionHarness, SECOND } from './bodyReactionHarness.js';
import { composedFeeling, configuredFeeling } from '../src/wiring/feelingWiring.js';
import type { FeelingSentenceWriter } from '../src/infra/models/feelingSentenceModel.js';
import { installObserverSink, withObserverRun } from '../src/infra/observer/observerContext.js';

/**
 * Her feeling sentence (Syzygy ADR-0013 D7, stage 2 item 3; `SHANNON_FEELING_SENTENCE`): in a strong text scene with the owner alone,
 * Haiku's two or three lines stand after the feeling turn's block; at most about 1 s is waited for them; otherwise nothing changes.
 */
const DAY = '2026-10-14T04:00:00.000Z';

function fakeWriter(lines: readonly string[] | null, delay = 0) {
  const asked: FeelingSentenceFacts[] = [];
  const writer: FeelingSentenceWriter = {
    async write(request) {
      asked.push(request.facts);
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      return lines;
    },
  };
  return { writer, asked };
}

async function play(options: { touches: boolean; writer?: FeelingSentenceWriter; shadow?: boolean; message?: string }) {
  const database = new DatabaseSync(':memory:');
  const clock = { at: DAY };
  let harness: Awaited<ReturnType<typeof reactionHarness>> | null = null;
  const shadow = options.shadow ?? true;
  const configured = composedFeeling({ database, now: () => clock.at, timeZone: 'Asia/Tokyo', chooser: null, turn: true, singleFace: false,
    ...(shadow ? { shadow: { database, snapshot: (scopeKey: string) => harness!.stateStore.snapshot(scopeKey) } } : {}),
    ...(options.writer ? { sentence: options.writer } : {}) });
  harness = await reactionHarness({ feeling: configured.port, stage2: false });
  const at = (instant: string) => { harness!.clock.at = instant; clock.at = instant; };
  at(DAY);
  if (options.touches) {
    harness.speaker.decision = { say: true, text: 'いやです', feeling: 'annoyed', stance: 'dislike' };
    await harness.react({ type: 'poke', part: 'chest' });
    for (const [index, offset] of [40, 80, 120].entries()) {
      at(new Date(Date.parse(DAY) + offset * SECOND).toISOString());
      await harness.react({ type: 'poke', part: 'chest' }, { id: `again-${index}`, reply: 'none' });
    }
  }
  at(new Date(Date.parse(DAY) + 200 * SECOND).toISOString());
  const started = Date.now();
  await harness.send('POST', '/v1/chat', { message: options.message ?? 'お前ポンコツだな' }, 'iphone');
  return { harness, elapsed: Date.now() - started, prompt: harness.chatModel.requests.at(-1)!.turnContext ?? '' };
}

describe('her feeling sentence (SHANNON_FEELING_SENTENCE)', () => {
  it('is off by default, and is not wired without the fast layer it reads', () => {
    expect(switchOn({}, 'SHANNON_FEELING_SENTENCE')).toBe(false);
    const environment = { SHANNON_FEELING_EVENTS: 'on', SHANNON_FEELING_TURN: 'on', SHANNON_FEELING_SENTENCE: 'on', ANTHROPIC_API_KEY: 'test-key' };
    const parts = { databasePath: ':memory:', timeZone: 'Asia/Tokyo', now: () => DAY, trace: null, state: () => { throw new Error('unused'); } };
    expect(configuredFeeling(environment, parts)!.port.sentence).toBeUndefined();
    expect(configuredFeeling({ ...environment, SHANNON_CORE_AFFECT: 'on' }, parts)!.port.sentence).toBeDefined();
  });

  it('stands after the feeling turn\'s block in a strong scene, written from closed facts (never his words)', async () => {
    const fake = fakeWriter(['むかつく。何回言えばわかるの。', 'でも、無視はしたくない。']);
    const spans: { input?: unknown; output?: unknown }[] = [];
    const stop = installObserverSink(event => { if ((event.input as { phase?: string } | undefined)?.phase === 'feeling.sentence') spans.push(event); });
    const { prompt } = await withObserverRun({ scopeKey: 'owner', surface: 'test' }, () => play({ touches: true, writer: fake.writer }));
    stop();
    expect(fake.asked).toHaveLength(1);
    expect(JSON.stringify(fake.asked[0])).not.toContain('ポンコツ');
    expect(fake.asked[0]!.turn.tags).toContain('insult');
    expect(prompt).toContain(`${FEELING_SENTENCE_HEADER}\n- むかつく。何回言えばわかるの。\n- でも、無視はしたくない。`);
    expect(prompt.indexOf(FEELING_SENTENCE_HEADER)).toBeGreaterThan(prompt.indexOf('[この番の気持ち]'));
    expect(JSON.stringify(spans)).not.toContain('むかつく');
  });

  it('is not written when she is settled: the prompt is the one without it', async () => {
    const fake = fakeWriter(['むかつく。']);
    const calm = await play({ touches: false, writer: fake.writer, message: 'こんにちは' });
    const without = await play({ touches: false, message: 'こんにちは' });
    expect(fake.asked).toHaveLength(0);
    const strip = (text: string) => text.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gu, 'id');
    expect(strip(calm.prompt)).toBe(strip(without.prompt));
  });

  it('is waited for at most about 1 s; late, the reply goes on without it', async () => {
    const fake = fakeWriter(['むかつく。'], 3_000);
    const { prompt, elapsed } = await play({ touches: true, writer: fake.writer });
    expect(fake.asked).toHaveLength(1);
    expect(prompt).not.toContain(FEELING_SENTENCE_HEADER);
    expect(elapsed).toBeLessThan(2_000);
  });

  it('is not written without the shadow, nor when the writer has nothing', async () => {
    const unused = fakeWriter(['むかつく。']);
    expect((await play({ touches: true, writer: unused.writer, shadow: false })).prompt).not.toContain(FEELING_SENTENCE_HEADER);
    expect(unused.asked).toHaveLength(0);
    expect((await play({ touches: true, writer: fakeWriter(null).writer })).prompt).not.toContain(FEELING_SENTENCE_HEADER);
  });
});
