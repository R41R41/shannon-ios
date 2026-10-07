/** Fixed protected paths for the Stage 4 execution owner. This definition is itself protected. */
export const STAGE4_CORE_PATHS = Object.freeze([
  'services/api/src/mind/inhibition/stage4CorePaths.ts',
    // Stage 4: the only mind owner, execution rights, IPC and their adapters are core too.
    'services/api/src/mindWorker.ts',
    'services/api/src/mind/action/threads/',
    'services/api/src/contracts/actionThreadContract.ts',
    'services/api/src/infra/config/stage4.ts',
    'services/api/src/infra/context/actionExecution.ts',
    'services/api/src/infra/ipc/mindSocket.ts',
    'services/api/src/infra/sqlite/mindOwnership.ts',
    'services/api/src/wiring/actionExecutionWiring.ts',
    'services/api/src/wiring/actionThreadsWiring.ts',
    'services/api/src/wiring/externalActionWiring.ts',
    'services/api/src/wiring/minecraftActionWiring.ts',
    'services/api/src/wiring/serverActionThreadsWiring.ts',
    'services/api/src/wiring/mindWorkerWiring.ts',
    'services/api/src/wiring/remoteMindWiring.ts',
    'services/api/src/infra/http/actionThreadRoutes.ts',
]);
