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

    // The photo route keeps its 3 MiB (plus headroom) in its own location; the rest of /companion/ is small (ADR-0011 review).
    // Each `location` header and the directives up to the next header or closing brace belong to it (one nested location exists).
    const blocks = [...configuration.matchAll(/location ((?:"[^"]*"|[^{"])+)\{((?:(?!location )[^{}])*)/gu)].map(match => ({ location: match[1]!.trim(), body: match[2]! }));
    const block = (location: string) => blocks.find(item => item.location === location)?.body ?? '';
    expect(block('= /companion/v1/voice/vision/snapshots')).toContain('client_max_body_size 4m;');
    expect(block('= /companion/v1/voice/vision/snapshots')).toContain('limit_req zone=shannon_media_req');
    expect(block('^~ /companion/')).toContain('client_max_body_size 256k;');
    // Her folder's long poll (`claim`) and `binding` stay small and are never counted; only a step report gets 1m and limits.
    const hostSteps = block('^~ /companion/v1/autonomy/host-steps/');
    expect(hostSteps).toContain('client_max_body_size 256k;');
    expect(hostSteps).not.toMatch(/limit_(req|conn) /u);
    const report = block('~ "^/companion/v1/autonomy/host-steps/[0-9a-f-]{36}/report$"');
    expect(report).toContain('client_max_body_size 1m;');
    expect(report).toContain('limit_conn shannon_report_conn');
    expect(block('^~ /companion/')).not.toMatch(/limit_(req|conn) /u);
    // No accepted body is written to client_body_temp: each location's buffer is its whole maximum body.
    for (const item of blocks) {
      const maximum = /client_max_body_size (\w+);/u.exec(item.body)?.[1];
      expect(maximum, item.location).toBeDefined();
      expect(item.body, item.location).toContain(`client_body_buffer_size ${maximum};`);
    }
    // One request and one connection zone per kind of route (vision, media, look, report), each declared, none shared.
    const limits = readFileSync(new URL('../../../deploy/azure/nginx-http-limits.conf', import.meta.url), 'utf8');
    for (const kind of ['vision', 'media', 'look', 'report']) {
      expect(limits).toContain(`zone=shannon_${kind}_req:`);
      expect(limits).toContain(`zone=shannon_${kind}_conn:`);
    }
    const used = [...configuration.matchAll(/limit_conn (shannon_\w+) (\d+);/gu)];
    expect(new Set(used.map(match => match[1])).size).toBe(4);
    expect(used.every(match => Number(match[2]) >= 6)).toBe(true);
  });
});
