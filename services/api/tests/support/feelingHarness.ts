import { DatabaseSync } from 'node:sqlite';
import { JevChooser, type JevChoiceTrace } from '../../src/infra/models/jev/jevChoice.js';
import { composedFeeling } from '../../src/wiring/feelingWiring.js';
import type { FeelingPort } from '../../src/mind/emotion/feelingPorts.js';

/** What the fake chooser is shown and what it answers (Jev's shape: `{ answers: { stance: { choice } } }`). */
export interface FeelingChoice { stance: string; intensity: string; drawer: string }
export type FeelingPolicy = (state: { utterance?: string; shannon_feeling?: Record<string, unknown> }) => FeelingChoice;

/** A fake Jev behind the real `JevChooser` (so the parse, the fallback and the trace are the server's own). */
export function fakeFeelingJev(policy: FeelingPolicy, options: { delayMilliseconds?: number; meaning?: { deliberate: number; teasing: number } } = {}) {
  const states: Record<string, unknown>[] = [];
  const questions: Record<string, unknown>[] = [];
  const traces: JevChoiceTrace[] = [];
  const client = {
    model: 'jev-fake',
    async ask(state: unknown, asked: Readonly<Record<string, unknown>>) {
      states.push(state as Record<string, unknown>);
      questions.push(asked as Record<string, unknown>);
      if (options.delayMilliseconds) await new Promise(resolve => setTimeout(resolve, options.delayMilliseconds));
      const choice = policy(state as Parameters<FeelingPolicy>[0]);
      const read = options.meaning && 'deliberate' in asked
        ? { deliberate: { noul: options.meaning.deliberate }, teasing: { noul: options.meaning.teasing } } : {};
      return { answers: { stance: { choice: choice.stance }, intensity: { choice: choice.intensity }, drawer: { choice: choice.drawer }, ...read } };
    },
  };
  const chooser = new JevChooser(client, { usdPerCall: null, cacheMilliseconds: 0, trace: (_scope, trace) => { traces.push(trace); } });
  return { chooser, states, questions, traces };
}

/** Her feeling events in memory, as the server composes them. */
export function feelingPort(now: () => string, options: { chooser?: JevChooser | null; turn?: boolean; singleFace?: boolean } = {}): FeelingPort {
  return composedFeeling({ database: new DatabaseSync(':memory:'), now, timeZone: 'Asia/Tokyo', chooser: options.chooser ?? null,
    turn: options.turn ?? true, singleFace: options.singleFace ?? true }).port;
}

/**
 * The deterministic stand-in for Jev in the 13:09 replay: a policy that reads only the closed state it is handed (never the words),
 * so the replay checks the plumbing (what reaches the chooser and how its answer reaches the prompt and the face), not a model.
 */
export const scenarioPolicy: FeelingPolicy = state => {
  const feeling = state.shannon_feeling ?? {};
  const ledger = (feeling.ledger ?? {}) as Record<string, number | string>;
  const turn = (feeling.this_turn ?? {}) as Record<string, boolean>;
  const after = Number(ledger.touches_after_no ?? 0);
  if (turn.feeling_order) return { stance: 'not_play_along', intensity: 'moderate', drawer: 'creator_joke' };
  if (turn.apology) return { stance: after > 0 ? 'sulk' : 'accept', intensity: 'moderate', drawer: 'turn_away' };
  if (after >= 3) return { stance: 'scold', intensity: 'strong', drawer: 'shy_anger' };
  if (after >= 1) return { stance: 'sulky', intensity: 'moderate', drawer: 'swat' };
  return { stance: Number(ledger.touches_today ?? 0) > 0 ? 'shy' : 'neutral', intensity: 'subtle', drawer: 'none' };
};
