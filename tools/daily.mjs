#!/usr/bin/env node
// Daily in-house measurement (3 days from 2026-11-11). Masked output only.
//   node tools/daily.mjs            -> docs/results/daily/<date>.md + one line appended to summary.txt (also printed)
// Reads the whole ~/.claude/projects and ~/.codex/sessions of this Mac (limits are per account, not per folder).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, run, renderText, statusObject } from '../engine-node/fleetpace-report.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.FLEETPACE_HOME ||= path.join(root, '.cache'); // in-house cache stays inside this repo (git-ignored)
const dir = path.join(root, 'docs/results/daily');
fs.mkdirSync(dir, { recursive: true });
const o = parseArgs(['--lang', 'ko', '--quiet', ...process.argv.slice(2)]);
const t0 = Date.now();
const r = run({ ...o, mask: true });
const st = statusObject(r, 'ko');
const d = new Date(), pad2 = (x) => String(x).padStart(2, '0');
const day = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`, hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const L = r.limits, w = L.worst;
const line = [
  `${day} ${hm}`,
  `${r.days}일 한도 창 ${L.windows}(주간 ${L.weekly}·5시간 ${L.fiveHour}${L.codexWindows ? `·Codex ${L.codexWindows}` : ''})`,
  w ? `가장 아까운 ${w.kind === 'five_hour' ? '5시간' : '주간'} 리셋 ${w.leftHours}시간 전` : '걸림 없음',
  `하위 ${r.burn.subPct}%·상위10% ${r.burn.top10Pct}%`,
  `최대 동시 ${r.concurrency.peak}`,
  `지금: ${st.line}`,
].join(' · ');
const md = `# Fleetpace 사내 측정 — ${day} ${hm}

> 이 맥 전체 기록(가림 켬). 읽은 것: 시각·토큰 숫자·오류 종류·하위 에이전트 이름표 첫 낱말(가림). 대화 글 0.
> 만든 명령: \`node tools/daily.mjs\` · 걸린 시간 ${((Date.now() - t0) / 1000).toFixed(1)}초 · 기록 ${r.scope.logGigabytes}GB 중 새로 읽은 것 ${r.scope.readGigabytes}GB

## 한 줄
${line}

## 리포트 (터미널 화면 그대로)
\`\`\`
${renderText(r, 'ko')}
\`\`\`

## status --json
\`\`\`json
${JSON.stringify(st, null, 2)}
\`\`\`

## 한도 창 목록
| 어디 | 종류 | 처음 걸림 | 리셋 | 리셋까지 남은 시간 | 줄 수 | 누가 |
|---|---|---|---|---|---|---|
${L.list.map((x) => `| ${x.src} | ${x.kind} | ${x.firstHit} | ${x.reset} | ${x.leftHours}시간 | ${x.hits} | ${x.by} |`).join('\n')}
`;
fs.writeFileSync(path.join(dir, `${day}.md`), md);
fs.appendFileSync(path.join(dir, 'summary.txt'), line + '\n');
console.log(line);
