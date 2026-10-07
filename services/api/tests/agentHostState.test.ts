import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AgentHostStateStore } from '../src/integrations/agentHost/agentHostState.js';
import { AgentHostBrokerClient } from '../src/integrations/agentHost/agentHostBroker.js';

describe('AgentHostStateStore', () => {
  it('persists resumable sessions and an idempotent durable event outbox', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'shannon-host-state-')), 'state.json');
    const store = new AgentHostStateStore(path);
    store.saveSession({
      taskId: 'task-1', startCommandId: 'command-1', threadId: 'thread-1', turnId: 'turn-1',
      pendingApprovalExternalRequestID: 'approval-1',
      goal: 'Recover a title edit',
      projectKey: 'fixture', cwd: '/fixture', updatedAt: '2026-09-04T00:00:00.000Z',
    });
    const event = {
      eventId: 'event-1', taskId: 'task-1', type: 'progress' as const,
      title: '進行中', occurredAt: '2026-09-04T00:00:01.000Z',
    };
    store.enqueueEvents([event, event]);
    store.saveProject({
      key: 'new-app', path: '/workspace/new-app',
      repositoryURL: 'https://github.com/example/new-app.git', updatedAt: '2026-09-04T00:00:02.000Z',
    });

    const restored = new AgentHostStateStore(path);
    expect(restored.resumableSessions()).toHaveLength(1);
    expect(restored.session('task-1')?.pendingApprovalExternalRequestID).toBe('approval-1');
    expect(restored.session('task-1')?.goal).toBe('Recover a title edit');
    expect(restored.pendingEvents()).toEqual([event]);
    expect(restored.registeredProjects()).toEqual([{
      key: 'new-app', path: '/workspace/new-app',
      repositoryURL: 'https://github.com/example/new-app.git', updatedAt: '2026-09-04T00:00:02.000Z',
    }]);
    restored.acknowledgeEvents(['event-1']);
    expect(restored.pendingEvents()).toEqual([]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(1);
  });
  it('publishes a durable old acknowledgement under its original lease after a newer generation starts',async()=>{
    const path=join(mkdtempSync(join(tmpdir(),'shannon-host-old-ack-')),'state.json'),state=new AgentHostStateStore(path);
    const oldLease={id:'action-1',holder:'host',generation:1};
    state.saveSession({taskId:'task-1',startCommandId:'command-1',threadId:'thread-1',turnId:'turn-2',actionLease:{...oldLease,generation:2},projectKey:'fixture',cwd:'/fixture',updatedAt:'2026-10-07T12:00:00.000Z'});
    const sent:unknown[]=[];
    vi.stubGlobal('fetch',async(_url:unknown,options:{body:string})=>{sent.push(JSON.parse(options.body));return {ok:true,json:async()=>({})};});
    try {
      await new AgentHostBrokerClient('https://synthetic.invalid','synthetic','host',state).publish([{eventId:'original-ack',taskId:'task-1',type:'paused',title:'synthetic',occurredAt:'2026-10-07T12:00:00.000Z',payload:{actionLease:oldLease}}]);
      expect(sent).toEqual([{hostId:'host',events:[expect.objectContaining({eventId:'original-ack',payload:{actionLease:oldLease}})]}]);
      expect(state.session('task-1')?.actionLease?.generation).toBe(2);expect(state.pendingEvents()).toEqual([]);
    } finally {vi.unstubAllGlobals();}
  });
});
