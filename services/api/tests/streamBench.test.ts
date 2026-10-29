import { describe, expect, it } from 'vitest';
import { runBench } from '../scripts/stream-bench/run.js';
import { makeChat } from '../scripts/stream-bench/makeChat.js';
import { FakeYoutube } from '../scripts/stream-bench/fakeYoutube.js';

/** The stream bench with the fake models: the recorded chat through the fake YouTube, the ear, the head's real routes and the mouth. */
describe('the stream bench (fake models)', () => {
  it('loses no comment, leaks nothing private, answers within the allowance and declines what must be declined', async () => {
    const report = await runBench({ models: 'fake', ear: 'inline', speed: 120, fakeLatencyMilliseconds: 2500, minecraft: true, chatWrites: false });
    expect(report.comments.recorded).toBe(makeChat().length);
    expect(report.comments.sentByApi).toBe(report.comments.recorded);
    expect(report.comments.lost).toBe(0);
    expect(report.comments.earSent).toBe(report.comments.recorded);
    expect(report.leaks.count).toBe(0);
    expect(report.leaks.checkedRequests).toBeGreaterThan(20);
    expect(report.answered.comments).toBeGreaterThan(15);
    expect(report.answered.perVirtualMinute).toBeLessThanOrEqual(10);
    expect(report.declined).toBeGreaterThanOrEqual(4);
    expect(report.notices).toBeGreaterThanOrEqual(1);
    expect(report.lines.byKind).toMatchObject({ greeting: 1, closing: 1 });
    expect(report.byTag.threat!.answered).toBeLessThanOrEqual(1);
    expect(report.byTag.reaction!.answered).toBe(0);
    expect(report.models.calls.total).toBeLessThanOrEqual(10 * 11);
    expect(report.latencyMs.headCommentToFirstSound.median).toBeLessThan(40_000);
  }, 90_000);
});

/**
 * The fake YouTube's `liveChatMessages.streamList` (`scripts/stream-bench/fakeYoutube.ts`): the recorded chat on the bench's clock, pushed down one
 * open connection, cut once in the middle of a response, resumed by `pageToken`, ended with `offlineAt`.
 */
describe('the fake YouTube streamList', () => {
  /** The whole objects in a growing JSON array or in lines of JSON: a brace count that ignores braces inside strings. */
  function objectsOf(text: string): { objects: any[]; rest: string } {
    const objects: any[] = [];
    let depth = 0, start = -1, inString = false, escaped = false, end = 0;
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i]!;
      if (inString) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') inString = false; continue; }
      if (char === '"') inString = true;
      else if (char === '{') { if (depth === 0) start = i; depth += 1; }
      else if (char === '}') { depth -= 1; if (depth === 0) { objects.push(JSON.parse(text.slice(start, i + 1))); end = i + 1; } }
    }
    return { objects, rest: text.slice(end).replace(/[\s,[\]]/gu, '') };
  }

  async function readAll(base: string, pageToken?: string): Promise<{ pages: any[]; rest: string; status: number }> {
    const response = await fetch(`${base}/liveChat/messages/stream?part=snippet,authorDetails&liveChatId=benchLiveChat001${pageToken ? `&pageToken=${pageToken}` : ''}`);
    let text = '';
    try {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
    } catch { /* the cut connection breaks the body */ }
    const { objects, rest } = objectsOf(text);
    return { pages: objects, rest, status: response.status };
  }

  it.each(['array', 'ndjson'] as const)('serves the whole chat as %s over a connection that is cut once, and a resume loses and doubles nothing', async framing => {
    const chat = makeChat();
    const epochMs = Date.now();
    const speed = 1200;
    const now = () => epochMs + (Date.now() - epochMs) * speed;
    const youtube = new FakeYoutube({ chat, speed, now, epochMs, framing });
    const base = await youtube.start();
    try {
      const first = await readAll(base);
      expect(first.status).toBe(200);
      expect(youtube.counts.streamCuts).toBe(1);
      // The cut left half of a response: what was whole is kept, and the half is not a page.
      expect(first.rest).not.toBe('');
      const taken = first.pages.flatMap(page => page.items.map((item: any) => item.id));
      const token = first.pages.at(-1)?.nextPageToken as string;
      expect(Number(token)).toBe(taken.length);
      expect(first.pages.every(page => page.kind === 'youtube#liveChatMessageListResponse')).toBe(true);

      const second = await readAll(base, token);
      expect(second.rest).toBe('');
      const all = [...taken, ...second.pages.flatMap(page => page.items.map((item: any) => item.id))];
      expect(all).toEqual(chat.map(row => row.id));
      // The chat is over: the last response says so.
      expect(second.pages.at(-1)?.offlineAt).toEqual(expect.any(String));
      expect(first.pages.some(page => page.offlineAt)).toBe(false);
      expect(youtube.counts).toMatchObject({ streamConnects: 2, streamCuts: 1, sent: chat.length, chatPolls: 0 });
      // Items are oldest first and carry a time of their own on the chat's clock.
      const times = [...first.pages, ...second.pages].flatMap(page => page.items.map((item: any) => Date.parse(item.snippet.publishedAt)));
      expect(times).toEqual([...times].sort((a, b) => a - b));
    } finally {
      await youtube.close();
    }
  }, 30_000);

  it('answers 404 when streamList is switched off, so an ear has to fall back to polling', async () => {
    const epochMs = Date.now();
    const youtube = new FakeYoutube({ chat: makeChat(), speed: 60, now: () => epochMs, epochMs, streamList: false });
    const base = await youtube.start();
    try {
      const response = await fetch(`${base}/liveChat/messages/stream?liveChatId=benchLiveChat001`);
      expect(response.status).toBe(404);
      expect(youtube.counts.streamConnects).toBe(0);
    } finally {
      await youtube.close();
    }
  });
});
