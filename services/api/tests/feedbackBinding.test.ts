import { afterEach, describe, expect, it } from 'vitest';
import { createLocalApiKernel } from '../src/wiring/apiKernelWiring.js';
import { configuredTurnRouting } from '../src/wiring/turnRoutingWiring.js';
import { createFeedbackWiring } from '../src/wiring/feedbackWiring.js';
import type { ShannonChatModel, ShannonChatModelRequest, ShannonVoiceModelRequest } from '../src/infra/models/chatModel.js';
import { feedbackHarness } from './support/feedbackHarness.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createFeedbackRoute } from '../src/infra/http/feedbackRoutes.js';
import { readJson, sendJson } from '../src/infra/http/serverHttp.js';
import { placeReply, type ShannonPlace } from '../src/integrations/places/placeDiscovery.js';
let h:ReturnType<typeof feedbackHarness>;
afterEach(()=>h?.close());
class LocalToolModel implements ShannonChatModel {
  readonly mode='openai' as const;readonly model='synthetic-no-network';calls=0;
  constructor(readonly withPlaces=false){}
  async generate(request:ShannonChatModelRequest){return this.answer(request);}
  async generateVoice(request:ShannonVoiceModelRequest){return this.answer(request);}
  private async answer(request:ShannonChatModelRequest|ShannonVoiceModelRequest){
    if(this.withPlaces && 'placeSearch' in request && request.placeSearch) return {mode:this.mode,model:this.model,reply:'候補を確かめました。',
      places:[{name:'[架空]の公園',address:'架空市の広場',reason:'合成確認用',mapQuery:'架空の公園',mapUrl:'https://maps.apple.com/?q=synthetic'}]};
    if(request.tools?.definitions.some(tool=>tool.name==='study.list')){
      expect(JSON.parse(await request.tools.call('study_list','{}')).ok).toBe(true);this.calls++;
    }
    return {mode:this.mode,model:this.model,reply:'書斎を確かめました。'};
  }
}
function kernel(deferred=false,enabled=true,withPlaces=false) {
  h=feedbackHarness();const queued:Array<()=>void>=[];
  const wiring=createFeedbackWiring({enabled,database:h.db,ownerScopeKey:'owner',now:()=>h.clock.at,ownerAlone:()=>h.clock.alone,source:h.source,toolEvidence:h.toolEvidence,
    defer:deferred?task=>queued.push(task):task=>task()});
  const routing=configuredTurnRouting({SHANNON_ADR8_STAGE2:'on',SHANNON_CONVERSATION_REWARD:'on',SHANNON_DIFFICULTY:'off',SHANNON_TURN_VERIFY:'off'},
    {databasePath:null,choices:h.choices,feedback:wiring?.ports,defer:task=>task()})!;
  const model=new LocalToolModel(withPlaces);
  const api=createLocalApiKernel(()=>h.clock.at,{stateStore:h.store,conversationStore:h.store,knowledgeStore:h.store,chatModel:model,
    turnChooser:{choose:async()=>({menu:{chosen:['study_list']}})},turnRouting:routing.routing,...(wiring?{feedback:wiring.ports}:{})});
  return {api,model,queued,flush(){while(queued.length)queued.shift()!();}};
}
describe('persisted tool reply feedback binding through real API turns',()=>{
  it('links the actual saved text turn and its trace, without blocking the completed response on metadata',async()=>{
    const {api,model,flush}=kernel(true);
    const reply=await api.dispatch({method:'POST',path:'/v1/chat',body:{scopeKey:'owner',threadId:'talk',message:'書斎に何がある？'}});
    expect(reply.status).toBe(200);expect(model.calls).toBe(1);
    expect(reply.body).not.toHaveProperty('feedback');
    const turnId=(reply.body as {turnId:string}).turnId;
    expect(h.feedback.project('owner','talk',turnId)).toBeNull();flush();
    expect(h.feedback.project('owner','talk',turnId)).toMatchObject({turnId,revision:0,reaction:null});
    expect(h.store.toolTraces('owner','talk',{turnIds:[turnId]})[0]?.calls).toMatchObject([{tool:'study.list',ok:true}]);
    await api.waitForBackground('owner');
    const history=await api.dispatch({method:'GET',path:'/v1/conversation',query:new URLSearchParams({scopeKey:'owner',threadId:'talk'})});
    // The exact persisted source remains resolvable even outside a UI display window.
    expect((history.body as {messages:unknown[]}).messages).toHaveLength(2);
    expect((history.body as {messages:Array<{role:string;feedback?:unknown}>}).messages.find(message=>message.role==='assistant')).toHaveProperty('feedback.turnId',turnId);
  });
  it('binds a voice delegation only to its exact persisted spoken reply, never a forged or reused client record',async()=>{
    const {api,model}=kernel();
    const delegation=await api.dispatch({method:'POST',path:'/v1/voice/gemini/cascade/delegations',body:{scopeKey:'owner',threadId:'talk',transcript:'書斎に何がある？'}});
    expect(delegation.status).toBe(200);expect(model.calls).toBe(1);
    const body=delegation.body as {reply:string;feedbackRecordId:string};expect(body.feedbackRecordId).toBeTypeOf('string');
    const submit=(shannonTranscript:string,feedbackRecordId=body.feedbackRecordId)=>api.dispatch({method:'POST',path:'/v1/voice/gemini/cascade/turns',body:{scopeKey:'owner',threadId:'talk',userTranscript:'書斎に何がある？',shannonTranscript,feedbackRecordId}});
    const saved=await submit(body.reply);expect(saved.status).toBe(201);
    const turnId=(saved.body as {turnId:string}).turnId;
    expect(h.feedback.project('owner','talk',turnId)).toMatchObject({turnId});
    const forged=await submit('返答を差し替えた。');expect(forged.body).not.toHaveProperty('feedback');
    const reused=await submit(body.reply);expect(h.feedback.project('owner','talk',(reused.body as {turnId:string}).turnId)).toBeNull();
    await api.waitForBackground('owner');
  });
  it('keeps Stage5 OFF responses and casual/no-tool replies without feedback targets',async()=>{
    const {api}=kernel(false,false);
    const response=await api.dispatch({method:'POST',path:'/v1/chat',body:{scopeKey:'owner',threadId:'talk',message:'こんにちは'}});
    expect(response.status).toBe(200);expect(response.body).not.toHaveProperty('feedback');
    expect(h.feedback.store.targets('owner')).toEqual([]);
    await api.waitForBackground('owner');
  });
  it('binds the exact saved voice reply with server map links and rejects altered or omitted links',async()=>{
    const {api,model}=kernel(false,true,true);
    const delegate=()=>api.dispatch({method:'POST',path:'/v1/voice/gemini/cascade/delegations',body:{scopeKey:'owner',threadId:'talk',transcript:'公園を探して。書斎も確かめて。'}});
    const delegation=await delegate();
    expect(delegation.status).toBe(200);expect(model.calls).toBe(1);
    const body=delegation.body as {reply:string;feedbackRecordId:string;uiBlocks:Array<{places:ShannonPlace[]}>};
    expect(body.reply).not.toContain('maps.apple.com');expect(body.feedbackRecordId).toBeTypeOf('string');
    const displayed=placeReply(body.reply,body.uiBlocks.flatMap(block=>block.places??[]));
    expect(displayed).toContain('- [ 架空 の公園](https://maps.apple.com/');
    const submit=(shannonTranscript:string,feedbackRecordId=body.feedbackRecordId)=>api.dispatch({method:'POST',path:'/v1/voice/gemini/cascade/turns',body:{scopeKey:'owner',threadId:'talk',userTranscript:'公園を探して。書斎も確かめて。',shannonTranscript,feedbackRecordId}});
    const saved=await submit(displayed);expect(saved.status).toBe(201);
    const turnId=(saved.body as {turnId:string}).turnId;
    expect(h.feedback.project('owner','talk',turnId)).toMatchObject({turnId,revision:0});
    expect(h.source('owner','talk',turnId)?.replyDigest).toBe(h.feedback.store.draft('owner',body.feedbackRecordId)?.replyDigest);
    for(const forged of [body.reply,displayed.replace('架空市の広場','別の所在地')]){
      const fresh=(await delegate()).body as {feedbackRecordId:string};
      const result=await submit(forged,fresh.feedbackRecordId);expect(result.status).toBe(201);
      expect(h.feedback.project('owner','talk',(result.body as {turnId:string}).turnId)).toBeNull();
    }
    await api.waitForBackground('owner');
  });
  it('round-trips a genuine tool reply through HTTP chat, projected history and the owner reaction route',async()=>{
    const {api,flush}=kernel(true),route=createFeedbackRoute({feedback:h.feedback,ownerScopeKey:'owner',ownerAlone:scope=>api.ownerAloneForFeedback(scope)});
    const server=createServer((request,response)=>{void(async()=>{
      const url=new URL(request.url??'/','http://localhost');
      if(url.pathname==='/v1/feedback')return route(request,response,{scopeKey:'owner'});
      const body=request.method==='POST'?{...await readJson(request,4096) as object,scopeKey:'owner'}:undefined;
      url.searchParams.set('scopeKey','owner');const result=await api.dispatch({method:request.method==='POST'?'POST':'GET',path:url.pathname,query:url.searchParams,...(body?{body}:{})});
      sendJson(response,result.status,result.body);
    })();});
    await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const chat=await fetch(`${base}/v1/chat`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({threadId:'talk',message:'書斎に何がある？'})});expect(chat.status).toBe(200);
      const answered=await chat.json() as {turnId:string};flush();
      const history=await(await fetch(`${base}/v1/conversation?threadId=talk`)).json() as {messages:Array<{role:string;feedback?:{targetId:string;turnId:string}}>};
      const target=history.messages.find(message=>message.role==='assistant')!.feedback!;expect(target.turnId).toBe(answered.turnId);
      const selected=await fetch(`${base}/v1/feedback`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({targetId:target.targetId,threadId:'talk',expectedRevision:0,operationId:'http-owner-choice',reaction:'good'})});expect(selected.status).toBe(200);
      expect(await selected.json()).toMatchObject({feedback:{revision:1,reaction:'good',turnId:answered.turnId}});
      const state=await(await fetch(`${base}/v1/feedback?threadId=talk&targetId=${target.targetId}&operationId=http-owner-choice`)).json();
      expect(state).toMatchObject({feedback:{revision:1},operation:{revision:1,operationId:'http-owner-choice'}});
    } finally {await api.waitForBackground('owner');await new Promise<void>(done=>server.close(()=>done()));}
  });
});
