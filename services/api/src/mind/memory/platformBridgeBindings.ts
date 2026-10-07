import type { PlatformBridgeBinding, PlatformBridgeConfiguration, ShannonPlatform } from './platformBridge.js';

/**
 * The bindings of the platform bridge (`platformBridge.ts`): how a configuration is composed from valid bindings, and
 * which binding a conversation falls under. Also the shared-audience header its projections and the platform surface
 * (`platformSurface.ts`) begin with.
 */
/**
 * A bridge configuration from bindings that are already valid. The environment's bindings may not overlap;
 * a configuration the server derives itself (the Minecraft body, `minecraftBodyContract.ts`) may let an exact
 * conversation stand inside a prefix, and the exact one then wins (`bindingFor` reads it first).
 */
export function composedPlatformBridgeConfiguration(
  token: string,
  scopeKey: string,
  candidates: readonly PlatformBridgeBinding[],
  source: string,
  options: { exactInsidePrefix?: boolean } = {},
): PlatformBridgeConfiguration {
  const bindings = new Map<string, PlatformBridgeBinding>();
  const prefixBindings: PlatformBridgeBinding[] = [];
  for (const binding of candidates) {
    if (binding.conversationId) {
      const key = bindingKey(binding.platform, binding.conversationId);
      if (bindings.has(key)) throw new Error(`${source} contains a duplicate conversation`);
      bindings.set(key, Object.freeze({ ...binding }));
    } else {
      if (prefixBindings.some(existing => existing.platform === binding.platform
        && existing.conversationIdPrefix === binding.conversationIdPrefix)) {
        throw new Error(`${source} contains a duplicate conversation prefix`);
      }
      prefixBindings.push(Object.freeze({ ...binding }));
    }
  }
  if (!options.exactInsidePrefix) {
    for (const exact of bindings.values()) {
      if (prefixBindings.some(prefix => prefix.platform === exact.platform
        && exact.conversationId?.startsWith(prefix.conversationIdPrefix ?? ''))) {
        throw new Error(`${source} contains overlapping bindings`);
      }
    }
  }
  return Object.freeze({ token, scopeKey, bindings, prefixBindings: Object.freeze(prefixBindings) });
}

export function bindingFor(
  configuration: PlatformBridgeConfiguration,
  platform: ShannonPlatform,
  conversationId: string,
): PlatformBridgeBinding | undefined {
  return configuration.bindings.get(bindingKey(platform, conversationId))
    ?? configuration.prefixBindings.find(binding => binding.platform === platform
      && matchesConversationPrefix(platform, conversationId, binding.conversationIdPrefix));
}

/**
 * What may follow a prefix: a Discord channel id, or the UUID of a Minecraft player (a whisper with Shannon's
 * Minecraft body; only the server derives such a prefix, the environment's prefixes are Discord ones).
 */
const PREFIX_SUFFIX: Readonly<Partial<Record<ShannonPlatform, RegExp>>> = Object.freeze({
  discord: /^\d{1,32}$/,
  minecraft: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
});

function matchesConversationPrefix(platform: ShannonPlatform, conversationId: string, prefix: string | undefined): boolean {
  const suffix = PREFIX_SUFFIX[platform];
  return prefix !== undefined && suffix !== undefined
    && conversationId.startsWith(prefix)
    && suffix.test(conversationId.slice(prefix.length));
}

function bindingKey(platform: ShannonPlatform, conversationId: string): string {
  return `${platform}\u0000${conversationId}`;
}

/**
 * The header of a conversation other people read. The owner's own turn there may release a protected line of his by
 * asking clearly; a turn anyone else wrote may not (owner decision 2026-10-06), so its header leaves that sentence out.
 */
export function sharedAudienceHeader(ownerWrote: boolean): string {
  return ownerWrote ? SHARED_AUDIENCE_HEADER : SHARED_AUDIENCE_HEADER.replace(OWNER_RELEASE, '');
}

export const SHARED_AUDIENCE_HEADER = '[Shannon shared audience]\nあなたはシャノンです。この会話はライ氏以外の人も読みます。発言する前に、その内容がこの場の人がまだ知らない個人情報にならないかを自分で確かめ、なるなら言わないか、一般的な言い方にしてください。ライ氏本人がこの場ではっきり求めた時は、本人の判断なので答えて構いません。控えていること自体は、聞かれない限り言わないでください。\n下に載っていない記憶は、覚えているふりをしないでください。';
const OWNER_RELEASE = 'ライ氏本人がこの場ではっきり求めた時は、本人の判断なので答えて構いません。';
