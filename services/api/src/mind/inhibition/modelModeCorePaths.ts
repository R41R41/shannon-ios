/** Owner selection and native read helpers are core: autonomous edits cannot bypass routing or result evidence. */
export const MODEL_MODE_CORE_PATHS = Object.freeze([
  'services/api/src/contracts/modelModeContract.ts',
  'services/api/src/contracts/minecraftPrimaryModelContract.ts',
  'services/api/src/contracts/minecraftBodyRequestContract.ts',
  'services/api/src/infra/http/modelModeRoutes.ts',
  'services/api/src/infra/sqlite/modelModeStore.ts',
  'services/api/src/infra/models/primaryModeChatModel.ts',
  'services/api/src/infra/models/webSearch.ts',
  'services/api/src/wiring/modelModeWiring.ts',
  'services/api/src/wiring/modelModePlanningWiring.ts',
  'services/api/src/wiring/serverMinecraftBodyWiring.ts',
  'services/api/src/surfaces/minecraft/minecraftBodyRequests.ts',
  'services/api/src/surfaces/minecraft/store/minecraftRequestsStore.ts',
  'services/api/src/surfaces/minecraft/store/minecraftPrimaryModels.ts',
  'docs/model-mode-contract.md',
]);
