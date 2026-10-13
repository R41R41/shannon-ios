/** Task authority, execution and native model boundaries are core, including the additive authority adapter. */
export const FCA_CORE_PATHS = Object.freeze([
  'services/api/src/mind/action/taskRuntime/', 'services/api/src/mind/action/fca/',
  'services/api/src/mind/action/agentTasks/store/fcaTaskAuthority.ts',
  'services/api/src/mind/action/agentTasks/store/taskKinds.ts',
  'services/api/src/wiring/fcaSharedWiring.ts', 'services/api/src/wiring/fcaMemoryWiring.ts',
  'services/api/src/infra/sqlite/sqliteFcaAffect.ts', 'services/api/src/infra/models/anthropic/anthropicFcaContext.ts',
  'services/api/src/mind/tools/memoryToolDefinitions.ts',
  'services/api/src/wiring/fcaResearchWiring.ts', 'services/api/src/wiring/fcaReadSources.ts',
  'services/api/src/mind/selectors/fcaToolSelection.ts',
  'services/api/src/infra/models/anthropic/anthropicFcaHistory.ts', 'services/api/src/infra/models/anthropic/anthropicFcaTools.ts', 'services/api/src/infra/models/anthropic/anthropicFcaSummary.ts',
  'services/api/src/wiring/taskRuntimeWiring.ts', 'services/api/src/wiring/serverFcaWiring.ts',
  'services/api/src/infra/http/fcaTaskRoutes.ts', 'services/api/src/infra/models/anthropic/anthropicFcaModel.ts',
  'services/api/src/mind/tools/shannonTaskTools.ts', 'services/api/src/mind/tools/taskToolDefinitions.ts', 'services/api/src/mind/inhibition/fcaCorePaths.ts',
]);
