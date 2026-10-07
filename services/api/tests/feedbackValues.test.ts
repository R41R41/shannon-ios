import { afterEach, describe, expect, it } from 'vitest';
import { feedbackReward, foldValues, valueCells } from '@shannon/learning';
import { feedbackHarness } from './support/feedbackHarness.js';
let h:ReturnType<typeof feedbackHarness>;
afterEach(()=>h?.close());
const nextDay=(day:number)=>`2026-10-${String(8+day).padStart(2,'0')}T00:00:00.000Z`;
function settled() {
  h=feedbackHarness();const seed=h.seed();
  h.choices.settleTalk('owner','talk',0.5,h.clock.at);
  return seed.target!;
}
function expected(reaction:'good'|'bad'|null) {
  return valueCells(foldValues(h.choices.store.settledInOrder('owner').map(choice=>{
    const adjusted=choice.choice.startsWith('tier.')?{reward:choice.reward!,serve:choice.serve!}:feedbackReward({world:choice.world!,serve:choice.serve!,growth:choice.growth!},reaction);
    return {choice:choice.choice,context:choice.context,world:choice.world!,growth:choice.growth!,costYen:choice.costYen,settledAt:choice.settledAt!,...adjusted};
  }))).map(cell=>Object.fromEntries(Object.entries(cell).map(([key,value])=>[key,typeof value==='number'?Math.round(value*1e9)/1e9:value])));
}
describe('optional owner feedback in nightly value versions',()=>{
  it('makes a feedback-only version without replaying settled choices or moods, and cancellation restores natural evidence',()=>{
    const target=settled(),original=h.choices.rows('owner');
    expect(h.values.nightly('owner',h.clock.at,h.clock.at).decision).toBe('snapshot');
    expect(h.values.overview('owner').cells).toEqual(expected(null));
    const natural=h.values.overview('owner').active!;
    expect(h.change(target.targetId,0,'good')).toMatchObject({revision:1});
    expect(h.choices.rows('owner')).toEqual(original);
    expect(h.values.overview('owner').active).toEqual(natural);
    expect(h.values.nightly('owner',h.clock.at,h.clock.at).decision).toBe('already');
    h.clock.at=nextDay(1);
    expect(h.values.nightly('owner',h.clock.at,h.clock.at).decision).toBe('snapshot');
    expect(h.values.overview('owner').active).toMatchObject({evidenceTo:natural.evidenceTo,feedbackSeq:1,feedbackPolicy:'owner_feedback_80_20_v1'});
    expect(h.values.overview('owner').cells).toEqual(expected('good'));
    h.change(target.targetId,1,null);h.clock.at=nextDay(2);
    expect(h.values.nightly('owner',h.clock.at,h.clock.at).decision).toBe('snapshot');
    expect(h.values.overview('owner').cells).toEqual(expected(null));
    expect(h.choices.rows('owner')).toEqual(original);
  });
  it('rolls back equal-choice-sequence feedback versions, freezes their cursor, and resumes the latest effective reaction',()=>{
    const target=settled();h.values.nightly('owner',h.clock.at);const initial=h.values.overview('owner').active!;
    h.change(target.targetId,0,'bad');h.clock.at=nextDay(1);h.values.nightly('owner',h.clock.at);
    const rolled=h.values.rollback('owner',h.clock.at);
    expect(rolled).toMatchObject({frozen:true,feedbackSeq:0,baseVersion:initial.versionId});
    const frozen=h.values.overview('owner').cells;
    h.change(target.targetId,1,'good');h.clock.at=nextDay(2);
    expect(h.values.nightly('owner',h.clock.at).decision).toBe('frozen');
    expect(h.values.overview('owner').cells).toEqual(frozen);
    expect(h.values.resume('owner',h.clock.at)).toMatchObject({frozen:false,feedbackSeq:2});
    expect(h.values.overview('owner').cells).toEqual(expected('good'));
  });
  it('rechecks feedback sequence inside the same durable transaction if another device changes it during the fold',()=>{
    const target=settled();let count=0;
    h.values.readFeedbackFrom({snapshot(scope){const snapshot=h.feedback.snapshot(scope);if(++count===1)h.change(target.targetId,0,'bad');return snapshot;}});
    h.values.nightly('owner',h.clock.at);
    expect(h.values.overview('owner').active).toMatchObject({feedbackSeq:1});
    expect(h.values.overview('owner').cells).toEqual(expected('bad'));
  });
  it('does not publish a version with unknown source and does not revive forgotten feedback',()=>{
    const target=settled();h.change(target.targetId,0,'good');h.clock.unknown=true;
    expect(()=>h.values.nightly('owner',h.clock.at)).toThrow('FEEDBACK_SOURCE_UNAVAILABLE');
    expect(h.values.overview('owner').active).toBeNull();
    h.clock.unknown=false;h.db.prepare('DELETE FROM conversation_messages WHERE scope_key=?').run('owner');
    h.values.nightly('owner',h.clock.at);
    expect(h.values.overview('owner').active).toMatchObject({feedbackSeq:2});
    expect(h.values.overview('owner').cells).toEqual(expected(null));
  });
});
