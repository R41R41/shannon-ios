import { randomUUID } from 'node:crypto';
import { afterEach,describe,expect,it } from 'vitest';
import { feedbackHarness } from './support/feedbackHarness.js';
import { FeedbackService } from '../src/mind/learning/feedbackService.js';
import { createFeedbackWiring } from '../src/wiring/feedbackWiring.js';
import { DatabaseSync } from 'node:sqlite';
const all:ReturnType<typeof feedbackHarness>[]=[];
const harness=()=>{const h=feedbackHarness();all.push(h);return h;};
afterEach(()=>all.splice(0).forEach(h=>h.close()));

describe('Stage5 server-bound owner feedback',()=>{
  it('binds the actual tool choices to exactly one saved reply, never tier choices or raw private traces',()=>{
    const h=harness(),turn=h.seed();
    expect(turn.target).toMatchObject({turnId:turn.turnId,threadId:'talk',revision:0,reaction:null});
    const serialized=JSON.stringify(turn.target);
    expect(serialized).not.toContain('study.list'); expect(serialized).not.toContain('synthetic-private');
    expect(h.feedback.bindTurn('owner',{recordId:turn.recordId,threadId:'talk',turnId:turn.turnId,reply:'改変した返答'})).toBeNull();
    const clone=h.store.appendTurn('owner','talk','別の発話',turn.reply,h.clock.at);
    expect(h.feedback.bindTurn('owner',{recordId:turn.recordId,threadId:'talk',turnId:clone.id,reply:turn.reply})).toBeNull();
    expect(h.feedback.project('stranger','talk',turn.turnId)).toBeNull();
    expect(h.feedback.get('owner',turn.target!.targetId,'another-talk')).toBeNull();
  });
  it.each([{tools:false},{presence:'others' as const},{withheld:true},{outOfTime:true},{described:true}])('never invents eligibility for %o',options=>{
    const h=harness(),turn=h.seed(options);expect(turn.target).toBeNull();expect(h.feedback.project('owner','talk',turn.turnId)).toBeNull();
  });
  it('stores CAS reaction revisions, duplicate acknowledgement, replacement and withdrawal without another choice or mood',()=>{
    const h=harness(),turn=h.seed(),id=turn.target!.targetId,operation=randomUUID();
    const before=h.choices.rows('owner');
    const first=h.change(id,0,'good',operation);
    expect(first).toMatchObject({revision:1,reaction:'good',operationId:operation});
    expect(h.change(id,0,'good',operation)).toEqual(first);
    expect(h.feedback.store.lastSeq('owner')).toBe(1);
    expect(h.change(id,1,'bad',operation)).toBe('FEEDBACK_OPERATION_REUSED');
    expect(h.change(id,0,'bad')).toBe('FEEDBACK_CONFLICT');
    expect(h.change(id,1,'bad')).toMatchObject({revision:2,reaction:'bad'});
    expect(h.change(id,2,null)).toMatchObject({revision:3,reaction:null});
    expect(h.choices.rows('owner')).toEqual(before);
    const reopened=new FeedbackService({database:h.db,ownerScopeKey:'owner',now:()=>h.clock.at,ownerAlone:()=>true,source:h.source,toolEvidence:h.toolEvidence});
    expect(reopened.get('owner',id,'talk')).toMatchObject({revision:3,reaction:null});
  });
  it('withholds and revokes forgotten sources from reading, mutation and learning, even if later restored',()=>{
    const h=harness(),turn=h.seed(),id=turn.target!.targetId;
    h.change(id,0,'good');
    h.store.apply('owner',{type:'memory-control-upserted',control:{memoryId:turn.turnId,kind:'experience',status:'forgotten',pinned:false,updatedAt:h.clock.at,changeReason:'所有者が忘れるよう指定した。'}});
    expect(h.feedback.get('owner',id,'talk')).toBeNull();
    expect(h.change(id,1,'bad')).toBe('FEEDBACK_NOT_FOUND');
    expect(h.feedback.snapshot('owner').reactions.size).toBe(0);
    h.store.apply('owner',{type:'memory-control-upserted',control:{memoryId:turn.turnId,kind:'experience',status:'active',pinned:false,updatedAt:h.clock.at,changeReason:'所有者が復元した。'}});
    expect(h.feedback.get('owner',id,'talk')).toBeNull();
  });
  it('fails closed for deleted sources, unknown reads, mismatched traces and void/lost choices',()=>{
    const h=harness(),turn=h.seed(),id=turn.target!.targetId;
    h.change(id,0,'good'); h.clock.unknown=true;
    expect(()=>h.feedback.get('owner',id,'talk')).toThrow('FEEDBACK_SOURCE_UNAVAILABLE');expect(()=>h.feedback.snapshot('owner')).toThrow('FEEDBACK_SOURCE_UNAVAILABLE');
    h.clock.unknown=false;
    h.db.prepare("UPDATE shannon_choices SET status='void',settle_code='lost' WHERE scope_key='owner' AND source_kind='tool_call'").run();
    expect(h.feedback.project('owner','talk',turn.turnId)).toBeNull();
    expect(h.feedback.snapshot('owner').reactions.size).toBe(0);
    h.db.prepare('DELETE FROM conversation_messages WHERE scope_key=? AND turn_id=?').run('owner',turn.turnId);
    expect(h.feedback.get('owner',id,'talk')).toBeNull();
  });
  it('does not block the response on deferred provenance writes, and OFF creates no feedback schema',()=>{
    const h=harness(),queued:Array<()=>void>=[];
    const parts=createFeedbackWiring({database:h.db,enabled:true,ownerScopeKey:'owner',now:()=>h.clock.at,ownerAlone:()=>true,source:h.source,toolEvidence:h.toolEvidence,defer:task=>queued.push(task)})!;
    parts.ports.captureTurn('owner',{recordId:'record-deferred',threadId:'talk',surface:'text',ownerAlone:true,usable:true,replyDigest:'a'.repeat(64),choices:[{choiceId:'choice-deferred',tool:'study.list',ok:true}],at:h.clock.at});
    expect(h.feedback.store.draft('owner','record-deferred')).toBeNull();
    queued.forEach(task=>task()); expect(h.feedback.store.draft('owner','record-deferred')).not.toBeNull();
    const tables=h.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    expect(createFeedbackWiring({database:h.db,enabled:false,ownerScopeKey:'owner',now:()=>h.clock.at,ownerAlone:()=>true,source:h.source,toolEvidence:h.toolEvidence})).toBeNull();
    expect(h.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual(tables);
  });
  it('keeps a proven content-free tool link after normal private trace retention and rejects cross-kind same-text notes',()=>{
    const h=harness(),turn=h.seed(),id=turn.target!.targetId;
    h.choices.settleTalk('owner','talk',0.5,h.clock.at);h.change(id,0,'good');
    h.store.deleteToolTraces('owner',[turn.turnId]);
    expect(h.feedback.get('owner',id,'talk')).toMatchObject({reaction:'good'});
    expect(h.feedback.snapshot('owner').reactions.size).toBe(1);
    const note=h.store.appendNote('owner','talk',turn.reply,h.clock.at,'agent-task-result');
    expect(h.feedback.bindTurn('owner',{recordId:turn.recordId,threadId:'talk',turnId:note.id,reply:turn.reply})).toBeNull();
  });
  it('creates no additive tables or columns on a pristine Stage5 OFF database',()=>{
    const db=new DatabaseSync(':memory:');
    try {
      const before=db.prepare('SELECT * FROM sqlite_master').all();
      expect(createFeedbackWiring({database:db,enabled:false,ownerScopeKey:'owner',now:()=>new Date().toISOString(),ownerAlone:()=>true,source:()=>null,toolEvidence:()=>[]})).toBeNull();
      expect(db.prepare('SELECT * FROM sqlite_master').all()).toEqual(before);
    } finally {db.close();}
  });
});
