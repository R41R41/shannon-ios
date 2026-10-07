import { describe, expect, it } from 'vitest';
import { OWNER_AUDIENCE, UNKNOWN_GUEST_PRESENCE } from '@shannon/cognition';
import { bodyPerception, textPerception, voicePerception } from '../src/mind/perception/perceptionPorts.js';
import { configuredMind } from '../src/wiring/mindWiring.js';
import { mindWorld } from './support/mindWorld.js';

/**
 * Syzygy ADR-0008 stage 3's latency bound (`docs/mind-workspace-contract.md`): on the response path, `perceive` (the surface's
 * normalizer, attention) and the render of the workspace add at most 3 ms at p95 to a text turn and 2 ms to a voice turn. Nothing
 * awaited: the journal is written after the response (its task is queued here and not run inside the measure). Measured over a
 * full workspace (twelve held items, notices, references read back from SQLite through the withholding, frames).
 */
const MINUTE = 60_000;

function p95(samples: number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
}

describe('the mind on the response path', () => {
  it('adds at most 3 ms at p95 to a text turn and 2 ms to a voice turn', async () => {
    const world = mindWorld({ SHANNON_ADR8_STAGE3: 'off' }, 'latency');
    // Stored turns to read back, on another thread.
    for (let index = 0; index < 8; index += 1) {
      await world.chat(`別の話その${index}、木材と石の数を数えておいてね`, { threadId: 'other' });
      world.advance(MINUTE);
    }
    const queued: Array<() => void> = [];
    const mind = configuredMind({}, { databasePath: world.path, now: world.now, schedule: task => { queued.push(task); } })!;
    const host = mind.host!;
    const turns = world.store.conversationHistory('owner', 'other').filter(message => message.role === 'user');
    const at = () => world.now();
    // A full workspace: stored turns with references, someone else's words, touches.
    for (const [index, message] of turns.entries()) {
      const item = host.perceive('owner', textPerception({ threadId: 'other', message: message.content, present: OWNER_AUDIENCE, alone: true, at: at() }))!;
      host.bind('owner', item.itemId, `experience:${message.sourceExperienceId}`);
      host.perceive('owner', voicePerception({ threadId: `voice-${index}`, transcript: `ミナです、${index}回目のこんにちは`, present: UNKNOWN_GUEST_PRESENCE, alone: false, guest: false, at: at() }));
      host.perceive('owner', bodyPerception({ touchId: `touch-${index}`, deviceId: 'body-pc', audience: 'owner', present: OWNER_AUDIENCE, input: 'press', at: at() }), { code: 'pet' });
      world.advance(10_000);
    }
    const snapshot = world.store.snapshot('owner');
    const measure = (surface: 'text' | 'voice', iterations: number) => {
      const samples: number[] = [];
      for (let index = 0; index < iterations; index += 1) {
        world.advance(5_000);
        const started = performance.now();
        const event = surface === 'text'
          ? textPerception({ threadId: 'thread', message: `今日はどうだった？ ${index}`, present: OWNER_AUDIENCE, alone: true, at: at() })
          : voicePerception({ threadId: 'thread-voice', transcript: `シャノン、今日はどうだった？ ${index}`, present: OWNER_AUDIENCE, alone: true, guest: false, at: at() });
        const item = host.perceive('owner', event);
        const blocks = host.render({ scopeKey: 'owner', surface, present: OWNER_AUDIENCE, at: at(), currentItemId: item?.itemId ?? null,
          current: { surface, sourceId: surface === 'text' ? 'thread' : 'thread-voice' }, snapshot, store: world.store });
        host.turnEnded();
        samples.push(performance.now() - started);
        if (surface === 'text') expect(blocks).toContain('[いまの場]');
      }
      return samples;
    };
    measure('text', 50); // warm-up
    const text = p95(measure('text', 300));
    const voice = p95(measure('voice', 300));
    expect(queued.length).toBeGreaterThan(0);
    expect(host.faulted).toBe(false);
    expect(text, `text p95 ${text.toFixed(3)} ms`).toBeLessThanOrEqual(3);
    expect(voice, `voice p95 ${voice.toFixed(3)} ms`).toBeLessThanOrEqual(2);
    console.log(`mind latency p95: text ${text.toFixed(3)} ms, voice ${voice.toFixed(3)} ms`);
    mind.close();
    await world.close();
  }, 60_000);
});
