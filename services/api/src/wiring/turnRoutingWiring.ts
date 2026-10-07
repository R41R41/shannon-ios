import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { conversationGrowth, nextTurnServe, skillRoutingSwitches } from '@shannon/learning';
import { PREDICTION_SYMBOL, dayBand } from '../contracts/cognitionLedgerContract.js';
import type { ConversationTurnRecord, TurnRouting } from '../contracts/turnRoutingContract.js';
import type { LlmUsageStore } from '../infra/models/llmUsage.js';
import { OpenAITurnChecker } from '../infra/models/turnChecker.js';
import type { ChoiceLedger } from '../mind/learning/choiceLedger.js';
import { TierCompetence } from '../mind/selectors/tierCompetence.js';

/**
 * Wiring of Syzygy ADR-0008 stage 2, step 4 (`docs/skill-and-routing-contract.md`): what a conversation turn is handed for its tier,
 * its verifier and the learning of its choices. Null with `SHANNON_ADR8_STAGE2=off` (or all three parts off): then every turn is
 * what it was, and her conversation tool calls stay stage 1's data-only choices.
 *
 * - The competence table has its own connection, created by the API process (`shannon_tier_outcomes`), with `SHANNON_DIFFICULTY`.
 * - Her conversation choices (owner answer I-3) go to the stage-1 choice ledger with `SHANNON_CONVERSATION_REWARD`, scored by
 *   closed signals and settled by the owner's next turn; the ledger must be on (`SHANNON_CHOICE_LEDGER`).
 * - Sonnet is never available in step 4: there is no Anthropic client yet (step 5 adds it behind the key and `SHANNON_SONNET_ROUTING`).
 */
const PRAGMAS = 'PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;';

export function configuredTurnRouting(
  environment: Readonly<Record<string, string | undefined>>,
  parts: { databasePath: string | null; choices: ChoiceLedger | null; usageStore?: LlmUsageStore; now?: () => string; fetcher?: typeof fetch; database?: DatabaseSync;
    /** When writes run (tests: at once). */ defer?: (task: () => void) => void },
): { routing: TurnRouting; close(): void } | null {
  const switches = skillRoutingSwitches(environment);
  if (!switches.stage2 || (!switches.difficulty && !switches.turnVerify && !switches.conversationReward)) return null;
  let database: DatabaseSync | null = null;
  if (switches.difficulty && (parts.database || parts.databasePath)) {
    database = parts.database ?? new DatabaseSync(parts.databasePath!);
    if (!parts.database) database.exec(PRAGMAS);
  }
  const competence = database ? new TierCompetence({ database, createsSchema: true, ...(parts.defer ? { defer: parts.defer } : {}) }) : null;
  const choices = switches.conversationReward && parts.choices?.conversation ? parts.choices : null;
  const apiKey = environment.OPENAI_API_KEY?.trim();
  const checker = apiKey && switches.turnVerify && switches.difficulty ? new OpenAITurnChecker({
    apiKey, model: environment.SHANNON_LLM_MODEL?.trim() || 'gpt-5.6-luna', ...(parts.usageStore ? { usageStore: parts.usageStore } : {}),
    ...(parts.fetcher ? { fetcher: parts.fetcher } : {}), ...(parts.now ? { now: parts.now } : {}),
  }) : null;
  const routing: TurnRouting = {
    switches: { difficulty: switches.difficulty, turnVerify: switches.turnVerify, conversationReward: choices !== null },
    sonnetAvailable: false,
    sonnetFirstTokenMs: () => null,
    competence: (scopeKey, tier, kind) => competence?.competence(scopeKey, tier, kind) ?? null,
    nextTurn: (scopeKey, talk, retryProbability, at) => {
      const serve = nextTurnServe(retryProbability);
      choices?.settleTalk(scopeKey, talk, serve, at);
      competence?.nextTurn(scopeKey, talk, serve, at);
    },
    record: (scopeKey, turn, at) => recordTurn(choices, competence, scopeKey, turn, at),
    ...(checker ? { checker } : {}),
  };
  return { routing, close: () => { if (database && !parts.database && database.isOpen) database.close(); } };
}

/**
 * One turn's choices: each tool call that ran (`tool.<name>`) and the tier (`tier.<served>`), with G from closed signals
 * (`conversationGrowth`): the tool worked, the turn ended inside its deadline, the verifier found nothing (when it checked). The
 * tier's outcome also goes to the competence table.
 */
export function recordTurn(choices: ChoiceLedger | null, competence: TierCompetence | null, scopeKey: string, turn: ConversationTurnRecord, at: string): void {
  const verified = turn.verified === null ? [] : [turn.verified];
  const context = `${dayBand(at)}.${turn.presence}`;
  for (const tool of turn.tools) {
    const choice = PREDICTION_SYMBOL.test(`tool.${tool.name}`) ? `tool.${tool.name}` : 'tool.unknown';
    choices?.recordConversation(scopeKey, { surface: turn.surface, choice, context, sourceKind: 'tool_call', sourceId: randomUUID() },
      conversationGrowth([tool.ok, turn.inDeadline, ...verified]), turn.talk, at);
  }
  if (!turn.tier) return;
  const growth = conversationGrowth([turn.inDeadline, ...verified, turn.tools.every(tool => tool.ok)]);
  const tier = PREDICTION_SYMBOL.test(`tier.${turn.tier.served}`) ? turn.tier.served : 'luna';
  choices?.recordConversation(scopeKey, { surface: turn.surface, choice: `tier.${tier}`, context, sourceKind: 'turn', sourceId: randomUUID() }, growth, turn.talk, at);
  competence?.record(scopeKey, { talkId: turn.talk, surface: turn.surface, tier, taskKind: PREDICTION_SYMBOL.test(turn.tier.kind) ? turn.tier.kind : 'unknown', growth }, at);
}
