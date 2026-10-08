import { SQLiteModelModeStore } from '../infra/sqlite/modelModeStore.js';
import { DEFAULT_HAIKU_MODEL, configuredResponseModel } from '../infra/models/anthropic/haikuConfig.js';
import { DEFAULT_SONNET_MODEL, sonnetRoutingAvailable, sonnetSettings } from '../infra/models/anthropic/anthropicConfig.js';
import type { AutonomyTextModel } from '../mind/action/ownTime/autonomyTextModel.js';

/** A separate worker connection reads only the preference. Its prepared call freezes the model and its budget estimate. */
export function configuredPlanningMode(environment: Readonly<Record<string, string | undefined>>, parts: {
  path: string; ownerScope: string; model: AutonomyTextModel; fallbackPlanning?: (scope: string) => string | null;
}) {
  // No dedicated native adapter: keep the existing purpose preferences, and the API does not advertise this surface.
  if (!parts.model.canUse(DEFAULT_HAIKU_MODEL)) return null;
  const store = new SQLiteModelModeStore(parts.path, false);
  const haikuAvailable = configuredResponseModel(environment, 'SHANNON_LLM_MODEL')?.model === DEFAULT_HAIKU_MODEL;
  return {
    planningModel(scope: string): string | null {
      if (scope !== parts.ownerScope) return null;
      try {
        const selected = store.read(scope);
        if (selected.mode === 'haiku' && !haikuAvailable) return parts.fallbackPlanning?.(scope) ?? null;
        if (selected.mode === 'sonnet' && (!sonnetRoutingAvailable(environment) || sonnetSettings(environment).model !== DEFAULT_SONNET_MODEL)) return null;
        const model = selected.mode === 'sonnet' ? DEFAULT_SONNET_MODEL : DEFAULT_HAIKU_MODEL;
        return parts.model.canUse(model) ? model : null;
      } catch { return null; } // Unknown configuration cannot grant a paid call or silently reset the saved mode.
    },
    close: () => store.close(),
  };
}
