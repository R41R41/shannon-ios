import { describe, expect, it } from 'vitest';
import { OBSERVER_NODES } from '../src/contracts/observerContract.js';
import {
  BLOCKS, CURRENT_LAYOUT, DEFAULT_PLACEMENT, LAYOUT_ID, VIEW_BOXES, VIEW_LINKS, VIEW_NODES,
  blockRoutes, customPositions, gridLayout, movedPositions, parsePlacement, routePath, routePoint, routeTable, savedPositions, viewHandoff, viewNodeOf, type GridLayout,
} from '../src/infra/observer/web/observerMap.js';

function noOverlap(layout: GridLayout) {
  const boxes = [...layout.boxes.values()], blocks = [...layout.blocks.values()];
  for (const list of [boxes, blocks]) for (const [index, a] of list.entries()) for (const b of list.slice(index + 1))
    expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true);
  for (const box of boxes) { expect(box.x + box.w).toBeLessThanOrEqual(layout.width); expect(box.y + box.h).toBeLessThanOrEqual(layout.height); }
}

describe('current-architecture view of observed events', () => {
  it('projects every contract node somewhere, with unique view ids and links between known boxes', () => {
    const ids = VIEW_NODES.map(spec => spec[0]);
    expect(new Set(ids).size).toBe(ids.length);
    const sources = new Set(VIEW_NODES.flatMap(spec => spec[6]));
    for (const node of OBSERVER_NODES) expect(sources.has(node), node).toBe(true);
    for (const [from, to] of [...VIEW_LINKS]) { expect(ids).toContain(from); expect(ids).toContain(to); }
    for (const spec of VIEW_NODES) expect(BLOCKS.map(block => block[0])).toContain(spec[1]);
    // The processes the owner asked to see are blocks; display-only boxes carry no contract node.
    expect(BLOCKS.map(block => block[2]).join(' ')).toMatch(/api.*worker.*autonomy worker.*world・agent-host/su);
    for (const id of ['identity', 'executive', 'sqlite']) expect(VIEW_NODES.find(spec => spec[0] === id)![6]).toEqual([]);
  });

  it('splits Jev and LLM nodes, and base from semantic recall, only from explicit payload fields', () => {
    expect(viewNodeOf('turn')).toBe('admit');
    expect(viewNodeOf('jevt', { surface: 'text', offeredTools: [], difficulty: 'normal' })).toBe('router');
    expect(viewNodeOf('jevv', {})).toBe('router');
    expect(viewNodeOf('jevt', { selector: 'fca', offeredCount: 3 })).toBe('fcaTool');
    expect(viewNodeOf('jevt', { selector: 'reflex_entry' })).toBe('reflexJev');
    expect(viewNodeOf('llm', { model: 'claude-haiku-5-5', round: 1 })).toBe('haiku');
    expect(viewNodeOf('llm', { provider: 'jev', questionCount: 2 })).toBe('jevModel');
    expect(viewNodeOf('llm', { provider: 'openai_decisions' })).toBe('jevModel');
    expect(viewNodeOf('recall', { message: 'x', threadId: 't' })).toBe('base');
    expect(viewNodeOf('recall', { message: 'x', semantic: true })).toBe('recall');
    expect(viewNodeOf('recall', { strategy: 'deterministic', surface: 'voice' })).toBe('base');
    expect(viewNodeOf('recall', { strategy: 'semantic', surface: 'voice' })).toBe('recall');
    expect(viewNodeOf('recall', { phase: 'decision_packet', maximumWaitMs: 900 })).toBe('recall');
    expect(viewNodeOf('recall', { phase: 'task_deterministic' })).toBe('base');
    expect(viewNodeOf('pcm')).toBe('pcm'); expect(viewNodeOf('unknown-node')).toBeNull();
    expect(viewHandoff({ fromNode: 'context', toNode: 'jevt', output: { phase: 'fca_selection', offeredCount: 4 } })).toEqual(['context', 'fcaTool']);
    expect(viewHandoff({ fromNode: 'jevt', toNode: 'context', output: { tools: [] } })).toEqual(['router', 'context']);
    expect(viewHandoff({ fromNode: 'native', toNode: 'llm', output: { model: 'claude-haiku-5-5', round: 1 } })).toEqual(['native', 'haiku']);
    expect(viewHandoff({ fromNode: 'native', toNode: 'llm', output: { provider: 'openai_decisions' } })).toEqual(['native', 'jevModel']);
  });

  it('lays out blocks and boxes without overlap and routes every structural link', () => {
    noOverlap(CURRENT_LAYOUT);
    for (const [layout, links] of [[CURRENT_LAYOUT, VIEW_LINKS]] as const) {
      const routes = routeTable(layout, links);
      expect(routes.size).toBe(links.length);
      for (const route of routes.values()) expect(routePath(route)).not.toMatch(/NaN|undefined|Infinity/);
      for (const route of blockRoutes(layout, links).values()) expect(route.from).not.toBe(route.to);
    }
    // Links between boxes that are not neighbours travel in the gutters, never through another box.
    for (const route of routeTable(CURRENT_LAYOUT, VIEW_LINKS).values()) {
      if (route.kind !== 'poly') continue;
      for (let index = 1; index < route.points.length; index += 1) {
        const [a, b] = [route.points[index - 1], route.points[index]];
        expect(a[0] === b[0] || a[1] === b[1]).toBe(true);
        for (const [id, box] of CURRENT_LAYOUT.boxes) {
          if (id === route.from || id === route.to) continue;
          const crosses = Math.max(a[0], b[0]) > box.x && Math.min(a[0], b[0]) < box.x + box.w && Math.max(a[1], b[1]) > box.y && Math.min(a[1], b[1]) < box.y + box.h;
          expect(crosses, `${route.from}>${route.to} crosses ${id}`).toBe(false);
        }
      }
      expect(routePoint(route, 0)).toEqual(route.points[0]); expect(routePoint(route, 1)).toEqual(route.points.at(-1));
    }
    // A return route never hides under its outbound route.
    const routes = routeTable(CURRENT_LAYOUT, VIEW_LINKS);
    expect(routes.get('haiku>gate')!.points).not.toEqual(routes.get('tools>haiku')!.points);
  });
});

describe('landscape default placement (owner, 2026-10-14)', () => {
  it('places every box exactly once from the placement text, and reports anything it cannot place', () => {
    const { cells, problems } = parsePlacement(DEFAULT_PLACEMENT);
    expect(problems).toEqual([]);
    expect([...cells.keys()].sort()).toEqual(VIEW_BOXES.map(spec => spec[0]).sort());
    expect(cells.get('sqlite')![2]).toBe(2);
    expect(parsePlacement('pcm nope\npcm', ['pcm', 'stt']).problems).toEqual(['unknown nope', 'repeated pcm', 'missing stt']);
    expect(parsePlacement('a a . b', ['a', 'b']).cells.get('a')).toEqual([0, 0, 2]);
  });
  it('fits a 16:9 or 16:10 screen instead of being tall, with every block a rectangle of its own', () => {
    expect(CURRENT_LAYOUT.width / CURRENT_LAYOUT.height).toBeGreaterThan(1.6);
    const columns = Math.max(...VIEW_NODES.map(spec => spec[2] + (spec[7] ?? 1)));
    const rows = Math.max(...VIEW_NODES.map(spec => spec[3])) + 1;
    expect(columns).toBeGreaterThan(rows);
    // A block's frame holds only its own boxes (blocks never overlap, see above), so no box of another block sits inside it.
    for (const [id, frame] of CURRENT_LAYOUT.blocks) for (const box of CURRENT_LAYOUT.boxes.values()) {
      if (box.block === id) continue;
      expect(box.x + box.w <= frame.x || frame.x + frame.w <= box.x || box.y + box.h <= frame.y || frame.y + frame.h <= box.y, `${id} holds a box of ${box.block}`).toBe(true);
    }
  });
});

describe('the owner moves boxes and blocks (owner, 2026-10-14)', () => {
  it('moves one box, grows its block around it, and joins a moved box by a curve', () => {
    const moved = movedPositions(CURRENT_LAYOUT, ['haiku'], 400, 260);
    const layout = gridLayout(BLOCKS, VIEW_NODES, moved), box = layout.boxes.get('haiku')!, before = CURRENT_LAYOUT.boxes.get('haiku')!;
    expect([box.x, box.y]).toEqual([before.x + 400, before.y + 260]);
    expect(box.shift).toEqual([400, 260]);
    const frame = layout.blocks.get('conv')!;
    expect(frame.x <= box.x && frame.y <= box.y && frame.x + frame.w >= box.x + box.w && frame.y + frame.h >= box.y + box.h).toBe(true);
    const routes = routeTable(layout, VIEW_LINKS);
    expect(routes.size).toBe(VIEW_LINKS.length);
    for (const route of routes.values()) expect(routePath(route)).not.toMatch(/NaN|undefined|Infinity/);
    for (const [key, route] of routes) if (key.includes('haiku')) expect(route.kind, key).toBe('curve');
    expect(customPositions(layout)).toEqual({ haiku: [box.x, box.y] });
  });
  it('moves a block with all its boxes, keeping its shape and the routes inside it', () => {
    const ids = VIEW_NODES.filter(spec => spec[1] === 'fca').map(spec => spec[0]);
    const layout = gridLayout(BLOCKS, VIEW_NODES, movedPositions(CURRENT_LAYOUT, ids, 300, -40));
    const before = CURRENT_LAYOUT.blocks.get('fca')!, after = layout.blocks.get('fca')!;
    expect([after.x - before.x, after.y - before.y, after.w, after.h]).toEqual([300, -40, before.w, before.h]);
    for (const [key, route] of routeTable(CURRENT_LAYOUT, VIEW_LINKS)) {
      const [from, to] = key.split('>');
      if (ids.includes(from) && ids.includes(to)) expect(routeTable(layout, VIEW_LINKS).get(key)!.kind).toBe(route.kind);
    }
    for (const route of blockRoutes(layout, VIEW_LINKS).values()) expect(routePath(route)).not.toMatch(/NaN|undefined|Infinity/);
  });
  it('never moves a block frame off the top-left of the map', () => {
    const ids = VIEW_NODES.filter(spec => spec[1] === 'client').map(spec => spec[0]);
    const layout = gridLayout(BLOCKS, VIEW_NODES, movedPositions(CURRENT_LAYOUT, ids, -5000, -5000)), frame = layout.blocks.get('client')!;
    expect(frame.x).toBe(0); expect(frame.y).toBe(0);
    expect(layout.blocks.get('client')!.w).toBe(CURRENT_LAYOUT.blocks.get('client')!.w);
  });
  it('restores only known boxes with bounded numbers, and only for the same default placement', () => {
    expect(savedPositions({ layout: LAYOUT_ID, nodes: { haiku: [500.4, 90], ghost: [1, 2], tools: ['x', 1], gate: [1e9, -5], store: [1, 2, 3] } })).toEqual({ haiku: [500, 90], gate: [20000, 30] });
    // A saved position at the very edge is what a drag at the edge produces.
    const edge = movedPositions(CURRENT_LAYOUT, ['pcm'], -9999, -9999);
    expect(savedPositions({ layout: LAYOUT_ID, nodes: { pcm: [0, 0] } })).toEqual(edge);
    expect(savedPositions({ layout: 'older-placement', nodes: { haiku: [1, 2] } })).toEqual({});
    for (const value of [null, 'x', [], { layout: LAYOUT_ID }, { layout: LAYOUT_ID, nodes: [] }]) expect(savedPositions(value)).toEqual({});
    expect(customPositions(CURRENT_LAYOUT)).toEqual({});
  });
});

describe('detail level is independent of zoom (owner, 2026-10-13)', () => {
  it('keeps a picked level at every zoom, and only "auto" follows the zoom', async () => {
    const { detailLevel } = await import('../src/infra/observer/web/observerMap.js');
    for (const picked of [1, 2, 3] as const) for (const zoom of [1, 1.5, 2.2, 3.6, 5]) expect(detailLevel(picked, zoom)).toBe(picked);
    expect([1, 2.2, 3.6].map(zoom => detailLevel(null, zoom))).toEqual([1, 2, 3]);
  });
  it('remembers only the overlay, hint and picked level, and rejects anything else', async () => {
    const { viewPrefs } = await import('../src/infra/observer/web/observer.js');
    expect(viewPrefs({ hidden: true, hint: false, level: 3, token: 'x' })).toEqual({ hidden: true, hint: false, level: 3 });
    expect(viewPrefs({ level: 7 })).toEqual({ hidden: false, hint: false, level: null });
    expect(viewPrefs('nope')).toEqual({ hidden: false, hint: false, level: null });
  });
  it('lays the input/output rows of every box inside the box', async () => {
    const { ioRows, textWidth, IO_FONT } = await import('../src/infra/observer/web/observerMap.js');
    const many = (prefix: string) => Array.from({ length: 6 }, (_, index) => ({ gloss: `${prefix}の長い意味の名前${index}`, key: `veryLongKeyName${index}`, value: 'x'.repeat(120) }));
    for (const box of CURRENT_LAYOUT.boxes.values()) for (const [input, output] of [[many('入'), many('出')], [many('入'), []], [[], many('出')]] as Array<[ReturnType<typeof many>, ReturnType<typeof many>]>) {
      const rows = ioRows(box, input, output);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.y + 2).toBeLessThanOrEqual(box.y + box.h);
        expect(textWidth(`${row.name} ${row.value}`, IO_FONT)).toBeLessThanOrEqual(box.w - 17 - 6 + 1);
      }
      if (input.length && output.length) expect(rows.some(row => row.mark === '出')).toBe(true);
    }
  });
});

describe('I/O rows edge cases', () => {
  it('draws nothing in a box too short for a row, and cuts a very long value quickly', async () => {
    const { ioRows, fitText, textWidth } = await import('../src/infra/observer/web/observerMap.js');
    const field = { gloss: '意味', key: 'key', value: 'v' };
    expect(ioRows({ x: 0, y: 0, w: 134, h: 20 }, [field], [field])).toEqual([]);
    const long = 'x'.repeat(200_000), cut = fitText(long, 6.8, 100);
    expect(cut.endsWith('…')).toBe(true); expect(textWidth(cut, 6.8)).toBeLessThanOrEqual(100);
  });
});

describe('critical path from observed timing and parent links only (owner, 2026-10-14, 2A)', () => {
  it('follows the last-finishing child back to the start, descending into it, and skips parallel waits', async () => {
    const { criticalPath } = await import('../src/infra/observer/web/observerAnalysis.js');
    const items = [
      { key: 'root', parent: null, start: 0, end: 1000 },
      { key: 'jev', parent: 'root', start: 10, end: 200 }, { key: 'recall', parent: 'root', start: 10, end: 340 },
      { key: 'model1', parent: 'root', start: 340, end: 600 }, { key: 'tool', parent: 'root', start: 600, end: 700 },
      { key: 'model2', parent: 'root', start: 700, end: 990 }, { key: 'inner', parent: 'recall', start: 100, end: 330 },
      { key: 'sidecar', parent: 'root', start: 200, end: 250 },
    ];
    expect([...criticalPath(items)].sort()).toEqual(['inner', 'model1', 'model2', 'recall', 'root', 'tool']);
    // Nothing invented from missing data: a span without an end is left out, and an empty list gives an empty path.
    expect(criticalPath([{ key: 'a', parent: null, start: 0, end: Number.NaN }]).size).toBe(0);
    expect(criticalPath([]).size).toBe(0);
  });
});
