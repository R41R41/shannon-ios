import { readFileSync } from 'node:fs';
import { answerOf, contextOf, walksIntoBlock } from './checks.js';
import { candidatesOf, loadJudged } from './judge.js';
import { loadRuns } from './load.js';
import { frameBefore, posOf, resultsByDecision } from './preflightFrames.js';
import { decisionOf, loadScenes } from './score.js';
import { preflightAct, preflightText } from '../../src/surfaces/minecraft/minecraftLlmcPreflight.js';
import type { ResultRow } from './run.js';

/**
 * 送る前の守り（minecraftLlmcPreflight.ts）の確かめ。
 * 1. 本番の記録: 実走32〜34 の全判断（mc.act の答え）に守りをかけ、体の実際の結果（結果の行）と照らす。
 *    本物の体が「済」にした手を守りが止めたら、誤って止めた数に入れる。地図は 2 通り: 判断の live の地図（先に聞く判断では古いことがある）と、
 *    直前の act の終わりの地図（act を送る時に体が持っていた最新の地図の見積もり。本番の守りは最新のフレームの地図を読む）。
 * 2. 再現台の答え（v1〜v3 と本番の記録）: 採点の ○△× と照らす。○ の答えを止めたら誤って止めた数。
 *   node --import tsx tests/decisionReplay/preflightEval.ts [--detail]
 */
const p = (name: string) => new URL(`./data/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const detail = process.argv.includes('--detail');
const options = { route: process.env.PREFLIGHT_ROUTE !== '0' };
const runs = loadRuns(p('export1.txt'), p('journal.txt'));
/** 実走27〜31（別の控え。場面には使わず、守りの誤って止めた数を数えるのに使う）。 */
const older = loadRuns(p('export2.txt'));
const groups: Array<[string, typeof runs]> = [['実走32〜34', runs], ['実走27〜31', older]];

interface Line { i: number; do: string; status: string; text: string }
function resultLines(text: string): Line[] {
  return text.split('\n').flatMap(line => { const m = /^(\d+) (\w+) (済|止|失|未) (.*)$/u.exec(line); return m ? [{ i: +m[1]!, do: m[2]!, status: m[3]!, text: m[4]! }] : []; });
}
const ownStop = (line: Line | undefined) => !!line && ((line.do === 'walk' && /^一歩ではない/u.test(line.text)) || (line.do === 'place' && /^置けない/u.test(line.text)));

for (const [label, group] of groups) for (const mode of ['live', 'fresh'] as const) {
  console.log(`## 1. 本番の記録（${label} の mc.act）: 地図 = ${mode === 'live' ? '判断の live の地図' : '直前の act の終わりの地図（無ければ live）'}\n`);
  const tally = { acts: 0, withMap: 0, fresh: 0, flagged: 0, sameStop: 0, otherStop: 0, earlierStop: 0, falseStop: 0, none: 0 };
  const falseList: string[] = [], flaggedList: string[] = [], missed: string[] = [];
  const byCode = new Map<string, number>();
  let walkStops = 0, walkStopsCaught = 0, placeStops = 0, placeStopsCaught = 0;
  const before: number[] = [];
  for (const run of group.values()) {
    const info = resultsByDecision(run);
    for (const d of info.ds) {
      const answer = answerOf((d.assistant?.content ?? []) as never);
      if (answer.tool !== 'mc.act') continue;
      tally.acts += 1;
      const frame = mode === 'fresh' ? frameBefore(info, d.index, d.live) : { map: (d.live.body ?? {}).map as string | undefined, feet: posOf((d.live.body ?? {}).state?.at), from: 'live' as const };
      if (frame.from === 'previous-act') tally.fresh += 1;
      if (frame.map && frame.feet) tally.withMap += 1;
      const stop = preflightAct(answer.input, { map: frame.map, feet: frame.feet }, options);
      const lines = resultLines(d.resultText);
      const own = lines.find(line => (line.status === '止' || line.status === '失') && ownStop(line));
      if (own?.do === 'walk') walkStops += 1;
      if (own?.do === 'place') placeStops += 1;
      if (stop) {
        tally.flagged += 1;
        byCode.set(stop.code, (byCode.get(stop.code) ?? 0) + 1);
        const at = lines.find(line => line.i === stop.hand);
        const tag = `${run.key} seq${d.row.seq} 手${stop.hand} ${stop.kind} ${stop.code} ${stop.why.slice(0, 70)}`;
        let kind: string;
        if (!at) { kind = 'none'; tally.none += 1; }
        else if (at.status === '済') { kind = 'falseStop'; tally.falseStop += 1; falseList.push(`${tag} | 体は済: ${at.text.slice(0, 90)}`); }
        else if (at.status === '未') { kind = 'earlierStop'; tally.earlierStop += 1; }
        else if (ownStop(at)) { kind = 'sameStop'; tally.sameStop += 1; }
        else { kind = 'otherStop'; tally.otherStop += 1; }
        before.push(stop.hand - 1);
        flaggedList.push(`${kind} ${tag}${frame.from === 'live' ? '' : ' [前の act の地図]'}`);
        if (own) { if (own.do === 'walk') walkStopsCaught += 1; else placeStopsCaught += 1; }
      } else if (own) missed.push(`${run.key} seq${d.row.seq} 手${own.i} ${own.do}: ${own.text.slice(0, 140)}`);
    }
  }
  console.log(`- mc.act の答え ${tally.acts}（地図と足の場所がある ${tally.withMap}、前の act の終わりの地図を使えた ${tally.fresh}）`);
  console.log(`- 守りが止めた ${tally.flagged}: 体も同じ手で止まった ${tally.sameStop}、体は別の理由で止まった ${tally.otherStop}、その手の前で別の手が止まり未実行 ${tally.earlierStop}、**体は済にした（誤って止めた）${tally.falseStop}**、結果の行なし ${tally.none}`);
  console.log(`- 理由別: ${[...byCode].map(([code, n]) => `${code} ${n}`).join('、') || '-'}`);
  console.log(`- 体が自分で出した 一歩ではない（walk）${walkStops} のうち守りが先に止めた ${walkStopsCaught}、置けない（place）${placeStops} のうち ${placeStopsCaught}`);
  console.log(`- 止めた手の前にあった手の数（止めたせいで動かない手）: ${before.length ? `平均 ${(before.reduce((a, b) => a + b, 0) / before.length).toFixed(1)}、0 個 ${before.filter(n => n === 0).length}、1 個以上 ${before.filter(n => n > 0).length}` : '-'}`);
  if (detail) { console.log('\n止めた物:'); flaggedList.forEach(line => console.log(`  ${line}`)); }
  if (falseList.length) { console.log('\n誤って止めた:'); falseList.forEach(line => console.log(`  ${line}`)); }
  if (detail && missed.length) { console.log('\n体の止まりで守りが拾えなかった物:'); missed.forEach(line => console.log(`  ${line}`)); }
  console.log('');
}

console.log('## 2. 再現台の答え（v1〜v3 と本番の記録）。地図は場面の判断の live\n');
const rows = readFileSync(p('results.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as ResultRow);
const judged = loadJudged(p('judge.jsonl'));
const stats = { answers: 0, acts: 0, stopped: 0, byVerdict: { '○': 0, '△': 0, '×': 0, '?': 0 } as Record<string, number>, stoppedByVerdict: { '○': 0, '△': 0, '×': 0, '?': 0 } as Record<string, number>, autoWalk: 0, autoWalkStopped: 0 };
const wrong: string[] = [], notCaught: string[] = [];
const frames = new Map([...runs].map(([key, run]) => [key, resultsByDecision(run)]));
for (const scene of loadScenes()) {
  const decision = decisionOf(runs, scene);
  const frame = frameBefore(frames.get(scene.run)!, decision.index, decision.live);
  const context = contextOf(decision);
  for (const item of candidatesOf(scene, decision, rows)) {
    stats.answers += 1;
    const judge = judged.get(`${scene.id}|${item.key}`);
    const verdict = item.score.verdict === '×' ? '×' : item.score.verdict === '○' && scene.judge !== 'always' ? '○' : judge?.verdict ?? item.score.verdict;
    stats.byVerdict[verdict] = (stats.byVerdict[verdict] ?? 0) + 1;
    if (item.answer.tool !== 'mc.act') continue;
    stats.acts += 1;
    const stop = preflightAct(item.answer.input, { map: frame.map, feet: frame.feet }, options);
    const auto = walksIntoBlock(item.answer, context);
    if (auto) stats.autoWalk += 1;
    if (stop) {
      stats.stopped += 1;
      stats.stoppedByVerdict[verdict] = (stats.stoppedByVerdict[verdict] ?? 0) + 1;
      if (auto) stats.autoWalkStopped += 1;
      if (verdict !== '×') wrong.push(`${scene.id} ${item.key} 採点${verdict} 守り: 手${stop.hand} ${stop.kind} ${stop.code} ${stop.why.slice(0, 90)}${auto ? '' : ' （再現台の自動検査には当たらない）'}`);
    } else if (auto) notCaught.push(`${scene.id} ${item.key} 採点${verdict} 自動検査: ${auto}`);
  }
}
console.log(`- 答え ${stats.answers}、うち mc.act ${stats.acts}。採点: ○ ${stats.byVerdict['○']}・△ ${stats.byVerdict['△']}・× ${stats.byVerdict['×']}・未採点 ${stats.byVerdict['?']}`);
console.log(`- 守りが止めた ${stats.stopped}（採点 ○ ${stats.stoppedByVerdict['○']}・△ ${stats.stoppedByVerdict['△']}・× ${stats.stoppedByVerdict['×']}・未採点 ${stats.stoppedByVerdict['?']}）。**○ か △ の答えを止めた ${(stats.stoppedByVerdict['○'] ?? 0) + (stats.stoppedByVerdict['△'] ?? 0)}**`);
console.log(`- 再現台の自動検査（塞がったマス・床の無いマス・1 段の上り下りへの walk）に当たった答え ${stats.autoWalk} のうち、守りも止めた ${stats.autoWalkStopped}`);
if (wrong.length) { console.log('\n○△ なのに止めた:'); wrong.forEach(line => console.log(`  ${line}`)); }
if (detail && notCaught.length) { console.log('\n自動検査に当たるが守りが止めなかった:'); notCaught.forEach(line => console.log(`  ${line}`)); }
export { preflightText };
