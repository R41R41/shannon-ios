import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { conversationGrowth, nextTurnServe, skillRoutingSwitches } from '@shannon/learning';
import { PREDICTION_SOURCE_ID, PREDICTION_SYMBOL, dayBand } from '../contracts/cognitionLedgerContract.js';
import type { ConversationTurnRecord, TurnRouting } from '../contracts/turnRoutingContract.js';
import type { LlmUsageStore } from '../infra/models/llmUsage.js';
import { OpenAITurnChecker } from '../infra/models/turnChecker.js';
import type { ChoiceLedger } from '../mind/learning/choiceLedger.js';
import { TierCompetence } from '../mind/selectors/tierCompetence.js';
import type { SkillTurnPorts } from '../contracts/skillMemoryContract.js';

/**
 * Wiring of Syzygy ADR-0008 stage 2, step 4 (`docs/skill-and-routing-contract.md`): what a conversation turn is handed for its tier,
 * its verifier and the learning of its choices. Null with `SHANNON_ADR8_STAGE2=off` (or all three parts off): then every turn is
 * what it was, and her conversation tool calls stay stage 1's data-only choices.
 *
 * - The competence table has its own connection, created by the API process (`shannon_tier_outcomes`), with `SHANNON_DIFFICULTY`.
 * - Her conversation choices (owner answer I-3) go to the stage-1 choice ledger with `SHANNON_CONVERSATION_REWARD`, scored by
 *   closed signals and settled by the owner's next turn; the ledger must be on (`SHANNON_CHOICE_LEDGER`).
 * - Sonnet is available only when `configuredSonnet` built it (the key and `SHANNON_SONNET_ROUTING=on`, step 5); the voice policy reads
 *   its rolling first-token latency.
 * - Step 6 (`SHANNON_SKILLS`): a skill she opened in the turn is a use of it, noted on the skill (settled like a tier's outcome)
 *   and, with the conversation reward, recorded as the choice `skill.use` (source: the skill) instead of `tool.skill.read`.
 */
const PRAGMAS = 'PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;';

export function configuredTurnRouting(
  environment: Readonly<Record<string, string | undefined>>,
  parts: { databasePath: string | null; choices: ChoiceLedger | null; usageStore?: LlmUsageStore; now?: () => string; fetcher?: typeof fetch; database?: DatabaseSync;
    /** Step 6: her skill memory's turn ports (`skillMemoryWiring.ts`), handed only while `SHANNON_SKILLS` is on. */ skills?: SkillTurnPorts | null;
    /** When writes run (tests: at once). */ defer?: (task: () => void) => void;
    /** Step 5: the Sonnet tier when routing is available (`configuredSonnet`), for its availability and measured first-token latency. */
    sonnet?: { firstTokenLatency: { estimate(): number | null } } | null },
): { routing: TurnRouting; close(): void } | null {
  const switches = skillRoutingSwitches(environment);
  const skills = switches.skills ? parts.skills ?? null : null;
  if (!switches.stage2 || (!switches.difficulty && !switches.turnVerify && !switches.conversationReward && !skills)) return null;
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
    sonnetAvailable: Boolean(parts.sonnet),
    sonnetFirstTokenMs: () => parts.sonnet?.firstTokenLatency.estimate() ?? null,
    competence: (scopeKey, tier, kind) => competence?.competence(scopeKey, tier, kind) ?? null,
    nextTurn: (scopeKey, talk, retryProbability, at) => {
      // Inside Jev's band only (ADR-0008 §14): unsure settles as if the next turn had said nothing (S = ½ for the ledger, G alone).
      const serve = nextTurnServe(retryProbability);
      choices?.settleTalk(scopeKey, talk, serve ?? 0.5, at, serve === null ? 'next_turn_unsure' : 'next_turn');
      competence?.nextTurn(scopeKey, talk, serve, at);
      skills?.nextTurn(scopeKey, talk, serve, at);
    },
    record: (scopeKey, turn, at) => recordTurn(choices, competence, scopeKey, turn, at, skills),
    ...(checker ? { checker } : {}),
  };
  return { routing, close: () => { if (database && !parts.database && database.isOpen) database.close(); } };
}

/**
 * One turn's choices: each tool call that ran (`tool.<name>`) and the tier (`tier.<served>`), with G from closed signals
 * (`conversationGrowth`): the tool worked, the turn ended inside its deadline, the verifier found nothing (when it checked). The
 * tier's outcome also goes to the competence table.
 */
export function recordTurn(choices: ChoiceLedger | null, competence: TierCompetence | null, scopeKey: string, turn: ConversationTurnRecord, at: string,
  skills: SkillTurnPorts | null = null): void {
  const verified = turn.verified === null ? [] : [turn.verified];
  const context = `${dayBand(at)}.${turn.presence}`;
  for (const tool of turn.tools) {
    // A skill she opened (step 6): a use of that skill, noted on it and recorded once as `skill.use` with the skill as its source.
    if (tool.name === 'skill.read' && tool.subject && skills) {
      const growth = conversationGrowth([tool.ok, turn.inDeadline, ...verified]);
      let skillId: string | null = null;
      try { skillId = skills.used(scopeKey, tool.subject, { talk: turn.talk, growth }, at); } catch { skillId = null; }
      if (skillId && PREDICTION_SOURCE_ID.test(skillId)) {
        choices?.recordConversation(scopeKey, { surface: turn.surface, choice: 'skill.use', context, sourceKind: 'skill', sourceId: skillId }, growth, turn.talk, at);
        continue;
      }
    }
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
