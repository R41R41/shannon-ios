import { VISION_CORE_PATHS } from './visionCorePaths.js';

/** Fixed response paths for the Stage 4 execution owner. This definition stays in approval_and_budget. */
export const STAGE4_CORE_PATHS = Object.freeze([
    // Stage 4: the only mind owner, execution rights, IPC and their adapters are core too.
    'services/api/src/mindWorker.ts',
    'services/api/src/mind/action/threads/',
    'services/api/src/contracts/actionThreadContract.ts',
    'services/api/src/infra/config/stage4.ts',
    'services/api/src/infra/context/actionExecution.ts',
    'services/api/src/infra/ipc/mindSocket.ts',
    'services/api/src/infra/sqlite/mindOwnership.ts',
    // ADR-0009 stage 1 (S2): the execution schema's ledger and steps, and the one opener of the shared file.
    'services/api/src/infra/sqlite/migrations/',
    'services/api/src/infra/sqlite/sqliteOpen.ts',
    'services/api/src/wiring/actionExecutionWiring.ts',
    'services/api/src/wiring/actionThreadsWiring.ts',
    'services/api/src/wiring/externalActionWiring.ts',
    'services/api/src/wiring/minecraftActionWiring.ts',
    'services/api/src/wiring/serverActionThreadsWiring.ts',
    'services/api/src/wiring/mindWorkerWiring.ts',
    'services/api/src/wiring/remoteMindWiring.ts',
    'services/api/src/infra/http/actionThreadRoutes.ts',
    // Syzygy ADR-0011 stage 1: the vision worker, its budget guard and the camera's privacy boundary.
    ...VISION_CORE_PATHS,
]);
