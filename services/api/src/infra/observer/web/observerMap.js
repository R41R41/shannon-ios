// The owner's view of the current architecture (owner choice 2026-10-13: per-turn timeline first, zoomable layered map second).
// View nodes are a projection of contract nodes and their observed payloads. Layout and classification never create an event.

/** Blocks are processes or subsystems: [id, label, process, role]. Order is the timeline lane order. */
export const BLOCKS = [
  ['client', '端末で聞く', 'iPhone・Mac（端末の報告）', 'input'],
  ['conv', '会話の経路', 'api', 'judgment'],
  ['fca', '共通 FCA の実行', 'api・worker', 'action'],
  ['voice', '声の出力', 'api → 端末', 'output'],
  ['mind', '心の後処理', 'mind・worker', 'memory'],
  ['own', '自分の時間', 'autonomy worker', 'own'],
  ['db', '共有 SQLite', '全プロセスが読み書き', 'store'],
  ['world', '外の体と反射', 'world・agent-host（今はまれ）', 'own'],
];

/** [id, block, col, row, label, role, contract nodes that can project here]. Display-only nodes list no contract node. */
export const VIEW_NODES = [
  ['pcm', 'client', 0, 0, '録音', 'マイク → 音声の塊', ['pcm']],
  ['stt', 'client', 0, 1, '文字起こし', '声 → 文字', ['stt']],
  ['join', 'client', 0, 2, '発話の結合', '切れた発話をつなぐ', ['join']],
  ['sentences', 'voice', 0, 3, '文に分ける', '生成途中から文を取る', ['sentences']],
  ['plan', 'voice', 0, 4, '声の計画', '感情・読み方へ', ['plan']],
  ['tts', 'voice', 0, 5, '音声合成', '文ごとに声へ', ['tts']],
  ['play', 'voice', 0, 6, '再生（端末）', '端末で鳴らす', ['play']],
  ['admit', 'conv', 1, 0, '受付', '一回の run を開く', ['turn']],
  ['base', 'conv', 2, 0, '記憶の土台', '状態・人・決定的文脈', ['recall']],
  ['perception', 'conv', 3, 0, '知覚', '入力 → 心の出来事', ['perception']],
  ['router', 'conv', 1, 1, 'Jev ルーター', '道具メニュー・難しさ', ['jevt', 'jevv']],
  ['recall', 'conv', 2, 1, '意味で想起', '埋め込み → Jev 並べ替え', ['recall']],
  ['identity', 'conv', 3, 1, '自己とできること', '相手と能力（段の時間）', []],
  ['jevModel', 'conv', 1, 2, 'Jev 呼び出し', '小さなモデルの判断', ['llm']],
  ['context', 'conv', 2, 2, '文脈を組む', '材料を一つの依頼に', ['context']],
  ['taskHub', 'conv', 3, 2, '会話タスク', 'task 台帳（FCA と共通）', ['taskHub']],
  ['decode', 'conv', 2, 3, '返事を読む', '構造を確かめる', ['decode']],
  ['fcaTool', 'conv', 3, 3, 'FCA 道具選択', 'Jev が渡す道具を絞る', ['jevt']],
  ['store', 'conv', 1, 4, '保存', '会話・結果を書く', ['store']],
  ['native', 'conv', 2, 4, 'モデル入力', 'Messages・道具定義へ', ['native']],
  ['haiku', 'conv', 3, 4, 'Haiku 道具ループ', '返事か道具かを決める', ['llm']],
  ['queue', 'fca', 4, 2, '実行枠', '種類ごとの上限で受付', ['queue']],
  ['fca', 'fca', 5, 2, 'FCA step', '同じエンジンで一歩', ['fca']],
  ['gate', 'fca', 4, 3, '道具の関門', '許可・入力・条件', ['gate']],
  ['compact', 'fca', 5, 3, '履歴の圧縮', '作業履歴を短く', ['compact']],
  ['tools', 'fca', 4, 4, '道具の実行', '道具を動かす', ['tools']],
  ['wait', 'fca', 5, 4, '待機', '待つ状態の記録', ['wait']],
  ['memory', 'mind', 1, 5, '記憶を書く', '返事の後に更新', ['memory']],
  ['embedding', 'mind', 2, 5, 'ベクトル化', '想起用の埋め込み', ['embedding']],
  ['sleep', 'mind', 3, 5, '睡眠・整理', '記憶をまとめる', ['sleep']],
  ['emotion', 'mind', 1, 6, '感情', '結果から気分へ', ['emotion']],
  ['prediction', 'mind', 2, 6, '予測', '予測と結果', ['prediction']],
  ['workspace', 'mind', 3, 6, '共有の場', '実行枠の投影', ['workspace']],
  ['autonomy', 'own', 4, 5, '自分の時間', '小さな一歩ずつ', ['autonomy']],
  ['executive', 'own', 5, 5, 'Executive', '作ってあるが停止中', []],
  ['sqlite', 'db', 4, 6, '共有 SQLite', '会話・記憶・タスク・台帳', [], 2],
  ['bodyObserve', 'world', 0, 7, '体の観測', '身体からの実観測', ['bodyObserve']],
  ['reflex', 'world', 1, 7, '反射', '反射処理の範囲', ['reflex']],
  ['reflexJev', 'world', 2, 7, '反射の判断', 'Jev の小さな判断', ['reflexJev']],
  ['reflexDecision', 'world', 3, 7, '反射の選択', '候補から選ぶ', ['reflexDecision']],
  ['bodyControl', 'world', 0, 8, '体の制御', 'stop・execute の応答', ['bodyControl']],
  ['minecraft', 'world', 1, 8, 'Minecraft', '外部・中は未計測', ['minecraft']],
  ['agentHost', 'world', 2, 8, 'Mac Agent Host', '外部・中は未計測', ['agentHost']],
];

/** Structural routes of the current architecture: [from, to, background]. Only received handoffs move. */
export const VIEW_LINKS = [
  ['pcm', 'stt'], ['stt', 'join'], ['join', 'admit'], ['admit', 'base'], ['admit', 'perception'],
  ['base', 'router'], ['base', 'recall'], ['base', 'identity'], ['router', 'context'], ['recall', 'context'], ['identity', 'context'],
  ['router', 'jevModel', true], ['recall', 'jevModel', true], ['perception', 'context', true],
  ['context', 'taskHub'], ['taskHub', 'fcaTool'], ['fcaTool', 'native'], ['native', 'haiku'],
  ['haiku', 'gate'], ['gate', 'tools'], ['tools', 'haiku'], ['haiku', 'decode'], ['decode', 'store'], ['decode', 'sentences'],
  ['sentences', 'plan'], ['plan', 'tts'], ['tts', 'play'],
  ['taskHub', 'queue'], ['queue', 'fca'], ['fca', 'gate'], ['fca', 'compact'], ['fca', 'wait'], ['fca', 'recall', true],
  ['store', 'memory'], ['memory', 'embedding'], ['embedding', 'recall', true], ['sleep', 'memory', true], ['emotion', 'prediction', true],
  ['store', 'sqlite', true], ['autonomy', 'queue'], ['executive', 'autonomy', true],
  ['bodyObserve', 'reflexDecision'], ['reflex', 'reflexJev'], ['reflexDecision', 'bodyControl'], ['bodyControl', 'minecraft'],
];

export const ROLES = ['input', 'judgment', 'action', 'output', 'memory', 'own', 'store'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** One contract node can mean different current processors; only explicit payload fields decide which. */
export function viewNodeOf(node, input, output) {
  const value = record(input) ? input : {}, result = record(output) ? output : {};
  const phase = typeof value.phase === 'string' ? value.phase : typeof result.phase === 'string' ? result.phase : '';
  switch (node) {
    case 'turn': return 'admit';
    case 'jevv': return 'router';
    case 'jevt': {
      const selector = typeof value.selector === 'string' ? value.selector : typeof result.selector === 'string' ? result.selector : '';
      if (selector === 'fca' || phase.startsWith('fca_selection')) return 'fcaTool';
      if (selector.startsWith('reflex')) return 'reflexJev';
      return 'router';
    }
    case 'llm': {
      const provider = typeof value.provider === 'string' ? value.provider : typeof result.provider === 'string' ? result.provider : '';
      return provider === 'jev' || provider === 'openai_decisions' ? 'jevModel' : 'haiku';
    }
    case 'recall': {
      const semantic = value.semantic === true || value.strategy === 'semantic' || ['task_semantic', 'decision_packet', 'start'].includes(phase);
      if (semantic) return 'recall';
      if (value.strategy === 'deterministic' || phase === 'task_deterministic' || Object.hasOwn(value, 'message')) return 'base';
      return 'recall';
    }
    default: return VIEW_INDEX.has(node) ? node : null;
  }
}
/** A handoff names contract endpoints; its single payload classifies both ends. */
export function viewHandoff(event) {
  const payload = record(event.output) ? event.output : record(event.input) ? event.input : {};
  return [viewNodeOf(event.fromNode, payload, payload), viewNodeOf(event.toNode, payload, payload)];
}
export const VIEW_INDEX = new Map(VIEW_NODES.map(spec => [spec[0], spec]));
export const BLOCK_INDEX = new Map(BLOCKS.map(spec => [spec[0], spec]));
export const roleOf = id => BLOCK_INDEX.get(VIEW_INDEX.get(id)?.[1])?.[3] ?? 'own';

/* ---------- 目指す姿 (Syzygy ADR-0009) — dummy data only, never an observed event ---------- */
export const TARGET_BLOCKS = [
  ['trig', 'きっかけ', '時刻・目標・反応・体', 'input'],
  ['exec', '中枢 Executive', '何をするかは一か所で決める', 'judgment'],
  ['cat', '能力カタログ', 'すべての行動を能力として持つ', 'judgment'],
  ['run', '実行系（一つ）', 'FCA task・リースは一層', 'action'],
  ['learn', '学習', '証拠 → 報酬 → 価値', 'memory'],
  ['ext', '外の体と書き場', 'world・agent・Aether', 'own'],
  ['conv', '会話の速い道', 'api・いつも最優先', 'output'],
  ['db', '共有 SQLite', '台帳・価値表・目標・タスク', 'store'],
];
/** [id, block, col, row, label, role, input fields, output fields]; fields are "意味 key=value; …" dummy values. */
export const TARGET_NODES = [
  ['tTime', 'trig', 0, 0, '時刻・休みの終わり', '休むと決めた時間が来た', '休み rest=40分', 'きっかけ trigger=time'],
  ['tGoal', 'trig', 0, 1, '見直し日の目標', '見直しの日が来た', '目標 goals=2', 'きっかけ trigger=review'],
  ['tOwner', 'trig', 0, 2, '所有者の反応', '返事・ボタン・作品', '種類 kind=reaction', '値 value=+1'],
  ['tBody', 'trig', 0, 3, '体の観測', '在席・画面・他の人', '在席 ownerAway=true', 'きっかけ trigger=body'],
  ['candidates', 'exec', 1, 0, '候補を出す', '目標×能力×休む・やめる', '目標 goals=3; 能力 capabilities=9', '候補 candidates=7; 手応え facts=7行'],
  ['executive', 'exec', 2, 0, 'Executive', '一回選ぶ・理由を一行', '候補 candidates=7; 予算 budget=71%', '選択 choice=research; 理由 reason=1行'],
  ['budget', 'exec', 3, 0, '一つの予算', '会話も自分の時間も同じ', '今日 used=29%', '残り remaining=71%'],
  ['capCreate', 'cat', 1, 1, '創作', '物語・詩を書く', '前提 ready=true', '費用 cost=中'],
  ['capResearch', 'cat', 2, 1, '読む・調べる', '公開の資料を読む', '前提 ready=true', '費用 cost=小'],
  ['capAether', 'cat', 3, 1, 'Aether に書く', 'シャノン用フォルダ', '前提 ready=true', '外への作用 effect=なし'],
  ['capNotify', 'cat', 1, 2, '知らせる', '文字・電話・知らせない', '前提 ready=待機', '外への作用 effect=所有者'],
  ['capMc', 'cat', 2, 2, 'Minecraft', '体のセッション', '前提 ready=停止中', '枠 slot=minecraft'],
  ['capRest', 'cat', 3, 2, '休む', '戻る時間と理由', '前提 ready=true', '費用 cost=0'],
  ['dispatch', 'run', 1, 3, '一つの依頼', '選んだ能力を task に', '能力 capability=research', 'task taskId=t-90b'],
  ['slots', 'run', 2, 3, '資源ごとの枠', '前面1・調査2・創作1', '種類 kind=research', '調査 research=1/2'],
  ['fcaTask', 'run', 3, 3, 'FCA タスク', '長い作業を一歩ずつ', 'task taskId=t-90b', '一歩 steps=6; 結果 status=done'],
  ['procedure', 'run', 1, 4, '手順', '決まった短い手順', '種類 kind=—', '結果 status=未使用'],
  ['evidence', 'learn', 4, 0, '証拠', '完了の判定に合う観測', '完了条件 criteria=1', '一致 matched=true'],
  ['reward', 'learn', 5, 0, '報酬 r2', '完了35・反応35・予測20・自己10', '完了 completion=1.0; 反応 owner=0.8; 予測 prediction=0.6; 自己 self=0.5', 'r2 r2=0.80'],
  ['values', 'learn', 4, 1, '価値表', '能力ごとの期待値', '鍵 key=research', '期待値 v=0.61→0.65; 不確かさ u=0.18'],
  ['goals', 'learn', 5, 1, '目標の一生', '立てる→進める→終える', '目標 goal=g-12', '進み progress=3/5; 次の見直し review=10/16'],
  ['world', 'ext', 4, 2, 'Minecraft', '外の体', '操作 op=—', '応答 ack=—'],
  ['agentHost', 'ext', 5, 2, 'Mac Agent Host', '外部作業', '作業 job=—', '結果 status=—'],
  ['aether', 'ext', 4, 3, 'Aether', 'シャノン用フォルダ', '操作 op=write', '成否 ok=true'],
  ['tin', 'conv', 0, 5, '発話・文字', '所有者の一言', '入口 surface=voice', '文字数 chars=14'],
  ['prep', 'conv', 1, 5, '並列の準備', '想起・Jev・自己を同時に', '待てる上限 maximumWaitMs=350', '候補 itemCount=5; 道具 tools=4'],
  ['haikuLow', 'conv', 2, 5, 'Haiku 低 effort', '速さ優先で返事を作る', 'effort effort=low; 回目 round=1', '最初の字 firstTokenMs=250'],
  ['first', 'conv', 3, 5, '最初の一文', '一文目で話し始める', '字数 chars=18', '話し始め speakAtMs=760'],
  ['tts', 'conv', 4, 5, '音声合成', '文ごとに声にする', '文 sentence=1/3', '最初の音 firstAudioMs=280'],
  ['sqlite', 'db', 4, 4, '共有 SQLite', '台帳・価値表・目標', '書き込み writes=9', '読み出し reads=21'],
];
export const TARGET_LINKS = [
  ['tTime', 'executive'], ['tGoal', 'candidates'], ['tOwner', 'executive'], ['tBody', 'executive'], ['candidates', 'executive'], ['budget', 'executive'],
  ['executive', 'capCreate', true], ['executive', 'capResearch'], ['executive', 'capAether', true], ['executive', 'capNotify', true], ['executive', 'capMc', true], ['executive', 'capRest'],
  ['capResearch', 'dispatch'], ['capRest', 'dispatch', true], ['dispatch', 'slots'], ['slots', 'fcaTask'], ['dispatch', 'procedure', true],
  ['fcaTask', 'evidence'], ['fcaTask', 'aether'], ['fcaTask', 'agentHost', true], ['fcaTask', 'world', true],
  ['evidence', 'reward'], ['tOwner', 'reward', true], ['reward', 'values'], ['reward', 'goals'], ['values', 'candidates'], ['goals', 'candidates'], ['values', 'sqlite', true],
  ['tin', 'prep'], ['prep', 'haikuLow'], ['haikuLow', 'first'], ['first', 'tts'], ['haikuLow', 'goals', true], ['budget', 'haikuLow', true],
];
/** Dummy runs: [node, startMs, durationMs, inputOverride|outputOverride, steps[[label,start,duration]]]. */
export const TARGET_RUNS = [
  { name: '自分の時間の一回', spans: [
    ['tTime', 0, 10], ['tGoal', 0, 30], ['candidates', 30, 140], ['budget', 170, 10], ['executive', 180, 1400],
    ['capResearch', 1580, 20], ['dispatch', 1600, 30], ['slots', 1630, 40],
    ['fcaTask', 1670, 24000, '', [['一歩 1', 1670, 3000], ['道具', 4670, 6000], ['一歩 2', 10670, 3000], ['道具', 13670, 8000], ['一歩 3', 21670, 4000]]],
    ['aether', 23500, 900], ['evidence', 25670, 200], ['tOwner', 27000, 10], ['reward', 27010, 60], ['values', 27070, 60], ['goals', 27070, 80], ['sqlite', 27100, 40],
    ['candidates', 27300, 120, '|候補 candidates=6'], ['executive', 27420, 1200, '|選択 choice=rest; 理由 reason=1行'], ['capRest', 28620, 20]] },
  { name: '会話（速い道）', spans: [
    ['tin', 0, 10], ['prep', 10, 340, '', [['想起', 10, 340], ['Jev', 10, 190], ['自己', 10, 20]]], ['budget', 350, 6],
    ['haikuLow', 350, 900], ['first', 760, 40], ['tts', 800, 300], ['goals', 1300, 40, '目標 goal=あとでやる|'], ['sqlite', 1300, 30]] },
];
export function dummyFields(text) {
  if (!text || text === '—') return [];
  return text.split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const match = part.match(/^(\S+)\s+(\S+)=(.*)$/u);
    return match ? { gloss: match[1], key: match[2], value: match[3] } : { gloss: part, key: '', value: '' };
  });
}
export function mergeFields(base, override) {
  const result = base.map(field => ({ ...field }));
  for (const field of dummyFields(override)) { const index = result.findIndex(item => item.key === field.key); if (index >= 0) result[index] = field; else result.push(field); }
  return result;
}

/* ---------- Geometry: one grid for both views ---------- */
export const NODE_W = 134, NODE_H = 72, PITCH_X = 160, PITCH_Y = 116, ORIGIN_X = 28, ORIGIN_Y = 44;
/** Blocks surround their own cells; nodes never overlap and blocks stay two pixels apart. */
export function gridLayout(blocks, nodes) {
  const boxes = new Map(), blockBoxes = new Map();
  for (const [id, block, col, row, , , , span] of nodes) {
    const wide = typeof span === 'number' ? span : 1;
    boxes.set(id, { x: ORIGIN_X + col * PITCH_X, y: ORIGIN_Y + row * PITCH_Y, w: NODE_W + (wide - 1) * PITCH_X, h: NODE_H, col, row, block });
  }
  for (const [id] of blocks) {
    const inside = [...boxes.values()].filter(box => box.block === id);
    if (!inside.length) continue;
    const left = Math.min(...inside.map(box => box.x)), top = Math.min(...inside.map(box => box.y));
    const right = Math.max(...inside.map(box => box.x + box.w)), bottom = Math.max(...inside.map(box => box.y + box.h));
    blockBoxes.set(id, { x: left - 12, y: top - 30, w: right - left + 24, h: bottom - top + 42 });
  }
  const width = Math.max(...[...blockBoxes.values()].map(box => box.x + box.w)) + 16;
  const height = Math.max(...[...blockBoxes.values()].map(box => box.y + box.h)) + 16;
  return { width, height, boxes, blocks: blockBoxes };
}
export const CURRENT_LAYOUT = gridLayout(BLOCKS, VIEW_NODES);
export const TARGET_LAYOUT = gridLayout(TARGET_BLOCKS, TARGET_NODES);

/** A cubic curve leaving the facing sides of two boxes; `offset` separates a pair of opposite routes. */
export function edgeCurve(a, b, offset = 0) {
  const ax = a.x + a.w / 2, ay = a.y + a.h / 2, bx = b.x + b.w / 2, by = b.y + b.h / 2, dx = bx - ax, dy = by - ay;
  // Leave through the sides that face each other; large blocks that overlap on one axis never route backwards.
  const apartX = a.x + a.w <= b.x || b.x + b.w <= a.x, apartY = a.y + a.h <= b.y || b.y + b.h <= a.y;
  const shared = (low1, high1, low2, high2, fallback) => { const low = Math.max(low1, low2), high = Math.min(high1, high2); return high > low ? (low + high) / 2 : fallback; };
  if (apartX && (!apartY || Math.abs(dx) > Math.abs(dy) * 1.4)) {
    const side = Math.sign(dx), y1 = apartY ? ay : shared(a.y, a.y + a.h, b.y, b.y + b.h, ay), y2 = apartY ? by : y1;
    const start = [ax + side * a.w / 2, y1 + offset], end = [bx - side * b.w / 2, y2 + offset], half = (end[0] - start[0]) / 2;
    return [start, [start[0] + half, start[1]], [end[0] - half, end[1]], end];
  }
  const side = Math.sign(dy) || 1, x1 = apartX ? ax : shared(a.x, a.x + a.w, b.x, b.x + b.w, ax), x2 = apartX ? bx : x1;
  const start = [x1 + offset, ay + side * a.h / 2], end = [x2 + offset, by - side * b.h / 2], half = (end[1] - start[1]) / 2;
  return [start, [start[0], start[1] + half], [end[0], end[1] - half], end];
}
export function bezierAt(points, t) {
  const u = 1 - t;
  return [0, 1].map(axis => u * u * u * points[0][axis] + 3 * u * u * t * points[1][axis] + 3 * u * t * t * points[2][axis] + t * t * t * points[3][axis]);
}
export const curvePath = points => `M${points[0].join(' ')} C${points[1].join(' ')} ${points[2].join(' ')} ${points[3].join(' ')}`;
/** A link between boxes that are not neighbours travels in the gutters (column gaps, then just above/below the
 * target row), never through another box; neighbours keep a short curve. Owner feedback 2026-10-13: fewer crossings. */
export function gutterRoute(a, b, offset = 0) {
  if (typeof a.col !== 'number' || typeof b.col !== 'number' || Math.abs(a.col - b.col) <= 1 && Math.abs(a.row - b.row) <= 1) return { kind: 'curve', points: edgeCurve(a, b, offset) };
  const right = b.col >= a.col, gx = right ? a.x + a.w + 6 + offset : a.x - 6 + offset;
  const down = b.row >= a.row, gy = down ? b.y - 5 + offset / 3 : b.y + b.h + 5 + offset / 3;
  const tx = b.x + b.w / 2 + offset;
  const points = [[right ? a.x + a.w : a.x, a.y + a.h / 2 + offset], [gx, a.y + a.h / 2 + offset], [gx, gy], [tx, gy], [tx, down ? b.y : b.y + b.h]];
  return { kind: 'poly', points };
}
export function routePath(route) {
  if (route.kind !== 'poly') return curvePath(route.points);
  return `M${route.points.map(point => point.join(' ')).join(' L')}`;
}
export function routePoint(route, t) {
  if (route.kind !== 'poly') return bezierAt(route.points, t);
  const parts = route.points.slice(1).map((point, index) => Math.hypot(point[0] - route.points[index][0], point[1] - route.points[index][1]));
  let distance = t * parts.reduce((sum, value) => sum + value, 0);
  for (const [index, length] of parts.entries()) {
    if (distance <= length || index === parts.length - 1) { const from = route.points[index], to = route.points[index + 1], f = length ? Math.min(1, distance / length) : 0; return [from[0] + (to[0] - from[0]) * f, from[1] + (to[1] - from[1]) * f]; }
    distance -= length;
  }
  return route.points[0];
}
/** Structural routes with opposite pairs offset, so a return path never hides under its outbound path. */
export function routeTable(layout, links) {
  const routes = new Map(), keys = new Set(links.map(([from, to]) => `${from}>${to}`));
  for (const [from, to, background] of links) {
    const a = layout.boxes.get(from), b = layout.boxes.get(to);
    if (!a || !b) continue;
    const offset = keys.has(`${to}>${from}`) ? (from < to ? -9 : 9) : 0;
    routes.set(`${from}>${to}`, { from, to, background: Boolean(background), ...gutterRoute(a, b, offset) });
  }
  return routes;
}
/** Block-level routes for the zoomed-out view, derived from node routes that cross a block boundary. */
export function blockRoutes(layout, links) {
  const pairs = new Map();
  for (const [from, to] of links) {
    const a = layout.boxes.get(from)?.block, b = layout.boxes.get(to)?.block;
    if (a && b && a !== b) pairs.set(`${a}>${b}`, [a, b]);
  }
  const routes = new Map();
  // Neighbouring blocks touch, so a block link is a short connector across their shared boundary (30%→70% of the centre line).
  for (const [key, [a, b]] of pairs) {
    const one = layout.blocks.get(a), two = layout.blocks.get(b), ax = one.x + one.w / 2, ay = one.y + one.h / 2, bx = two.x + two.w / 2, by = two.y + two.h / 2;
    const length = Math.hypot(bx - ax, by - ay) || 1, shift = pairs.has(`${b}>${a}`) ? (a < b ? -12 : 12) : 0, nx = -(by - ay) / length * shift, ny = (bx - ax) / length * shift;
    const at = t => [ax + (bx - ax) * t + nx, ay + (by - ay) * t + ny];
    routes.set(key, { from: a, to: b, kind: 'curve', points: [at(.3), at(.43), at(.57), at(.7)] });
  }
  return routes;
}
