import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { apiSourcePath } from './support/sources.js';

describe('Azure deployment contract', () => {
  it('ships the activity loop switched off, with placeholders only for its dedicated credential', () => {
    for (const path of ['../../../deploy/azure/api.env.example', '../../../.env.example']) {
      const example = readFileSync(new URL(path, import.meta.url), 'utf8');
      expect(example).toMatch(/^SHANNON_AUTONOMY_ENABLED=false$/mu);
      // Names only: no value may be committed for a credential.
      expect(example).toMatch(/^SHANNON_AUTONOMY_GEMINI_API_KEY=$/mu);
      expect(example).toMatch(/^SHANNON_AUTONOMY_OPENAI_API_KEY=$/mu);
      for (const name of ['SHANNON_AUTONOMY_CYCLES_PER_DAY', 'SHANNON_AUTONOMY_CYCLE_MAX_STEPS', 'SHANNON_AUTONOMY_CYCLE_MAX_READS',
        'SHANNON_AUTONOMY_MAX_PUBLIC_READS', 'SHANNON_AUTONOMY_READ_MAX_BYTES', 'SHANNON_AUTONOMY_READ_TIMEOUT_MS', 'SHANNON_AUTONOMY_OWNER_ACTIVE_MINUTES']) {
        expect(example, name).toMatch(new RegExp(`^${name}=`, 'mu'));
      }
    }
    const unit = readFileSync(new URL('../../../deploy/azure/shannon-ios-autonomy.service', import.meta.url), 'utf8');
    // An entry file stays at the root of the API sources (Syzygy ADR-0008 §6): the unit runs it there.
    expect(apiSourcePath('autonomyWorker.ts')).toBe('services/api/src/autonomyWorker.ts');
    expect(unit).toContain(apiSourcePath('autonomyWorker.ts'));
    expect(unit).toContain('EnvironmentFile=/home/azureuser/.config/shannon-ios/api.env');
    expect(unit).toContain('ReadWritePaths=/home/azureuser/shannon-ios-data');
    expect(unit).toContain('NoNewPrivileges=true');
    expect(unit).toMatch(/^CPUQuota=\d+%$/mu);
    expect(unit).toMatch(/^MemoryMax=\d+M$/mu);
  });

  it('allows confirmed camera snapshots through nginx to the route-specific API limit', () => {
    const configuration = readFileSync(
      new URL('../../../deploy/azure/nginx-location.conf', import.meta.url),
      'utf8',
    );

    expect(configuration).toContain('client_max_body_size 4m;');
    expect(configuration).toContain('camera snapshots at 3 MiB');
  });
});
