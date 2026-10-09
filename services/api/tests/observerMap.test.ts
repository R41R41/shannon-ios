import { describe, expect, it } from 'vitest';
import { LINKS, NODE_SPECS, createMapRouter, mapLayout, type MapBox, type MapLayout, type MapRoute } from '../src/infra/observer/web/observerMap.js';

type Point = [number, number];
const adoptedRows = [
  ['pcm', 'stt', 'join', 'perception', 'turn', 'jevv'],
  ['taskHub', 'queue', 'fca', 'compact', 'wait', 'workspace'],
  ['recall', 'context', 'native', 'llm', 'decode', 'emotion'],
  [null, 'jevt', 'tools', 'gate', 'store', 'prediction'],
  ['sentences', 'plan', 'tts', 'play'],
  ['bodyObserve', 'reflex', 'reflexJev', 'reflexDecision', 'bodyControl', 'minecraft'],
  ['memory', 'embedding', 'sleep', 'autonomy', 'agentHost'],
];
const loop = [['native', 'llm'], ['llm', 'gate'], ['gate', 'tools'], ['tools', 'native']] as const;

function crosses(a: Point, b: Point, box: MapBox, padding = 0) {
  const left = box.x - padding, right = box.x + box.w + padding;
  const top = box.y - padding, bottom = box.y + box.h + padding;
  return a[0] === b[0]
    ? a[0] > left && a[0] < right && Math.max(a[1], b[1]) > top && Math.min(a[1], b[1]) < bottom
    : a[1] > top && a[1] < bottom && Math.max(a[0], b[0]) > left && Math.min(a[0], b[0]) < right;
}

function portSide(point: Point, box: MapBox) {
  if (point[0] === box.x && point[1] > box.y && point[1] < box.y + box.h) return 'left';
  if (point[0] === box.x + box.w && point[1] > box.y && point[1] < box.y + box.h) return 'right';
  if (point[1] === box.y && point[0] > box.x && point[0] < box.x + box.w) return 'top';
  if (point[1] === box.y + box.h && point[0] > box.x && point[0] < box.x + box.w) return 'bottom';
  return null;
}

function expectClearRoute(layout: MapLayout, route: MapRoute | null, from: string, to: string) {
  expect(route, `${from}>${to} exists`).not.toBeNull();
  const points = route!.points;
  expect(points.length).toBeGreaterThanOrEqual(2);
  expect(route!.path).not.toMatch(/NaN|undefined|Infinity/);
  for (const point of points) {
    expect(point[0]).toBeGreaterThanOrEqual(0); expect(point[0]).toBeLessThanOrEqual(layout.width);
    expect(point[1]).toBeGreaterThanOrEqual(0); expect(point[1]).toBeLessThanOrEqual(layout.height);
  }
  for (const [id, point, adjacent] of [[from, points[0], points[1]], [to, points.at(-1)!, points.at(-2)!]] as const) {
    const side = portSide(point, layout.boxes.get(id)!);
    expect(side, `${from}>${to}: boundary port on ${id}`).not.toBeNull();
    if (side === 'left') expect(adjacent[0]).toBeLessThan(point[0]);
    if (side === 'right') expect(adjacent[0]).toBeGreaterThan(point[0]);
    if (side === 'top') expect(adjacent[1]).toBeLessThan(point[1]);
    if (side === 'bottom') expect(adjacent[1]).toBeGreaterThan(point[1]);
  }
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1], b = points[index];
    expect((a[0] === b[0]) !== (a[1] === b[1]), `${from}>${to}: orthogonal, nonzero segment`).toBe(true);
    for (const [id, box] of layout.boxes) {
      // Endpoint stems touch their own boundary only. Other boxes retain an 8 px
      // clearance, greater than the 6 px rounded elbow radius and packet radius.
      expect(crosses(a, b, box, id === from || id === to ? 0 : 8), `${from}>${to}: avoids ${id}`).toBe(false);
    }
  }
}

describe('adopted compact FCA lanes', () => {
  it('retains all 38 processors and 49 links, with the chosen seven rows and no prototype padding rows', () => {
    expect(NODE_SPECS).toHaveLength(38); expect(LINKS).toHaveLength(49);
    expect(new Set(LINKS.map(([from, to]) => `${from}>${to}`)).size).toBe(49);
    const layout = mapLayout(1088);
    for (const [row, ids] of adoptedRows.entries()) for (const [col, id] of ids.entries()) {
      if (id) expect(layout.boxes.get(id)).toMatchObject({ row, col });
      else expect([...layout.boxes.values()].some(box => box.row === row && box.col === col)).toBe(false);
    }
    expect(layout.zones).toHaveLength(7);
    expect(layout.zones[2].h).toBe(layout.pitch * 2 - 8);
    expect(layout.zones[3].x).toBeGreaterThan(layout.boxes.get('decode')!.x);
    expect(layout.height - Math.max(...[...layout.boxes.values()].map(box => box.y + box.h))).toBe(32);
    expect(layout.height).toBe(1032);
  });

  it.each([390, 1088, 1400, 1441, 1920])('routes every canonical link around boxes at viewport width %i with distinct ports', width => {
    const layout = mapLayout(width), router = createMapRouter(layout), usedPorts = new Set<string>();
    expect(layout.width).toBeGreaterThanOrEqual(1088);
    for (const [from, to] of LINKS) {
      const route = router.route(from, to);
      expectClearRoute(layout, route, from, to);
      for (const [id, point] of [[from, route!.points[0]], [to, route!.points.at(-1)!]] as const) {
        const key = `${id}:${point.join(':')}`;
        expect(usedPorts.has(key), `distinct ${key}`).toBe(false); usedPorts.add(key);
      }
    }
    // These four centered, direct legs form the visible return loop, including tools→native.
    for (const [from, to] of loop) expect(router.route(from, to)!.points).toHaveLength(2);
    expect(router.route('native', 'llm')!.points[0][0]).toBe(router.route('gate', 'tools')!.points[1][0]);
    expect(router.route('native', 'llm')!.points[1][0]).toBe(router.route('gate', 'tools')!.points[0][0]);
    expect(router.route('llm', 'gate')!.points[0][0]).toBe(router.route('llm', 'gate')!.points[1][0]);
    expect(router.route('tools', 'native')!.points[0][0]).toBe(router.route('tools', 'native')!.points[1][0]);
  });

  it('adds real, noncanonical handoffs without moving existing wires, and forgets dynamic reservations on reset', () => {
    const layout = mapLayout(1400), router = createMapRouter(layout), fresh = createMapRouter(layout);
    const canonical = LINKS.map(([from, to]) => router.route(from, to));
    for (const [from, to] of [['stt', 'perception'], ['join', 'fca'], ['tts', 'store'], ['play', 'turn'], ['sleep', 'fca'], ['bodyObserve', 'reflex']]) {
      const route = router.route(from, to); expectClearRoute(layout, route, from, to);
      expect(router.route(from, to)).toBe(route);
    }
    expect(LINKS.map(([from, to]) => router.route(from, to))).toEqual(canonical);
    expect(router.route('absent', 'llm')).toBeNull(); expect(router.route('llm', 'llm')).toBeNull();
    router.reset();
    expect(router.route('sleep', 'fca')).toEqual(fresh.route('sleep', 'fca'));
    expect(LINKS.map(([from, to]) => router.route(from, to))).toEqual(canonical);
  });

  it('does not reserve a source port when an observed handoff cannot be routed', () => {
    const box = (x: number, y: number, w: number, h: number): MapBox => ({ x, y, w, h, col: 0, row: 0 });
    // A malformed/custom layout traps b within c. Failure must not progressively
    // consume a's ports or change the next independently routable handoff.
    const layout: MapLayout = { width: 400, height: 240, pitch: 144, zones: [], boxes: new Map([
      ['a', box(32, 64, 80, 64)], ['b', box(240, 88, 64, 48)], ['c', box(224, 64, 112, 112)],
    ]) };
    const router = createMapRouter(layout, []);
    for (let attempt = 0; attempt < 20; attempt += 1) expect(router.route('a', 'b')).toBeNull();
    expect(router.route('a', 'c')).toEqual(createMapRouter(layout, []).route('a', 'c'));
    expect(router.route('a', 'c')).not.toBeNull();
  });
});
