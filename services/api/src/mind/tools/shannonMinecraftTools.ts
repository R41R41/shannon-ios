import { withMinecraftBodyCapability } from '@shannon/cognition';

/**
 * A model request with her Minecraft body's capability line, exactly when the turn's own tools include `minecraft.request`
 * (second review, 2026-10-06): the owner alone as the server knows it, her tools on, the body configured and in the game,
 * and the turn offered tools at all (a voice turn by its words). Otherwise the request is returned as it is, so a server
 * without a body sends exactly what it sent before.
 */
export function withMinecraftToolLine<T extends { systemPrompt: string; tools?: { definitions: readonly { name: string }[]; menu?: { offered: readonly { name: string }[] } } }>(request: T): T {
  // With the tool menu (Syzygy ADR-0008 stage 2) the line follows every tool the turn offers, not only the schemas sent.
  return (request.tools?.menu?.offered ?? request.tools?.definitions)?.some(tool => tool.name === 'minecraft.request')
    ? { ...request, systemPrompt: withMinecraftBodyCapability(request.systemPrompt) } : request;
}
