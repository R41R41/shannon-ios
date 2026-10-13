import { modelModePort, type ModelModePreference, type ModelModeSnapshot } from '../contracts/modelModeContract.js';
import { SQLiteModelModeStore } from '../infra/sqlite/modelModeStore.js';
import { createModelModeRoute } from '../infra/http/modelModeRoutes.js';
import { PrimaryModeChatModel } from '../infra/models/primaryModeChatModel.js';
import type { ShannonChatModel } from '../infra/models/chatModel.js';
import type { AnthropicChatModel } from '../infra/models/anthropic/anthropicChatModel.js';
import { DEFAULT_HAIKU_MODEL } from '../infra/models/anthropic/haikuConfig.js';
import { DEFAULT_SONNET_MODEL } from '../infra/models/anthropic/anthropicConfig.js';
import { dedicatedAutonomyCredential } from '../mind/action/ownTime/autonomyTextModel.js';
import { tieredChatModel } from './sonnetWiring.js';

/** Composition only: the preference grants no credential, action lease, budget, or permission. */
export function createModelModeWiring(environment: Readonly<Record<string, string | undefined>>, parts: {
  path: string; ownerScope: string; haiku: ShannonChatModel; sonnet: AnthropicChatModel | null;
}) {
  const store = new SQLiteModelModeStore(parts.path);
  const models = { haiku: parts.haiku.model, sonnet: parts.sonnet?.model ?? DEFAULT_SONNET_MODEL };
  const available = { haiku: parts.haiku.model === DEFAULT_HAIKU_MODEL, sonnet: parts.sonnet?.model === DEFAULT_SONNET_MODEL };
  const capabilities = (_scope: string, selected: ModelModePreference): Pick<ModelModeSnapshot, 'available' | 'models' | 'appliesTo'> => {
    const appliesTo: ModelModeSnapshot['appliesTo'][number][] = ['conversation'];
    if (available[selected.mode] && dedicatedAutonomyCredential('anthropic', environment)) appliesTo.push('autonomy-planning');
    return { available, models, appliesTo };
  };
  const modes = modelModePort(store, capabilities);
  return {
    store, modes,
    // The normal mode calls Haiku directly; its medium rethink remains, while automatic Sonnet escalation is disabled.
    chatModel: new PrimaryModeChatModel(store, parts.haiku, available.sonnet ? tieredChatModel(parts.haiku, parts.sonnet) : null, models.sonnet),
    route: createModelModeRoute({ modes, ownerScopeKey: parts.ownerScope }),
    close: () => store.close(),
  };
}
