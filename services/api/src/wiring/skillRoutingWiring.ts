import { skillRoutingSwitches, type SkillRoutingSwitches } from '@shannon/learning';
import type { DecisionTraceWriter } from '../contracts/decisionTraceContract.js';
import { countedJevFetch } from '../infra/models/jev/jevClient.js';
import { JevChoiceClient, JevChooser, type JevChoiceTrace } from '../infra/models/jev/jevChoice.js';
import { jevUsdPerCall } from '../infra/models/jev/jevUsage.js';
import { JevTurnChooser, type TurnChooser } from '../mind/selectors/turnChoices.js';
import type { ReadToolPorts } from '../mind/tools/shannonReadTools.js';
import { conversationCapabilityPrompt } from '../mind/action/respond/conversationCapabilities.js';
import { notionTurnProjection } from '../integrations/notion/notionConversation.js';
import type { NotionSource } from '../integrations/notion/notionSource.js';
import type { VoyagerCatalog } from '../integrations/voyager/organize.js';
import { type OwnerUpcoming } from '../mind/memory/ownerUpcoming.js';
import type { ShannonChatModel } from '../infra/models/chatModel.js';
import { runPlaceDiscoverySkill } from '../integrations/places/placeDiscoverySkill.js';
import { dailyToolPorts } from './dailyReadWiring.js';

/**
 * Wiring of Syzygy ADR-0008 stage 2 (`docs/skill-and-routing-contract.md`): what the API kernel is handed for the turn's Jev
 * call. Each part reads its switch from the environment it is given; `SHANNON_ADR8_STAGE2=off` hands nothing, and the kernel
 * is then exactly the kernel of ca7cf519 (`stage2SwitchedOff.test.ts`).
 */
export interface SkillRoutingParts {
  /** The turn's Jev call (the tool menu, and from step 4 the difficulty); absent without Jev or with the parts switched off. */
  turnChooser?: TurnChooser;
  /** With the tool menu's switch: a search or read that found nothing names the places the turn can look in (`sourcesLine`). */
  toolHints?: true;
}

export function skillRoutingParts(
  environment: Readonly<Record<string, string | undefined>>,
  options: { trace: DecisionTraceWriter | null; jevFetch?: typeof fetch; now?: () => string; /** The install's secret salt of the input digest `h`. */ salt?: string },
): SkillRoutingParts {
  const switches = skillRoutingSwitches(environment);
  const chooser = configuredTurnChooser(environment, switches, options);
  return { ...(chooser ? { turnChooser: chooser } : {}), ...(switches.stage2 && switches.toolMenu ? { toolHints: true as const } : {}) };
}

function configuredTurnChooser(
  environment: Readonly<Record<string, string | undefined>>, switches: SkillRoutingSwitches,
  options: { trace: DecisionTraceWriter | null; jevFetch?: typeof fetch; now?: () => string; /** The install's secret salt of the input digest `h`. */ salt?: string },
): TurnChooser | null {
  if (!switches.stage2 || (!switches.toolMenu && !switches.difficulty)) return null;
  const jev = configuredJevChooser(environment, options);
  return jev ? new JevTurnChooser(jev, { toolMenu: switches.toolMenu, difficulty: switches.difficulty }) : null;
}

/**
 * The stage-2 Jev client with its trace writer (the turn's call, and tree recall's beam): the same endpoint, model and timeout as
 * the voice router's Jev (`createConfiguredVoiceDecisionGateway`), counted like it. Null without `TYPESAFE_API_KEY`.
 */
export function configuredJevChooser(
  environment: Readonly<Record<string, string | undefined>>,
  options: { trace: DecisionTraceWriter | null; jevFetch?: typeof fetch; now?: () => string; /** The install's secret salt of the input digest `h`. */ salt?: string },
): JevChooser | null {
  const apiKey = environment.TYPESAFE_API_KEY?.trim();
  if (!apiKey) return null;
  const timeout = Number(environment.SHANNON_JEV_TIMEOUT_MS);
  const client = new JevChoiceClient({
    apiKey,
    ...(environment.SHANNON_JEV_ENDPOINT?.trim() ? { endpoint: environment.SHANNON_JEV_ENDPOINT.trim() } : {}),
    model: environment.SHANNON_JEV_MODEL?.trim() || 'jev-latest',
    ...(Number.isInteger(timeout) && timeout > 0 ? { timeoutMilliseconds: timeout } : {}),
    fetcher: options.trace ? countedJevFetch(options.jevFetch) : options.jevFetch ?? fetch,
  });
  const write = options.trace;
  return new JevChooser(client, {
    usdPerCall: jevUsdPerCall(environment), ...(options.salt ? { salt: options.salt } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(write ? { trace: (scopeKey: string, trace: JevChoiceTrace) => write(scopeKey, {
      surface: trace.surface, decision: trace.decision, decider: 'jev', model: trace.model, questions: trace.questions, contextChars: trace.contextChars,
      latencyMs: trace.latencyMs, outcome: trace.outcome, fallbackDecider: trace.outcome === 'ok' ? null : 'local', answers: trace.answers,
      costUsd: trace.costUsd, relatedId: null, at: trace.at,
    }) } : {}),
  });
}

/**
 * Step 3 (`SHANNON_READ_TOOLS`): the ports of her read tools, over the same reads the conversation's projections make. Null
 * while stage 2 or the switch is off: then her runner has none of them and every offer is what it was.
 */
export function readToolPorts(
  environment: Readonly<Record<string, string | undefined>>,
  parts: { notion: NotionSource | null; voyagerCatalog: VoyagerCatalog;
    upcoming: Pick<OwnerUpcoming, 'promptFor'> & Partial<Pick<OwnerUpcoming, 'promptWithSources' | 'searchWithSources' | 'freeTimeWithSources' | 'loopLines'>>;
    chatModel: ShannonChatModel; now?: () => string },
): ReadToolPorts | null {
  if (!skillRoutingSwitches(environment).readTools) return null;
  return {
    ...(parts.chatModel.searchWeb ? { web: parts.chatModel.searchWeb.bind(parts.chatModel) } : {}),
    ...(parts.chatModel.readWeb ? { webRead: parts.chatModel.readWeb.bind(parts.chatModel) } : {}),
    notion: async query => {
      const sourceIds = new Set<string>();
      const read = await notionTurnProjection(parts.notion, `Notionの「${query}」`, Date.now,
        ids => ids.forEach(id => sourceIds.add(`notion-page://${id.replaceAll('-', '').toLowerCase()}`)));
      return { text: read?.prompt ?? '', sources: read?.sources ?? [], sourceIds: [...sourceIds] };
    },
    voyagerTasks: async query => {
      const sourceIds: string[] = [];
      const text = await conversationCapabilityPrompt('', query ? `「${query}」のタスク` : 'タスク', { voyagerCatalog: parts.voyagerCatalog },
        { aetherNotes: false, voyagerTasks: true, upcoming: false, ownOutreach: false }, ids => sourceIds.push(...ids));
      return { text, sourceIds };
    },
    upcoming: (scopeKey, range) => {
      const message = range === 'week' ? '今週の予定' : 'これからの予定';
      const projection = parts.upcoming.promptWithSources?.(scopeKey, message, 'owner');
      return projection ? { text: projection.prompt, sourceIds: projection.sourceIds.map(id => `calendar-item://${encodeURIComponent(id)}`) }
        : parts.upcoming.promptFor(scopeKey, message, 'owner');
    },
    ...(parts.upcoming.searchWithSources ? { upcomingSearch: (scopeKey: string, input: Record<string, unknown>) => {
      const projection = parts.upcoming.searchWithSources!(scopeKey, input);
      return { text: projection.prompt, sourceIds: projection.sourceIds.map(id => `calendar-item://${encodeURIComponent(id)}`) };
    } } : {}),
    ...(parts.upcoming.freeTimeWithSources ? { freeTime: (scopeKey: string, input: Record<string, unknown>) => {
      const projection = parts.upcoming.freeTimeWithSources!(scopeKey, input);
      return { text: projection.prompt, sourceIds: projection.sourceIds.map(id => `calendar-item://${encodeURIComponent(id)}`) };
    } } : {}),
    daily: dailyToolPorts(environment, {
      ...(parts.upcoming.loopLines ? { schedule: (scopeKey: string, at: string) => parts.upcoming.loopLines!(scopeKey, at, 'owner') } : {}),
      ...(parts.chatModel.searchWeb ? { web: parts.chatModel.searchWeb.bind(parts.chatModel) } : {}), ...(parts.now ? { now: parts.now } : {}),
    }),
    places: async (scopeKey, query, spoken, permitted) => runPlaceDiscoverySkill(parts.chatModel, { scopeKey, message: query, context: { ...permitted, ...(spoken ? { spoken: true } : {}) } }),
  };
}
