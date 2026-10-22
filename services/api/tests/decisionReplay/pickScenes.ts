import { answerOf } from './checks.js';
import { loadAllRuns } from './allRuns.js';
import { decisions } from './load.js';
import { loadScenes } from './score.js';

/** 場面を足す候補の一覧（API を使わない）。run ごとに、判断の連番・epoch・敵の数・急ぎの行・直前の止まり・答えの道具を並べる。 */
const runs = loadAllRuns();
const used = new Set(loadScenes().map(scene => `${scene.run}:${scene.seq}`));
const only = process.argv[2];
for (const [key, run] of runs) {
  if (only && key !== only) continue;
  console.log(`== ${key} 判断 ${run.rows.length} 件`);
  for (const d of decisions(run)) {
    const body = (d.live.body ?? {}) as Record<string, any>, state = (body.state ?? {}) as Record<string, any>;
    const answer = answerOf((d.assistant?.content ?? []) as never);
    const last = Array.isArray(body.lastResults) && typeof body.lastResults[0] === 'string' ? String(body.lastResults[0]).split('\n')[0]!.slice(0, 50) : '';
    const stopped = /(止|失) /u.test(last) ? 'STOP' : '';
    console.log([used.has(`${key}:${d.row.seq}`) ? 'USED' : '    ', `seq=${d.row.seq}`, `e${d.epoch}`, `i${d.index}`, `min=${state.minutes ?? '?'}`, `hp=${state.health ?? '?'}`,
      `thr=${Array.isArray(body.threats) ? body.threats.length : 0}`, `urg=${Array.isArray(body.urgent) ? body.urgent.length : 0}`, stopped, answer.tool ?? '-', `hands=${answer.hands.length}`, last].join(' '));
  }
}
