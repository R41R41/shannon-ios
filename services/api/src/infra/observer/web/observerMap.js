// Canonical processors remain individually inspectable; layout never creates an event.
export const NODE_SPECS = [
  ['pcm',0,0,'CLIENT / CONVERTER','PCM CONVERTER','マイク → 音声チャンク'],
  ['stt',1,0,'TRANSCRIPTION / MODEL','TRANSCRIPTION','音声 → 文字起こし'],
  ['join',2,0,'CLIENT / CONVERTER','UTTERANCE','発話結合・語彙正規化'],
  ['perception',3,0,'API / CONVERTER','PERCEPTION','知覚 → MindEvent'],
  ['turn',4,0,'API / RUN','TURN','実リクエストの範囲'],
  ['jevv',5,0,'JEV / VOICE ROUTER','JEV · VOICE','既存音声の返答・能力選択'],
  ['taskHub',0,1,'COMMON / TASK REGISTRY','TASK HUB','親子タスク・状態の記録'],
  ['queue',1,1,'COMMON / ADMISSION','ADMISSION','実行枠・leaseの受付'],
  ['fca',2,1,'COMMON / STEP','FCA STEP','同じエンジンで各taskを実行'],
  ['compact',3,1,'COMMON / CONVERTER','COMPACTION','作業履歴を圧縮'],
  ['wait',4,1,'COMMON / CHECKPOINT','WAIT STATE','待機状態の確定・待ち時間ではない'],
  ['workspace',5,1,'MIND / PROJECTION','WORKSPACE','共有の場・実行枠の投影'],
  ['recall',0,2,'SHARED / RETRIEVAL','RECALL','関連する記憶を想起'],
  ['context',1,2,'SHARED / CONVERTER','CONTEXT','知覚・想起・選択を統合'],
  ['jevt',1,3,'JEV / TOOL CHOOSER','JEV · TOOLS','道具・難易度の選択'],
  ['native',2,2,'SHARED / CONVERTER','MODEL I/O','Messages・道具定義へ変換'],
  ['llm',3,2,'PROVIDER / LLM','LLM','実モデル呼出・cache usage'],
  ['decode',4,2,'SHARED / CONVERTER','REPLY DECODER','構造化回答・検証'],
  ['gate',3,3,'SHARED / POLICY','TOOL GATE','許可・入力・実行条件'],
  ['tools',2,3,'EXECUTOR / EXPANDABLE','TOOL ▾','道具一覧・実行結果を開く'],
  ['store',4,3,'SHARED / STORE','RESULT STORE','会話・task結果の保存'],
  ['emotion',5,2,'SHARED / STATE','EMOTION','感情状態の投影・更新'],
  ['prediction',5,3,'SHARED / LEDGER','PREDICTION','観測できる予測・結果'],
  ['agentHost',4,6,'HOST / EXTERNAL','AGENT HOST','外部作業・内部は未計測'],
  ['sentences',0,4,'OUTPUT / CONVERTER','SENTENCE SPLIT','生成途中の文を取り出す'],
  ['plan',1,4,'OUTPUT / CONVERTER','VOICE PLAN','感情・読み方へ投影'],
  ['tts',2,4,'VOICE / TTS MODEL','TTS','文ごとの音声合成'],
  ['play',3,4,'CLIENT / AUDIO','PCM PLAYBACK','enqueue・完了報告／発音開始は未計測'],
  ['bodyObserve',0,5,'BODY / PERCEPTION','BODY OBSERVE','身体からの実観測'],
  ['reflex',1,5,'BODY / CONTROL','REFLEX','反射処理の範囲'],
  ['reflexJev',2,5,'JEV / REFLEX','JEV · REFLEX','反射の小モデル判断'],
  ['reflexDecision',3,5,'BODY / CHOICE','REFLEX DECISION','Decisions / Jev → 候補選択'],
  ['bodyControl',4,5,'BODY / ACK','BODY CONTROL','stop・execute・return応答'],
  ['minecraft',5,5,'BODY / EXTERNAL','MINECRAFT','外部の身体・内部は未計測'],
  ['memory',0,6,'SHARED / WRITER','MEMORY WRITER','返答後の記憶更新'],
  ['embedding',1,6,'SHARED / MODEL','EMBEDDING','想起用のベクトル更新'],
  ['sleep',2,6,'MAINTENANCE / WORKER','SLEEP / LEARN','共通FCAまたは既存の記憶整理'],
  ['autonomy',3,6,'LEGACY / WORKER','OWN-TIME','既存自律活動・FCA移行は別'],
];
export const LANES = ['INPUT / 入力・知覚', 'TASK / タスクの受付', 'FCA LOOP / 判断 ⇄ 道具', 'SHARED', 'OUTPUT / 返答・音声', 'BODY / 身体・反射', 'MEMORY / 記憶・外部経路'];
const CIRCUITS = {
  input:['pcm','stt','join','perception','bodyObserve'],
  judgment:['turn','fca','jevv','jevt','context','native','llm','reflexJev','reflexDecision'],
  action:['taskHub','queue','wait','workspace','gate','tools','autonomy','minecraft','agentHost','reflex','bodyControl'],
  output:['decode','plan','sentences','tts','play'],
  memory:['compact','recall','store','memory','sleep','embedding','emotion','prediction'],
};
export const circuitFor = node => Object.entries(CIRCUITS).find(([, nodes]) => nodes.includes(node))?.[0] ?? 'neutral';
// Structural routes are subdued; only received explicit handoffs become receipt paths.
export const LINKS = [
  ['pcm','stt'],['stt','join'],['join','perception'],['perception','taskHub'],['turn','context'],['perception','jevv'],['jevv','context'],
  ['taskHub','queue'],['queue','fca'],['fca','compact'],['compact','context'],['fca','recall'],['store','wait'],['workspace','context'],
  ['recall','context'],['context','native'],['context','jevt'],['jevt','context'],['jevt','native'],['native','llm'],['llm','decode'],['llm','gate'],['gate','tools'],['tools','native'],
  ['llm','store'],['tools','store'],['decode','store'],['decode','sentences'],['sentences','plan'],['plan','tts'],['tts','play'],['store','memory'],
  ['fca','reflex'],['fca','reflexJev'],['reflexJev','fca'],['reflex','reflexJev'],['reflexJev','reflex'],['bodyObserve','reflexDecision'],['reflexDecision','bodyControl'],['reflex','fca'],['bodyControl','minecraft',true],
  ['emotion','context',true],['prediction','memory',true],['memory','embedding',true],['embedding','recall',true],['fca','sleep',true],['tools','sleep',true],['autonomy','workspace',true],['agentHost','workspace',true],
];
export const ROUTES = {
  all:{label:'全体',nodes:null},
  task:{label:'共通FCA',nodes:['perception','taskHub','queue','fca','compact','recall','context','jevt','native','llm','gate','tools','decode','wait','store']},
  text:{label:'テキスト',nodes:['turn','perception','taskHub','queue','fca','recall','context','jevt','native','llm','decode','store']},
  touch:{label:'触れ合い',nodes:['reflex','reflexJev','bodyControl','taskHub','fca','emotion','prediction','memory']},
  voice:{label:'音声',nodes:['pcm','stt','join','perception','turn','jevv','taskHub','queue','fca','context','jevt','native','llm','decode','sentences','plan','tts','play']},
  tool:{label:'道具ループ',nodes:['fca','context','jevt','native','llm','gate','tools','decode','wait']},
  body:{label:'反射・Minecraft',nodes:['bodyObserve','reflex','reflexJev','reflexDecision','bodyControl','minecraft','taskHub','fca']},
  memory:{label:'睡眠・記憶',nodes:['fca','sleep','memory','embedding','recall','emotion','prediction','store']},
  legacy:{label:'既存経路',nodes:['turn','perception','jevv','jevt','context','native','llm','decode','autonomy','workspace','agentHost']},
};
export function routeIncludes(route, from, to) { const nodes = ROUTES[route]?.nodes; return !nodes || nodes.includes(from) && (!to || nodes.includes(to)); }
/** Adopted compact lanes; no prototype-only empty rows. Coordinates stay on the routing grid. */
export function mapLayout(width) {
  const canvasWidth = Math.max(1088, Math.ceil(width / 8) * 8), margin = 32, gap = 40;
  const nodeWidth = Math.floor((canvasWidth - margin * 2 - gap * 5) / 48) * 8, pitch = 144;
  const boxes = new Map(NODE_SPECS.map(([id,col,row]) => [id,{x:margin+col*(nodeWidth+gap),y:40+row*pitch,w:nodeWidth,h:96,row,col}]));
  const regions = [[0,0,6,1],[0,1,6,1],[0,2,5,2],[5,2,1,2],[0,4,6,1],[0,5,6,1],[0,6,6,1]];
  const zones = regions.map(([col,row,columns,rows],index) => ({
    x:margin+col*(nodeWidth+gap)-16,y:row*pitch+8,w:columns*nodeWidth+(columns-1)*gap+32,h:rows*pitch-8,label:LANES[index],
  }));
  return { width:canvasWidth,height:7*pitch+24,boxes,pitch,zones };
}

const CELL = 8, CLEARANCE = 8, STEM = 16;
const DIRECTIONS = [[1,0],[0,1],[-1,0],[0,-1]];
const NORMAL = { right:0, bottom:1, left:2, top:3 };
const LOOP_PORTS = { 'native>llm':['right','left'], 'llm>gate':['bottom','top'], 'gate>tools':['left','right'], 'tools>native':['top','bottom'] };
const MAIN_LINKS = new Set(['pcm>stt','stt>join','join>perception','perception>taskHub','taskHub>queue','queue>fca','fca>recall','recall>context','context>native','native>llm','llm>decode','llm>gate','gate>tools','tools>native','decode>sentences','sentences>plan','plan>tts','tts>play']);

class MinHeap {
  values = [];
  push(value) {
    let index = this.values.length; this.values.push(value);
    while (index) {
      const parent = (index - 1) >> 1;
      if (this.values[parent].score <= value.score) break;
      this.values[index] = this.values[parent]; index = parent;
    }
    this.values[index] = value;
  }
  pop() {
    const first = this.values[0], last = this.values.pop();
    if (this.values.length) {
      let index = 0;
      while (index * 2 + 1 < this.values.length) {
        let child = index * 2 + 1;
        if (child + 1 < this.values.length && this.values[child + 1].score < this.values[child].score) child += 1;
        if (this.values[child].score >= last.score) break;
        this.values[index] = this.values[child]; index = child;
      }
      this.values[index] = last;
    }
    return first;
  }
}

function connectorSides(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  return Math.abs(dx) > Math.abs(dy) * .8 ? dx >= 0 ? ['right','left'] : ['left','right'] : dy >= 0 ? ['bottom','top'] : ['top','bottom'];
}
const sideLength = (box, side) => side === 'top' || side === 'bottom' ? box.w : box.h;
function connectorPort(box, side, offset) {
  const point = side === 'top' ? [box.x+offset,box.y] : side === 'bottom' ? [box.x+offset,box.y+box.h] : side === 'left' ? [box.x,box.y+offset] : [box.x+box.w,box.y+offset];
  const direction = NORMAL[side], normal = DIRECTIONS[direction];
  return { point, outside:[point[0]+normal[0]*STEM,point[1]+normal[1]*STEM], direction };
}
function simplify(points) {
  const unique = points.filter((point,index) => !index || point[0] !== points[index-1][0] || point[1] !== points[index-1][1]);
  return unique.filter((point,index) => !index || index === unique.length-1 ||
    !((unique[index-1][0] === point[0] && point[0] === unique[index+1][0]) || (unique[index-1][1] === point[1] && point[1] === unique[index+1][1])));
}
export function roundedMapPath(points) {
  let path = `M${points[0].join(' ')}`;
  for (let index=1;index<points.length-1;index+=1) {
    const before=points[index-1],point=points[index],after=points[index+1];
    const incoming=Math.hypot(point[0]-before[0],point[1]-before[1]),outgoing=Math.hypot(after[0]-point[0],after[1]-point[1]);
    const radius=Math.min(6,incoming/2,outgoing/2);
    const a=point.map((value,axis)=>value+(before[axis]-value)*radius/incoming),b=point.map((value,axis)=>value+(after[axis]-value)*radius/outgoing);
    path+=` L${a.join(' ')} Q${point.join(' ')} ${b.join(' ')}`;
  }
  return `${path} L${points.at(-1).join(' ')}`;
}

/** Deterministic orthogonal A*: node clearance, distinct ports, and penalties for bends/shared strokes.
 * Dynamic observed handoffs receive the same obstacle checks without moving existing paths.
 * reset() discards dynamic paths/port reservations while preserving the public canonical geometry.
 */
export function createMapRouter(layout, links = LINKS) {
  const {boxes,width,height} = layout, columns = Math.ceil(width/CELL)+1, rows = Math.ceil(height/CELL)+1;
  const blocked = new Uint8Array(columns*rows);
  for (const box of boxes.values()) for (let y=(box.y-CLEARANCE)/CELL;y<=(box.y+box.h+CLEARANCE)/CELL;y+=1)
    for (let x=(box.x-CLEARANCE)/CELL;x<=(box.x+box.w+CLEARANCE)/CELL;x+=1) blocked[y*columns+x]=1;
  let occupied = new Set(), ports = new Map(), routes = new Map();
  const edgeKey = (a,b) => a < b ? `${a}:${b}` : `${b}:${a}`;
  const reserve = (id,side,offset) => {
    const key = `${id}:${side}`;
    if (!ports.has(key)) ports.set(key,new Set()); ports.get(key).add(offset);
    return connectorPort(boxes.get(id),side,offset);
  };
  const available = (id,side) => {
    const slots=[],used=ports.get(`${id}:${side}`),length=sideLength(boxes.get(id),side);
    for(let value=16;value<=length-16;value+=CELL) if(!used?.has(value)) slots.push(value);
    return slots;
  };
  const requests = links.map(([from,to]) => ({from,to,key:`${from}>${to}`,sides:LOOP_PORTS[`${from}>${to}`]??connectorSides(boxes.get(from),boxes.get(to))}));
  const groups = new Map();
  for (const request of requests) for (const [id,side,field] of [[request.from,request.sides[0],'start'],[request.to,request.sides[1],'end']]) {
    if(LOOP_PORTS[request.key]) { request[field]=reserve(id,side,Math.round(sideLength(boxes.get(id),side)/CELL/2)*CELL); continue; }
    const key=`${id}:${side}`;if(!groups.has(key)) groups.set(key,[]);groups.get(key).push({request,field,id,side});
  }
  for (const list of groups.values()) {
    const {id,side}=list[0],horizontal=side==='top'||side==='bottom',slots=available(id,side);
    list.sort((a,b)=>{
      const first=boxes.get(a.field==='start'?a.request.to:a.request.from),second=boxes.get(b.field==='start'?b.request.to:b.request.from);
      return (horizontal?first.x-second.x:first.y-second.y)||a.request.key.localeCompare(b.request.key);
    });
    if(list.length>slots.length) throw new Error('OBSERVER_PORT_CAPACITY');
    list.forEach((item,index)=>{const slot=slots[Math.floor((index+1)*(slots.length+1)/(list.length+1))-1];item.request[item.field]=reserve(id,side,slot);});
  }

  function search(start,end) {
    const sx=start.outside[0]/CELL,sy=start.outside[1]/CELL,tx=end.outside[0]/CELL,ty=end.outside[1]/CELL;
    const startCell=sy*columns+sx,targetCell=ty*columns+tx;
    if(blocked[startCell]||blocked[targetCell]) return null;
    const costs=new Float64Array(columns*rows*4).fill(Infinity),previous=new Int32Array(costs.length).fill(-1),heap=new MinHeap();
    const initial=startCell*4+start.direction;costs[initial]=0;
    heap.push({key:initial,x:sx,y:sy,direction:start.direction,cost:0,score:Math.abs(tx-sx)+Math.abs(ty-sy)});
    let final=-1;
    while(heap.values.length) {
      const current=heap.pop(); if(current.cost!==costs[current.key]) continue;
      if(current.x===tx&&current.y===ty) {final=current.key;break;}
      for(let direction=0;direction<4;direction+=1) {
        const x=current.x+DIRECTIONS[direction][0],y=current.y+DIRECTIONS[direction][1],cell=y*columns+x;
        if(x<1||x>=columns-1||y<1||y>=rows-1||blocked[cell]) continue;
        const key=cell*4+direction,edge=edgeKey(current.y*columns+current.x,cell);
        const cost=current.cost+1+(direction===current.direction?0:3)+(occupied.has(edge)?8:0);
        if(cost>=costs[key]) continue;
        costs[key]=cost;previous[key]=current.key;
        heap.push({key,x,y,direction,cost,score:cost+Math.abs(tx-x)+Math.abs(ty-y)});
      }
    }
    if(final<0) return null;
    const path=[];
    for(let key=final;key>=0;key=previous[key]) {const cell=Math.floor(key/4);path.push([cell%columns*CELL,Math.floor(cell/columns)*CELL]);}
    return path.reverse();
  }
  function draw(request) {
    const grid=search(request.start,request.end);if(!grid) return null;
    const points=simplify([request.start.point,...grid,request.end.point]);
    for(let index=1;index<grid.length;index+=1) occupied.add(edgeKey(grid[index-1][1]/CELL*columns+grid[index-1][0]/CELL,grid[index][1]/CELL*columns+grid[index][0]/CELL));
    const route={points,path:roundedMapPath(points)};routes.set(request.key,route);return route;
  }
  const ordered=[...requests].sort((a,b)=>Number(MAIN_LINKS.has(b.key))-Number(MAIN_LINKS.has(a.key)));
  for(const request of ordered) if(!draw(request)) throw new Error(`OBSERVER_ROUTE_UNAVAILABLE:${request.key}`);
  const canonicalRoutes=new Map(routes),canonicalOccupied=new Set(occupied),canonicalPorts=new Map([...ports].map(([key,value])=>[key,new Set(value)]));
  return {
    route(from,to) {
      const key=`${from}>${to}`;if(routes.has(key)) return routes.get(key);
      if(!boxes.has(from)||!boxes.has(to)||from===to) return null;
      const sides=connectorSides(boxes.get(from),boxes.get(to)),request={from,to,key},reserved=[];
      const release=()=>{for(const [id,side,offset] of reserved) ports.get(`${id}:${side}`)?.delete(offset);};
      for(const [id,preferred,field] of [[from,sides[0],'start'],[to,sides[1],'end']]) {
        const candidates=[preferred,...Object.keys(NORMAL).filter(side=>side!==preferred)];
        const side=candidates.find(value=>available(id,value).length);if(!side) {release();return null;}
        const slots=available(id,side),offset=slots[Math.floor(slots.length/2)];
        request[field]=reserve(id,side,offset);reserved.push([id,side,offset]);
      }
      const result=draw(request);if(!result) release();return result;
    },
    reset() { routes=new Map(canonicalRoutes);occupied=new Set(canonicalOccupied);ports=new Map([...canonicalPorts].map(([key,value])=>[key,new Set(value)])); },
  };
}
