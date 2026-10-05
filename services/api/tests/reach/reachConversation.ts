import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalApiKernel } from '../../src/apiKernel.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonChatModelResult } from '../../src/chatModel.js';
import type { LlmUsageEvent, LlmUsageStore } from '../../src/llmUsage.js';
import { SQLiteShannonStore } from '../../src/sqliteStore.js';
import {
  SHIRITORI_TURNS, ShiritoriGame, carried, judgeShiritori, sameReading, scriptedShiritoriReply, shiritoriScenario, shiritoriScriptInputs,
  type ReachDriver, type ReachStop,
} from '../../../../packages/evaluation/src/reach/index.js';

/**
 * Scenario (a) driven through the real conversation path: the API kernel over a temporary SQLite store,
 * `POST /v1/chat` turn by turn, the owner side scripted. Only the chat model differs between the modes.
 */
export const REACH_YEN_PER_USD = 160;
const SCOPE = 'reach:owner';
const THREAD = 'reach-shiritori';

/** The model-free player: answers from the request it is given and nothing else. */
export class ScriptedShiritoriModel implements ShannonChatModel {
  readonly mode = 'openai' as const;
  readonly model = 'scripted-shiritori';
  async generate(request: ShannonChatModelRequest): Promise<ShannonChatModelResult> {
    return { mode: this.mode, model: this.model, reply: scriptedShiritoriReply(request.history, request.message) };
  }
}

/** Collects the usage a live chat model reports; nothing else. */
export class ReachUsage implements LlmUsageStore {
  readonly events: LlmUsageEvent[] = [];
  recordLlmUsage(event: LlmUsageEvent): void { this.events.push(event); }
  backgroundLlmCostUsd(): number { return 0; }
}

/** Sees each request on its way to the model: its size, and the text the judge checks for, never kept beyond the turn. */
class RequestWatch implements ShannonChatModel {
  readonly mode: ShannonChatModel['mode'];
  readonly model: string;
  calls = 0;
  promptCharacters = 0;
  last: ShannonChatModelRequest | null = null;

  constructor(private readonly inner: ShannonChatModel) {
    this.mode = inner.mode;
    this.model = inner.model;
  }

  async generate(request: ShannonChatModelRequest): Promise<ShannonChatModelResult> {
    this.calls += 1;
    this.last = request;
    this.promptCharacters += request.systemPrompt.length + request.message.length + (request.priorThreadSummary?.length ?? 0)
      + request.history.reduce((sum, item) => sum + item.content.length, 0);
    return this.inner.generate(request);
  }
}

export interface ShiritoriDriverOptions {
  usage?: ReachUsage;
  /** Live: the model and price settings the run used, by name and value (never a credential). */
  inputs?: Readonly<Record<string, string>>;
}

export function shiritoriDriver(model: ShannonChatModel, options: ShiritoriDriverOptions = {}): ReachDriver {
  const usage = options.usage;
  return async ({ signal, mode }) => {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-reach-a-'));
    let clock = Date.parse('2026-10-05T10:00:00.000Z');
    const now = () => new Date(clock).toISOString();
    const store = new SQLiteShannonStore({ path: join(directory, 'reach.sqlite'), now });
    const watch = new RequestWatch(model);
    const api = createLocalApiKernel(now, { chatModel: watch, stateStore: store, conversationStore: store, knowledgeStore: store });
    // The work a turn leaves behind runs after the reply, as on the server: the feeling of the reply is committed on
    // the next tick, and the memory refinement by the background coordinator. Both finish before the next turn.
    const settle = async () => {
      await new Promise(resolve => setImmediate(resolve));
      await api.waitForBackground(SCOPE);
    };
    const said: string[] = [];
    const errors: number[] = [];
    let longestHistory = 0;
    let stop: ReachStop | null = null;
    const send = async (message: string) => {
      clock += 20_000;
      let reply = '';
      try {
        const response = await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: SCOPE, threadId: THREAD, message } });
        if (response.status === 200) reply = String((response.body as { reply?: unknown }).reply ?? '');
        else errors.push(response.status);
      } catch {
        // The kernel lets a failed model call through; on the server it becomes an error response.
        errors.push(0);
      }
      const request = watch.last;
      longestHistory = Math.max(longestHistory, request?.history.length ?? 0);
      const history = sameReading((request?.history ?? []).map(item => item.content).join('\n'));
      const historyComplete = said.every(text => history.includes(sameReading(text)));
      const whole = request ? [request.systemPrompt, request.priorThreadSummary ?? '', history, request.message].join('\n') : '';
      said.push(message, reply);
      await settle();
      return { reply, historyComplete, whole };
    };
    const game = new ShiritoriGame();
    const questions = () => game.questions();
    let asked: ReturnType<typeof questions> = [];
    try {
      for (let turn = 1; turn <= SHIRITORI_TURNS; turn += 1) {
        if (signal.aborted || watch.calls >= shiritoriScenario.limits.maximumSteps) { stop = { cause: signal.aborted ? 'timeout' : 'budget', detail: `turn:${turn}` }; break; }
        const { reply, historyComplete } = await send(game.ownerMessage(turn));
        game.recordReply(turn, { reply, historyComplete });
      }
      if (!stop) {
        asked = questions();
        for (const question of asked) {
          if (signal.aborted) { stop = { cause: 'timeout', detail: `question:${question.checkId}` }; break; }
          const { reply, historyComplete, whole } = await send(question.message);
          game.questionExchanges.push({ reply, historyComplete, needlesPresent: carried(whole, question.needles) });
        }
      }
    } finally {
      await settle();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
    // A provider that failed is the tool's; the game still went on, so the checks keep what was reached.
    if (!stop && errors.length) stop = { cause: 'tool', detail: `chat-failed:${errors.length}` };
    const { checks, metrics } = judgeShiritori(game, asked);
    const events = usage?.events ?? [];
    const usd = events.reduce((sum, event) => sum + event.estimatedCostUsd, 0);
    return {
      checks, stop, steps: watch.calls,
      inputs: { ...shiritoriScriptInputs(), chatModel: model.model, ...options.inputs },
      metrics: { ...metrics, chatErrors: errors.length, longestHistory },
      cost: {
        calls: watch.calls, promptCharacters: watch.promptCharacters, measured: mode === 'live' && events.length > 0,
        inputTokens: events.reduce((sum, event) => sum + event.inputTokens, 0),
        outputTokens: events.reduce((sum, event) => sum + event.outputTokens, 0),
        yen: Math.round(usd * REACH_YEN_PER_USD * 100) / 100,
      },
    };
  };
}

export function scriptedShiritoriDriver(): ReachDriver {
  return shiritoriDriver(new ScriptedShiritoriModel());
}
