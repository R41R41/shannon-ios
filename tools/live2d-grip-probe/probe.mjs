// Measures where the bundled Live2D page names each part of her (`ShannonDesktopBodyGrip.zones`, the Mac desktop body's
// carry rule). It presses every point of a band of her figure in headless Chrome and records the page's answer, in the
// page's drawing coordinates: u = (x - centre) / drawingHeight, v = (y - drawingTop) / drawingHeight.
//
//   1. Serve apps/ios/Sources/ShannonAppCore/Live2D/embed on 127.0.0.1:8766 (python3 -m http.server 8766 --bind 127.0.0.1).
//   2. Start Chrome: --headless=new --remote-debugging-port=9333 --use-angle=swiftshader --enable-unsafe-swiftshader
//      --user-data-dir=<a scratch folder>.
//   3. With a page that has `partAt` (0.1.0+202610060340 and later), ask it instead of pressing: no touch is started,
//      and each point is answered at once.
//      MODE=partAt node probe.mjs 400 680 face.json 0.006 -0.10 0.10 0.105 0.215
//      MODE=partAt node probe.mjs 400 680 boots.json 0.01 -0.15 0.15 0.76 0.99
//      With an older page, leave MODE out: each point is pressed (PAUSE=700 for her face: a tap on her head starts a
//      resting stroke that a later press would end, so each point is pressed twice after a pause and must agree).
//   4. python3 zones.py 1 face.json boots.json   (prints the zones as Swift)
//
// Usage: node probe.mjs <width> <height> <out.json> [step] [u0 u1 v0 v1 ...]
import { writeFileSync } from 'node:fs';

const [width, height, out, stepArg, ...bandArgs] = process.argv.slice(2);
const step = Number(stepArg ?? 0.006);
const bands = [];
for (let i = 0; i + 3 < bandArgs.length; i += 4) bands.push(bandArgs.slice(i, i + 4).map(Number));
if (!bands.length) bands.push([-0.45, 0.45, 0.0, 1.0]);

const version = await (await fetch('http://127.0.0.1:9333/json/version')).json();
const target = await (await fetch('http://127.0.0.1:9333/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => {
  const m = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (m.result?.exceptionDetails) throw new Error(JSON.stringify(m.result.exceptionDetails));
  return m.result?.result?.value;
};

await send('Emulation.setDeviceMetricsOverride', { width: Number(width), height: Number(height), deviceScaleFactor: 2, mobile: false });
await send('Page.enable');
await send('Page.navigate', { url: 'http://127.0.0.1:8766/embed.html' });
const ready = await evaluate(`new Promise(resolve => {
  const t0 = performance.now();
  (function wait() {
    if (window.shannonBody && document.querySelector('#stage canvas')) return setTimeout(() => resolve(true), 4000);
    if (performance.now() - t0 > 60000) return resolve(false);
    setTimeout(wait, 200);
  })();
})`);
if (!ready) throw new Error('page not ready');
const result = await evaluate(`(async () => {
  window.__msgs = [];
  window.webkit = { messageHandlers: { shannonBody: { postMessage: m => window.__msgs.push(JSON.parse(JSON.stringify(m))) } } };
  window.shannonBody.setLayout({ mode: 'full', scale: 1, offsetX: 0, offsetY: 0, fit: 'contain' });
  window.shannonBody.setTouchEnabled(true);
  window.shannonBody.setIdle({ gestures: false, sway: 0 });
  await new Promise(r => setTimeout(r, 1500));
  const busy = ms => { const t = performance.now(); while (performance.now() - t < ms) {} };
  const wait = ms => new Promise(res => setTimeout(res, ms));
  const press = async (x, y, hold) => {
    const opts = { clientX: x, clientY: y, button: 0, buttons: 1, bubbles: true, cancelable: true };
    window.dispatchEvent(new MouseEvent('mousedown', opts));
    await wait(hold);
    window.dispatchEvent(new MouseEvent('mouseup', opts));
  };
  // One short press, then everything the page says before the next one; a press on empty space between samples ends
  // anything the page still holds, so that no answer is credited to the next point.
  const code = async (x, y) => {
    await press(1, 1, 5); await wait(40);
    window.__msgs = [];
    await press(x, y, 30);
    await wait(70);
    const touches = window.__msgs.filter(m => m.type === 'touch');
    if (touches.length > 1) return 'MULTI';
    if (touches.length) return touches[0].touch.part ?? '?';
    return window.__msgs.some(m => m.type === 'tap') ? 'TAP' : '';
  };
  // A light tap on the head starts a resting stroke that a later press may end: such an answer is not this point's.
  // So a point is asked again after a pause long enough for any episode to end, and kept only when both agree.
  const asked = (x, y) => {
    const r = window.shannonBody.partAt(x, y);
    return r ? (r.part === 'other' ? 'TAP' : r.part) : '';
  };
  const settled = async (x, y) => {
    if (${JSON.stringify(process.env.MODE ?? '')} === 'partAt') return asked(x, y);
    const first = await code(x, y);
    await press(1, 1, 5); await wait(${Number(process.env.PAUSE ?? 0)});
    if (!${process.env.PAUSE ? 'true' : 'false'}) return first;
    const second = await code(x, y);
    await press(1, 1, 5); await wait(${Number(process.env.PAUSE ?? 0)});
    return first === second ? first : 'MIXED:' + first + '/' + second;
  };
  const bands = ${JSON.stringify(bands)}, step = ${step};
  const r = document.getElementById('stage').getBoundingClientRect();
  const samples = [];
  for (const [u0, u1, v0, v1] of bands) {
    for (let v = v0; v <= v1 + 1e-9; v += step) {
      for (let u = u0; u <= u1 + 1e-9; u += step) {
        const x = r.left + r.width / 2 + u * r.height, y = r.top + v * r.height;
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
        samples.push([+u.toFixed(4), +v.toFixed(4), await settled(x, y)]);
      }
      await new Promise(res => setTimeout(res, 0));
    }
  }
  const after = document.getElementById('stage').getBoundingClientRect();
  return { viewport: [innerWidth, innerHeight], stage: [r.left, r.top, r.width, r.height], same: after.top === r.top && after.height === r.height, version: window.shannonBody.version, samples };
})()`);
writeFileSync(out, JSON.stringify(result));
const counts = {};
for (const [, , c] of result.samples) counts[c] = (counts[c] ?? 0) + 1;
console.log(JSON.stringify({ browser: version.Browser, viewport: result.viewport, stage: result.stage, same: result.same, version: result.version, n: result.samples.length, counts }));
await send('Target.closeTarget', { targetId: target.id });
ws.close();
