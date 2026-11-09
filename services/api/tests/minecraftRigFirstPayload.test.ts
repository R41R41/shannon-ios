import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installRigFirstPayload } from '../scripts/minecraftRigFirstPayload.js';
import { decisionRecorder, installDecisionRecorder, noteStageRow } from '../src/infra/decisionRecords/decisionRecordNotes.js';
import { withDecisionScope } from '../src/infra/decisionRecords/decisionRecordScope.js';
import { recordedClient } from '../src/infra/decisionRecords/decisionRecordClient.js';

const roots: string[] = [];
afterEach(() => { installDecisionRecorder(null); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(changes: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-first-payload-')); roots.push(root);
  const directory = path.join(root, '1793832504664484974'); fs.mkdirSync(directory);
  const log = vi.fn(); let clock = 1000;
  const options = { enabled: 'on', keep: true, modelMode: 'real', directory, obsMode: 'transient', root,
    minecraftTask: (id: string) => id === 'mc-task', log, now: () => clock, ...changes };
  return { root, directory, log, options, capture: () => installRigFirstPayload(options), setClock: (value: number) => { clock = value; } };
}
const body = { model: 'claude-haiku-5-5', max_tokens: 2000, system: [{ type: 'text', text: 'MC rules', cache_control: { type: 'ephemeral', ttl: '1h' } }],
  messages: [{ role: 'system', clear_at: 'turn_end', content: '{"body":{"scan":["observed login row"]}}' }], tools: [] };
function send(kind: 'decision' | 'plan' | 'summary', payload: unknown, taskId = 'mc-task') {
  const create = vi.fn(async (_body: unknown, _options: unknown) => ({ content: [] })), client = recordedClient({ messages: { create } } as never, kind) as any;
  return { create, call: () => withDecisionScope({ taskId, stepId: 'step-1', record: true }, () => client.messages.create(payload,
    { headers: { authorization: 'never-write-auth', 'x-api-key': 'never-write-key', 'anthropic-beta': 'never-write-beta' } })) };
}
describe('opt-in first provider bodies, only in the kept isolated rig', () => {
  it('keeps the exact final body while omitting options/headers and records only the first decision and plan', async () => {
    const f = fixture(), capture = f.capture()!;
    capture.observe({ observation: { connected: true, state: { world: {} } } });
    f.setClock(1300); capture.observe({ observation: { connected: true, state: { world: { scan: { at: 'body-scan-time', text: 'observed' } } } } });
    const request = send('decision', body); await request.call(); expect(request.create.mock.calls[0]![0]).toBe(body);
    await send('decision', { ...body, model: 'second-never-saved' }).call(); await send('plan', body).call();
    noteStageRow({ ev: 'received', ids: { run: 'mc-task' } }); capture.close(); capture.close();
    expect(decisionRecorder()).toBeNull();
    expect(fs.readdirSync(f.directory).sort()).toEqual(['first-provider-decision.json', 'first-provider-observation.json', 'first-provider-plan.json']);
    const saved = JSON.parse(fs.readFileSync(path.join(f.directory, 'first-provider-decision.json'), 'utf8'));
    expect(saved).toMatchObject({ obsMode: 'transient', firstObservationMs: 0, firstWorldScanMs: 300, firstScanAt: 'body-scan-time', body });
    const all = fs.readdirSync(f.directory).map(name => fs.readFileSync(path.join(f.directory, name), 'utf8')).join('\n');
    expect(all).not.toMatch(/never-write|headers|second-never-saved/u);
  });
  it('all keeps every decision and plan body, numbered, for the scene replay', async () => {
    const f = fixture({ enabled: 'all' }), capture = f.capture()!;
    await send('decision', body).call(); await send('decision', { ...body, model: 'second' }).call(); await send('plan', body).call();
    await send('decision', body, 'other-chat').call(); capture.close();
    expect(f.log).not.toHaveBeenCalled();
    expect(fs.readdirSync(path.join(f.directory, 'payloads')).sort()).toEqual(['0001-decision.json', '0002-decision.json', '0003-plan.json']);
    expect(JSON.parse(fs.readFileSync(path.join(f.directory, 'payloads', '0002-decision.json'), 'utf8')).body.model).toBe('second');
  });
  it('ignores other chat and summary requests and reports a scan which arrives only after the first request', async () => {
    const f = fixture(), capture = f.capture()!;
    await send('decision', { ...body, messages: ['unrelated owner conversation'] }, 'other-chat').call();
    await send('summary', { ...body, messages: ['summary never captured'] }).call();
    await send('decision', body).call(); f.setClock(1800);
    capture.observe({ observation: { connected: true, state: { world: { scan: { at: 'later', text: 'observed' } } } } }); capture.close();
    const saved = JSON.parse(fs.readFileSync(path.join(f.directory, 'first-provider-decision.json'), 'utf8'));
    expect(saved.firstWorldScanMs).toBeNull();
    expect(JSON.parse(fs.readFileSync(path.join(f.directory, 'first-provider-observation.json'), 'utf8')).firstWorldScanMs).toBe(800);
    expect(JSON.stringify(saved)).not.toContain('unrelated owner conversation');
    expect(fs.readdirSync(f.directory)).not.toContain('first-provider-summary.json');
  });
  it('keeps the first final body before a provider rejection without changing that rejection', async () => {
    const f = fixture(), capture = f.capture()!, failure = new Error('synthetic provider failure');
    const provider = { messages: { create: vi.fn(() => Promise.reject(failure)) } };
    const client = recordedClient(provider as never, 'decision') as any;
    const call = withDecisionScope({ taskId: 'mc-task', stepId: 's', record: true }, () => client.messages.create(body, {}));
    expect(fs.existsSync(path.join(f.directory, 'first-provider-decision.json'))).toBe(true);
    await expect(call).rejects.toBe(failure); expect(provider.messages.create).toHaveBeenCalledOnce(); capture.close();
  });
  it.each([{ headers: { 'x-api-key': 'plain-secret' } }, { apiKey: 'plain-secret' }, { messages: ['sk-ant-' + 'x'.repeat(30)] }])('refuses credential material instead of saving a changed provider body', async material => {
    const f = fixture(), capture = f.capture()!; await send('decision', { ...body, ...material }).call(); capture.close();
    expect(fs.existsSync(path.join(f.directory, 'first-provider-decision.json'))).toBe(false);
    expect(f.log).toHaveBeenCalledWith('RIG_FIRST_PAYLOAD_REFUSED_MATERIAL');
  });
  it.each([{ enabled: 'off' }, { enabled: undefined }])('writes nothing when capture is absent or off', changes => {
    const f = fixture(changes); expect(f.capture()).toBeNull(); expect(fs.readdirSync(f.directory)).toEqual([]); expect(decisionRecorder()).toBeNull();
  });
  it.each([{ keep: false }, { modelMode: 'script' }, { enabled: 'yes' }])('rejects capture without its explicit kept-real-rig boundary', changes => {
    const f = fixture(changes); expect(f.capture).toThrow('RIG_FIRST_PAYLOAD_REQUIRES_KEPT_REAL_RIG'); expect(fs.readdirSync(f.directory)).toEqual([]);
  });
  it('refuses an existing record file and directories outside the immediate rig root', async () => {
    const f = fixture(); fs.writeFileSync(path.join(f.directory, 'first-provider-decision.json'), 'original');
    const capture = f.capture()!; await send('decision', body).call(); capture.close();
    expect(fs.readFileSync(path.join(f.directory, 'first-provider-decision.json'), 'utf8')).toBe('original');
    const outside = fixture(); outside.options.directory = outside.root;
    expect(outside.capture).toThrow('RIG_FIRST_PAYLOAD_DIRECTORY_REFUSED');
  });
  it('does not change dispatch or poll handling when recording or its logger fails', async () => {
    const f = fixture({ log: () => { throw new Error('logger failed'); } }), capture = f.capture()!;
    const cyclic: any = { ...body }; cyclic.cycle = cyclic;
    const request = send('decision', cyclic); await expect(request.call()).resolves.toEqual({ content: [] });
    expect(request.create).toHaveBeenCalledOnce();
    expect(() => capture.observe({ get observation() { throw new Error('observation read failed'); } })).not.toThrow();
    capture.close(); expect(fs.existsSync(path.join(f.directory, 'first-provider-decision.json'))).toBe(false);
  });
});
