import { describe, expect, it } from 'vitest';
import { configuredGithubRepositories, parseGithubReleases } from '../src/githubReleases.js';

describe('GitHub Releases source adapter', () => {
  it('normalizes, deduplicates, and rejects malformed configured repositories', () => {
    expect(configuredGithubRepositories('OpenAI/openai-node, openai/OPENAI-NODE, ../admin, owner/repo?x=1, good/.github')).toEqual([
      'openai/openai-node', 'good/.github',
    ]);
  });

  it('keeps public releases that belong to the configured repository', () => {
    const releases = parseGithubReleases([{
      id: 42, name: 'Version 2', tag_name: 'v2.0.0', draft: false, prerelease: true,
      html_url: 'https://github.com/OpenAI/openai-node/releases/tag/v2.0.0#notes',
      body: 'Changes\r\n- safer', published_at: '2026-09-10T12:00:00Z', author: { login: 'release-bot' },
    }], 'openai/openai-node');

    expect(releases).toEqual([{
      externalId: '42', title: 'Version 2',
      url: 'https://github.com/OpenAI/openai-node/releases/tag/v2.0.0',
      summary: 'プレリリース\nChanges\n- safer', author: 'release-bot', publishedAt: '2026-09-10T12:00:00.000Z',
    }]);
  });

  it('rejects drafts, wrong repositories, invalid ids, and missing publication time', () => {
    const base = {
      id: 1, tag_name: 'v1', name: 'Version 1', draft: false, prerelease: false,
      html_url: 'https://github.com/openai/openai-node/releases/tag/v1', published_at: '2026-09-10T12:00:00Z',
    };
    expect(parseGithubReleases([
      { ...base, id: 1, draft: true },
      { ...base, id: 2, html_url: 'https://github.com/other/repo/releases/tag/v1' },
      { ...base, id: -3 },
      { ...base, id: 4, published_at: null },
      { ...base, id: 5, tag_name: '' },
    ], 'openai/openai-node')).toEqual([]);
  });
});
