import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createLocalApiKernel, type ShannonApiKernelOptions } from '../src/infra/http/apiKernel.js';
import { OpenAIResponsesChatModel } from '../src/infra/models/chatModel.js';
import { createConfiguredVoiceDecisionGateway, VOICE_SKILLS } from '../src/mind/selectors/voiceDecision.js';
import { stage2SwitchedOffScenarios } from './support/stage2Scenarios.js';
import { readToolPorts, skillRoutingParts } from '../src/wiring/skillRoutingWiring.js';
import { configuredTurnRouting } from '../src/wiring/turnRoutingWiring.js';
import { DatabaseSync } from 'node:sqlite';
import { DisabledVoyagerCatalog } from '../src/integrations/voyager/organizeIntegrations.js';
import { LocalStubChatModel } from '../src/infra/models/chatModel.js';
import type { DecisionTraceDraft } from '../src/contracts/decisionTraceContract.js';
import { createInitialCompanionState } from '@shannon/cognition';
import { configuredSkillMemory, skillTurnPorts } from '../src/wiring/skillMemoryWiring.js';

/**
 * Syzygy ADR-0008 stage 2, the switched-off proof (`docs/skill-and-routing-contract.md`): with `SHANNON_ADR8_STAGE2=off` every
 * provider request of a text turn and a voice turn, and every Jev request of the voice router, is byte for byte what ca7cf519
 * sent. The digests below were recorded on ca7cf519 itself (the stage-1 deploy, before any stage-2 code) and are never
 * regenerated for a stage-2 change: `SHANNON_WRITE_STAGE2_OFF=1` writes the file only where it does not exist.
 *
 * The turns run through the API kernel with the real OpenAI adapter and the real Jev voice gateway over a capturing fetch:
 * her tools offered and not, a tool round, the schedule, tasks and Notion projections, a forced web search, others present,
 * and the voice router's Jev call. Each request body is digested with random ids taken out.
 */
const fixture = new URL('./fixtures/stage2-switched-off-v1.json', import.meta.url);
const at = '2026-10-07T03:00:00.000Z';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
const digest = (text: string) => createHash('sha256').update(text.replace(UUID, 'ID')).digest('hex').slice(0, 24);

const structured = (reply: string) => JSON.stringify({
  reply, feeling: null, threadSummary: null, threadTitle: null, taskDecision: { disposition: 'none', reason: '雑談' }, taskProposal: null, intentPlan: null, artifacts: null,
});

function jevAnswers(): Record<string, unknown> {
  return {
    ...Object.fromEntries(VOICE_SKILLS.map(skill => [`skill__${skill}`, { type: 'noul', noul: 0.1 }])),
    transcript_reliable: { type: 'noul', noul: 0.95 },
    reply_required: { type: 'noul', noul: 0.9 }, solution_wanted: { type: 'noul', noul: 0.7 },
    conversation_class: { type: 'choice', choice: 'direct' }, affect: { type: 'choice', choice: 'bright' },
    affect_intensity: { type: 'choice', choice: 'moderate' }, delivery: { type: 'choice', choice: 'quick' },
    latency_class: { type: 'choice', choice: 'under_3s' }, waiting_scenario: { type: 'choice', choice: 'general' },
    waiting_variant: { type: 'choice', choice: 'steady' }, waiting_affect: { type: 'choice', choice: 'bright' },
    waiting_intensity: { type: 'choice', choice: 'subtle' }, waiting_delivery: { type: 'choice', choice: 'quick' },
  };
}

export interface CapturedTurns { openai: string[]; jev: string[] }

/**
 * Runs every scenario on a fresh kernel and returns the digests of what was sent, by scenario. `extra` is merged into the
 * kernel's options (the stage-2 wiring, switched off); `jevAlso` is told of every Jev request beyond the voice router's.
 */
export async function capturedScenarioDigests(extra: (fetchers: { jev: typeof fetch }) => Partial<ShannonApiKernelOptions> = () => ({})): Promise<Record<string, CapturedTurns>> {
  const out: Record<string, CapturedTurns> = {};
  for (const scenario of stage2SwitchedOffScenarios) {
    const captured: CapturedTurns = { openai: [], jev: [] };
    let round = 0;
    const openai = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body);
      captured.openai.push(digest(body));
      round += 1;
      // The tool-round scenario asks for one call first, then answers.
      if (scenario.toolRound && round === 1) {
        return new Response(JSON.stringify({ output: [{ type: 'function_call', call_id: 'call-1', name: 'study_list', arguments: '{}' }],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }));
      }
      const voice = JSON.parse(body).text?.format === undefined;
      return new Response(JSON.stringify({ output_text: voice ? 'はい、聞こえています。' : structured('はい、聞こえています。'),
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }));
    }) as typeof fetch;
    const jev = (async (_url: string | URL | Request, init?: RequestInit) => {
      captured.jev.push(digest(String(init?.body)));
      // The router's answers; any other question (stage 2's) gets its menu's first entry, or a low probability.
      const asked = (JSON.parse(String(init?.body)) as { questions: Record<string, { type: string; criteria: Record<string, string> }> }).questions;
      const router = jevAnswers();
      return new Response(JSON.stringify({ answers: Object.fromEntries(Object.entries(asked).map(([key, question]) => [key, router[key]
        ?? (question.type === 'choice' ? { type: 'choice', choice: Object.keys(question.criteria)[0] } : { type: 'noul', noul: 0.2 })])) }));
    }) as typeof fetch;
    const chatModel = new OpenAIResponsesChatModel({ apiKey: 'test-only', fetcher: openai, now: () => at });
    const voiceDecision = createConfiguredVoiceDecisionGateway({ TYPESAFE_API_KEY: 'jev-test' }, undefined, jev);
    const api = createLocalApiKernel(() => at, { chatModel, voiceDecision, ...extra({ jev }) });
    for (const turn of scenario.turns) {
      const response = await api.dispatch(turn.kind === 'text'
        ? { method: 'POST', path: '/v1/chat', body: { scopeKey: 'owner', threadId: 'thread', message: turn.words, ...turn.extra } }
        : { method: 'POST', path: '/v1/voice/gemini/cascade/delegations', body: {
          scopeKey: 'owner', threadId: 'thread-voice', transcript: turn.words, deviceContext: {
            timeZoneIdentifier: 'Asia/Tokyo', requestedLocation: false, location: null, ...turn.extra,
            userUtterance: { id: `u-${turn.words.length}`, text: turn.words, source: 'speech', rawText: turn.words },
          } } });
      expect(response.status, `${scenario.name}: ${turn.words}`).toBe(200);
      await api.waitForBackground('owner');
    }
    out[scenario.name] = captured;
  }
  return out;
}

export function recordedSwitchedOff(): Record<string, CapturedTurns> {
  return JSON.parse(readFileSync(fixture, 'utf8')).scenarios as Record<string, CapturedTurns>;
}

describe('stage 2 switched off: the requests of ca7cf519', () => {
  it('sends the recorded provider and Jev requests in every scenario', async () => {
    const current = await capturedScenarioDigests();
    if (process.env.SHANNON_WRITE_STAGE2_OFF === '1' && !existsSync(fixture)) {
      writeFileSync(fixture, `${JSON.stringify({ about: 'Digests of the provider and Jev requests of ca7cf519 (stage2SwitchedOff.test.ts). Never regenerated for a stage-2 change.', scenarios: current }, null, 1)}\n`);
    }
    const recorded = recordedSwitchedOff();
    expect(Object.keys(current)).toEqual(Object.keys(recorded));
    for (const name of Object.keys(recorded)) expect(current[name], name).toEqual(recorded[name]);
    // The scenarios are not all the same request, and each made the calls it is about.
    const all = Object.values(recorded).flatMap(item => item.openai);
    expect(new Set(all).size).toBeGreaterThan(8);
    expect(recorded['tool-round']!.openai.length).toBe(2);
    expect(Object.values(recorded).some(item => item.jev.length > 0)).toBe(true);
  });
});

/** The stage-2 wiring as `server.ts` builds it, from this environment, with Jev and the trace writer of the test. */
function stage2(environment: Record<string, string>, traces: DecisionTraceDraft[]) {
  return ({ jev }: { jev: typeof fetch }) => {
    const reads = readToolPorts({ TYPESAFE_API_KEY: 'jev-test', ...environment }, {
      notion: null, voyagerCatalog: new DisabledVoyagerCatalog(), upcoming: { promptFor: () => '' }, chatModel: new LocalStubChatModel(),
    });
    // Step 6: her skill memory with one skill in it, as server.ts builds it (its own connection, the tables created here).
    const skillMemory = configuredSkillMemory({ TYPESAFE_API_KEY: 'jev-test', ...environment }, { databasePath: null, database: new DatabaseSync(':memory:'), createsSchema: true, defer: task => task() });
    skillMemory?.memory.create('owner', { draft: { name: 'weekly-review', description: '週のふりかえりをする時', steps: '1. 三つ挙げる', aids: 'なし', references: 'なし' }, evidence: [] }, { carries: () => false }, at);
    const skills = skillMemory ? skillTurnPorts(skillMemory.memory, scopeKey => createInitialCompanionState(scopeKey, at)) : null;
    const routing = configuredTurnRouting({ TYPESAFE_API_KEY: 'jev-test', ...environment }, { databasePath: null, database: new DatabaseSync(':memory:'), choices: null, skills });
    return { ...skillRoutingParts({ TYPESAFE_API_KEY: 'jev-test', ...environment }, {
      trace: (_scopeKey, draft) => { traces.push(draft); }, jevFetch: jev, now: () => at,
    }), ...(reads ? { readTools: reads } : {}), ...(routing ? { turnRouting: routing.routing } : {}), ...(skills ? { skills } : {}) };
  };
}

describe('stage 2 switched off with the stage-2 wiring in place', () => {
  it('sends the requests of ca7cf519 and no Jev request beyond the router\'s, with SHANNON_ADR8_STAGE2=off', async () => {
    const traces: DecisionTraceDraft[] = [];
    const current = await capturedScenarioDigests(stage2({ SHANNON_ADR8_STAGE2: 'off' }, traces));
    const recorded = recordedSwitchedOff();
    for (const name of Object.keys(recorded)) expect(current[name], name).toEqual(recorded[name]);
    expect(traces).toEqual([]);
    expect(skillRoutingParts({ SHANNON_ADR8_STAGE2: 'off', TYPESAFE_API_KEY: 'jev-test' }, { trace: null })).toEqual({});
    expect(configuredTurnRouting({ SHANNON_ADR8_STAGE2: 'off' }, { databasePath: ':memory:', choices: null })).toBeNull();
    // Step 6: no skill memory, so no table, no index and no skill.read.
    expect(configuredSkillMemory({ SHANNON_ADR8_STAGE2: 'off' }, { databasePath: ':memory:', createsSchema: true })).toBeNull();
  });

  it('also with only its parts switched off, and with stage 2 on but no Jev configured', async () => {
    const recorded = recordedSwitchedOff();
    for (const environment of [{ SHANNON_TOOL_MENU: 'off', SHANNON_DIFFICULTY: 'off', SHANNON_READ_TOOLS: 'off', SHANNON_TURN_VERIFY: 'off', SHANNON_CONVERSATION_REWARD: 'off', SHANNON_SKILLS: 'off', SHANNON_TREE_RECALL: 'off' }]) {
      const traces: DecisionTraceDraft[] = [];
      const current = await capturedScenarioDigests(stage2(environment, traces));
      for (const name of Object.keys(recorded)) expect(current[name], `${JSON.stringify(environment)} ${name}`).toEqual(recorded[name]);
      expect(traces).toEqual([]);
    }
    expect(skillRoutingParts({}, { trace: null })).toEqual({});
  });

  it('is not vacuous: with stage 2 on, a turn that offers tools asks Jev for the menu and sends other bytes', async () => {
    const traces: DecisionTraceDraft[] = [];
    const current = await capturedScenarioDigests(stage2({}, traces));
    const recorded = recordedSwitchedOff();
    expect(current['text-tools']!.openai).not.toEqual(recorded['text-tools']!.openai);
    expect(current['text-tools']!.jev.length).toBe(1);
    // Her read tools fold the schedule's projection of a text turn of the owner alone.
    expect(current['text-schedule']!.openai).not.toEqual(recorded['text-schedule']!.openai);
    // With the difficulty on, the one call holds the menu and the difficulty questions, traced as `difficulty`.
    expect(traces.some(trace => trace.decision === 'difficulty' && trace.surface === 'text' && trace.answers.tool !== undefined)).toBe(true);
    // Voice: the router's call is the same; the second call is beside it, also in a turn that offers no tools (the difficulty).
    expect(current['voice-greeting']!.jev).toContain(recorded['voice-greeting']!.jev[0]);
    expect(current['voice-greeting']!.jev).toHaveLength(2);
    // With only the menu, a turn that offers no tools is not asked anything.
    const menuOnly = await capturedScenarioDigests(stage2({ SHANNON_DIFFICULTY: 'off' }, []));
    expect(menuOnly['voice-greeting']!.jev).toEqual(recorded['voice-greeting']!.jev);
  });
});
