import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CodexAppServerClient } from '../src/codexAppServerClient.js';

describe('CodexAppServerClient', () => {
  it('performs the JSONL handshake and drives the thread/turn lifecycle', async () => {
    const fixture = fileURLToPath(new URL('./fixtures/fakeCodexAppServer.mjs', import.meta.url));
    const notifications: string[] = [];
    const client = new CodexAppServerClient({
      executable: process.execPath,
      args: [fixture],
      requestTimeoutMs: 2_000,
    });
    client.onNotification(notification => notifications.push(notification.method));

    await client.start();
    const thread = await client.request<{ thread: { id: string } }>('thread/start', {
      cwd: process.cwd(), sandbox: 'workspace-write', approvalPolicy: 'on-request',
    });
    const turn = await client.request<{ turn: { id: string } }>('turn/start', {
      threadId: thread.thread.id, input: [{ type: 'text', text: 'fixture' }],
    });
    await eventually(() => notifications.includes('turn/started'));

    expect(thread.thread.id).toBe('thread-1');
    expect(turn.turn.id).toBe('turn-1');
    await client.stop();
  });
});

async function eventually(predicate: () => boolean): Promise<void> {
  for (let count = 0; count < 50; count += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('condition not reached');
}
