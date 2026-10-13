/** Owner selection and native read helpers are core: autonomous edits cannot bypass routing or result evidence. */
export const MODEL_MODE_CORE_PATHS = Object.freeze([
  'services/api/src/contracts/modelModeContract.ts',
  'services/api/src/infra/http/modelModeRoutes.ts',
  'services/api/src/infra/sqlite/modelModeStore.ts',
  'services/api/src/infra/models/primaryModeChatModel.ts',
  'services/api/src/infra/models/webSearch.ts',
  'services/api/src/wiring/modelModeWiring.ts',
  'services/api/src/wiring/modelModePlanningWiring.ts',
  'services/api/src/wiring/serverMinecraftBodyWiring.ts',
  'docs/model-mode-contract.md',
]);
