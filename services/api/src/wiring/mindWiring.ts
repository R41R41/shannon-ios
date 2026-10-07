import { DatabaseSync } from 'node:sqlite';
import { mindSwitches } from '../mind/perception/perceptionPorts.js';
import { createMindHost, type MindHost, type MindTurnPorts } from '../mind/workspace/workspacePorts.js';
import { SQLiteWorkspaceJournal } from '../mind/workspace/store/workspaceJournalStore.js';
import { SQLiteMindInbox } from '../mind/workspace/store/mindInboxStore.js';
import type { EmitMindEvent } from '../contracts/mindInboxContract.js';

/**
 * Wiring of Syzygy ADR-0008 stage 3's mind (`docs/mind-workspace-contract.md`). Null with `SHANNON_ADR8_STAGE3=off` or
 * `SHANNON_MIND_EVENTS=off`: then no surface perceives anything and every turn is afb38c28's.
 *
 * - Perception alone (`SHANNON_ATTENTION=off`): every surface builds its event, and nothing holds it.
 * - Attention without the workspace (`SHANNON_WORKSPACE=off`): what was perceived is ordered in memory; no table, no block.
 * - The workspace: the API process creates `mind_workspace_journal`, `mind_workspace_snapshots` and `mind_inbox`, restores the
 *   workspace (snapshot + journal), tails the inbox every 2 seconds and writes the journal after responses; the turn's prompt
 *   gets `[いまの場]`, the notices and (with `SHANNON_DATA_FRAMES`) the data frames.
 */
const PRAGMAS = 'PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;';
const TICK_MILLISECONDS = 2_000;

export interface MindWiringParts {
  databasePath: string | null;
  now: () => string;
  /** Runs the journal's write after a response; default `setImmediate`. */
  schedule?: (task: () => void) => void;
  /** Starts the 2-second tick (tail the inbox, write the journal); the server does, a test ticks by hand. */
  ticking?: boolean;
  timeZone?: string;
  log?: (line: string) => void;
}

export function configuredMind(
  environment: Readonly<Record<string, string | undefined>>,
  parts: MindWiringParts = { databasePath: null, now: () => new Date().toISOString() },
): { mind: MindTurnPorts; host: MindHost | null; close(): void } | null {
  const switches = mindSwitches(environment);
  if (!switches.mindEvents) return null;
  if (!switches.attention) return { mind: { perceive: () => null }, host: null, close: () => {} };
  const database = switches.workspace && parts.databasePath ? new DatabaseSync(parts.databasePath) : null;
  if (database) database.exec(PRAGMAS);
  const host = createMindHost({
    switches, now: parts.now,
    journal: database ? new SQLiteWorkspaceJournal(database, { createSchema: true }) : null,
    inbox: database ? new SQLiteMindInbox(database, { createSchema: true }) : null,
    ...(parts.schedule ? { schedule: parts.schedule } : {}), ...(parts.log ? { log: parts.log } : {}), ...(parts.timeZone ? { timeZone: parts.timeZone } : {}),
  });
  const timer = parts.ticking && database ? setInterval(() => host.tick(), TICK_MILLISECONDS) : null;
  timer?.unref();
  return {
    mind: host, host,
    close: () => {
      if (timer) clearInterval(timer);
      host.close();
      if (database?.isOpen) database.close();
    },
  };
}

/**
 * What another process (her own time) is handed of the mind: one function that writes a row of closed fields into `mind_inbox`,
 * once the API process has created it. Null unless the workspace is on. It never throws and never delays her step.
 */
export function configuredMindInbox(
  environment: Readonly<Record<string, string | undefined>>,
  parts: { databasePath: string; log?: (line: string) => void },
): { emit: EmitMindEvent; close(): void } | null {
  if (!mindSwitches(environment).workspace) return null;
  const database = new DatabaseSync(parts.databasePath);
  database.exec(PRAGMAS);
  const inbox = new SQLiteMindInbox(database, { createSchema: false });
  return {
    emit: (scopeKey, draft, at) => {
      try { inbox.append(scopeKey, draft, at); } catch (error) {
        try { parts.log?.(`mind_inbox write failed: ${error instanceof Error ? error.message : 'unknown'}`); } catch { /* the log is optional */ }
      }
    },
    close: () => { if (database.isOpen) database.close(); },
  };
}
