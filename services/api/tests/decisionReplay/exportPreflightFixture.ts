import { readFileSync, writeFileSync } from 'node:fs';
import { answerOf, contextOf } from './checks.js';
import { candidatesOf, loadJudged } from './judge.js';
import { loadRuns } from './load.js';
import { frameBefore, resultsByDecision } from './preflightFrames.js';
import { decisionOf, loadScenes } from './score.js';
import { preflightAct } from '../../src/surfaces/minecraft/minecraftLlmcPreflight.js';
import type { ResultRow } from './run.js';

/**
 * 守りの試験の控え（tests/fixtures/act-preflight-*.json）を、本番の記録と再現台の答えから作る。
 *   node --import tsx tests/decisionReplay/exportPreflightFixture.ts <出力フォルダ>
 * 地図は、段の層だけに切る（上からの 21×21 の格子と縦の行は守りが読まない）。
 */
const out = process.argv[2];
if (!out) throw new Error('usage: exportPreflightFixture.ts <dir>');
const p = (name: string) => new URL(`./data/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const runs = loadRuns(p('export1.txt'), p('journal.txt'));
const trim = (map: string | undefined) => {
  const lines = (map ?? '').split('\n');
  const first = lines.findIndex((line, index) => index > 0 && /^y=/u.test(line));
  const last = lines.findIndex(line => line.startsWith('縦 '));
  return [lines[0], ...lines.slice(first < 0 ? 1 : first, last < 0 ? undefined : last)].join('\n');
};
const lineOf = (text: string) => text.split('\n').flatMap(line => { const m = /^(\d+) (\w+) (済|止|失|未) ([^:：\s]*)/u.exec(line); return m ? [{ i: +m[1]!, do: m[2]!, status: m[3]!, word: m[4]! }] : []; });

const acts: unknown[] = [];
let clean = 0;
for (const run of runs.values()) {
  const info = resultsByDecision(run);
  for (const d of info.ds) {
    const answer = answerOf((d.assistant?.content ?? []) as never);
    if (answer.tool !== 'mc.act' || !answer.hands.some(hand => hand.do === 'walk' || hand.do === 'place')) continue;
    const frame = frameBefore(info, d.index, d.live);
    if (!frame.map || !frame.feet) continue;
    const lines = lineOf(d.resultText);
    const stop = preflightAct(answer.input, { map: frame.map, feet: frame.feet });
    const realStop = lines.some(line => (line.status === '止' || line.status === '失') && (line.do === 'walk' || line.do === 'place'));
    if (!stop && !realStop && (clean += 1) % 3 !== 0) continue;
    acts.push({ run: run.key, seq: d.row.seq, from: frame.from, feet: frame.feet, map: trim(frame.map), input: { hands: answer.hands }, lines });
  }
}
writeFileSync(`${out}/act-preflight-recorded-v1.json`, `${JSON.stringify({ note: '実走32〜34 の本番の mc.act の答えと、体の実際の結果の行。地図は act を送る時に体が持っていた最新の地図の見積もり（直前の act の終わりの地図）。', acts })}\n`);

const rows = readFileSync(p('results.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as ResultRow);
const judged = loadJudged(p('judge.jsonl'));
const frames = new Map([...runs].map(([key, run]) => [key, resultsByDecision(run)]));
const scenes: Record<string, unknown> = {}, answers: unknown[] = [];
for (const scene of loadScenes()) {
  const decision = decisionOf(runs, scene);
  const frame = frameBefore(frames.get(scene.run)!, decision.index, decision.live);
  void contextOf;
  scenes[scene.id] = { map: trim(frame.map), feet: frame.feet };
  for (const item of candidatesOf(scene, decision, rows)) {
    if (item.answer.tool !== 'mc.act') continue;
    const judge = judged.get(`${scene.id}|${item.key}`);
    const verdict = item.score.verdict === '×' ? '×' : item.score.verdict === '○' && scene.judge !== 'always' ? '○' : judge?.verdict ?? item.score.verdict;
    answers.push({ scene: scene.id, key: item.key, verdict, input: { hands: item.answer.hands } });
  }
}
writeFileSync(`${out}/act-preflight-replay-v1.json`, `${JSON.stringify({ note: '再現台の場面（32）の地図と、v1〜v3・本番の記録の mc.act の答えの採点（○△×）。', scenes, answers })}\n`);
console.log(`recorded acts ${acts.length}, replay scenes ${Object.keys(scenes).length}, answers ${answers.length}`);
