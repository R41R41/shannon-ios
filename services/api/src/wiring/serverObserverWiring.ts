import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ShannonApiKernel } from '../infra/http/apiKernel.js';
import type { ShannonDevicePrincipal } from '../infra/auth/deviceAuth.js';
import { startObserverPublisher } from '../infra/observer/store/observerStore.js';
import { createObserverRoute, serveObserverAsset } from '../infra/observer/observerRoutes.js';
import { withObserverRun } from '../infra/observer/observerContext.js';
import { startEventLoopDelayWatch, startEventLoopWatch, startGcWatch } from '../infra/observer/eventLoopWatch.js';
export function configuredServerObserver(path:string,kernel:ShannonApiKernel,ownerScope:string,isGame:(principal:ShannonDevicePrincipal)=>boolean){
  const publisher=startObserverPublisher(path);
  const stopLoop=startEventLoopWatch('api'); // A blocked loop is named in journald even after the observer ring has moved on.
  const stopGc=startGcWatch('api'); // mb-llmc r7: and a collection that held it, so that a block with no other name can be told.
  const stopDelay=startEventLoopDelayWatch('api'); // mb-llmc r8: and a delay of 100 ms or more, with the named work that overlapped it (`during=`).
  const stopWatch=()=>[stopLoop,stopGc,stopDelay].forEach(stop=>stop());
  return {asset:serveObserverAsset,route:createObserverRoute({store:publisher?.store??null,ownerScope,ownerAlone:()=>kernel.ownerAloneForFeedback(ownerScope),isGame}),
    speech:<T>(principal:ShannonDevicePrincipal|null,work:()=>Promise<T>,runHeader?:string|string[])=>principal?withObserverRun({scopeKey:principal.scopeKey,surface:'tts',audience:kernel.ownerAloneForFeedback(principal.scopeKey)?'owner':'others',...(typeof runHeader==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runHeader)?{runId:runHeader}:{})},work):work(),
    close:()=>{
      stopWatch();
      publisher?.close();
    }};
}
