import { afterEach, describe, expect, it } from 'vitest';
import { feedbackHarness } from './support/feedbackHarness.js';
import { FeedbackService } from '../src/mind/learning/feedbackService.js';
import { ROOT_VALUE } from '@shannon/learning';
let h:ReturnType<typeof feedbackHarness>;
afterEach(()=>h?.close());
const proof={taskId:'task-real',threadId:'talk',attemptId:'attempt-original',status:'verified' as const,evidenceIds:['receipt-original','check-completed']};
function taskReply() {
  const reply='作業が完了しました。確認も通りました。',note=h.store.appendNoteOnce('owner','talk','task-result-original',reply,h.clock.at,'agent-task-result',true);
  return {reply,messageId:note.id,taskId:proof.taskId,threadId:proof.threadId};
}
describe('real dispatched task feedback provenance',()=>{
  it('does not create a task choice from a historical proof or a thumb; dispatch is idempotent and original verified settlement happens once',()=>{
    h=feedbackHarness();h.tasks.set(proof.taskId,proof);const binding=taskReply();
    expect(h.feedback.bindTaskReply('owner',binding)).toBeNull();
    expect(h.choices.rows('owner')).toHaveLength(0);
    h.feedback.taskDispatched('owner',{taskId:proof.taskId,attemptId:proof.attemptId,at:h.clock.at,presence:'alone'});
    h.feedback.taskDispatched('owner',{taskId:proof.taskId,attemptId:proof.attemptId,at:h.clock.at,presence:'alone'});
    expect(h.choices.rows('owner')).toHaveLength(1);
    h.feedback.taskVerified('owner',proof.taskId,'attempt-foreign',h.clock.at,3);
    expect(h.choices.rows('owner')[0]).toMatchObject({status:'pending',success:null});
    h.feedback.taskVerified('owner',proof.taskId,proof.attemptId,h.clock.at,3);
    const original=h.choices.rows('owner');expect(original[0]).toMatchObject({status:'settled',subjectKind:'task',subjectId:proof.taskId,sourceId:proof.attemptId,world:0,serve:1,growth:1,costYen:3,settleCode:'task_verified'});
    h.feedback.taskVerified('owner',proof.taskId,proof.attemptId,h.clock.at,99);expect(h.choices.rows('owner')).toEqual(original);
    const realTurn=h.seed({reply:binding.reply});
    expect(h.feedback.bindTaskReply('owner',{...binding,messageId:realTurn.turnId})).toBeNull();
    const target=h.feedback.bindTaskReply('owner',binding)!;expect(target).toMatchObject({turnId:binding.messageId});
    expect(h.change(target.targetId,0,'bad')).toMatchObject({revision:1});
    expect(h.feedback.snapshot('owner').reactions.get(original[0]!.choiceId)).toBe('bad');
    expect(h.choices.rows('owner').filter(choice=>choice.choice==='task.execute')).toEqual(original);
    expect(h.choices.store.unclaimed('owner',50,true)).toHaveLength(0);
    h.values.nightly('owner',h.clock.at);expect(h.values.overview('owner').cells.find(cell=>cell.level==='choice')).toMatchObject({choice:'task.execute',n:1,serve:0.8});
  });
  it('keeps absent/foreign proof pending and refuses definitive void/lost choices even if proof later appears',()=>{
    h=feedbackHarness();const binding=taskReply();
    h.feedback.taskDispatched('owner',{taskId:proof.taskId,attemptId:proof.attemptId,at:h.clock.at,presence:'alone'});
    h.feedback.taskVerified('owner',proof.taskId,proof.attemptId,h.clock.at,0);expect(h.choices.rows('owner')[0]!.status).toBe('pending');
    h.feedback.taskUnusable('owner',proof.taskId,proof.attemptId,h.clock.at);h.tasks.set(proof.taskId,proof);
    h.feedback.taskVerified('owner',proof.taskId,proof.attemptId,h.clock.at,0);expect(h.choices.rows('owner')[0]!.status).toBe('void');
    expect(h.feedback.bindTaskReply('owner',binding)).toBeNull();
    expect(h.feedback.snapshot('owner').reactions.size).toBe(0);
  });
  it('revokes a target after a successful proof read proves a new original attempt or changed finish contract',()=>{
    h=feedbackHarness();h.feedback.taskDispatched('owner',{taskId:proof.taskId,attemptId:proof.attemptId,at:h.clock.at,presence:'alone'});h.tasks.set(proof.taskId,proof);
    h.feedback.taskVerified('owner',proof.taskId,proof.attemptId,h.clock.at,0);const binding=taskReply(),target=h.feedback.bindTaskReply('owner',binding)!;
    h.change(target.targetId,0,'good');h.tasks.set(proof.taskId,{...proof,attemptId:'new-attempt'});
    expect(h.feedback.snapshot('owner')).toMatchObject({seq:2});expect(h.feedback.get('owner',target.targetId,'talk')).toBeNull();
    h.tasks.set(proof.taskId,proof);expect(h.feedback.get('owner',target.targetId,'talk')).toBeNull();
  });
  it('holds a fold without permanent revocation for an unknown or ambiguous legacy proof read',()=>{
    h=feedbackHarness();h.feedback.taskDispatched('owner',{taskId:proof.taskId,attemptId:proof.attemptId,at:h.clock.at,presence:'alone'});h.tasks.set(proof.taskId,proof);
    h.feedback.taskVerified('owner',proof.taskId,proof.attemptId,h.clock.at,0);const target=h.feedback.bindTaskReply('owner',taskReply())!;h.change(target.targetId,0,'good');
    const ambiguous=new FeedbackService({database:h.db,ownerScopeKey:'owner',now:()=>h.clock.at,ownerAlone:()=>true,source:h.source,toolEvidence:h.toolEvidence,taskProof:()=>null});
    expect(()=>ambiguous.get('owner',target.targetId,'talk')).toThrow('FEEDBACK_TASK_PROOF_UNAVAILABLE');expect(()=>ambiguous.snapshot('owner')).toThrow('FEEDBACK_TASK_PROOF_UNAVAILABLE');
    expect(h.feedback.store.lastSeq('owner')).toBe(1);expect(h.feedback.get('owner',target.targetId,'talk')).not.toBeNull();
    const invalid=new FeedbackService({database:h.db,ownerScopeKey:'owner',now:()=>h.clock.at,ownerAlone:()=>true,source:h.source,toolEvidence:h.toolEvidence,taskProofStatus:()=>({status:'invalid'})});
    expect(invalid.snapshot('owner')).toMatchObject({seq:2});expect(h.feedback.get('owner',target.targetId,'talk')).toBeNull();
  });
  it('keeps the original dispatch expectation and audience when durable callbacks replay after V changed',()=>{
    h=feedbackHarness();let reads=0;
    const feedback=new FeedbackService({database:h.db,ownerScopeKey:'owner',now:()=>h.clock.at,ownerAlone:()=>true,source:h.source,toolEvidence:h.toolEvidence,values:()=>{reads++;return {...ROOT_VALUE,mean:0.9,version:'later-version'};}});
    const expectation={presence:'alone' as const,value:{...ROOT_VALUE,mean:0.2,variance:0.25,version:'original-version'}};
    const dispatch={taskId:'late-task',attemptId:'original-attempt',at:h.clock.at,presence:'others' as const,expectation};
    feedback.taskDispatched('owner',dispatch);
    feedback.taskDispatched('owner',{...dispatch,expectation:{presence:'others',value:{...ROOT_VALUE,mean:0.8,version:'replayed-version'}}});
    expect(h.choices.rows('owner')).toHaveLength(1);expect(h.choices.rows('owner')[0]).toMatchObject({expected:0.2,expectedSd:0.5,valueVersion:'original-version',context:'morning.alone'});expect(reads).toBe(0);
    feedback.taskDispatched('owner',{...dispatch,taskId:'unknown-task',attemptId:'unknown-attempt',expectation:{presence:'unknown',value:null}});
    expect(h.choices.rows('owner')).toHaveLength(1);expect(reads).toBe(0);
  });
});
