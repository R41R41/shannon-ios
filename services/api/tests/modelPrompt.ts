/**
 * Everything a model request (or a chat response) gives the model as prompt text: her identity, what she knows of the
 * owner, and the turn's context (`ShannonPromptLayers`), joined. A test that asks what reached the model, or that
 * something never did, asks it of all of them.
 */
export function promptOf(value: { systemPrompt?: string; profilePrompt?: string; turnContext?: string } | null | undefined): string {
  return value ? [value.systemPrompt, value.profilePrompt, value.turnContext].filter(Boolean).join('\n\n') : '';
}
