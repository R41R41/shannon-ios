import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryCompanionStateStore } from '@shannon/cognition';
import type { CompletedTurn, TurnBackgroundService } from '../src/backgroundUpdates.js';
import { InMemoryConversationStore, type ShannonExperience } from '../src/conversationStore.js';
import {
  configuredPlatformBridge,
  PlatformBridgeError,
  PlatformBridgeService,
  platformBridgeThreadId,
  type PlatformBridgeConfiguration,
} from '../src/platformBridge.js';
import { SQLiteShannonStore } from '../src/sqliteStore.js';

const now = () => '2026-09-17T12:00:00.000Z';
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

class RecordingBackground implements TurnBackgroundService {
  readonly mode = 'durable-queue' as const;
  readonly scheduled: Array<{ turn: CompletedTurn; experienceId?: string }> = [];
  recordTurn(_turn: CompletedTurn): ShannonExperience { throw new Error('not used by platform bridge'); }
  schedule(turn: CompletedTurn, experienceId?: string): void { this.scheduled.push({ turn, experienceId }); }
  async waitForIdle(_scopeKey: string): Promise<void> {}
}

describe('legacy platform bridge', () => {
  it('stays disabled when empty and requires a complete, exact binding configuration', () => {
    expect(configuredPlatformBridge({})).toBeNull();
    expect(() => configuredPlatformBridge({
      SHANNON_PLATFORM_BRIDGE_TOKEN: 'short',
      SHANNON_PLATFORM_BRIDGE_SCOPE_KEY: 'owner',
      SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON: '[]',
    })).toThrow('at least 32');
    expect(() => configuredPlatformBridge({
      SHANNON_PLATFORM_BRIDGE_TOKEN: 'a'.repeat(32),
      SHANNON_PLATFORM_BRIDGE_SCOPE_KEY: 'owner',
      SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON: '[{"platform":"discord"}]',
    })).toThrow('invalid binding');

    const configured = configuration();
    expect(configured.scopeKey).toBe('owner');
    expect(configured.bindings.get('discord\u000012345')).toEqual({
      platform: 'discord', conversationId: '12345', ownerUserId: '67890', title: 'Discord・友人グループ',
    });
    expect(configured.prefixBindings).toEqual([]);
  });

  it('allows an exact owner across every channel in one Discord guild without accepting other actors or guilds', () => {
    const configured = configuredPlatformBridge({
      SHANNON_PLATFORM_BRIDGE_TOKEN: 'a'.repeat(32),
      SHANNON_PLATFORM_BRIDGE_SCOPE_KEY: 'owner',
      SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON: JSON.stringify([{
        platform: 'discord', conversationIdPrefix: 'discord:111:', ownerUserId: '67890', title: 'Discord・コミュニティ',
      }]),
    });
    if (!configured) throw new Error('test configuration missing');
    const state = new InMemoryCompanionStateStore(now);
    const conversations = new InMemoryConversationStore();
    const bridge = new PlatformBridgeService(configured, state, conversations, new RecordingBackground(), now);

    expect(bridge.ingest({ ...validRequest(), conversationId: 'discord:111:222' }).duplicate).toBe(false);
    expect(bridge.ingest({ ...validRequest(), requestId: 'message-101', conversationId: 'discord:111:333' }).duplicate).toBe(false);
    expectBridgeError(
      () => bridge.ingest({ ...validRequest(), requestId: 'message-102', conversationId: 'discord:112:222' }),
      'PLATFORM_CONVERSATION_DENIED',
    );
    expectBridgeError(
      () => bridge.ingest({ ...validRequest(), requestId: 'message-102b', conversationId: 'discord:111:not-a-channel' }),
      'PLATFORM_CONVERSATION_DENIED',
    );
    expectBridgeError(
      () => bridge.ingest({ ...validRequest(), requestId: 'message-103', conversationId: 'discord:111:444', sourceUserId: 'friend' }),
      'PLATFORM_ACTOR_DENIED',
    );
  });

  it('rejects malformed or overlapping Discord conversation prefixes', () => {
    const environment = (bindings: unknown[]) => ({
      SHANNON_PLATFORM_BRIDGE_TOKEN: 'a'.repeat(32),
      SHANNON_PLATFORM_BRIDGE_SCOPE_KEY: 'owner',
      SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON: JSON.stringify(bindings),
    });
    expect(() => configuredPlatformBridge(environment([{
      platform: 'discord', conversationIdPrefix: 'discord:111', ownerUserId: '67890', title: 'Discord',
    }]))).toThrow('invalid binding');
    expect(() => configuredPlatformBridge(environment([{
      platform: 'discord', conversationIdPrefix: 'discord:111:', ownerUserId: '67890', title: 'Discord',
    }, {
      platform: 'discord', conversationId: 'discord:111:222', ownerUserId: '67890', title: 'Discord channel',
    }]))).toThrow('overlapping bindings');
  });

  it('records an owner turn once in a stable platform thread and queues memory refinement once', () => {
    const state = new InMemoryCompanionStateStore(now);
    const conversations = new InMemoryConversationStore();
    const background = new RecordingBackground();
    const bridge = new PlatformBridgeService(configuration(), state, conversations, background, now);
    const request = validRequest();

    const first = bridge.ingest(request);
    const duplicate = bridge.ingest(request);
    const threadId = platformBridgeThreadId('discord', '12345');

    expect(first).toMatchObject({ duplicate: false, threadId });
    expect(duplicate).toEqual({ ...first, duplicate: true });
    expect(background.scheduled).toHaveLength(1);
    expect(background.scheduled[0]?.experienceId).toBe(first.experienceId);
    expect(conversations.listThreads('owner')).toEqual([
      expect.objectContaining({ threadId, title: 'Discord・友人グループ', messageCount: 2 }),
    ]);
    expect(conversations.conversationHistory('owner', threadId).map(item => item.content)).toEqual([
      '僕は浜松のうなぎが好き', '前にも話してくれたね。覚えておくよ。',
    ]);
  });

  it('fails closed for unknown conversations, unbound actors, and conflicting retries', () => {
    const state = new InMemoryCompanionStateStore(now);
    const conversations = new InMemoryConversationStore();
    const bridge = new PlatformBridgeService(configuration(), state, conversations, new RecordingBackground(), now);

    expectBridgeError(() => bridge.ingest({ ...validRequest(), conversationId: 'other' }), 'PLATFORM_CONVERSATION_DENIED');
    expectBridgeError(() => bridge.ingest({ ...validRequest(), sourceUserId: 'friend' }), 'PLATFORM_ACTOR_DENIED');
    bridge.ingest(validRequest());
    expectBridgeError(() => bridge.ingest({ ...validRequest(), userMessage: '同じIDの別内容' }), 'PLATFORM_TURN_CONFLICT');
  });

  it('keeps deduplication durable across a SQLite restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'shannon-platform-bridge-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'shannon.sqlite');
    const firstStore = new SQLiteShannonStore({ path, now });
    const firstBackground = new RecordingBackground();
    const first = new PlatformBridgeService(configuration(), firstStore, firstStore, firstBackground, now)
      .ingest(validRequest());
    firstStore.close();

    const reopened = new SQLiteShannonStore({ path, now });
    const secondBackground = new RecordingBackground();
    const duplicate = new PlatformBridgeService(configuration(), reopened, reopened, secondBackground, now)
      .ingest(validRequest());
    expect(duplicate).toEqual({ ...first, duplicate: true });
    expect(secondBackground.scheduled).toHaveLength(0);
    expect(reopened.conversationHistory('owner', first.threadId)).toHaveLength(2);
    reopened.close();
  });
});

function configuration(): PlatformBridgeConfiguration {
  const configured = configuredPlatformBridge({
    SHANNON_PLATFORM_BRIDGE_TOKEN: 'a'.repeat(32),
    SHANNON_PLATFORM_BRIDGE_SCOPE_KEY: 'owner',
    SHANNON_PLATFORM_BRIDGE_BINDINGS_JSON: JSON.stringify([{
      platform: 'discord', conversationId: '12345', ownerUserId: '67890', title: 'Discord・友人グループ',
    }]),
  });
  if (!configured) throw new Error('test configuration missing');
  return configured;
}

function validRequest() {
  return {
    platform: 'discord',
    requestId: 'message-100',
    conversationId: '12345',
    sourceUserId: '67890',
    userMessage: '僕は浜松のうなぎが好き',
    shannonReply: '前にも話してくれたね。覚えておくよ。',
    observedAt: '2026-09-17T11:59:00.000Z',
  } as const;
}

function expectBridgeError(operation: () => unknown, code: PlatformBridgeError['code']): void {
  try {
    operation();
    throw new Error('expected bridge error');
  } catch (error) {
    expect(error).toBeInstanceOf(PlatformBridgeError);
    expect((error as PlatformBridgeError).code).toBe(code);
  }
}
