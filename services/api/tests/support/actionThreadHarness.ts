import { DatabaseSync } from 'node:sqlite';
import { SQLiteActionStore } from '../../src/mind/action/threads/store/actionStore.js';
import type { ActionThreads } from '../../src/contracts/actionThreadContract.js';
export function actionHarness(now:()=>string,path=':memory:') {
  const db=new DatabaseSync(path),store=new SQLiteActionStore(db);
  const actions:ActionThreads={
    enqueue:async draft=>store.enqueue(draft,now()),claim:async id=>store.claim(id,'test-runner',now()),
    renew:async(lease,progress)=>store.renew(lease,now(),progress),dispatch:async(lease,keys)=>store.dispatch(lease,now(),keys),
    finish:async(lease,state,code)=>store.finish(lease,state,code,now()),list:async scope=>store.list(scope),
    stop:async(scope,id,request)=>store.stop(scope,id,request,now()),resume:async(scope,id)=>store.resume(scope,id,now()),
    reconcile:async(lease,state,code)=>store.reconcile(lease,state,code,now()),checkpoint:async(lease,code,failureCode)=>store.checkpoint(lease,code,now(),failureCode),
    reserve:async(lease,id,day,yen,cap,spent)=>store.reserve(lease,id,day,yen,cap,spent,now()),settle:async(lease,id,yen)=>store.settle(lease,id,yen,now()),
  };
  return {db,store,actions,close:()=>db.close()};
}
