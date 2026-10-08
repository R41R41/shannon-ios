/** Task authority, execution and native model boundaries are core, including the additive authority adapter. */
export const FCA_CORE_PATHS = Object.freeze([
  'services/api/src/mind/action/taskRuntime/', 'services/api/src/mind/action/fca/',
  'services/api/src/mind/action/agentTasks/store/fcaTaskAuthority.ts',
  'services/api/src/mind/action/agentTasks/store/fcaHostPredicate.ts',
  'services/api/src/wiring/taskRuntimeWiring.ts', 'services/api/src/wiring/serverFcaWiring.ts',
  'services/api/src/infra/http/fcaTaskRoutes.ts', 'services/api/src/infra/models/anthropic/anthropicFcaModel.ts',
  'services/api/src/mind/tools/shannonTaskTools.ts', 'services/api/src/mind/tools/taskToolDefinitions.ts', 'services/api/src/mind/inhibition/fcaCorePaths.ts',
]);
