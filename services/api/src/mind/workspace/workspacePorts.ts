/**
 * The window of the workspace part (Syzygy ADR-0008 §6 and §10, rule `mind-via-ports`; stage 3, `docs/mind-workspace-contract.md`):
 * what another part of the mind or a surface may import of it. The workspace is the shared place of a turn (`[いまの場]`, the
 * notices and the data frames), held in the API process behind `MindHost` (owner answer 1; it moves to `mindWorker.ts` in
 * stage 4). Her own time never imports it (rule `own-time-without-private-stores`): she is handed `EmitMindEvent` only. Core:
 * response path.
 *
 * Step F3: the host, its journal and snapshots, the inbox tail, the prompt layout and the fault circuit. Whether the part runs is
 * `mindSwitches(...).workspace` (attention alone: `.attention`).
 */
export { mindSwitches, type MindSwitches } from '@shannon/mind';
export { MIND_HOST_LIMITS, createMindHost, operationOf, type MindHost, type MindHostOptions, type MindTurnPorts, type WorkspaceTurn } from './mindHost.js';
export {
  DATA_FRAME_RULE, DATA_FRAME_THREAT, framedReport, NOTICE_MARKERS, PROMPT_LAYOUT_LIMITS, WORKSPACE_PLACE_HEADER, dataFrame, noticeLine, withWorkspace, workspaceBlocks, type LayoutTurn,
} from './promptLayout.js';
export { NOTICE_KINDS, SPEECH_KINDS, WORKSPACE_LIMITS, type WorkspaceItem, type WorkspaceScope } from './workspaceState.js';
export { WorkspaceTextReader } from './workspaceText.js';
export type { JournalRow, SnapshotRow, SQLiteWorkspaceJournal } from './store/workspaceJournalStore.js';
export type { SQLiteMindInbox } from './store/mindInboxStore.js';
