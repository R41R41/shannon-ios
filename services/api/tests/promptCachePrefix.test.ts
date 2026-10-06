import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SHIRITORI_TURNS, ShiritoriGame } from '../../../packages/evaluation/src/reach/index.js';
import { createLocalApiKernel } from '../src/apiKernel.js';
import type { ShannonChatModelRequest } from '../src/chatModel.js';
import { chatTurnRequestBody } from '../src/chatModelTurn.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { ScriptedShiritoriModel } from './reach/reachConversation.js';

vi.setConfig({ testTimeout: 120_000 });
afterEach(() => { vi.unstubAllEnvs(); });

type Body = { instructions: string; input: Array<{ role: string; content: unknown }>; tools?: unknown; text: { format: unknown } };

/** The parts of a text-chat provider body, each as one string. */
function parts(request: ShannonChatModelRequest) {
  const body = chatTurnRequestBody('gpt-5.6-luna', request, 'shannon-mac') as Body;
  return {
    tools: JSON.stringify(body.tools ?? []), schema: JSON.stringify(body.text.format), instructions: body.instructions,
    input: body.input.map(item => `${item.role}\n${typeof item.content === 'string' ? item.content : JSON.stringify(item.content)}`),
  };
}

/** Two orders a provider may render a body in: tools and schema before the instructions, or after them. */
const ORDERS = {
  toolsFirst: (p: ReturnType<typeof parts>) => [p.tools, p.schema, p.instructions, ...p.input].join('\u0000'),
  instructionsFirst: (p: ReturnType<typeof parts>) => [p.instructions, p.tools, p.schema, ...p.input].join('\u0000'),
};

function commonPrefix(left: string, right: string): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1;
  return index;
}

/** The share of each request that repeats the start of the request before it, over a whole thread. */
function prefixShare(requests: readonly ShannonChatModelRequest[], order: (p: ReturnType<typeof parts>) => string): number {
  const bodies = requests.map(request => order(parts(request)));
  let shared = 0;
  let total = 0;
  for (let index = 1; index < bodies.length; index += 1) {
    shared += commonPrefix(bodies[index - 1]!, bodies[index]!);
    total += bodies[index]!.length;
  }
  return Math.round(shared / total * 1000) / 1000;
}

/**
 * One Talk of `games` shiritori games of the reach measure (a), one after the other, through the kernel over a SQLite
 * store (so her knowledge projection is there too), and every request the model was given.
 */
async function shiritoriThread(games: number, seed?: (store: SQLiteShannonStore) => void): Promise<ShannonChatModelRequest[]> {
  const inner = new ScriptedShiritoriModel();
  const requests: ShannonChatModelRequest[] = [];
  const directory = mkdtempSync(join(tmpdir(), 'shannon-prefix-'));
  let clock = Date.parse('2026-10-05T10:00:00.000Z');
  const now = () => new Date(clock).toISOString();
  const store = new SQLiteShannonStore({ path: join(directory, 'prefix.sqlite'), now });
  const api = createLocalApiKernel(now, { chatModel: { mode: inner.mode, model: inner.model,
    generate: request => { requests.push(request); return inner.generate(request); } }, stateStore: store, conversationStore: store, knowledgeStore: store });
  seed?.(store);
  try {
    for (let round = 0; round < games; round += 1) {
      const game = new ShiritoriGame();
      for (let turn = 1; turn <= SHIRITORI_TURNS; turn += 1) {
        clock += 20_000;
        const response = await api.dispatch({ method: 'POST', path: '/v1/chat', body: { scopeKey: 'prefix:owner', threadId: 'prefix-shiritori', message: game.ownerMessage(turn) } });
        game.recordReply(turn, { reply: String((response.body as { reply?: unknown }).reply ?? ''), historyComplete: true });
        await new Promise(resolve => setImmediate(resolve));
        await api.waitForBackground('prefix:owner');
      }
    }
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
  return requests;
}

/** Characters of `order`'s rendering of `request` up to the end of its replayed history. */
function throughHistory(request: ShannonChatModelRequest, order: (p: ReturnType<typeof parts>) => string): number {
  const p = parts(request);
  return order({ ...p, input: p.input.slice(0, request.history.length) }).length;
}

describe('the provider prompt cache (Syzygy ADR-0003 principle 4)', () => {
  it('repeats, from one turn of a Talk to the next, her identity, the fixed blocks, the tools, the schema and the history', async () => {
    const requests = await shiritoriThread(1);
    expect(requests).toHaveLength(SHIRITORI_TURNS);
    for (const request of requests) {
      const body = chatTurnRequestBody('gpt-5.6-luna', request, 'shannon-mac') as Body;
      // What changes every turn is not in the instructions: it is one developer message after the history.
      expect(body.instructions).not.toContain('[Shannon shared state');
      expect(body.instructions).not.toContain('[Current cognitive context');
      expect(body.input.at(-2)).toEqual({ role: 'developer', content: expect.stringMatching(/^\[Shannon shared state v\d+\]/u) });
      expect(body.input.at(-1)?.role).toBe('user');
    }
    for (const order of Object.values(ORDERS)) {
      // From the first turn on, the turn that asks for a title included: its schema is every turn's schema.
      for (let index = 1; index < requests.length; index += 1) {
        const [before, after] = [requests[index - 1]!, requests[index]!];
        // Nothing fell out of the window: the next history begins with the whole history before it.
        expect(after.history.slice(0, before.history.length)).toEqual(before.history);
        expect(commonPrefix(order(parts(before)), order(parts(after)))).toBeGreaterThanOrEqual(throughHistory(before, order));
      }
    }
    // Measured on the base of this change (54cec9a): 0.647 with the tools and schema rendered first, 0.187 with the
    // instructions first, because the shared state followed her identity at the top of the instructions. Now 0.881 both ways.
    expect(prefixShare(requests, ORDERS.toolsFirst)).toBeGreaterThan(0.85);
    expect(prefixShare(requests, ORDERS.instructionsFirst)).toBeGreaterThan(0.85);
  });

  it('keeps the start of a full history on most turns, so the cache keeps it too', async () => {
    // The smallest budget, so three games in one Talk overflow it many times over.
    vi.stubEnv('SHANNON_CONVERSATION_REPLAY_CHARACTERS', '2000');
    const requests = await shiritoriThread(3);
    let full = 0;
    let kept = 0;
    for (let index = 1; index < requests.length; index += 1) {
      const [before, after] = [requests[index - 1]!, requests[index]!];
      expect(after.history.reduce((sum, item) => sum + item.content.length, 0)).toBeLessThanOrEqual(2_000);
      if (before.history.length < 40) continue;
      full += 1;
      // The window kept its start: the next history begins with the whole history before it, and the request repeats it.
      if (JSON.stringify(after.history.slice(0, before.history.length)) !== JSON.stringify(before.history)) continue;
      kept += 1;
      for (const order of Object.values(ORDERS)) {
        expect(commonPrefix(order(parts(before)), order(parts(after)))).toBeGreaterThanOrEqual(throughHistory(before, order));
      }
    }
    // Sliding by one message, no turn of a full window kept its start, and 0.594 / 0.171 of each request repeated the one
    // before (54cec9a; 0.785 / 0.787 with the turn's context after the history). With the stable head 155 of 159 turns kept
    // it, and 0.867 of each request repeats the one before, either way.
    expect(kept / full).toBeGreaterThan(0.6);
    expect(prefixShare(requests, ORDERS.toolsFirst)).toBeGreaterThan(0.8);
    expect(prefixShare(requests, ORDERS.instructionsFirst)).toBeGreaterThan(0.8);
  });

  it('puts what she knows of the owner after the fixed blocks and before the shared state', async () => {
    const requests = await shiritoriThread(1, store => store.apply('prefix:owner', {
      type: 'user-fact-upserted', source: 'conversation',
      fact: { id: 'favorite-food', statement: 'ユーザーの好きな食べ物は寿司', confidence: 0.95, observedAt: '2026-10-05T09:00:00.000Z', evidence: '好きな食べ物は寿司' },
    }));
    for (const request of requests) {
      expect(request.systemPrompt).not.toContain('寿司');
      expect(request.profilePrompt).toMatch(/^\[User knowledge\]\n- 好きな食べ物は？: ユーザーの好きな食べ物は寿司 /u);
      expect(request.turnContext).toMatch(/^\[Shannon shared state v\d+\]/u);
      const body = chatTurnRequestBody('gpt-5.6-luna', request, 'shannon-mac') as Body;
      // Identity first, the profile last in the instructions, the state at the head of the turn's message.
      expect(body.instructions.startsWith(request.systemPrompt)).toBe(true);
      expect(body.instructions.endsWith(`\n\n${request.profilePrompt}`)).toBe(true);
      expect(body.input.at(-2)?.content).toMatch(/^\[Shannon shared state v\d+\]/u);
    }
    // The order of the bracketed headers of one whole request, pinned: identity, fixed blocks, profile, then the turn.
    const headers = (request: ShannonChatModelRequest) => {
      const body = chatTurnRequestBody('gpt-5.6-luna', request, 'shannon-mac') as Body;
      return [body.instructions, ...body.input.map(item => String(item.content))].join('\n').split('\n').filter(line => /^\[[^\]]+\]$/u.test(line));
    };
    expect(headers(requests[1]!).map(header => header.replace(/ v\d+\]$/u, ']'))).toEqual([
      '[シャノンの人格]', '[Syzygyの3つのアプリ]', '[ボクにできること・できないこと]',
      '[ユーザーに見せる返答]', '[生成物]', '[目的の計画案]', '[Codexで行う作業]', '[トークの現在地]', '[この返答での気持ち]', '[ボクの道具]',
      '[User knowledge]',
      // The turn's developer message. The second state block is the cognitive context's own (`turnCognitiveContext.ts`).
      '[Shannon shared state]', '[Current cognitive context — use before answering]',
      '[Current intention frame — durable, owner-visible, and evidence-backed]', '[Shannon shared state]', '[直前までの保存済みトーク要約]',
    ]);
    // The profile is part of the prefix the next turn repeats.
    for (let index = 1; index < requests.length; index += 1) {
      for (const order of Object.values(ORDERS)) {
        expect(commonPrefix(order(parts(requests[index - 1]!)), order(parts(requests[index]!)))).toBeGreaterThanOrEqual(throughHistory(requests[index - 1]!, order));
      }
    }
  });
});
