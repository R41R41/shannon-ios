import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { FEED_LIMITS } from '../src/surfaces/stream/streamFeed.js';
import { makePlace } from './streamHarness.js';

/**
 * The comment feed (contract §1, `GET /v1/stream/feed`): every comment the ear brought, in order, with the author's account never in it, and
 * a feed that can never slow or fail the ear's batch. The listener here is a stand-in for the response; the real routes are in
 * `streamRoutes.test.ts`.
 */
class FakeResponse extends EventEmitter {
  raw = '';
  destroyed = false;
  writableEnded = false;
  writableLength = 0;
  head = 0;
  constructor(private readonly failWith?: Error) { super(); }
  writeHead(status: number): void { this.head = status; }
  write(text: string): boolean {
    if (this.failWith) throw this.failWith;
    this.raw += text;
    return true;
  }
  end(): void { this.writableEnded = true; }
  destroy(): void { this.destroyed = true; }
  events(): { event: string; id?: number; data: any }[] {
    return this.raw.split('\n\n').flatMap(block => {
      const event = /^event: (.+)$/mu.exec(block)?.[1], data = /^data: (.+)$/mu.exec(block)?.[1], id = /^id: (\d+)$/mu.exec(block)?.[1];
      return event && data ? [{ event, ...(id ? { id: Number(id) } : {}), data: JSON.parse(data) }] : [];
    });
  }
  comments(): any[] { return this.events().filter(item => item.event === 'comment').map(item => item.data); }
}

const started = () => {
  const place = makePlace();
  const { streamId } = place.service.start({ title: 'T' }).stream;
  const listen = (after?: number) => {
    const response = new FakeResponse();
    place.service.feed.subscribe(response as never, after);
    return response;
  };
  return { place, streamId, listen };
};

describe('the comment feed', () => {
  it('sends the state and then every comment in seq order, a paid one with its micros and currency, never the author\'s account', async () => {
    const { place, streamId, listen } = started();
    const listener = listen();
    place.service.ingest(streamId, [
      place.comment('こんにちは', { authorId: 'UC-secret-author-001' }),
      place.comment('ありがとう', { authorId: 'UC-secret-author-002', kind: 'superchat', roles: ['member'],
        amount: { display: '¥1,000', micros: 1_000_000_000, currency: 'JPY' } }),
      place.comment('w', { authorId: 'UC-secret-author-003' }),
    ]);
    const events = listener.events();
    expect(events.map(item => item.event)).toEqual(['state', 'comment', 'comment', 'comment']);
    expect(events[0]!.data).toEqual({ streamId, live: true, seq: 0 });
    const comments = listener.comments();
    expect(comments.map(item => item.seq)).toEqual([1, 2, 3]);
    expect(events.filter(item => item.event === 'comment').map(item => item.id)).toEqual([1, 2, 3]);
    expect(comments[0]).toMatchObject({ streamId, commentId: 'c1', authorName: '視聴者1', text: 'こんにちは', kind: 'text', roles: [], first: true, status: 'new', tags: [] });
    expect(comments[0].viewer).toMatch(/^[0-9a-f]{12}$/u);
    expect(comments[0]).not.toHaveProperty('amount');
    expect(comments[0].at).toBe(place.clock.t);
    expect(comments[1]).toMatchObject({ kind: 'superchat', roles: ['member'], amount: { display: '¥1,000', micros: 1_000_000_000, currency: 'JPY' } });
    expect(comments[2]).toMatchObject({ text: 'w', status: 'skipped' });
    expect(listener.raw).not.toContain('UC-secret-author');
    expect(listener.raw).not.toContain('authorId');
    await place.service.settle();
  });

  it('does not send the same id twice, and marks the ear\'s own words synthetic', () => {
    const { place, streamId, listen } = started();
    const listener = listen();
    const first = place.comment('ひとつめ');
    place.service.ingest(streamId, [first, { ...first }, place.comment('ようこそ', { kind: 'membership', synthetic: true })]);
    expect(listener.comments().map(item => item.commentId)).toEqual(['c1', 'c2']);
    expect(listener.comments()[1]).toMatchObject({ kind: 'membership', synthetic: true });
    expect(listener.comments()[0]).not.toHaveProperty('synthetic');
  });

  it('resends only what is after `after`, and all of it with no after, 0, or a number past the last', () => {
    const { place, streamId, listen } = started();
    place.service.ingest(streamId, [place.comment('いち'), place.comment('に'), place.comment('さん')]);
    expect(listen(2).comments().map(item => item.seq)).toEqual([3]);
    expect(listen().comments().map(item => item.seq)).toEqual([1, 2, 3]);
    expect(listen(0).comments().map(item => item.seq)).toEqual([1, 2, 3]);
    expect(listen(99).comments().map(item => item.seq)).toEqual([1, 2, 3]);
    const caughtUp = listen(3);
    expect(caughtUp.comments()).toEqual([]);
    expect(caughtUp.events()[0]).toMatchObject({ event: 'state', data: { live: true, seq: 3 } });
  });

  it('sends state live:false at the end, drops the words, and keeps counting seq into the next stream', async () => {
    const { place, streamId, listen } = started();
    const listener = listen();
    place.service.ingest(streamId, [place.comment('いち'), place.comment('に')]);
    await place.service.settle();
    await place.service.end(streamId);
    expect(listener.events().filter(item => item.event === 'state').map(item => item.data)).toEqual([
      { streamId, live: true, seq: 0 }, { streamId, live: false, seq: 2 },
    ]);
    const later = listen();
    expect(later.comments()).toEqual([]);
    expect(later.events()).toEqual([{ event: 'state', data: { streamId, live: false, seq: 2 } }]);
    expect(place.service.feed.keptCount()).toBe(0);
    const next = place.service.start({}).stream.streamId;
    place.service.ingest(next, [place.comment('つぎ')]);
    expect(listener.comments().map(item => [item.seq, item.streamId, item.text])).toEqual([[1, streamId, 'いち'], [2, streamId, 'に'], [3, next, 'つぎ']]);
    expect(listen().comments().map(item => item.seq)).toEqual([3]);
    await place.service.settle();
  });

  it('keeps the last 2,000 of 2,500', () => {
    const { place, streamId, listen } = started();
    for (let index = 0; index < 25; index += 1) place.service.ingest(streamId, Array.from({ length: 100 }, (_, item) => place.comment(`ひとこと${index}-${item}`)));
    expect(place.service.feed.keptCount()).toBe(2000);
    const comments = listen().comments();
    expect(comments).toHaveLength(2000);
    expect(comments[0].seq).toBe(501);
    expect(comments[1999].seq).toBe(2500);
  });

  it('never fails or waits for the ear\'s batch when a listener\'s write throws, or when it falls behind', () => {
    const { place, streamId, listen } = started();
    const broken = new FakeResponse(new Error('socket closed'));
    place.service.feed.subscribe(broken as never, 0);
    const behind = new FakeResponse();
    place.service.feed.subscribe(behind as never, 0);
    const healthy = listen();
    expect(place.service.feed.listenerCount()).toBe(2);
    behind.writableLength = FEED_LIMITS.backlogBytes + 1;
    const result = place.service.ingest(streamId, [place.comment('いち'), place.comment('に')]);
    expect(result).toMatchObject({ accepted: 2, duplicates: 0 });
    expect(healthy.comments()).toHaveLength(2);
    expect(behind.destroyed).toBe(true);
    expect(place.service.feed.listenerCount()).toBe(1);
    expect(place.service.view().comments).toHaveLength(2);
  });

  it('does not take a late listener\'s replay for falling behind: a long stream\'s kept comments all arrive, and it stays', () => {
    const { place, streamId, listen } = started();
    for (let batch = 0; batch < 10; batch += 1) {
      place.service.ingest(streamId, Array.from({ length: 200 }, (_, index) => place.comment(`${batch * 200 + index} ${'長いコメント'.repeat(40)}`)));
    }
    // The socket has sent nothing of the burst yet: its unsent length is the whole replay, far over the backlog a live listener may have.
    class Unsent extends FakeResponse { override write(text: string): boolean { this.writableLength += Buffer.byteLength(text); return super.write(text); } }
    const late = new Unsent();
    place.service.feed.subscribe(late as never, 0);
    expect(late.writableLength).toBeGreaterThan(FEED_LIMITS.backlogBytes);
    expect(late.comments()).toHaveLength(2000);
    expect(late.destroyed).toBe(false);
    place.service.ingest(streamId, [place.comment('つぎ')]);
    expect(late.comments()).toHaveLength(2001);
    expect(late.destroyed).toBe(false);
    // Past the replay it is measured again: a megabyte more unsent and it is closed.
    late.writableLength += FEED_LIMITS.backlogBytes + 1;
    place.service.ingest(streamId, [place.comment('さらに')]);
    expect(late.destroyed).toBe(true);
  });

  it('closes the oldest listener when a ninth comes', () => {
    const { place, listen } = started();
    const all = Array.from({ length: FEED_LIMITS.listeners + 1 }, () => listen());
    expect(place.service.feed.listenerCount()).toBe(FEED_LIMITS.listeners);
    expect(all[0]!.destroyed).toBe(true);
    expect(all[1]!.destroyed).toBe(false);
  });

  it('streams 1,500 comments at a minute\'s pace of 300, all in order', async () => {
    const { place, streamId, listen } = started();
    const listener = listen();
    for (let index = 0; index < 1500; index += 1) {
      place.service.ingest(streamId, [place.comment(`コメント${index}`)]);
      if (index % 5 === 4) place.clock.t += 1000;
    }
    const comments = listener.comments();
    expect(comments.map(item => item.seq)).toEqual(Array.from({ length: 1500 }, (_, index) => index + 1));
    expect(comments[1499].text).toBe('コメント1499');
    await place.service.settle();
  });
});
