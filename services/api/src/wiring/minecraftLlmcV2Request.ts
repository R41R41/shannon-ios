import type { FcaToolDefinition } from '../mind/action/fca/fcaPorts.js';
import { createAnthropicFcaModel } from '../infra/models/anthropic/anthropicFcaModel.js';
import { llmcCoreKnowledge } from '../surfaces/minecraft/minecraftKnowledgeCore.js';
import { candidateMenuTools, minecraftV2Hooks } from '../surfaces/minecraft/minecraftLlmcV2.js';

/**
 * SHANNON_MINECRAFT_LLMC_V2, for the decision replay: the fixed part of a request of the mode (the system blocks and the tools, with their cache marks
 * and the fields beside them: model, thinking, effort, tool_choice), as the production model builds it, from the body's tool definitions of a recorded
 * run (`core`; the menu of the mode is picked from them, `mc.act` with the hands one to a line). The model is the production one
 * (`createAnthropicFcaModel` with the own prompt and the mode's hooks); its transport refuses on purpose, so nothing is sent.
 */
export interface CandidateFixed {
  system: Array<{ type: 'text'; text: string; cache_control?: unknown }>;
  tools: Array<Record<string, unknown>>;
  /** The whole body of the request that was captured (empty history), without its messages. */
  fixed: Record<string, unknown>;
  headers: Record<string, string>;
}
export async function candidateFixed(core: readonly FcaToolDefinition[], model = 'claude-opus-5-5'): Promise<CandidateFixed> {
  let captured: { body: Record<string, unknown>; headers: Record<string, string> } | null = null;
  const client = { messages: { create(body: Record<string, unknown>, options: { headers?: Record<string, string> }) {
    captured = { body: JSON.parse(JSON.stringify(body)) as Record<string, unknown>, headers: options.headers ?? {} };
    return Promise.reject(new Error('captured'));
  } } };
  const mode = createAnthropicFcaModel({ model, client: client as never, recordUsage() {}, minecraftOwnPrompt: true,
    systemAppendix: llmcCoreKnowledge(true), minecraftV2: minecraftV2Hooks() });
  const menu = candidateMenuTools(core), quiet = { info: console.info, warn: console.warn };
  console.info = console.warn = () => undefined;
  try {
    await mode.decide({ task: { id: 'replay', title: 'replay', goal: 'エンドラを討伐してください', completionCriteria: 'replay' }, messages: [], children: [], history: [],
      tools: menu, coreTools: menu, transient: {} }, new AbortController().signal);
  } catch { /* the transport refuses on purpose */ } finally { Object.assign(console, quiet); }
  if (!captured) throw new Error('CANDIDATE_FIXED_NOT_CAPTURED');
  const { body, headers } = captured as { body: Record<string, unknown>; headers: Record<string, string> };
  const { messages: _messages, ...fixed } = body;
  return { system: fixed.system as CandidateFixed['system'], tools: fixed.tools as CandidateFixed['tools'], fixed, headers };
}
