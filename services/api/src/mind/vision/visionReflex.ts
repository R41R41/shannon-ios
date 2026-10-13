import {
  createReflexController, type ReflexBodyAdapter, type ReflexEntryInput, type ReflexEntrySelector, type ReflexEvent, type ReflexHandoffPort,
  type ReflexSelector, type ReflexSessionReceipt, type ReflexSessionRequest,
} from '../action/reflex/reflexPorts.js';

/**
 * The reflex loop's home in the vision worker (Syzygy ADR-0011 §9, option C; stage 1 slice 4). The loop itself
 * (`reflexController`), its selectors (`openAIReflexSelector` for Decisions, `jevReflex` for the entry) and their wiring now sit
 * behind this interface in the worker process instead of the API's event loop. A body joins by registering a source: its adapter
 * (observe, candidates, execute, release), its hand-off to the existing lease authority, and its limits. The registry decides
 * nothing of its own: rules stay where they were (leases in the mind worker, the floor in the body).
 *
 * Stage 1 registers no source: Minecraft stays off until stage 2 (ADR-0010 with the Minebot lane). The API's existing Minecraft
 * wiring (`wiring/fcaBodyWiring.ts`) is left unchanged, behind its own switch, so that branch's retirement of the legacy request
 * path merges without a conflict; stage 2 registers the Minecraft adapter here and removes it there.
 */
export interface VisionReflexSource {
  /** A closed id (`minecraft-body`, `avatar-body`). */
  id: string;
  body: ReflexBodyAdapter;
  handoff: ReflexHandoffPort;
  /** Exact task revision / generation / owner checks (`ReflexPorts.current`). */
  current(context: ReflexSessionRequest['context']): boolean | Promise<boolean>;
  /** Image decisions need the Decisions selector; text-only ones the Jev selector. */
  selector: 'image' | 'text';
}

export interface VisionReflexProviders {
  entry: ReflexEntrySelector | null;
  image: ReflexSelector | null;
  text: ReflexSelector | null;
}

export interface VisionReflexHost {
  readonly sources: readonly string[];
  run(sourceId: string, request: ReflexSessionRequest, signal?: AbortSignal): Promise<ReflexSessionReceipt | null>;
  monitor(sourceId: string, request: ReflexSessionRequest, input: ReflexEntryInput, signal?: AbortSignal): Promise<ReflexSessionReceipt | null>;
  cancel(sourceId: string, scopeKey: string, bodyId: string): void;
  close(): Promise<void>;
}

/**
 * One controller per registered source, each with its own selector. Null without a source: no client, no model call, no loop.
 * `providers` is called only when a source is registered, so stage 1 creates no Decisions or Jev client for the reflex.
 */
export function createVisionReflexHost(sources: readonly VisionReflexSource[], parts: {
  providers(): VisionReflexProviders; event(event: ReflexEvent): void | Promise<void>; now(): number;
}): VisionReflexHost | null {
  if (!sources.length) return null;
  const providers = parts.providers();
  const controllers = new Map(sources.map(source => {
    const selector = source.selector === 'image' ? providers.image : providers.text;
    if (!selector) throw new Error(`VISION_REFLEX_SELECTOR_MISSING:${source.id}`);
    return [source.id, createReflexController({ body: source.body, handoff: source.handoff, selector, current: source.current, event: parts.event,
      now: parts.now })] as const;
  }));
  const controller = (id: string) => {
    const found = controllers.get(id);
    if (!found) throw new Error('VISION_REFLEX_SOURCE_UNKNOWN');
    return found;
  };
  return {
    sources: [...controllers.keys()],
    run: (id, request, signal) => controller(id).run(request, signal),
    monitor: (id, request, input, signal) => {
      if (!providers.entry) return Promise.resolve(null);
      return controller(id).monitor(request, input, providers.entry, signal);
    },
    cancel: (id, scopeKey, bodyId) => controller(id).cancel(scopeKey, bodyId),
    close: async () => { await Promise.allSettled([...controllers.values()].map(item => item.close())); },
  };
}
