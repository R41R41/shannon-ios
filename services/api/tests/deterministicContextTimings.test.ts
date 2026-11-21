import { afterEach, describe, expect, it, vi } from 'vitest';
import { OWNER_AUDIENCE } from '@shannon/cognition';
import { memoryWorld } from './support/memoryWorld.js';
import { prepareTurnCognitiveContext } from '../src/mind/workspace/turnCognitiveContext.js';

/** The line a slow read of what she remembers leaves: where the time went, by part and inside the withholding read. */
const closes: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of closes.splice(0)) close(); });

describe('the slow deterministic context line', () => {
  it('names the counts and the time of the audience gate, the withholding, the hidden-turn pass and the receipt reads', () => {
    const world = memoryWorld();
    closes.push(world.close);
    for (let index = 0; index < 6; index += 1) {
      world.advance(60_000);
      world.store.appendTurn('owner', 'thread', `話題${index}`, `返事${index}`, world.now(), { capturedStateVersion: 0,
        messageEmotion: { valence: 0, arousal: 0.3, openness: 0.35, expression: 'calm' as const } });
    }
    const candidates = world.store.experienceCandidates.bind(world.store);
    world.store.experienceCandidates = (...input: Parameters<typeof candidates>) => {
      const until = performance.now() + 270;
      while (performance.now() < until) { /* a slow read of the remembered turns */ }
      return candidates(...input);
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    prepareTurnCognitiveContext(world.store.snapshot('owner'), world.store, { scopeKey: 'owner', message: '話題の続き', occurredAt: world.now(),
      channel: 'voice', present: OWNER_AUDIENCE });
    const line = warn.mock.calls.map(call => String(call[0])).find(text => text.startsWith('Shannon slow deterministic context'));
    expect(line).toMatch(/ read=\d+ms visible=\d+ms /u);
    expect(line).toMatch(/ inside visible: turns=6 kept=6 rules=0 gate=\d+ms withheld=\d+ms hidden=\d+ms sourceReads=0 sourceReadTime=\d+ms$/u);
  });
});
