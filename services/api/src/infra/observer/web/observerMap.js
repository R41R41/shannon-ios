// The owner's view of the current architecture (owner choice 2026-10-13: per-turn timeline first, zoomable layered map second;
// 2026-10-14: the target-architecture dummy view is retired, boxes and blocks can be dragged, the default placement is landscape).
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

/** The boxes: [id, block, label, role, contract nodes that can project here]. Display-only boxes list no contract node.
 * Where they stand is a separate, data-only placement (below), so a layout can change without touching the boxes. */
export const VIEW_BOXES = [
  ['pcm', 'client', '録音', 'マイク → 音声の塊', ['pcm']],
  ['stt', 'client', '文字起こし', '声 → 文字', ['stt']],
  ['join', 'client', '発話の結合', '切れた発話をつなぐ', ['join']],
  ['sentences', 'voice', '文に分ける', '生成途中から文を取る', ['sentences']],
  ['plan', 'voice', '声の計画', '感情・読み方へ', ['plan']],
  ['tts', 'voice', '音声合成', '文ごとに声へ', ['tts']],
  ['play', 'voice', '再生（端末）', '端末で鳴らす', ['play']],
  ['admit', 'conv', '受付', '一回の run を開く', ['turn']],
  ['base', 'conv', '記憶の土台', '状態・人・決定的文脈', ['recall']],
  ['perception', 'conv', '知覚', '入力 → 心の出来事', ['perception']],
  ['router', 'conv', 'Jev ルーター', '道具メニュー・難しさ', ['jevt', 'jevv']],
  ['recall', 'conv', '意味で想起', '埋め込み → Jev 並べ替え', ['recall']],
  ['identity', 'conv', '自己とできること', '相手と能力（段の時間）', []],
  ['jevModel', 'conv', 'Jev 呼び出し', '小さなモデルの判断', ['llm']],
  ['context', 'conv', '文脈を組む', '材料を一つの依頼に', ['context']],
  ['taskHub', 'conv', '会話タスク', 'task 台帳（FCA と共通）', ['taskHub']],
  ['decode', 'conv', '返事を読む', '構造を確かめる', ['decode']],
  ['fcaTool', 'conv', 'FCA 道具選択', 'Jev が渡す道具を絞る', ['jevt']],
  ['store', 'conv', '保存', '会話・結果を書く', ['store']],
  ['native', 'conv', 'モデル入力', 'Messages・道具定義へ', ['native']],
  ['haiku', 'conv', 'Haiku 道具ループ', '返事か道具かを決める', ['llm']],
  ['queue', 'fca', '実行枠', '種類ごとの上限で受付', ['queue']],
  ['fca', 'fca', 'FCA step', '同じエンジンで一歩', ['fca']],
  ['gate', 'fca', '道具の関門', '許可・入力・条件', ['gate']],
  ['compact', 'fca', '履歴の圧縮', '作業履歴を短く', ['compact']],
  ['tools', 'fca', '道具の実行', '道具を動かす', ['tools']],
  ['wait', 'fca', '待機', '待つ状態の記録', ['wait']],
  ['memory', 'mind', '記憶を書く', '返事の後に更新', ['memory']],
  ['embedding', 'mind', 'ベクトル化', '想起用の埋め込み', ['embedding']],
  ['sleep', 'mind', '睡眠・整理', '記憶をまとめる', ['sleep']],
  ['emotion', 'mind', '感情', '結果から気分へ', ['emotion']],
  ['prediction', 'mind', '予測', '予測と結果', ['prediction']],
  ['workspace', 'mind', '共有の場', '実行枠の投影', ['workspace']],
  ['autonomy', 'own', '自分の時間', '小さな一歩ずつ', ['autonomy']],
  ['executive', 'own', 'Executive', '作ってあるが停止中', []],
  ['sqlite', 'db', '共有 SQLite', '会話・記憶・タスク・台帳', []],
  ['bodyObserve', 'world', '体の観測', '身体からの実観測', ['bodyObserve']],
  ['reflex', 'world', '反射', '反射処理の範囲', ['reflex']],
  ['reflexJev', 'world', '反射の判断', 'Jev の小さな判断', ['reflexJev']],
  ['reflexDecision', 'world', '反射の選択', '候補から選ぶ', ['reflexDecision']],
  ['bodyControl', 'world', '体の制御', 'stop・execute の応答', ['bodyControl']],
  ['minecraft', 'world', 'Minecraft', '外部・中は未計測', ['minecraft']],
  ['agentHost', 'world', 'Mac Agent Host', '外部・中は未計測', ['agentHost']],
];

/** Default landscape placement (owner, 2026-10-14: 「横長の画面に対応させたい」; chosen from side-by-side mocks: 案A
 * 「入口 → 会話 → 出口」). Left: what comes in (端末, 外の体と反射); middle: the conversation, FCA, own time and SQLite;
 * right: voice and the mind's after-work. One line is one grid row, one word one cell: a box id, `.` for an empty cell, and
 * the same id repeated in neighbouring cells for a wider box. Blocks must stay rectangles. */
export const LAYOUT_ID = 'landscape-a1';
export const DEFAULT_PLACEMENT = `
  pcm            stt         admit       base      router    context  native    sentences   plan
  .              join        perception  recall    jevModel  taskHub  haiku     play        tts
  bodyObserve    reflex      store       identity  .         fcaTool  decode    memory      embedding
  reflexDecision reflexJev   compact     queue     gate      .        .         sleep       emotion
  bodyControl    .           wait        fca       tools     autonomy executive prediction  workspace
  minecraft      agentHost   .           .         .         sqlite   sqlite    .           .
`;
/** Grid cells of a placement text: id -> [col, row, span]. Unknown, missing or repeated ids are reported, never guessed. */
export function parsePlacement(text, ids = VIEW_BOXES.map(spec => spec[0])) {
  const cells = new Map(), known = new Set(ids), problems = [];
  text.trim().split('\n').forEach((line, row) => {
    const words = line.trim().split(/\s+/);
    words.forEach((word, col) => {
      if (word === '.') return;
      if (!known.has(word)) { problems.push(`unknown ${word}`); return; }
      const cell = cells.get(word);
      if (cell && cell[1] === row && cell[0] + cell[2] === col) { cell[2] += 1; return; }
      if (cell) { problems.push(`repeated ${word}`); return; }
      cells.set(word, [col, row, 1]);
    });
  });
  for (const id of known) if (!cells.has(id)) problems.push(`missing ${id}`);
  return { cells, problems };
}
const PLACED = parsePlacement(DEFAULT_PLACEMENT);
if (PLACED.problems.length) throw new Error(`observer placement: ${PLACED.problems.join(', ')}`);
/** Boxes with their default grid cell: [id, block, col, row, label, role, contract nodes, span]. */
export const VIEW_NODES = VIEW_BOXES.map(([id, block, label, description, sources]) => { const [col, row, span] = PLACED.cells.get(id); return [id, block, col, row, label, description, sources, span]; });

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

/* ---------- Geometry ---------- */
export const NODE_W = 134, NODE_H = 72, PITCH_X = 160, PITCH_Y = 116, ORIGIN_X = 28, ORIGIN_Y = 44;
/** A block's frame around its boxes: 12 px at the sides and bottom, 30 px above for its title. */
export const BLOCK_PAD = { side: 12, top: 30, bottom: 12 };
/** Boxes stand on their grid cell unless the owner moved them (`positions`: id -> [x, y], owner, 2026-10-14). Each box keeps
 * its cell and the shift from it, so routing knows which boxes still stand as the grid placed them. Blocks always surround
 * their own boxes, wherever those are, so moving a block is moving its boxes. On the default grid nodes never overlap and
 * blocks stay two pixels apart. */
export function gridLayout(blocks, nodes, positions = {}) {
  const boxes = new Map(), blockBoxes = new Map();
  for (const [id, block, col, row, , , , span] of nodes) {
    const wide = typeof span === 'number' ? span : 1, x = ORIGIN_X + col * PITCH_X, y = ORIGIN_Y + row * PITCH_Y;
    const moved = Object.hasOwn(positions, id) ? positions[id] : null, at = moved ?? [x, y];
    boxes.set(id, { x: at[0], y: at[1], w: NODE_W + (wide - 1) * PITCH_X, h: NODE_H, col, row, block, shift: [at[0] - x, at[1] - y] });
  }
  for (const [id] of blocks) {
    const inside = [...boxes.values()].filter(box => box.block === id);
    if (!inside.length) continue;
    const left = Math.min(...inside.map(box => box.x)), top = Math.min(...inside.map(box => box.y));
    const right = Math.max(...inside.map(box => box.x + box.w)), bottom = Math.max(...inside.map(box => box.y + box.h));
    blockBoxes.set(id, { x: left - BLOCK_PAD.side, y: top - BLOCK_PAD.top, w: right - left + BLOCK_PAD.side * 2, h: bottom - top + BLOCK_PAD.top + BLOCK_PAD.bottom });
  }
  const width = Math.max(...[...blockBoxes.values()].map(box => box.x + box.w)) + 16;
  const height = Math.max(...[...blockBoxes.values()].map(box => box.y + box.h)) + 16;
  return { width, height, boxes, blocks: blockBoxes };
}
export const CURRENT_LAYOUT = gridLayout(BLOCKS, VIEW_NODES);

/* ---------- The owner's own arrangement (owner, 2026-10-14: drag boxes and blocks freely, 「初期配置に戻す」) ---------- */
const MAX_COORD = 20000;
/** Moves the given boxes together by (dx, dy), never past the top-left edge (a block's frame stays on the map), and
 * returns their new positions. A block moves as all of its boxes, so it keeps its shape. */
export function movedPositions(layout, ids, dx, dy) {
  const list = ids.map(id => [id, layout.boxes.get(id)]).filter(([, box]) => box);
  if (!list.length) return {};
  const left = Math.min(...list.map(([, box]) => box.x)), top = Math.min(...list.map(([, box]) => box.y));
  const sx = Math.max(BLOCK_PAD.side - left, Math.min(MAX_COORD - left, dx)), sy = Math.max(BLOCK_PAD.top - top, Math.min(MAX_COORD - top, dy));
  return Object.fromEntries(list.map(([id, box]) => [id, [Math.round(box.x + sx), Math.round(box.y + sy)]]));
}
/** Only boxes the owner moved away from the default grid are kept. */
export function customPositions(layout) {
  return Object.fromEntries([...layout.boxes].filter(([, box]) => box.shift[0] !== 0 || box.shift[1] !== 0).map(([id, box]) => [id, [box.x, box.y]]));
}
/** A saved arrangement from this browser's storage: only known boxes with finite coordinates, clamped to what a drag can reach, and only for the
 * placement it was made on (a new default placement starts from the new default). Anything else is ignored. */
export function savedPositions(value, ids = VIEW_NODES.map(spec => spec[0]), layoutId = LAYOUT_ID) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value.layout !== layoutId) return {};
  const nodes = value.nodes !== null && typeof value.nodes === 'object' && !Array.isArray(value.nodes) ? value.nodes : {}, known = new Set(ids), result = {};
  for (const [id, at] of Object.entries(nodes)) {
    if (!known.has(id) || !Array.isArray(at) || at.length !== 2 || !at.every(n => typeof n === 'number' && Number.isFinite(n))) continue;
    // The same bounds a drag can reach: a block's frame never starts left of or above the map.
    result[id] = [Math.round(Math.max(BLOCK_PAD.side, Math.min(MAX_COORD, at[0]))), Math.round(Math.max(BLOCK_PAD.top, Math.min(MAX_COORD, at[1])))];
  }
  return result;
}

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
  // Gutters exist only between boxes that still stand as the grid placed them relative to each other; a box the owner moved
  // on its own is joined by a short curve instead (moving a whole block keeps the gutters inside it).
  const sameShift = (a.shift?.[0] ?? 0) === (b.shift?.[0] ?? 0) && (a.shift?.[1] ?? 0) === (b.shift?.[1] ?? 0);
  if (!sameShift || typeof a.col !== 'number' || typeof b.col !== 'number' || Math.abs(a.col - b.col) <= 1 && Math.abs(a.row - b.row) <= 1) return { kind: 'curve', points: edgeCurve(a, b, offset) };
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

/* ---------- Detail level (owner, 2026-10-13): what is drawn is independent of how far the map is zoomed ---------- */
/** 1 = blocks, 2 = boxes, 3 = boxes with their inputs/outputs. A picked level always wins; only "auto" follows the zoom. */
export function detailLevel(picked, zoom) {
  if (picked === 1 || picked === 2 || picked === 3) return picked;
  return zoom < 1.7 ? 1 : zoom < 3 ? 2 : 3;
}
/** Rough SVG text width: monospace Latin is .6 em, Japanese is 1 em. Used only to keep text inside its box. */
export function textWidth(text, size) { return [...String(text)].reduce((sum, char) => sum + (char.charCodeAt(0) < 256 ? .6 : 1), 0) * size; }
export function fitText(text, size, width) {
  if (textWidth(text, size) <= width) return String(text);
  // Pre-trim to what could fit at the narrowest glyph, so the loop below stays short for long values.
  const chars = [...String(text)].slice(0, Math.max(0, Math.ceil(width / (size * .6))) + 1);
  while (chars.length && textWidth(`${chars.join('')}…`, size) > width) chars.pop();
  return chars.length ? `${chars.join('')}…` : '';
}
export const IO_FONT = 6.8, IO_PITCH = 8.5;
/** Input/output rows laid out inside a box: at most as many rows as fit its height, every row cut to its width. */
export function ioRows(box, input, output) {
  const top = box.y + 28, bottom = box.y + box.h - 3, budget = Math.max(0, Math.floor((bottom - top - 2) / IO_PITCH) + 1);
  const inputs = Math.min(budget, input.length, output.length ? Math.max(1, budget - Math.min(output.length, budget - 1)) : budget);
  const outputs = Math.max(0, Math.min(output.length, budget - inputs));
  const rows = [], width = box.w - 17 - 6;
  let y = top;
  for (const [mark, list] of [['入', input.slice(0, inputs)], ['出', output.slice(0, outputs)]]) {
    list.forEach((field, index) => {
      const name = fitText(field.gloss || field.key, IO_FONT, width * .55);
      rows.push({ mark: index === 0 ? mark : '', name, value: fitText(field.value, IO_FONT, Math.max(0, width - textWidth(`${name} `, IO_FONT))), y });
      y += IO_PITCH;
    });
    if (list.length) y += 2;
  }
  return rows.filter(row => row.y <= bottom);
}
