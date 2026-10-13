/**
 * The window of her own time (Syzygy ADR-0008 §6 and §10, rule `mind-via-ports`; stage 3, S1): what another part of the mind or an
 * integration may import of it (her folder's paths, model prices, and the types of her service, her loop and her stores).
 * Her own time's own imports go through no window but `selfPorts`, `agentTasksPorts` and types of `inhibitionPorts`: her loop is
 * handed interfaces, and its imports are pinned (`autonomyLoopPrivacy.test.ts`).
 */
export { hostFolderPath, HOST_STEP_CODES, hostFolderLabel, hostStepContentDigest, ROOM_LOOK_GUARD, roomLookGuard, type HostStepCode } from './autonomyHostFolderPath.js';
export { type AutonomyNotionReader } from './autonomyLoopSteps.js';
export { configuredAutonomyModelPrices, type AutonomyModelPrices } from './autonomyModels.js';
export { type RecordedDecision, type ShannonAutonomyService } from './autonomyService.js';
export { type AutonomyLoopHeartbeat } from './store/autonomyLoopState.js';
export { type StudyAether } from './studyAether.js';
export { type ListResult, type ReadResult, type SearchResult, type WriteResult } from './hostFolderOperationResults.js';
export { type HostFolderOperations, type HostRunOutcome } from './hostFolderOperations.js';
export { type SQLiteAutonomyStore } from './store/autonomyStore.js';
export { type HostOperation } from './store/hostFolderOperationsStore.js';
export { type GoalRejection, type PursuitClosedReason, type PursuitEvent, type PursuitGoalColumns } from './store/pursuitGoals.js';
export { type StudyPiece, type StudyPieceKind, type StudyPieceStatus, type StudyRejection } from './store/studyStore.js';

export { studyWriteKey, syncedWithin } from './studyAether.js';

export type { AutonomyPhone, PhoneFacts } from './autonomyLoopPhoneStep.js';
