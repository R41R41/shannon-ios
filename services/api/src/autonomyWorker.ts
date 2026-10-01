import { setTimeout as delay } from 'node:timers/promises';
import { SQLiteAutonomyAnnouncer } from './autonomyAnnouncer.js';
import { configuredAutonomy } from './autonomyBudget.js';
import { ShannonAutonomyLoop } from './autonomyLoop.js';
import { configuredAutonomyLoop } from './autonomyLoopConfig.js';
import { BoundedPublicReader } from './autonomyReader.js';
import { ShannonAutonomyService } from './autonomyService.js';
import { SQLiteStudyShowing } from './autonomyShowing.js';
import { SQLiteAutonomyStore } from './autonomyStore.js';
import { configuredAutonomyTextModel } from './autonomyTextModel.js';
import { notionLoopReader } from './notionLoopReader.js';
import { configuredNotionSource } from './notionSource.js';
import { configuredDatabasePath } from './sqliteStore.js';

/**
 * Entry of the activity loop (Syzygy ADR-0002 step 3): its own process, so the API,
 * chat and voice never wait for it. It does nothing but keep its lease while
 * `SHANNON_AUTONOMY_ENABLED` is not `true`, while the owner has paused her, or while
 * no dedicated model credential is configured.
 */
const databasePath = configuredDatabasePath();
const now = () => new Date().toISOString();
const store = new SQLiteAutonomyStore(databasePath);
const config = configuredAutonomy(process.env, { databasePath });
const announcer = new SQLiteAutonomyAnnouncer(databasePath);
// The same zone as the initiative loop, so both share one message slot per day.
const showing = new SQLiteStudyShowing(databasePath);
const service = new ShannonAutonomyService({ store, config, now, announcer });
// Read-only Notion, only when the owner connected it; without a token the loop never plans a Notion step.
const notion = notionLoopReader(configuredNotionSource(process.env, { log: line => console.log(line) }));
const loop = new ShannonAutonomyLoop({
  store, service, config, loop: configuredAutonomyLoop(process.env), model: configuredAutonomyTextModel(process.env),
  reader: new BoundedPublicReader({
    maximumBytes: boundedInteger(process.env.SHANNON_AUTONOMY_READ_MAX_BYTES, 10_000, 5_000_000, 1_500_000),
    timeoutMilliseconds: boundedInteger(process.env.SHANNON_AUTONOMY_READ_TIMEOUT_MS, 1_000, 60_000, 10_000),
  }),
  showing, now, ...(notion ? { notion } : {}),
});
const pollMilliseconds = boundedInteger(process.env.SHANNON_AUTONOMY_POLL_SECONDS, 5, 3_600, 60) * 1_000;
const once = process.argv.includes('--once');
const shutdown = new AbortController();
let stopping = false;
const requestStop = () => { stopping = true; shutdown.abort(); };
process.once('SIGINT', requestStop);
process.once('SIGTERM', requestStop);

console.log(`Shannon autonomy worker started (${loop.workerId}, ${loop.readiness()})`);
let last = '';
try {
  do {
    let tick: string;
    try {
      tick = await loop.tick(shutdown.signal);
    } catch (error) {
      tick = `failed:${error instanceof Error ? error.message.replace(/[^A-Z0-9_:-]/giu, '_').slice(0, 80) : 'UNKNOWN'}`;
    }
    // Content-free: only the state of the loop is logged, and only when it changes.
    if (tick !== last && tick !== 'stepped') console.log(`Shannon autonomy loop: ${tick}`);
    last = tick;
    if (once) break;
    try {
      await delay(tick === 'stepped' || tick === 'cycle-ended' ? 2_000 : pollMilliseconds, undefined, { signal: shutdown.signal });
    } catch (error) {
      if (!stopping) throw error;
    }
  } while (!stopping);
} finally {
  try { loop.release(); } catch { /* the lease runs out by itself */ }
  showing.close();
  announcer.close();
  store.close();
}

function boundedInteger(value: string | undefined, minimum: number, maximum: number, fallback: number): number {
  const parsed = Number(value);
  return value?.trim() && Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
