import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAgentHostConfig, resolveAgentProject } from '../src/agentHostConfig.js';

describe('Agent Host configuration', () => {
  it('resolves only an exact Mac-side allowlist alias', () => {
    const root = mkdtempSync(join(tmpdir(), 'shannon-host-config-'));
    const project = join(root, 'project');
    mkdirSync(project);
    const config = loadAgentHostConfig({
      SHANNON_API_BASE_URL: 'https://sh4nnon.com/companion',
      SHANNON_AGENT_HOST_TOKEN: 'x'.repeat(32),
      SHANNON_AGENT_PROJECTS_JSON: JSON.stringify({ Shannon: project }),
      SHANNON_AGENT_DEFAULT_PROJECT: 'Shannon',
    });

    expect(resolveAgentProject(config, 'shannon')).toMatchObject({ key: 'shannon', path: realpathSync(project) });
    expect(resolveAgentProject(config, undefined).path).toBe(realpathSync(project));
    expect(config.deliveryMode).toBe('local-device');
    expect(() => resolveAgentProject(config, '/tmp/not-allowed')).toThrow('AGENT_PROJECT_NOT_ALLOWLISTED');
  });

  it('rejects cleartext remote brokers and short host tokens', () => {
    const root = mkdtempSync(join(tmpdir(), 'shannon-host-config-'));
    const base = {
      SHANNON_AGENT_HOST_TOKEN: 'x'.repeat(32),
      SHANNON_AGENT_PROJECTS_JSON: JSON.stringify({ project: root }),
      SHANNON_AGENT_DEFAULT_PROJECT: 'project',
    };
    expect(() => loadAgentHostConfig({ ...base, SHANNON_API_BASE_URL: 'http://example.com' }))
      .toThrow('must use HTTPS');
    expect(() => loadAgentHostConfig({ ...base, SHANNON_AGENT_HOST_TOKEN: 'short' }))
      .toThrow('at least 32');
  });

  it('accepts the isolated cloud TestFlight delivery mode', () => {
    const root = mkdtempSync(join(tmpdir(), 'shannon-host-config-'));
    const config = loadAgentHostConfig({
      SHANNON_AGENT_HOST_TOKEN: 'x'.repeat(32),
      SHANNON_AGENT_PROJECTS_JSON: JSON.stringify({ Shannon: root }),
      SHANNON_AGENT_DEFAULT_PROJECT: 'Shannon',
      SHANNON_AGENT_DELIVERY_MODE: 'cloud-testflight',
    });
    expect(config.deliveryMode).toBe('cloud-testflight');
  });
});
