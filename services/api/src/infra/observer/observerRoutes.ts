import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import type { ShannonDevicePrincipal } from '../auth/deviceAuth.js';
import { sendJson } from '../http/serverHttp.js';
import type { SQLiteObserverStore } from './store/observerStore.js';
import { observerCatalog } from './observerCatalog.js';
import { ingestObserverClientEvents } from './observerClientEvents.js';

const assets=new Map<string,{file:string;type:string}>([['/observer',{file:'index.html',type:'text/html; charset=utf-8'}],['/observer/',{file:'index.html',type:'text/html; charset=utf-8'}],['/observer/observer.css',{file:'observer.css',type:'text/css; charset=utf-8'}],['/observer/observer.js',{file:'observer.js',type:'text/javascript; charset=utf-8'}]]);
export function serveObserverAsset(request:IncomingMessage,response:ServerResponse,path:string):boolean {
  const asset=assets.get(path);if(!asset)return false;
  response.setHeader('Cache-Control','no-store');response.setHeader('X-Content-Type-Options','nosniff');response.setHeader('Referrer-Policy','no-referrer');
  response.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if(request.method!=='GET'){sendJson(response,405,{error:'METHOD_NOT_ALLOWED'});return true;}
  if(path==='/observer/'){response.writeHead(308,{Location:'../observer','Cache-Control':'no-store'});response.end();return true;}
  try{const content=readFileSync(new URL(`./web/${asset.file}`,import.meta.url));response.writeHead(200,{'Content-Type':asset.type});response.end(content);}catch{sendJson(response,503,{error:'OBSERVER_ASSET_UNAVAILABLE'});}return true;
}
export function createObserverRoute(options:{store:SQLiteObserverStore|null;ownerScope:string;ownerAlone:()=>boolean;isGame:(principal:ShannonDevicePrincipal)=>boolean}) {
  const reads=new Map<string,{since:number;count:number}>();
  return async(request:IncomingMessage,response:ServerResponse,path:string,principal:ShannonDevicePrincipal|null,url:URL):Promise<void>=>{
    response.setHeader('Cache-Control','no-store');response.setHeader('X-Content-Type-Options','nosniff');
    if(!principal||principal.scopeKey!==options.ownerScope||options.isGame(principal)){sendJson(response,403,{error:'OBSERVER_OWNER_ONLY'});return;}
    if(request.method!=='GET'&&!(path==='/v1/observer/client-events'&&request.method==='POST')){sendJson(response,405,{error:'METHOD_NOT_ALLOWED'});return;}
    if(!options.store){sendJson(response,503,{error:'OBSERVER_UNAVAILABLE'});return;}
    const now=Date.now();for(const [key,value]of reads)if(value.since+60_000<now)reads.delete(key);
    const budget=reads.get(principal.deviceId)??{since:now,count:0};reads.set(principal.deviceId,budget);if(++budget.count>300){sendJson(response,429,{error:'OBSERVER_RATE_LIMITED'});return;}
    const alone=()=>{try{return url.searchParams.get('audience')!=='others'&&options.ownerAlone()===true;}catch{return false;}};
    if(!alone()){sendJson(response,200,options.store.held());return;}
    if(path==='/v1/observer/client-events'){await ingestObserverClientEvents(request,response,principal,options.store,alone);return;}
    if(path==='/v1/observer/catalog'){const catalog=observerCatalog();sendJson(response,200,alone()?catalog:options.store.held());return;}
    if(path!=='/v1/observer/events'){sendJson(response,404,{error:'NOT_FOUND'});return;}
    const after=Number(url.searchParams.get('after')??0),limit=Number(url.searchParams.get('limit')??200);
    if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>200){sendJson(response,400,{error:'INVALID_OBSERVER_CURSOR'});return;}
    try{const batch=options.store.read(principal.scopeKey,after,limit);sendJson(response,200,alone()?batch:options.store.held());}catch{sendJson(response,503,{error:'OBSERVER_UNAVAILABLE'});}
  };
}
