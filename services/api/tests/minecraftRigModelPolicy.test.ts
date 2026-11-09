import { describe, expect, it, vi } from 'vitest';
import { createRigModelLifecycle, rigModelValues, trackRigModelWork } from '../scripts/minecraftRigModelPolicy.js';
import { DEFAULT_HAIKU_MODEL } from '../src/infra/models/anthropic/haikuConfig.js';
import { AnthropicRequestNotSentError } from '../src/infra/models/anthropic/anthropicFcaFailure.js';
import type { FcaModel, FcaModelInput } from '../src/mind/action/fca/fcaPorts.js';
import type { LlmcWiring } from '../src/wiring/minecraftLlmcConfiguration.js';

describe('isolated Minecraft validation model policy', () => {
  it('replaces production routing without mutating the environment', () => {
    const production = Object.freeze({
      SHANNON_MINECRAFT_LLMC_MODEL: 'claude-opus-5-5',
      SHANNON_MINECRAFT_LLMC_PLAN_MODEL: 'claude-opus-5-5',
      SHANNON_MINECRAFT_LLMC_ESCALATE_MODEL: 'next',
      SHANNON_MINECRAFT_LLMC_STRICT_MODEL: 'off',
      SHANNON_TIMEZONE: 'Asia/Tokyo',
    });
    const validation = rigModelValues(production);
    expect(validation).toMatchObject({
      SHANNON_MINECRAFT_LLMC_MODEL: DEFAULT_HAIKU_MODEL,
      SHANNON_MINECRAFT_LLMC_PLAN_MODEL: DEFAULT_HAIKU_MODEL,
      SHANNON_MINECRAFT_LLMC_ESCALATE_MODEL: 'none',
      SHANNON_MINECRAFT_LLMC_STRICT_MODEL: 'on',
      SHANNON_TIMEZONE: 'Asia/Tokyo',
    });
    expect(production.SHANNON_MINECRAFT_LLMC_MODEL).toBe('claude-opus-5-5');
  });

  it('routes every paid role to Sonnet for the approved thru run, escalation off', () => {
    expect(rigModelValues({ SHANNON_MINECRAFT_LLMC_PLAN_MODEL: 'claude-opus-5-5' }, 'sonnet')).toMatchObject({
      SHANNON_MINECRAFT_LLMC_MODEL: 'claude-sonnet-5-5',
      SHANNON_MINECRAFT_LLMC_PLAN_MODEL: 'claude-sonnet-5-5',
      SHANNON_MINECRAFT_LLMC_ESCALATE_MODEL: 'none',
      SHANNON_MINECRAFT_LLMC_STRICT_MODEL: 'on',
    });
  });

  it.each(['opus', 'claude-opus-5-5', 'invalid', '', 'toString'])('rejects an unintended paid validation model: %s', requested => {
    expect(() => rigModelValues({}, requested)).toThrow('RIG_VALIDATION_REQUIRES_HAIKU_OR_SONNET');
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const fixture = (parts: Partial<LlmcWiring> = {}): LlmcWiring => ({
  names: { main: DEFAULT_HAIKU_MODEL, plan: DEFAULT_HAIKU_MODEL, escalate: null },
  models: { main: { async decide() { return { decision: { kind: 'complete', summary: 'done' }, history: [] }; }, toolResults: value => value },
    escalate: null },
  summarizer: null, policy: {}, historyAhead: { get: () => undefined, set() {}, clear() {} }, ...parts,
});

describe('isolated rig paid work shutdown', () => {
  it('cannot attest STOPPED before a parallel summary finishes recording usage', async () => {
    const lifecycle = createRigModelLifecycle(), provider = deferred<void>(), usage = deferred<void>(), accounting = deferred<void>();
    const events: string[] = [];
    const client = { create: vi.fn(() => provider.promise) };
    const wiring = trackRigModelWork(fixture({ summarizer: { async summarize() {
      await client.create();
      accounting.resolve();
      await usage.promise;
      events.push('usage recorded');
      return {};
    } } }), lifecycle);
    const summary = wiring.summarizer!.summarize({ previous: null, rounds: [] }, new AbortController().signal);
    lifecycle.stopAccepting();
    const shutdown = (async () => { events.push('driver closed'); await lifecycle.drain(); events.push('STOPPED'); })();
    provider.resolve();
    await accounting.promise;
    expect(events).toEqual(['driver closed']);
    usage.resolve();
    await summary;
    await shutdown;
    expect(events).toEqual(['driver closed', 'usage recorded', 'STOPPED']);
    expect(client.create).toHaveBeenCalledOnce();
  });

  it('refuses a first plan released by a late scan without sending or recording a charge', async () => {
    const lifecycle = createRigModelLifecycle(), scan = deferred<void>();
    const client = { create: vi.fn(async () => ({})) }, recordUsage = vi.fn();
    const wiring = trackRigModelWork(fixture({ planner: async () => {
      const answer = await client.create();
      recordUsage();
      return answer;
    } }), lifecycle);
    const late = scan.promise.then(() => wiring.planner!('system', 'input', new AbortController().signal));
    const refused = expect(late).rejects.toBeInstanceOf(AnthropicRequestNotSentError);
    lifecycle.stopAccepting();
    await lifecycle.drain();
    scan.resolve();
    await refused;
    expect(client.create).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('waits for a failed replan to finish its usage record and then releases the tracker', async () => {
    const lifecycle = createRigModelLifecycle(), provider = deferred<void>(), usage = deferred<void>(), accounting = deferred<void>();
    const events: string[] = [];
    const wiring = trackRigModelWork(fixture({ replanner: async () => {
      try { await provider.promise; } catch (error) {
        accounting.resolve();
        await usage.promise;
        events.push('unknown usage recorded');
        throw error;
      }
      return {};
    } }), lifecycle);
    const call = wiring.replanner!('system', 'input', new AbortController().signal);
    const refused = expect(call).rejects.toThrow('provider-failed');
    lifecycle.stopAccepting();
    const shutdown = lifecycle.drain().then(() => { events.push('STOPPED'); });
    provider.reject(new Error('provider-failed'));
    await accounting.promise;
    expect(events).toEqual([]);
    usage.resolve();
    await refused;
    await shutdown;
    await lifecycle.drain();
    expect(events).toEqual(['unknown usage recorded', 'STOPPED']);
  });

  it('preserves native model state, identity and signals while closing decisions and second judgments too', async () => {
    class Model implements FcaModel {
      #value = 'native';
      seen: AbortSignal[] = [];
      async decide(_input: FcaModelInput, signal: AbortSignal) {
        this.seen.push(signal);
        return { decision: { kind: 'complete' as const, summary: this.#value }, history: [] };
      }
      toolResults() { return this.#value; }
      async redecide() {
        if (this.#value !== 'native') throw new Error('LOST_MODEL_STATE');
        return null;
      }
    }
    const model = new Model(), lifecycle = createRigModelLifecycle();
    const wiring = trackRigModelWork(fixture({ models: { main: model, strong: model, escalate: null } }), lifecycle);
    const signal = new AbortController().signal;
    expect(wiring.models.main).toBe(wiring.models.strong);
    expect(wiring.models.main.toolResults([])).toBe('native');
    await expect(wiring.models.main.decide({} as FcaModelInput, signal)).resolves.toMatchObject({ decision: { summary: 'native' } });
    await expect(wiring.models.main.redecide!({ taskId: 't', note: 'n', signal, timeoutMs: 1_000 })).resolves.toBeNull();
    lifecycle.stopAccepting();
    await expect(wiring.models.main.decide({} as FcaModelInput, signal)).rejects.toBeInstanceOf(AnthropicRequestNotSentError);
    await expect(wiring.models.main.redecide!({ taskId: 't', note: 'n', signal, timeoutMs: 1_000 }))
      .rejects.toBeInstanceOf(AnthropicRequestNotSentError);
    expect(model.seen).toEqual([signal]);
    await lifecycle.drain();
  });
});
