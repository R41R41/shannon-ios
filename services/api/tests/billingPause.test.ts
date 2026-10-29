import { afterEach, describe, expect, it, vi } from 'vitest';
import { refusalError } from '../src/infra/models/anthropic/anthropicFcaFailure.js';
import { FCA_MODEL_BILLING } from '../src/mind/action/fca/fcaProviderRetry.js';
import type { FcaModel } from '../src/mind/action/fca/fcaPorts.js';
import { BILLING_PAUSED_SUMMARY, pausedSummary } from '../src/wiring/taskPauseNotice.js';
import { billingGuarded } from '../src/wiring/minecraftLlmcWiring.js';
import { rejectedTaskReport } from '../src/wiring/taskRuntimeWiring.js';
import { currentActionExecution } from '../src/infra/context/actionExecution.js';
import { minecraftWorld } from './support/fcaBodyRecoveryWorld.js';

/**
 * A-20 (run 47: the credit ran out; the provider answered HTTP 400 「Your credit balance is too low to access the Anthropic API」, and the head failed the running request as
 * FCA_MODEL_HTTP_400 with the world running). A refusal for the account's credit is told apart (a closed code), pauses a Minecraft request (resumable once the balance is filled),
 * holds it with the world stopped when it asked to be held, and a request a refused decision already failed is reopened by the operator's resume.
 */
const worlds: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const world of worlds.splice(0).reverse()) await world.close(); });
function world() {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const w = minecraftWorld({});
  worlds.push(w);
  return w;
}

describe('the provider\'s refusal for the credit has its own closed code', () => {
  it('a 400 that says the credit balance is too low (and a 402) is FCA_MODEL_BILLING; every other 4xx stays FCA_MODEL_HTTP_<status>', () => {
    expect(refusalError(400, { message: '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing"}}' }).message).toBe(FCA_MODEL_BILLING);
    expect(refusalError(402, { message: 'payment required' }).message).toBe(FCA_MODEL_BILLING);
    expect(refusalError(400, { message: 'messages.0: tool_use ids must be unique' }).message).toBe('FCA_MODEL_HTTP_400');
    expect(refusalError(400, {}).message).toBe('FCA_MODEL_HTTP_400');
    expect(refusalError(404, { message: 'credit balance is too low' }).message).toBe('FCA_MODEL_HTTP_404');
  });
  it('the guard tells the hold before the error goes on, only for billing, and leaves the rest of the model as it is', async () => {
    const told: string[] = [];
    const base = { decide: async () => { throw new Error(FCA_MODEL_BILLING); }, toolResults: () => 'kept', marker: 'x' } as unknown as FcaModel;
    const guarded = billingGuarded(base, () => told.push('billing'));
    await expect(guarded.decide({} as never, new AbortController().signal)).rejects.toThrow(FCA_MODEL_BILLING);
    expect(told).toEqual(['billing']);
    expect(guarded.toolResults([])).toBe('kept');
    expect((guarded as unknown as { marker: string }).marker).toBe('x');
    const other = billingGuarded({ decide: async () => { throw new Error('FCA_MODEL_HTTP_400'); }, toolResults: () => '' } as unknown as FcaModel, () => told.push('wrong'));
    await expect(other.decide({} as never, new AbortController().signal)).rejects.toThrow('FCA_MODEL_HTTP_400');
    expect(told).toEqual(['billing']);
    // asking for the hold never changes the error
    const broken = billingGuarded(base, () => { throw new Error('hold failed'); });
    await expect(broken.decide({} as never, new AbortController().signal)).rejects.toThrow(FCA_MODEL_BILLING);
  });
  it('the pause\'s summary is one a pause wrote (it is cleared when the request goes on)', () => {
    expect(pausedSummary(BILLING_PAUSED_SUMMARY)).toBe(true);
  });
});

describe('a Minecraft request whose decision was refused for the credit is paused, not failed', () => {
  it('stops it as paused (stopped, resumable) with the billing summary, asks nothing again, and resumes when the operator says so', async () => {
    const w = world();
    const api = w.startApi();
    const task = w.createTask(api);
    w.connectBody(api, 'c1', 'complete');
    w.script.push(() => { currentActionExecution()!.modelOutcome = 'acknowledged'; throw new Error(FCA_MODEL_BILLING); });
    await w.until(api, () => w.phase(api) === 'stopped', 'paused for billing');
    expect(api.driver.runtime.get('owner', task.id)).toMatchObject({ status: 'paused', summary: BILLING_PAUSED_SUMMARY });
    expect(w.phase(api)).not.toBe('failed');
    expect(w.modelInputs).toHaveLength(1);
    expect(api.driver.runtime.resume('owner', task.id)?.phase).toBe('ready');
  });
});

describe('a request a refused decision already failed is reopened (the operator\'s resume), and no other failed task is', () => {
  it('FCA_MODEL_HTTP_400 failed it: reopenRejected pauses it again as stopped with the summary; once; it can be resumed', async () => {
    const w = world();
    const api = w.startApi();
    const task = w.createTask(api);
    w.connectBody(api, 'c1', 'complete');
    // the refusal is acknowledged by the provider, as the adapter marks it before it throws
    w.script.push(() => { currentActionExecution()!.modelOutcome = 'acknowledged'; throw new Error('FCA_MODEL_HTTP_400'); });
    await w.until(api, () => w.phase(api) === 'failed', 'the refused decision fails the request');
    const title = api.driver.runtime.get('owner', task.id)!.title;
    expect(api.driver.runtime.reopenRejected!('owner', task.id, BILLING_PAUSED_SUMMARY, '別の失敗の文')).toBeNull();
    const reopened = api.driver.runtime.reopenRejected!('owner', task.id, BILLING_PAUSED_SUMMARY, rejectedTaskReport(title));
    expect(reopened).toMatchObject({ phase: 'stopped', status: 'paused', summary: BILLING_PAUSED_SUMMARY });
    expect(w.events()).toContain('fca_rejected_reopened');
    expect(api.driver.runtime.reopenRejected!('owner', task.id, BILLING_PAUSED_SUMMARY, rejectedTaskReport(title))).toBeNull();
    expect(api.driver.runtime.resume('owner', task.id)?.phase).toBe('ready');
  });
  it('a completed task and a task failed in another way are not reopened', async () => {
    const w = world();
    const api = w.startApi();
    const task = w.createTask(api);
    w.connectBody(api, 'c1', 'complete');
    await w.until(api, () => w.phase(api) === 'completed', 'completes');
    expect(api.driver.runtime.reopenRejected!('owner', task.id, 'x', rejectedTaskReport(api.driver.runtime.get('owner', task.id)!.title))).toBeNull();
  });
});
