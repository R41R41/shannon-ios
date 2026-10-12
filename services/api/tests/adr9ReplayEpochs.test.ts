import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type Anthropic from '@anthropic-ai/sdk';
import { InMemoryCompanionStateStore, OWNER_AUDIENCE } from '@shannon/cognition';
import { afterEach, describe, expect, it } from 'vitest';
import { plannedChatBody } from '../src/infra/models/anthropic/anthropicCachePlan.js';
import { plannedVoiceBody } from '../src/infra/models/anthropic/anthropicVoicePlan.js';
import { cachePlanRequest } from '../src/infra/models/anthropic/cachePlanMarkers.js';
import { resetWarmTurns, warmTurnsView } from '../src/infra/models/anthropic/cacheWarmTurns.js';
import type { ShannonConversationItem } from '../src/infra/models/chatModel.js';
import { SQLiteShannonStore } from '../src/infra/sqlite/sqliteStore.js';
import { InMemoryConversationStore } from '../src/mind/memory/store/conversationStore.js';
import { ensureReplayEpochSchema, selectReplayEpoch, upsertReplayEpoch } from '../src/mind/memory/store/sqliteReplayEpochs.js';
import {
  EPOCH_REPLAY_BUDGET_DEFAULT, REPLAY_BUDGET_DEFAULT, conversationReplay, epochReplayWindow, replayRule, summaryCoverRule,
} from '../src/mind/recall/conversationWindow.js';
import { HAIKU } from './support/claudeForegroundScenarios.js';

/**
 * Replay epochs (Syzygy ADR-0009 stage 1, M5): a replayed message keeps its bytes for the whole epoch, the history is only
 * appended to, and a cut (a rebase) comes once the budget is passed, so each turn of an epoch repeats the previous turn's
 * request up to its words (BP2) byte for byte. Synthetic data only.
 */
type Body = Anthropic.MessageCreateParamsNonStreaming;
const at = '2026-10-13T03:00:00.000Z';
const EPOCHS = { SHANNON_CLAUDE_CACHE_PLAN: 'on', SHANNON_REPLAY_EPOCHS: 'on' };
const directories: string[] = [];
afterEach(() => {
  resetWarmTurns();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function renderedPrefix(body: Body, lastMessage: number): string {
  const { model, tools, tool_choice: choice, thinking, output_config: output, system } = body;
  const strip = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null), (key, child: unknown) => key === 'cache_control' ? undefined : child);
  return JSON.stringify(strip({ model, tools, choice, thinking, output, system, messages: body.messages.slice(0, lastMessage + 1) }));
}

function markedWordsIndex(body: Body): number {
  return body.messages.findIndex(message => message.role === 'user' && Array.isArray(message.content)
    && message.content.some(block => block.type === 'text' && 'cache_control' in block && block.cache_control));
}

/** Turn n's words and reply: every fourth reply is longer than the 1,500 characters an older text message is clipped to. */
const words = (n: number) => `${String(n).padStart(3, '0')}の言葉${'い'.repeat(140)}`;
const reply = (n: number) => `${String(n).padStart(3, '0')}の返事${(n % 4 === 3 ? 'ろ' : 'は').repeat(n % 4 === 3 ? 2_400 : 1_200)}`;

interface Turn { body: Body; epoch?: { number: number; rebased: boolean }; characters: number; history: readonly ShannonConversationItem[] }

/** A Talk of `count` text turns under the plan: each turn's request built from the replay, then the turn stored. */
function textTalk(count: number, environment: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), 'shannon-epochs-'));
  directories.push(directory);
  const store = new SQLiteShannonStore({ path: join(directory, 'shannon.sqlite'), now: () => at, replayEpochs: true });
  const turns: Turn[] = [];
  for (let n = 0; n < count; n++) {
    const replay = conversationReplay('text', store.snapshot('owner'), store, 'owner', 'thread', OWNER_AUDIENCE, environment);
    const fields = replay.request(`合成された${n}ターン目の文脈`);
    const body = cachePlanRequest(plannedChatBody(HAIKU, { scopeKey: 'owner', systemPrompt: '合成された人格', profilePrompt: '合成された持ち主の層',
      message: words(n), ...fields }, undefined));
    turns.push({ body, ...(replay.epoch ? { epoch: replay.epoch } : {}), characters: replay.characters, history: fields.history });
    store.appendTurn('owner', 'thread', words(n), reply(n), at);
  }
  store.close();
  return turns;
}

/** Whether turn n repeats turn n-1's request byte for byte up to turn n-1's words. */
function repeatsPrevious(turns: readonly Turn[], n: number): boolean {
  const cachedUpTo = markedWordsIndex(turns[n - 1]!.body);
  return renderedPrefix(turns[n]!.body, cachedUpTo) === renderedPrefix(turns[n - 1]!.body, cachedUpTo);
}

describe('the replay epoch switch', () => {
  it('is off by default: the rule, its budget and every replay are as before', () => {
    expect(replayRule('text', {}).epochs).toBeUndefined();
    expect(replayRule('text', {}).budgetCharacters).toBe(REPLAY_BUDGET_DEFAULT);
    expect(replayRule('voice', EPOCHS).epochs).toBeUndefined();
  });

  it('widens the text budget to 32,000 under epochs unless the budget is set, and takes voice only with the voice plan', () => {
    const text = replayRule('text', EPOCHS);
    expect(text.budgetCharacters).toBe(EPOCH_REPLAY_BUDGET_DEFAULT);
    expect(text.epochs).toEqual({ fillCharacters: 24_000 });
    expect(replayRule('text', { ...EPOCHS, SHANNON_CONVERSATION_REPLAY_CHARACTERS: '20000' }).budgetCharacters).toBe(20_000);
    const voice = replayRule('voice', { ...EPOCHS, SHANNON_CLAUDE_CACHE_PLAN_VOICE: 'on' });
    expect(voice.budgetCharacters).toBe(REPLAY_BUDGET_DEFAULT);
    expect(voice.epochs).toEqual({ fillCharacters: 9_000 });
  });

  it('has the replay summary cover what the next cut can leave out: all but the newest half of the budget', () => {
    const cover = summaryCoverRule(replayRule('text', EPOCHS));
    expect(cover.budgetCharacters).toBe(16_000);
    expect(cover.stableHead).toBeUndefined();
    const plain = replayRule('text', {});
    expect(summaryCoverRule(plain)).toBe(plain);
  });
});

describe('a Talk of 25 text turns under replay epochs', () => {
  const turns = textTalk(25, EPOCHS);
  const rebases = turns.flatMap((turn, n) => turn.epoch?.rebased ? [n] : []);

  it('begins its first epoch with the first history and is cut again exactly once', () => {
    expect(turns[0]!.epoch).toBeUndefined();
    expect(rebases[0]).toBe(1);
    expect(rebases).toHaveLength(2);
    const cut = rebases[1]!;
    expect(cut).toBeGreaterThan(15);
    expect(turns.slice(1, cut).every(turn => turn.epoch?.number === 1)).toBe(true);
    expect(turns.slice(cut).every(turn => turn.epoch?.number === 2)).toBe(true);
  });

  it('repeats the previous turn\'s request byte for byte up to its words on every turn of an epoch', () => {
    for (let n = 2; n < turns.length; n++) {
      if (n === rebases[1]) expect(repeatsPrevious(turns, n), `turn ${n} (the cut)`).toBe(false);
      else expect(repeatsPrevious(turns, n), `turn ${n}`).toBe(true);
    }
  });

  it('keeps a long reply as stored while it stays in its epoch, even after it left the newest 20 messages', () => {
    const before = turns[rebases[1]! - 1]!.history;
    expect(before.length).toBeGreaterThan(20);
    expect(before[7]!.content).toBe(reply(3));
    expect(before.some(item => item.content.endsWith('…'))).toBe(false);
  });

  it('clips at the cut what is older than the newest 20 messages, and stays within the budget and the fill', () => {
    const cut = turns[rebases[1]!]!;
    expect(cut.characters).toBeLessThanOrEqual(24_000);
    const older = cut.history.slice(0, -20);
    expect(older.some(item => item.content.endsWith('…') && Array.from(item.content).length === 1_500)).toBe(true);
    expect(cut.history.slice(-20).some(item => item.content.endsWith('…'))).toBe(false);
    for (const turn of turns) expect(turn.characters).toBeLessThanOrEqual(EPOCH_REPLAY_BUDGET_DEFAULT);
    expect(turns.at(-1)!.history.length).toBeGreaterThan(cut.history.length);
  });

  it('counts the cuts and the turns that kept their epoch for GET /v1/ops', () => {
    resetWarmTurns();
    textTalk(3, EPOCHS);
    expect(warmTurnsView().events).toMatchObject({ 'text:epoch_rebase': 1, 'text:epoch_kept': 1 });
  });

  it('without epochs, the same Talk at the same budget changes old bytes as the newest 20 move on', () => {
    const sliding = textTalk(16, { SHANNON_CONVERSATION_REPLAY_CHARACTERS: String(EPOCH_REPLAY_BUDGET_DEFAULT) });
    const misses = sliding.flatMap((_turn, n) => n >= 2 && !repeatsPrevious(sliding, n) ? [n] : []);
    expect(misses).toContain(14);
  });
});

describe('an epoch window', () => {
  const items = (count: number) => Array.from({ length: count }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const,
    content: `${index}${'あ'.repeat(999)}` }));
  const ids = (count: number) => Array.from({ length: count }, (_, index) => `m${index}`);
  const rule = replayRule('text', EPOCHS);

  it('is cut again when its first message is no longer replayed (forgotten or withheld)', () => {
    const first = epochReplayWindow(ids(10), items(10), rule, undefined, at)!;
    expect(first.rebased).toBe(true);
    const kept = epochReplayWindow(ids(12), items(12), rule, first.record, at)!;
    expect(kept.rebased).toBe(false);
    const forgotten = epochReplayWindow(ids(12).slice(1), items(12).slice(1), rule, first.record, at)!;
    expect(forgotten.rebased).toBe(true);
    expect(forgotten.record.epoch).toBe(2);
  });

  it('is cut again when the budget changed', () => {
    const first = epochReplayWindow(ids(4), items(4), rule, undefined, at)!;
    const widened = replayRule('text', { ...EPOCHS, SHANNON_CONVERSATION_REPLAY_CHARACTERS: '40000' });
    expect(epochReplayWindow(ids(6), items(6), widened, first.record, at)!.rebased).toBe(true);
  });

  it('keeps the newest messages it must replay rather than cutting every turn when they alone pass the budget', () => {
    const long = (count: number) => Array.from({ length: count }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const,
      content: `${index}${'え'.repeat(3_999)}` }));
    const first = epochReplayWindow(ids(10), long(10), rule, undefined, at)!;
    expect(first.characters).toBeGreaterThan(rule.budgetCharacters);
    expect(epochReplayWindow(ids(12), long(12), rule, first.record, at)!.rebased).toBe(false);
  });

  it('is nothing when nothing can be replayed', () => {
    expect(epochReplayWindow([], [], rule, undefined, at)).toBeNull();
  });
});

describe('where an epoch is kept', () => {
  it('SQLite: one row per thread and channel, ids and numbers only, written again at each cut', () => {
    const database = new DatabaseSync(':memory:');
    ensureReplayEpochSchema(database);
    ensureReplayEpochSchema(database);
    const record = { epoch: 1, startMessageId: 'a', fullFromMessageId: 'b', budgetCharacters: 32_000, startedAt: at };
    upsertReplayEpoch(database, 'owner', 'thread', 'text', record);
    upsertReplayEpoch(database, 'owner', 'thread', 'text', { ...record, epoch: 2, startMessageId: 'c' });
    expect(selectReplayEpoch(database, 'owner', 'thread', 'text')).toEqual({ ...record, epoch: 2, startMessageId: 'c' });
    expect(selectReplayEpoch(database, 'owner', 'thread', 'voice')).toBeUndefined();
    const columns = (database.prepare('PRAGMA table_info(conversation_replay_epochs)').all() as Array<{ name: string }>).map(column => column.name);
    expect(columns).toEqual(['scope_key', 'thread_id', 'channel', 'epoch', 'start_message_id', 'full_from_message_id', 'budget_characters', 'started_at']);
    database.close();
  });

  it('SQLite without the switch: no table, and the replay is computed as without epochs', () => {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-epochs-off-'));
    directories.push(directory);
    const store = new SQLiteShannonStore({ path: join(directory, 'shannon.sqlite'), now: () => at, replayEpochs: false });
    store.appendTurn('owner', 'thread', 'こんにちは', 'はい。', at);
    expect(conversationReplay('text', store.snapshot('owner'), store, 'owner', 'thread', OWNER_AUDIENCE, EPOCHS).epoch).toBeUndefined();
    store.close();
  });

  it('a store without epochs replays as without them', () => {
    const store = new InMemoryConversationStore();
    const state = new InMemoryCompanionStateStore(() => at);
    store.appendTurn('owner', 'thread', 'こんにちは', 'はい。', at);
    const bare = Object.assign(Object.create(store) as InMemoryConversationStore, { replayEpoch: undefined, saveReplayEpoch: undefined });
    expect(conversationReplay('text', state.snapshot('owner'), bare, 'owner', 'thread', OWNER_AUDIENCE, EPOCHS).epoch).toBeUndefined();
    expect(conversationReplay('text', state.snapshot('owner'), store, 'owner', 'thread', OWNER_AUDIENCE, EPOCHS).epoch).toEqual({ number: 1, rebased: true });
  });
});

describe('a voice Talk under replay epochs and the voice plan', () => {
  it('repeats the previous voice turn\'s request up to its words while the epoch lasts', () => {
    const environment = { ...EPOCHS, SHANNON_CLAUDE_CACHE_PLAN_VOICE: 'on' };
    const store = new InMemoryConversationStore();
    const state = new InMemoryCompanionStateStore(() => at);
    const bodies: Body[] = [];
    const rebased: number[] = [];
    for (let n = 0; n < 24; n++) {
      const replay = conversationReplay('voice', state.snapshot('owner'), store, 'owner', 'thread', OWNER_AUDIENCE, environment);
      if (replay.epoch?.rebased) rebased.push(n);
      // A transcript with a double space and a trailing newline: replayed later with single spaces, sent so now too.
      const heard = `${n}の声  ${'う'.repeat(300)}\n`;
      bodies.push(cachePlanRequest(plannedVoiceBody(HAIKU, { scopeKey: 'owner', systemPrompt: '合成された人格', message: heard,
        useWebSearch: false, conversationClass: 'direct', ...replay.request('合成された声の文脈') }, 300)));
      store.appendTurn('owner', 'thread', heard, `${n}の返事 ${'え'.repeat(500)}`, at);
    }
    expect(rebased.length).toBeGreaterThanOrEqual(2);
    for (let n = 2; n < bodies.length; n++) {
      if (rebased.includes(n)) continue;
      const cachedUpTo = markedWordsIndex(bodies[n - 1]!);
      expect(renderedPrefix(bodies[n]!, cachedUpTo), `voice turn ${n}`).toBe(renderedPrefix(bodies[n - 1]!, cachedUpTo));
    }
  });
});
