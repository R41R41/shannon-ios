import { DEFAULT_HAIKU_MODEL } from '../src/infra/models/anthropic/haikuConfig.js';
import { DEFAULT_SONNET_MODEL } from '../src/infra/models/anthropic/anthropicConfig.js';
import { AnthropicRequestNotSentError } from '../src/infra/models/anthropic/anthropicFcaFailure.js';
import type { FcaModel } from '../src/mind/action/fca/fcaPorts.js';
import { FcaNoDecisionError } from '../src/mind/action/fca/fcaNoResponse.js';
import type { LlmcWiring } from '../src/wiring/minecraftLlmcConfiguration.js';

/** Paid roles of the isolated rig, by the rig's --llm-model. Haiku validates; Sonnet is only the owner-approved thru run (11/10 filming shape). */
const RIG_MODELS: Readonly<Record<string, string>> = { haiku: DEFAULT_HAIKU_MODEL, sonnet: DEFAULT_SONNET_MODEL };

/** Validation is isolated from the production environment and uses one model (Haiku, or Sonnet for the approved thru run) for every paid model path. */
export function rigModelValues(
  values: Readonly<Record<string, string>>,
  requested = 'haiku',
): Record<string, string> {
  const model = Object.hasOwn(RIG_MODELS, requested) ? RIG_MODELS[requested] : undefined;
  if (!model) throw new Error('RIG_VALIDATION_REQUIRES_HAIKU_OR_SONNET');
  return {
    ...values,
    SHANNON_MINECRAFT_LLMC_MODEL: model,
    SHANNON_MINECRAFT_LLMC_PLAN_MODEL: model,
    SHANNON_MINECRAFT_LLMC_ESCALATE_MODEL: 'none',
    SHANNON_MINECRAFT_LLMC_STRICT_MODEL: 'on',
  };
}

/** Includes the caller's decoding and usage recording, not just the provider's transport promise. */
export function createRigModelLifecycle() {
  let closing = false;
  const pending = new Set<Promise<unknown>>();
  return {
    run<T>(work: () => Promise<T>): Promise<T> {
      if (closing) return Promise.reject(new AnthropicRequestNotSentError('RIG_MODEL_CLOSED'));
      const running = (async () => work())();
      pending.add(running);
      const settled = () => { pending.delete(running); };
      void running.then(settled, settled);
      return running;
    },
    stopAccepting(): void { closing = true; },
    async drain(): Promise<void> {
      closing = true;
      await Promise.allSettled([...pending]);
    },
  };
}
type RigModelLifecycle = ReturnType<typeof createRigModelLifecycle>;

function trackCall<Args extends unknown[], Result>(lifecycle: RigModelLifecycle, work: (...args: Args) => Promise<Result>) {
  return (...args: Args): Promise<Result> => lifecycle.run(() => work(...args)).catch((error: unknown) => {
    // end1108b S7/S8b: word-only answers failed the request and their words were nowhere. The rig (not production) prints them.
    if (error instanceof FcaNoDecisionError && error.said) console.log(`RIG_UNDECIDED ${JSON.stringify({ said: error.said })}`);
    throw error;
  });
}

/** Bind other methods to their original instance so native model private state remains usable. */
function trackModel(model: FcaModel, lifecycle: RigModelLifecycle): FcaModel {
  const decide = trackCall(lifecycle, model.decide.bind(model));
  const redecide = model.redecide ? trackCall(lifecycle, model.redecide.bind(model)) : undefined;
  return new Proxy(model, {
    get(target, property) {
      if (property === 'decide') return decide;
      if (property === 'redecide') return redecide;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** Detached first plans and history summaries must settle before a rig can attest its final spend. */
export function trackRigModelWork(wiring: LlmcWiring, lifecycle: RigModelLifecycle): LlmcWiring {
  const models = new Map<FcaModel, FcaModel>();
  const tracked = (model: FcaModel) => {
    let found = models.get(model);
    if (!found) { found = trackModel(model, lifecycle); models.set(model, found); }
    return found;
  };
  return {
    ...wiring,
    models: {
      main: tracked(wiring.models.main),
      escalate: wiring.models.escalate ? tracked(wiring.models.escalate) : null,
      ...(wiring.models.strong !== undefined ? { strong: wiring.models.strong ? tracked(wiring.models.strong) : null } : {}),
    },
    ...(wiring.planner ? { planner: trackCall(lifecycle, wiring.planner) } : {}),
    ...(wiring.replanner ? { replanner: trackCall(lifecycle, wiring.replanner) } : {}),
    summarizer: wiring.summarizer ? { ...wiring.summarizer,
      summarize: trackCall(lifecycle, wiring.summarizer.summarize.bind(wiring.summarizer)) } : null,
  };
}
