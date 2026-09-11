import { describe, expect, it } from 'vitest';
import { isRepeatedWorldSignal, sourceDiversityAdjustment } from '../src/worldSignalQuality.js';

const previous = {
  sourceId: 'hn:top', sourceTitle: 'Hacker News',
  title: 'AI agents build durable memory from daily work',
  url: 'https://www.example.com/story/?utm_source=feed&id=42#comments',
  createdAt: '2026-09-03T03:00:00.000Z',
};

describe('world signal quality', () => {
  it('treats tracking-only URL variants as the same item', () => {
    expect(isRepeatedWorldSignal({
      sourceId: 'rss:test', sourceTitle: 'Another feed', title: 'Different headline',
      url: 'http://example.com/story?id=42&utm_medium=rss',
    }, [previous])).toBe(true);
  });

  it('recognizes a lightly rewritten title across different sources', () => {
    expect(isRepeatedWorldSignal({
      sourceId: 'arxiv:agents', sourceTitle: 'arXiv・AI agents',
      title: 'AI agents build durable memory from daily work — new study',
      url: 'https://arxiv.org/abs/2609.00001',
    }, [previous])).toBe(true);
  });

  it('does not collapse a different topic just because it shares a source', () => {
    expect(isRepeatedWorldSignal({
      sourceId: 'hn:top', sourceTitle: 'Hacker News',
      title: 'New database indexing technique for mobile applications',
      url: 'https://example.com/database-indexing',
    }, [previous])).toBe(false);
  });

  it('applies only a ranking penalty to an immediate source repeat', () => {
    expect(sourceDiversityAdjustment({
      sourceId: 'hn:top', sourceTitle: 'Hacker News', title: 'Another story', url: 'https://other.example/story',
    }, [previous])).toBe(-0.12);
  });
});
