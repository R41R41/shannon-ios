import { randomUUID } from 'node:crypto';
import type { BackgroundJobPayload } from '../../mind/sleep/store/backgroundJobStore.js';
import { migrateAgentTasks } from '../../mind/action/agentTasks/agentTaskStore.js';
import { DEFAULT_QUESTION_DEFINITIONS } from '../../mind/memory/store/knowledgeStore.js';
import { conciseThreadTitle, parseSnapshot, parseTurnPayload } from './sqliteStoreCodecs.js';
import type { SQLiteCompanionRepository } from './sqliteCompanionRepository.js';
import type { SQLiteStoreContext } from './sqliteStoreContext.js';
import { migrateMemorySearchIndex } from '../../mind/memory/store/sqliteMemorySearch.js';
import { migrateMemoryEmbeddings } from '../../mind/memory/store/sqliteMemoryEmbeddings.js';
import { migrateShannonKnowledge } from '../../mind/memory/store/sqliteShannonKnowledge.js';

const SCHEMA_VERSION = 17;
interface EventRow { sequence: number; event_id: string; scope_key: string; event_type: string; observed_at: string; payload_json: string; }

export class SQLiteStoreMigrator {
  constructor(private readonly context: SQLiteStoreContext, private readonly companion: SQLiteCompanionRepository) {}

  migrate(): void {
    const version = this.context.database.prepare('PRAGMA user_version').get() as unknown as { user_version: number };
    const previousVersion = Number(version.user_version);
    if (previousVersion > SCHEMA_VERSION) {
      throw new Error(`SHANNON_DATABASE_SCHEMA_TOO_NEW:${version.user_version}`);
    }
    if (previousVersion === SCHEMA_VERSION) return;
    this.context.transaction(() => {
      if (previousVersion < 1) this.context.database.exec(`
        CREATE TABLE IF NOT EXISTS companion_states (
          scope_key TEXT PRIMARY KEY,
          version INTEGER NOT NULL CHECK (version >= 0),
          updated_at TEXT NOT NULL,
          snapshot_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS conversation_messages (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id TEXT NOT NULL UNIQUE,
          scope_key TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          ordinal INTEGER NOT NULL CHECK (ordinal IN (0, 1)),
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
          content TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          metadata_json TEXT,
          UNIQUE (scope_key, turn_id, ordinal)
        );

        CREATE INDEX IF NOT EXISTS conversation_messages_scope_sequence
          ON conversation_messages (scope_key, sequence);

        CREATE TABLE IF NOT EXISTS experience_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          scope_key TEXT NOT NULL,
          event_type TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS experience_events_scope_sequence
          ON experience_events (scope_key, sequence);
        CREATE INDEX IF NOT EXISTS experience_events_scope_type_sequence
          ON experience_events (scope_key, event_type, sequence);

      `);
      if (previousVersion < 2) this.context.database.exec(`
        CREATE TABLE IF NOT EXISTS background_jobs (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id TEXT NOT NULL UNIQUE,
          dedupe_key TEXT NOT NULL UNIQUE,
          scope_key TEXT NOT NULL,
          job_kind TEXT NOT NULL CHECK (job_kind IN ('turn-refinement', 'sleep-consolidation')),
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'completed', 'failed')),
          available_at TEXT NOT NULL,
          lease_owner TEXT,
          lease_until TEXT,
          attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
          created_at TEXT NOT NULL,
          completed_at TEXT,
          last_error TEXT
        );
        CREATE INDEX IF NOT EXISTS background_jobs_claim
          ON background_jobs (status, available_at, sequence);
      `);
      if (previousVersion === 1) {
        const historicalTurns = this.context.database.prepare(`
          SELECT sequence, event_id, scope_key, event_type, observed_at, payload_json
          FROM experience_events
          WHERE event_type = 'turn.completed'
          ORDER BY sequence ASC
        `).all() as unknown as EventRow[];
        const markHistorical = this.context.database.prepare(`
          INSERT OR IGNORE INTO background_jobs
            (job_id, dedupe_key, scope_key, job_kind, payload_json, status, available_at, attempts, created_at, completed_at)
          VALUES (?, ?, ?, 'turn-refinement', ?, 'completed', ?, 0, ?, ?)
        `);
        for (const row of historicalTurns) {
          const turn = parseTurnPayload(row.payload_json);
          if (!turn) continue;
          const payload: BackgroundJobPayload = {
            kind: 'turn-refinement',
            experienceId: row.event_id,
            userMessage: turn.userMessage,
          };
          markHistorical.run(
            randomUUID(),
            `turn:${row.event_id}`,
            row.scope_key,
            JSON.stringify(payload),
            row.observed_at,
            row.observed_at,
            row.observed_at,
          );
        }
      }
      if (previousVersion < 3) this.migrateThreadedConversations();
      if (previousVersion < 4) this.migrateKnowledgeCore();
      if (previousVersion < 5) this.migrateThreadArchive();
      if (previousVersion < 6) this.migrateLlmUsage();
      if (previousVersion < 7) migrateAgentTasks(this.context.database);
      if (previousVersion < 8) this.migrateThreadTitleOrigin();
      if (previousVersion < 9) this.migrateVoiceUsageLane();
      if (previousVersion < 10) this.migrateThreadSummary();
      if (previousVersion < 11) this.migrateRealtimeVoiceReservations();
      if (previousVersion < 12) this.migratePlatformTurnReceipts();
      if (previousVersion < 13) this.migrateRealtimeVoiceAllowanceExtensions();
      if (previousVersion < 14) this.repairMemoryProjections();
      if (previousVersion < 15) migrateMemorySearchIndex(this.context.database);
      if (previousVersion < 16) migrateMemoryEmbeddings(this.context.database);
      if (previousVersion < 17) migrateShannonKnowledge(this.context.database);
      this.context.database.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    });
  }

  private repairMemoryProjections(): void {
    const scopes = this.context.database.prepare('SELECT scope_key FROM companion_states').all();
    for (const row of scopes) {
      const scope = String(row.scope_key);
      const state = this.companion.snapshot(scope);
      // Add provenance only. History, facts, old profile versions and controls
      // remain auditable; active derivatives are rebuilt under current policy.
      this.context.database.prepare('UPDATE companion_states SET snapshot_json = ? WHERE scope_key = ?')
        .run(JSON.stringify(state), scope);
      this.companion.writePersonalityProfile(scope, state, this.context.now());
      this.companion.writePromptProjection(scope, state);
    }
  }

  private migrateThreadTitleOrigin(): void {
    const columns = this.context.database.prepare("PRAGMA table_info('conversation_threads')").all() as unknown as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'title_origin')) {
      // Legacy titles have no edit provenance; preserve even manually chosen default titles.
      this.context.database.exec("ALTER TABLE conversation_threads ADD COLUMN title_origin TEXT NOT NULL DEFAULT 'manual';");
    }
  }

  private migrateThreadSummary(): void {
    const columns = this.context.database.prepare("PRAGMA table_info('conversation_threads')").all() as unknown as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'summary')) {
      this.context.database.exec('ALTER TABLE conversation_threads ADD COLUMN summary TEXT;');
    }
  }

  private migratePlatformTurnReceipts(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS platform_turn_receipts (
        scope_key TEXT NOT NULL,
        platform TEXT NOT NULL,
        request_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        experience_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, platform, request_id)
      );
      CREATE INDEX IF NOT EXISTS platform_turn_receipts_created
        ON platform_turn_receipts (created_at DESC);
    `);
  }

  private migrateThreadedConversations(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS conversation_threads (
        thread_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversation_threads_scope
        ON conversation_threads (scope_key, updated_at DESC);
    `);

    const columns = this.context.database.prepare("PRAGMA table_info('conversation_messages')").all() as unknown as Array<{ name: string }>;
    const hasThreadId = columns.some(column => column.name === 'thread_id');

    if (!hasThreadId) {
      const now = this.context.now();
      this.context.database.exec('ALTER TABLE conversation_messages ADD COLUMN thread_id TEXT;');

      const scopes = this.context.database.prepare(`
        SELECT DISTINCT scope_key
        FROM conversation_messages
      `).all() as unknown as Array<{ scope_key: string }>;

      const createThread = this.context.database.prepare(`
        INSERT INTO conversation_threads (thread_id, scope_key, title, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      const seedFirstMessage = this.context.database.prepare(`
        SELECT content, observed_at
        FROM conversation_messages
        WHERE scope_key = ?
        ORDER BY sequence ASC
        LIMIT 1
      `);
      const assignThread = this.context.database.prepare(`
        UPDATE conversation_messages
        SET thread_id = ?
        WHERE scope_key = ?
      `);

      for (const row of scopes) {
        const threadId = `legacy:${row.scope_key}`;
        const seed = seedFirstMessage.get(row.scope_key) as { content: string; observed_at: string } | undefined;
        const title = seed ? conciseThreadTitle(seed.content) : '新しいトーク';
        createThread.run(threadId, row.scope_key, title, seed?.observed_at ?? now, seed?.observed_at ?? now);
        assignThread.run(threadId, row.scope_key);
      }
    }

    const missing = this.context.database.prepare(`
      SELECT scope_key, message_id
      FROM conversation_messages
      WHERE thread_id IS NULL
      LIMIT 1
    `).get();
    if (missing) {
      const now = this.context.now();
      const createThread = this.context.database.prepare(`
        INSERT INTO conversation_threads (thread_id, scope_key, title, created_at, updated_at)
        VALUES (?, ?, '新しいトーク', ?, ?)
      `);
      const assignMissing = this.context.database.prepare(`
        UPDATE conversation_messages
        SET thread_id = ?
        WHERE scope_key = ? AND thread_id IS NULL
      `);
      const rows = this.context.database.prepare(`
        SELECT DISTINCT scope_key
        FROM conversation_messages
        WHERE thread_id IS NULL
      `).all() as unknown as Array<{ scope_key: string }>;
      for (const row of rows) {
        const threadId = randomUUID();
        createThread.run(threadId, row.scope_key, '新しいトーク', now, now);
        assignMissing.run(threadId, row.scope_key);
      }
    }

    this.context.database.exec(`
      CREATE INDEX IF NOT EXISTS conversation_messages_scope_thread
        ON conversation_messages (scope_key, thread_id, sequence);
    `);

    const conversationThreads = this.context.database.prepare(`
      SELECT COUNT(*) AS count FROM conversation_threads
    `).get() as unknown as { count: number };
    if (conversationThreads.count === 0) return;

    this.context.database.exec(`
      CREATE INDEX IF NOT EXISTS conversation_messages_thread_scope_sequence
        ON conversation_messages (thread_id, scope_key, sequence);
    `);
  }

  private migrateThreadArchive(): void {
    const columns = this.context.database.prepare("PRAGMA table_info('conversation_threads')").all() as unknown as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'archived_at')) {
      this.context.database.exec('ALTER TABLE conversation_threads ADD COLUMN archived_at TEXT;');
    }
    this.context.database.exec(`
      CREATE INDEX IF NOT EXISTS conversation_threads_active_scope
        ON conversation_threads (scope_key, archived_at, updated_at DESC);
    `);
  }

  private migrateLlmUsage(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS llm_usage_events (
        usage_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        lane TEXT NOT NULL CHECK (lane IN ('chat', 'sleep', 'voice')),
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
        cached_input_tokens INTEGER NOT NULL CHECK (cached_input_tokens >= 0),
        output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
        total_tokens INTEGER NOT NULL CHECK (total_tokens >= 0),
        estimated_cost_usd REAL NOT NULL CHECK (estimated_cost_usd >= 0),
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS llm_usage_events_month_lane
        ON llm_usage_events (occurred_at, lane);
    `);
  }

  private migrateVoiceUsageLane(): void {
    const row = this.context.database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'llm_usage_events'
    `).get() as unknown as { sql?: string } | undefined;
    if (row?.sql?.includes("'voice'")) return;

    this.context.database.exec(`
      ALTER TABLE llm_usage_events RENAME TO llm_usage_events_before_voice;
      CREATE TABLE llm_usage_events (
        usage_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        lane TEXT NOT NULL CHECK (lane IN ('chat', 'sleep', 'voice')),
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
        cached_input_tokens INTEGER NOT NULL CHECK (cached_input_tokens >= 0),
        output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
        total_tokens INTEGER NOT NULL CHECK (total_tokens >= 0),
        estimated_cost_usd REAL NOT NULL CHECK (estimated_cost_usd >= 0),
        occurred_at TEXT NOT NULL
      );
      INSERT INTO llm_usage_events
        (usage_id, scope_key, lane, model, input_tokens, cached_input_tokens,
         output_tokens, total_tokens, estimated_cost_usd, occurred_at)
      SELECT usage_id, scope_key, lane, model, input_tokens, cached_input_tokens,
             output_tokens, total_tokens, estimated_cost_usd, occurred_at
      FROM llm_usage_events_before_voice;
      DROP TABLE llm_usage_events_before_voice;
      CREATE INDEX llm_usage_events_month_lane
        ON llm_usage_events (occurred_at, lane);
    `);
  }

  private migrateRealtimeVoiceReservations(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS realtime_voice_session_reservations (
        reservation_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        day_key TEXT NOT NULL,
        reserved_seconds INTEGER NOT NULL CHECK (reserved_seconds > 0),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS realtime_voice_session_reservations_scope_day
        ON realtime_voice_session_reservations (scope_key, day_key);
    `);
  }

  private migrateRealtimeVoiceAllowanceExtensions(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS realtime_voice_allowance_extensions (
        scope_key TEXT NOT NULL,
        day_key TEXT NOT NULL,
        additional_seconds INTEGER NOT NULL CHECK (additional_seconds > 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, day_key)
      );
    `);
  }

  private migrateKnowledgeCore(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS question_definitions (
        question_key TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        question TEXT NOT NULL,
        display_order INTEGER NOT NULL,
        allows_multiple INTEGER NOT NULL DEFAULT 0 CHECK (allows_multiple IN (0, 1)),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS knowledge_answers (
        answer_id TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        question_key TEXT NOT NULL,
        answer TEXT NOT NULL,
        confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        source TEXT NOT NULL CHECK (source IN ('conversation', 'sleep', 'user', 'inference')),
        confirmed INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0, 1)),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope_key, answer_id),
        FOREIGN KEY (question_key) REFERENCES question_definitions(question_key)
      );
      CREATE INDEX IF NOT EXISTS knowledge_answers_scope_question
        ON knowledge_answers (scope_key, question_key, updated_at DESC);
      CREATE TABLE IF NOT EXISTS knowledge_evidence (
        evidence_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        answer_id TEXT NOT NULL,
        quote TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('conversation', 'sleep', 'user', 'inference')),
        observed_at TEXT NOT NULL,
        UNIQUE (scope_key, answer_id, quote, observed_at)
      );
      CREATE INDEX IF NOT EXISTS knowledge_evidence_answer
        ON knowledge_evidence (scope_key, answer_id, observed_at DESC);
      CREATE TABLE IF NOT EXISTS knowledge_revisions (
        revision_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        answer_id TEXT NOT NULL,
        previous_answer TEXT,
        next_answer TEXT NOT NULL,
        reason TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS knowledge_revisions_answer
        ON knowledge_revisions (scope_key, answer_id, observed_at DESC);
      CREATE TABLE IF NOT EXISTS personality_profiles (
        profile_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        version INTEGER NOT NULL,
        analysis TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        created_at TEXT NOT NULL,
        UNIQUE (scope_key, version)
      );
      CREATE TABLE IF NOT EXISTS activity_events (
        activity_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        activity_type TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT,
        occurred_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS activity_events_scope_time
        ON activity_events (scope_key, occurred_at DESC);
      CREATE TABLE IF NOT EXISTS sleep_runs (
        sleep_run_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        day_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
        summary_json TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE (scope_key, day_key)
      );
      CREATE TABLE IF NOT EXISTS prompt_projections (
        scope_key TEXT PRIMARY KEY,
        state_version INTEGER NOT NULL,
        content TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const seededAt = this.context.now();
    const insertDefinition = this.context.database.prepare(`
      INSERT OR IGNORE INTO question_definitions
        (question_key, category, question, display_order, allows_multiple, created_at)
      VALUES (?, ?, ?, ?, 0, ?)
    `);
    for (const definition of DEFAULT_QUESTION_DEFINITIONS) {
      insertDefinition.run(definition.key, definition.category, definition.question, definition.order, seededAt);
    }

    const states = this.context.database.prepare(`
      SELECT scope_key, snapshot_json FROM companion_states
    `).all() as unknown as Array<{ scope_key: string; snapshot_json: string }>;
    for (const row of states) {
      const state = parseSnapshot(row.snapshot_json, row.scope_key, seededAt);
      for (const fact of state.userFacts) this.companion.synchronizeFact(row.scope_key, fact, 'sleep');
      this.companion.writePromptProjection(row.scope_key, state);
    }
  }


}
