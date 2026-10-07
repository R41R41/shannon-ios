import { afterEach, describe, expect, it } from 'vitest';
import { attachConversationFeedback } from '../src/mind/memory/memoryPorts.js';
import { feedbackHarness } from './support/feedbackHarness.js';
import { OWNER_AUDIENCE } from '@shannon/cognition';
let h:ReturnType<typeof feedbackHarness>;
afterEach(()=>h?.close());
describe('exact memory-owned feedback source and history projection',()=>{
  it('looks beyond the bounded display window without guessing old turns deleted or exposing source text',()=>{
    h=feedbackHarness({maximumDisplayedConversationItems:2});const turn=h.seed();
    h.store.appendTurn('owner','talk','別の話','別の返答',h.clock.at);
    expect(h.store.conversationHistory('owner','talk').some(message=>message.sourceExperienceId===turn.turnId)).toBe(false);
    expect(h.source('owner','talk',turn.turnId)).toMatchObject({kind:'turn',status:'visible',ownerAlone:true});
    expect(h.feedback.get('owner',turn.target!.targetId,'talk')).not.toBeNull();
    expect(h.source('owner','other',turn.turnId)).toMatchObject({status:'deleted'});
    expect(JSON.stringify(h.source('owner','talk',turn.turnId))).not.toContain(turn.reply);
  });
  it('never treats a raw or legacy same-text note as an owner-only task result',()=>{
    h=feedbackHarness();h.store.snapshot('owner');
    const legacy=h.store.appendNote('owner','talk','作業が終わりました。',h.clock.at,'agent-task-result');
    const unknown=h.store.appendNoteOnce('owner','talk','note-unknown','作業が終わりました。',h.clock.at,'agent-task-result');
    const others=h.store.appendNoteOnce('owner','talk','note-others','作業が終わりました。',h.clock.at,'agent-task-result',false);
    const owner=h.store.appendNoteOnce('owner','talk','note-owner','作業が終わりました。',h.clock.at,'agent-task-result',true);
    expect(h.source('owner','talk',legacy.id)?.status).not.toBe('visible');
    expect(h.source('owner','talk',unknown.id)).toMatchObject({kind:'task-note',status:'hidden',ownerAlone:false});
    expect(h.source('owner','talk',others.id)).toMatchObject({kind:'task-note',status:'hidden',ownerAlone:false});
    expect(h.source('owner','talk',owner.id)).toMatchObject({kind:'task-note',status:'visible',ownerAlone:true});
    h.store.apply('owner',{type:'memory-control-upserted',control:{memoryId:owner.id,kind:'experience',status:'forgotten',pinned:false,updatedAt:h.clock.at,changeReason:'忘れる。'}});
    expect(h.source('owner','talk',owner.id)?.status).toBe('forgotten');
  });
  it('attaches only eligible assistant replies and strips server-only audience/provenance, including Stage5 OFF history',()=>{
    h=feedbackHarness();const turn=h.seed();
    h.store.appendNoteOnce('owner','talk','note-owner','作業が終わりました。',h.clock.at,'agent-task-result',true);
    const messages=h.store.conversationHistory('owner','talk');
    const alone=attachConversationFeedback(messages,h.feedback,'owner','talk',()=>true);
    expect(alone.find(message=>message.role==='assistant'&&message.sourceExperienceId===turn.turnId)).toHaveProperty('feedback.targetId',turn.target!.targetId);
    expect(alone.filter(message=>message.role==='user').every(message=>!message.feedback)).toBe(true);
    expect(JSON.stringify(alone)).not.toContain('noteOwnerAlone');
    expect(attachConversationFeedback(messages,h.feedback,'owner','talk',()=>false).some(message=>message.id==='note-owner')).toBe(false);
    expect(attachConversationFeedback(messages,undefined,'owner','talk',()=>true).some(message=>message.feedback)).toBe(false);
    expect(JSON.stringify(attachConversationFeedback(messages,undefined,'owner','talk',()=>true))).not.toContain('noteOwnerAlone');
    expect(attachConversationFeedback(messages,h.feedback,'owner','talk',()=>{throw new Error('unavailable');}).some(message=>message.id==='note-owner')).toBe(false);
  });
  it('withholds reactions when the stored reply recalled a now-forgotten private source',()=>{
    h=feedbackHarness();const recalled=h.seed(),turn=h.seed({reply:'別の話について整理しました。'});
    const row=h.db.prepare("SELECT metadata_json FROM conversation_messages WHERE scope_key='owner' AND turn_id=? AND role='assistant'").get(turn.turnId) as {metadata_json:string|null};
    h.db.prepare("UPDATE conversation_messages SET metadata_json=? WHERE scope_key='owner' AND turn_id=? AND role='assistant'").run(JSON.stringify({...JSON.parse(row.metadata_json??'{}'),recalledMemoryIds:[recalled.turnId]}),turn.turnId);
    expect(h.source('owner','talk',turn.turnId)?.status).toBe('visible');
    h.store.apply('owner',{type:'memory-control-upserted',control:{memoryId:recalled.turnId,kind:'experience',status:'forgotten',pinned:false,updatedAt:h.clock.at,changeReason:'忘れる。'}});
    expect(h.source('owner','talk',turn.turnId)).toMatchObject({status:'forgotten'});
    expect(attachConversationFeedback(h.store.conversationHistory('owner','talk'),h.feedback,'owner','talk',()=>true).some(message=>message.feedback)).toBe(false);
  });
  it('requires the original owner speaker as well as an owner-only stored audience',()=>{
    h=feedbackHarness();
    const turn=h.store.appendTurn('owner','talk','不明な話者の発話','返答です。',h.clock.at,{capturedStateVersion:0,messageEmotion:{expression:'calm',valence:0,arousal:0.3,openness:0.4},audience:OWNER_AUDIENCE,speaker:'unknown'});
    expect(h.source('owner','talk',turn.id)).toMatchObject({kind:'turn',status:'hidden',ownerAlone:false});
  });
});
