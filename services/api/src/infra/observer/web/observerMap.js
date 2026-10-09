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
  ['jevt',2,2,'JEV / TOOL CHOOSER','JEV · TOOLS','道具・難易度の選択'],
  ['native',3,2,'SHARED / CONVERTER','MODEL I/O','Messages・道具定義へ変換'],
  ['llm',4,2,'PROVIDER / LLM','LLM','実モデル呼出・cache usage'],
  ['decode',5,2,'SHARED / CONVERTER','REPLY DECODER','構造化回答・検証'],
  ['gate',0,3,'SHARED / POLICY','TOOL GATE','許可・入力・実行条件'],
  ['tools',1,3,'EXECUTOR / EXPANDABLE','TOOL ▾','道具一覧・実行結果を開く'],
  ['store',2,3,'SHARED / STORE','RESULT STORE','会話・task結果の保存'],
  ['emotion',3,3,'SHARED / STATE','EMOTION','感情状態の投影・更新'],
  ['prediction',4,3,'SHARED / LEDGER','PREDICTION','観測できる予測・結果'],
  ['agentHost',5,3,'HOST / EXTERNAL','AGENT HOST','外部作業・内部は未計測'],
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
export const LANES = ['01 / INPUT · 既存音声入口', '02 / COMMON FCA · タスクの受付と実行', '03 / SHARED LOOP · 想起・変換・Jev・LLM', '04 / ACTION · 道具・記録・共有状態', '05 / VOICE OUTPUT · 発音開始は未計測', '06 / BODY · 反射・Minecraft', '07 / MEMORY · 睡眠・既存BACKGROUND'];
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
export function mapLayout(width) {
  const canvasWidth = Math.max(1080, width), margin = 36, gap = 40, nodeWidth = (canvasWidth - margin * 2 - gap * 5) / 6, pitch = 164;
  const boxes = new Map(NODE_SPECS.map(([id,col,row]) => [id,{x:margin+col*(nodeWidth+gap),y:44+row*pitch,w:nodeWidth,h:112,row,col}]));
  return { width:canvasWidth,height:LANES.length*pitch+16,boxes,pitch };
}
