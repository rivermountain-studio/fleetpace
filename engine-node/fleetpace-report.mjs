#!/usr/bin/env node
// Fleetpace report — a local, read-only "limit pace" report for people who run many AI coding agents.
// Reads ONLY: line timestamps, line kinds, token counts, model names, rate-limit error fields,
// sub-agent labels (.meta.json description/agentType/model) and Codex rate-limit snapshots.
// Never reads conversation text, credentials or keychains, and never touches the network.
// One file, zero dependencies, Node 18+.  MIT License.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// ---------- constants (the only place to tune) ----------
export const NAME = 'Fleetpace';
export const VERSION = '0.1.0';
// "burn" = input + 5*output + 1.25*cache write + 0.1*cache read, times a model weight. Always shown as "about".
export const WEIGHT = { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 };
export const MODEL_WEIGHT = [[/haiku/i, 0.2], [/sonnet/i, 0.6]]; // anything else counts as a large model: 1.0
const BUCKET = 600;                       // seconds per burn bucket
const SMALL = 12288, HEAD = 4096, TAIL = 8192, // long lines keep only head + tail: id/model/kind at the start, usage/timestamp/cwd at the end
  CHUNK = 1 << 20;
const H = 3600, D = 86400;
const WIN = { five_hour: 5 * H, seven_day: 7 * D };
const CACHE_VER = 1;
const UNKNOWN_WARN = 0.2;                 // >20% unreadable lines -> "this version is not fully readable yet"

// ---------- words (4 languages, one object) ----------
const T = {
  ko: {
    title: (d) => `${NAME} 리포트 — 최근 ${d}일 (이 컴퓨터, 밖으로 보내는 것 없음)`,
    windows: '한도에 걸린 창', worst: '가장 아까운 한 번', peakDay: '가장 많이 태운 날',
    burn: '누가 태웠나', conc: '동시에 돈 최대', idle: '전원 정지', pace: '지금 페이스',
    winVal: (n, w, f, c) => `${n}개  (주간 ${w} · 5시간 ${f}${c ? ` · Codex ${c}` : ''})`,
    worstVal: (k, left, at) => `${k === 'five_hour' ? '5시간' : '주간'} 한도를 리셋 ${left} 전에 다 씀 (${at})`,
    peakVal: (at, x) => `${at} (하루 평균의 ${x}배)`,
    burnVal: (s, t) => `하위 에이전트 ${s}% · 상위 10% 실행이 ${t}%`,
    rank: (i) => `${i}위`, concVal: (n, h) => `${n}개 (3개 이상 ${h}시간)`,
    idleVal: (h, d) => `${h}시간 (평일 낮 ${d}시간)`,
    paceTight: (k, p, at, r) => `${k} 약 ${p}% — 이대로면 ${at} 바닥 (리셋 ${r})`,
    paceOk: (k, p, r) => `${k} 약 ${p}% — 리셋(${r})까지 감`,
    paceBlocked: (k, r, m) => `${k} 한도 걸림${m ? '(계정 중 하나)' : ''} — 리셋 ${r}`,
    paceNone: '값 없음 — 한도에 한 번 걸린 기록이 있어야 추정됩니다',
    paceRolling: (k, p) => `${k} 약 ${p}% (최근 5시간 기준)`,
    paceOver: (k, p) => `${k} 약 ${p}% — 추정을 넘음(다른 계정·모델 사용분이 섞였을 수 있음)`,
    paceMixed: (k) => `${k} 추정 안 함 — 리셋 시각이 둘 이상(계정이 여럿으로 보임)`,
    codexVal: (k, p, r) => `Codex ${k} ${p}% · 리셋 ${r}`,
    codexTight: (k, p, at) => `Codex ${k} ${p}% — 이대로면 ${at} 바닥`,
    week: '주간', five: '5시간', day: '일', hour: '시간',
    teams: '팀별 소모 (약, 가중 토큰)', projects: '프로젝트별', other: '그 밖', lead: '지휘 세션',
    team: '팀', project: '프로젝트', noLabel: '(이름 없음)',
    runs: (n) => `${n}번`,
    card: (f, m) => `→ 카드로 저장: ${f}   (이름·경로 가림: ${m ? '켬' : '끔'})`,
    tray: '→ 상시로 보기: 트레이 앱은 준비 중입니다',
    nothing: '기록을 찾지 못했습니다 (~/.claude/projects, ~/.codex/sessions).\n  다른 곳이면 --claude-dir 로 알려 주세요.',
    unknownFmt: (p) => `이 버전 기록은 아직 다 못 읽습니다 (모르는 줄 ${p}%)`,
    skipped: (n) => `읽지 못한 파일 ${n}개 (권한 등) — 건너뜀`,
    progress: (g) => `읽는 중… ${g}GB`,
    wd: ['일', '월', '화', '수', '목', '금', '토'],
    badDays: '--days 는 1~365 사이 숫자여야 합니다 (예: --days 30)',
    badLang: '--lang 은 ko, en, ja, zh 중 하나여야 합니다',
    badOpt: (o) => `모르는 옵션: ${o}  (도움말: --help)`,
  },
  en: {
    title: (d) => `${NAME} report — last ${d} days (this computer, nothing leaves it)`,
    windows: 'Limit windows hit', worst: 'Costliest hit', peakDay: 'Heaviest day',
    burn: 'Who burned it', conc: 'Peak concurrency', idle: 'Fleet fully idle', pace: 'Pace now',
    winVal: (n, w, f, c) => `${n}  (weekly ${w} · 5-hour ${f}${c ? ` · Codex ${c}` : ''})`,
    worstVal: (k, left, at) => `${k === 'five_hour' ? '5-hour' : 'Weekly'} limit used up ${left} before reset (${at})`,
    peakVal: (at, x) => `${at} (${x}x a normal day)`,
    burnVal: (s, t) => `sub-agents ${s}% · top 10% of runs ${t}%`,
    rank: (i) => `#${i}`, concVal: (n, h) => `${n} agents (3+ for ${h}h)`,
    idleVal: (h, d) => `${h}h (weekday daytime ${d}h)`,
    paceTight: (k, p, at, r) => `${k} ~${p}% — runs out ${at} (reset ${r})`,
    paceOk: (k, p, r) => `${k} ~${p}% — lasts until reset (${r})`,
    paceBlocked: (k, r, m) => `${k} limit hit${m ? ' (one account)' : ''} — resets ${r}`,
    paceNone: 'no value yet — needs at least one past limit hit to estimate',
    paceRolling: (k, p) => `${k} ~${p}% (last 5 hours)`,
    paceOver: (k, p) => `${k} ~${p}% — above the estimate (another account or model may be mixed in)`,
    paceMixed: (k) => `${k} not estimated — resets on more than one clock (several accounts?)`,
    codexVal: (k, p, r) => `Codex ${k} ${p}% · resets ${r}`,
    codexTight: (k, p, at) => `Codex ${k} ${p}% — runs out ${at}`,
    week: 'Weekly', five: '5-hour', day: 'd', hour: 'h',
    teams: 'Burn by team (approx., weighted tokens)', projects: 'By project', other: 'others', lead: 'lead session',
    team: 'Team', project: 'Project', noLabel: '(no label)',
    runs: (n) => (n === 1 ? '1 run' : `${n} runs`),
    card: (f, m) => `→ Card saved: ${f}   (names & paths masked: ${m ? 'on' : 'off'})`,
    tray: '→ Always-on view: tray app coming soon',
    nothing: 'No records found (~/.claude/projects, ~/.codex/sessions).\n  Point to another place with --claude-dir.',
    unknownFmt: (p) => `This log version is not fully readable yet (${p}% unknown lines)`,
    skipped: (n) => `${n} files could not be read (permissions etc.) — skipped`,
    progress: (g) => `reading… ${g} GB`,
    wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    badDays: '--days must be a number from 1 to 365 (e.g. --days 30)',
    badLang: '--lang must be one of ko, en, ja, zh',
    badOpt: (o) => `Unknown option: ${o}  (see --help)`,
  },
  ja: {
    title: (d) => `${NAME} レポート — 直近${d}日（このPCのみ・外部送信なし）`,
    windows: '上限に達した枠', worst: 'いちばん惜しい1回', peakDay: '最も使った日',
    burn: '誰が使ったか', conc: '最大同時実行', idle: '全停止', pace: '現在のペース',
    winVal: (n, w, f, c) => `${n}件（週間 ${w}・5時間 ${f}${c ? `・Codex ${c}` : ''}）`,
    worstVal: (k, left, at) => `${k === 'five_hour' ? '5時間' : '週間'}上限をリセット${left}前に使い切り（${at}）`,
    peakVal: (at, x) => `${at}（1日平均の${x}倍）`,
    burnVal: (s, t) => `サブエージェント ${s}%・上位10%の実行で ${t}%`,
    rank: (i) => `${i}位`, concVal: (n, h) => `${n}個（3個以上 ${h}時間）`,
    idleVal: (h, d) => `${h}時間（平日日中 ${d}時間）`,
    paceTight: (k, p, at, r) => `${k} 約${p}% — このままだと${at}に枯渇（リセット ${r}）`,
    paceOk: (k, p, r) => `${k} 約${p}% — リセット（${r}）まで持ちます`,
    paceBlocked: (k, r, m) => `${k}上限に到達${m ? '（一部アカウント）' : ''}・リセット ${r}`,
    paceNone: 'まだ値がありません — 上限に達した記録が1回以上必要です',
    paceRolling: (k, p) => `${k} 約${p}%（直近5時間）`,
    paceOver: (k, p) => `${k} 約${p}% — 推定を超過（別アカウント・モデルの分が混ざっている可能性）`,
    paceMixed: (k) => `${k} 推定しません — リセット時刻が複数（アカウントが複数の可能性）`,
    codexVal: (k, p, r) => `Codex ${k} ${p}%・リセット ${r}`,
    codexTight: (k, p, at) => `Codex ${k} ${p}% — このままだと${at}に枯渇`,
    week: '週間', five: '5時間', day: '日', hour: '時間',
    teams: 'チーム別の消費（目安・重み付きトークン）', projects: 'プロジェクト別', other: 'その他', lead: '指揮セッション',
    team: 'チーム', project: 'プロジェクト', noLabel: '（名前なし）',
    runs: (n) => `${n}回`,
    card: (f, m) => `→ カードを保存: ${f}（名前・パスの伏せ字: ${m ? 'オン' : 'オフ'}）`,
    tray: '→ 常駐表示: トレイアプリは準備中です',
    nothing: '記録が見つかりません（~/.claude/projects, ~/.codex/sessions）。\n  別の場所なら --claude-dir で指定してください。',
    unknownFmt: (p) => `このバージョンの記録はまだ全部は読めません（不明な行 ${p}%）`,
    skipped: (n) => `読めないファイル ${n}件（権限など）— スキップ`,
    progress: (g) => `読み込み中… ${g}GB`,
    wd: ['日', '月', '火', '水', '木', '金', '土'],
    badDays: '--days は 1〜365 の数字で指定してください（例: --days 30）',
    badLang: '--lang は ko, en, ja, zh のいずれかです',
    badOpt: (o) => `不明なオプション: ${o}（--help を参照）`,
  },
  zh: {
    title: (d) => `${NAME} 报告 — 最近 ${d} 天（仅本机，不向外发送任何数据）`,
    windows: '触及限额的窗口', worst: '最可惜的一次', peakDay: '用量最高的一天',
    burn: '谁用掉的', conc: '最高并发', idle: '全部停工', pace: '当前速度',
    winVal: (n, w, f, c) => `${n} 个（每周 ${w} · 5小时 ${f}${c ? ` · Codex ${c}` : ''}）`,
    worstVal: (k, left, at) => `${k === 'five_hour' ? '5小时' : '每周'}限额在重置前 ${left} 用完（${at}）`,
    peakVal: (at, x) => `${at}（日均的 ${x} 倍）`,
    burnVal: (s, t) => `子代理 ${s}% · 前10%的运行占 ${t}%`,
    rank: (i) => `第${i}`, concVal: (n, h) => `${n} 个（3个以上 ${h} 小时）`,
    idleVal: (h, d) => `${h} 小时（工作日白天 ${d} 小时）`,
    paceTight: (k, p, at, r) => `${k} 约 ${p}% — 照此速度 ${at} 用完（重置 ${r}）`,
    paceOk: (k, p, r) => `${k} 约 ${p}% — 能撑到重置（${r}）`,
    paceBlocked: (k, r, m) => `${k}已触及限额${m ? '（其中一个账号）' : ''} — ${r} 重置`,
    paceNone: '暂无数值 — 至少需要一次触及限额的记录才能估算',
    paceRolling: (k, p) => `${k} 约 ${p}%（最近5小时）`,
    paceOver: (k, p) => `${k} 约 ${p}% — 超出估算（可能混入了其他账号或模型的用量）`,
    paceMixed: (k) => `${k} 不做估算 — 重置时间不止一个（可能有多个账号）`,
    codexVal: (k, p, r) => `Codex ${k} ${p}% · 重置 ${r}`,
    codexTight: (k, p, at) => `Codex ${k} ${p}% — 照此速度 ${at} 用完`,
    week: '每周', five: '5小时', day: '天', hour: '小时',
    teams: '各团队用量（约，加权 token）', projects: '按项目', other: '其他', lead: '主控会话',
    team: '团队', project: '项目', noLabel: '（无名称）',
    runs: (n) => `${n} 次`,
    card: (f, m) => `→ 已保存卡片: ${f}（名称和路径已隐藏: ${m ? '开' : '关'}）`,
    tray: '→ 常驻查看: 托盘应用准备中',
    nothing: '未找到记录（~/.claude/projects, ~/.codex/sessions）。\n  如在别处，请用 --claude-dir 指定。',
    unknownFmt: (p) => `此版本的记录还不能完全读取（未知行 ${p}%）`,
    skipped: (n) => `${n} 个文件无法读取（权限等）— 已跳过`,
    progress: (g) => `读取中… ${g} GB`,
    wd: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
    badDays: '--days 必须是 1 到 365 之间的数字（例如 --days 30）',
    badLang: '--lang 必须是 ko、en、ja、zh 之一',
    badOpt: (o) => `未知选项: ${o}（参见 --help）`,
  },
};
export const LANGS = Object.keys(T);

const HELP = `${NAME} ${VERSION} — local limit-pace report for AI coding agent fleets (unofficial; works with Claude Code and Codex logs)

  node fleetpace-report.mjs [report] [options]     30-second report
  node fleetpace-report.mjs status --json           pace right now, one JSON object

  --days N        period, 1-365 (default 30)
  --lang L        ko | en | ja | zh (default: system language)
  --json          machine-readable output
  --html [FILE]   also save a one-file HTML card (default fleetpace-report.html)
  --no-mask       show real team labels and folder names (default: masked)
  --project DIR   only one project folder (e.g. ~/.claude/projects/<one>)
  --claude-dir D  Claude Code projects folder (default $CLAUDE_CONFIG_DIR/projects or ~/.claude/projects)
  --codex-dir D   Codex sessions folder (default $CODEX_HOME/sessions or ~/.codex/sessions)
  --no-cache      do not read or write ~/.fleetpace/cache-v1.json

Reads only timestamps, token counts, model names and rate-limit error fields. No network. Delete ~/.fleetpace to remove all traces.`;

// ---------- small helpers ----------
const toEpoch = (s) => { const v = Date.parse(s); return Number.isFinite(v) ? v / 1000 : null; };
const r1 = (x) => Math.round(x * 10) / 10;
const pct = (a, b) => (b > 0 ? Math.round((1000 * a) / b) / 10 : 0);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
export function modelWeight(m) { for (const [rx, w] of MODEL_WEIGHT) if (rx.test(m || '')) return w; return 1.0; }
export function burnOf(u, model) {
  return (u.input * WEIGHT.input + u.output * WEIGHT.output + u.cacheWrite * WEIGHT.cacheWrite + u.cacheRead * WEIGHT.cacheRead) * modelWeight(model);
}
export function width(s) { let w = 0; for (const ch of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1; return w; }
const pad = (s, n) => s + ' '.repeat(Math.max(s ? 1 : 0, n - width(s)));
function cut(s, n) { let out = '', w = 0; for (const ch of s) { const cw = width(ch); if (w + cw > n - 1) return out + '…'; out += ch; w += cw; } return out; }
function union(iv) {
  const out = [];
  for (const [s, e] of [...iv].sort((a, b) => a[0] - b[0])) {
    if (e <= s) continue;
    if (out.length && s <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], e);
    else out.push([s, e]);
  }
  return out;
}
const total = (iv) => iv.reduce((a, [s, e]) => a + e - s, 0);
const clip = (iv, a, b) => iv.filter(([s, e]) => e > a && s < b).map(([s, e]) => [Math.max(s, a), Math.min(e, b)]);
function subtract(a, b) {
  const out = [];
  for (const [s, e] of a) {
    let cur = s;
    for (const [bs, be] of b) { if (be <= cur || bs >= e) continue; if (bs > cur) out.push([cur, bs]); cur = Math.max(cur, be); if (cur >= e) break; }
    if (cur < e) out.push([cur, e]);
  }
  return out;
}

// ---------- line reader: bounded memory even for 50MB lines ----------
// Calls onLine(text) per complete line. Lines above SMALL bytes are reduced to head + tail (fields we need live there).
// Returns the byte offset just after the last complete line (a trailing partial line is left for next time).
function readLines(fp, start, onLine, onBytes) {
  const fd = fs.openSync(fp, 'r'), buf = Buffer.allocUnsafe(CHUNK); // one reused buffer; only cross-chunk pieces are copied
  let parts = [], len = 0, head = null, off = start, committed = start;
  const add = (b) => {
    parts.push(b); len += b.length;
    if (len > SMALL + TAIL) {
      const all = Buffer.concat(parts);
      if (!head) head = Buffer.from(all.subarray(0, HEAD));
      parts = [Buffer.from(all.subarray(all.length - TAIL))]; len = TAIL;
    }
  };
  const emit = () => {
    const body = parts.length === 1 ? parts[0] : Buffer.concat(parts);
    onLine(head ? head.toString('utf8') + '\n' + body.toString('utf8') : body.toString('utf8'));
    parts = []; len = 0; head = null;
  };
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, off);
      if (n <= 0) break;
      let pos = 0;
      for (;;) {
        const nl = buf.indexOf(10, pos);
        if (nl < 0 || nl >= n) { if (pos < n) add(Buffer.from(buf.subarray(pos, n))); break; }
        if (!parts.length && nl - pos <= SMALL) onLine(buf.toString('utf8', pos, nl));
        else { add(buf.subarray(pos, nl)); emit(); }
        pos = nl + 1; committed = off + pos;
      }
      off += n; if (onBytes) onBytes(n);
    }
  } finally { fs.closeSync(fd); }
  return committed;
}

// ---------- Claude Code line parsing (regex on allowed fields only) ----------
const RX_TS = /"uuid":"[^"]{8,64}","timestamp":"([^"]+)"/;
const RX_TS_ANY = /"timestamp":"(\d{4}-\d\d-\d\dT[^"]+)"/g;
const RX_TYPE = /"type":"(user|assistant)","(?:message|uuid)"/;
const RX_ROLE = /"message":\{[^{}]{0,300}?"role":"(user|assistant)"/;
const RX_ID = /"id":"(msg_[A-Za-z0-9_-]+)"/;
const RX_MODEL = /"model":"([^"]{1,80})"/;
const RX_STOP = /"stop_reason":"([a-z_]+)"/;
const RX_CWD = /"cwd":"([^"]{1,1000})"/;
const RX_RLT = /"rateLimitType":"([a-z_0-9]+)"/;
const RX_RESET = /"resetsAt":(\d{9,12})/;
const RX_U = { input: /"input_tokens":(\d+)/, output: /"output_tokens":(\d+)/, cacheWrite: /"cache_creation_input_tokens":(\d+)/, cacheRead: /"cache_read_input_tokens":(\d+)/ };

// seven_day, seven_day_overage_included, seven_day_opus ... all count as a weekly window
const normKind = (k) => (k.startsWith('seven_day') ? 'seven_day' : k.startsWith('five_hour') ? 'five_hour' : k);
const baseName = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || '?';
function newClaudeState(kind) {
  return { kind, off: 0, first: null, last: null, burn: {}, hits: [], work: [], open: null, lastId: null, lastW: 0, lastB: 0, lastT: null, model: null, proj: null, lines: 0, bad: 0, future: 0 };
}
function claudeLine(st, s, now) {
  if (s.charCodeAt(s.length - 1) === 13) s = s.slice(0, -1);
  if (!s.length) return;
  st.lines++;
  if (s[0] !== '{' || s[s.length - 1] !== '}') { st.bad++; return; }
  let t = null;
  const m = RX_TS.exec(s);
  if (m) t = toEpoch(m[1]);
  else { let last = null; for (const x of s.matchAll(RX_TS_ANY)) last = x[1]; if (last) t = toEpoch(last); }
  if (t !== null && t > now + 600) { st.future++; return; }
  if (t === null) t = st.lastT; else st.lastT = t;
  if (t === null) return;
  if (st.first === null || t < st.first) st.first = t;
  if (st.last === null || t > st.last) st.last = t;
  if (!st.proj) { const c = RX_CWD.exec(s); if (c) st.proj = baseName(c[1]); }
  if (s.includes('"error":"rate_limit"')) {
    const k = RX_RLT.exec(s), r = RX_RESET.exec(s);
    st.hits.push([t, normKind(k ? k[1] : 'unknown'), r ? +r[1] : 0]);
  }
  const tm = RX_TYPE.exec(s) || RX_ROLE.exec(s);
  const ty = tm ? tm[1] : null;
  const side = s.includes('"isSidechain":true');
  if (ty === 'assistant') {
    const id = RX_ID.exec(s), u = s.lastIndexOf('"usage":{');
    if (id && u >= 0) {
      const us = s.slice(u, u + 4000), g = (k) => { const x = RX_U[k].exec(us); return x ? +x[1] : 0; };
      const mm = RX_MODEL.exec(s), model = mm ? mm[1] : null;
      if (model && model[0] !== '<' && !st.model) st.model = model;
      const w = burnOf({ input: g('input'), output: g('output'), cacheWrite: g('cacheWrite'), cacheRead: g('cacheRead') }, model);
      const b = Math.floor(t / BUCKET);
      if (id[1] === st.lastId) st.burn[st.lastB] -= st.lastW; // same message written again: keep the last copy only
      st.burn[b] = (st.burn[b] || 0) + w;
      st.lastId = id[1]; st.lastW = w; st.lastB = b;
    }
    if (st.kind === 'lead' && !side) {
      if (st.open === null) st.open = t;
      const sr = RX_STOP.exec(s);
      if (sr && sr[1] === 'end_turn') { st.work.push([st.open, t]); st.open = null; }
    }
  } else if (ty === 'user' && st.kind === 'lead' && !side) {
    if (s.includes('"isMeta":true') || s.includes('"type":"tool_result"')) return;
    if (st.open === null) st.open = t;
  }
}

// ---------- Codex rollout parsing (token_count rate-limit snapshots only) ----------
function newCodexState() { return { kind: 'codex', off: 0, hits: [], series: { five_hour: [], seven_day: [] }, snap: null, lines: 0, bad: 0, first: null, last: null, burn: {} }; }
const codexKind = (x, fallback) => (x && +x.window_minutes === 300 ? 'five_hour' : x && +x.window_minutes === 10080 ? 'seven_day' : fallback);
function codexLine(st, s, now) {
  if (!s.includes('"token_count"')) return;
  st.lines++;
  if (s.length > SMALL) return;
  let d; try { d = JSON.parse(s); } catch { st.bad++; return; }
  const p = d && d.payload, t = toEpoch((d && d.timestamp) || '');
  if (!p || p.type !== 'token_count' || t === null || t > now + 600) return;
  const rl = p.rate_limits; if (!rl || typeof rl !== 'object') return;
  if (st.first === null || t < st.first) st.first = t;
  if (st.last === null || t > st.last) st.last = t;
  const snap = { t };
  for (const [key, fb] of [['primary', 'five_hour'], ['secondary', 'seven_day']]) {
    const x = rl[key]; if (!x || typeof x !== 'object') continue;
    const kind = codexKind(x, fb), used = +x.used_percent, reset = +x.resets_at || 0;
    if (!Number.isFinite(used)) continue;
    snap[kind] = { pct: used, reset };
    const ser = st.series[kind] || (st.series[kind] = []), b = Math.floor(t / BUCKET), lastP = ser[ser.length - 1];
    if (lastP && Math.floor(lastP[0] / BUCKET) === b) ser[ser.length - 1] = [t, used, reset]; else ser.push([t, used, reset]);
    if (used >= 100) addHit(st, [t, kind, reset]);
  }
  if (rl.rate_limit_reached_type) { const k = /week|second|seven/i.test(String(rl.rate_limit_reached_type)) ? 'seven_day' : 'five_hour'; addHit(st, [t, k, snap[k] ? snap[k].reset : 0]); }
  if (!st.snap || t >= st.snap.t) st.snap = snap;
}
function addHit(st, h) {
  const l = st.hits[st.hits.length - 1];
  if (l && l[1] === h[1] && Math.abs(l[2] - h[2]) < 600) return;
  st.hits.push(h);
}

// ---------- finding files (no symlink following for folders) ----------
function listDir(dir) { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; } }
export function findSources(o) {
  const home = o.home || os.homedir();
  const claudeRoot = o.claudeDir || (process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, 'projects') : path.join(home, '.claude', 'projects'));
  const codexRoot = o.codexDir || (process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, 'sessions') : path.join(home, '.codex', 'sessions'));
  const files = [], out = { files, roots: { claude: false, codex: false }, skipped: 0 };
  const projects = [];
  if (o.project) projects.push(o.project);
  else { const ents = listDir(claudeRoot); if (ents) { out.roots.claude = true; for (const e of ents) if (e.isDirectory()) projects.push(path.join(claudeRoot, e.name)); } }
  for (const pd of projects) {
    const ents = listDir(pd); if (!ents) { if (o.project) out.skipped++; continue; }
    out.roots.claude = true;
    for (const e of ents) {
      if (e.isFile() && e.name.endsWith('.jsonl')) files.push({ fp: path.join(pd, e.name), kind: 'lead', pd });
      else if (e.isDirectory()) {
        const sd = path.join(pd, e.name, 'subagents'), se = listDir(sd);
        if (se) for (const f of se) if (f.isFile() && f.name.endsWith('.jsonl')) files.push({ fp: path.join(sd, f.name), kind: 'sub', pd });
      }
    }
  }
  const walk = (dir, depth) => {
    if (depth > 6) return;
    const ents = listDir(dir); if (!ents) return;
    out.roots.codex = true;
    for (const e of ents) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) walk(fp, depth + 1);
      else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) files.push({ fp, kind: 'codex' });
    }
  };
  walk(codexRoot, 0);
  return out;
}

// ---------- cache (numbers only; keys are hashes of paths) ----------
function cacheFile() { return path.join(process.env.FLEETPACE_HOME || path.join(os.homedir(), '.fleetpace'), `cache-v${CACHE_VER}.json`); }
function loadCache(o) {
  if (!o.cache) return { v: CACHE_VER, files: {} };
  try { const c = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')); if (c && c.v === CACHE_VER && c.files) return c; } catch { /* no cache yet */ }
  return { v: CACHE_VER, files: {} };
}
function saveCache(o, c) {
  if (!o.cache) return;
  try { fs.mkdirSync(path.dirname(cacheFile()), { recursive: true }); const tmp = cacheFile() + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(c)); fs.renameSync(tmp, cacheFile()); } catch { /* cache is optional */ }
}
const keyOf = (fp) => crypto.createHash('sha1').update(fp).digest('hex').slice(0, 20);

// ---------- collect: scan new bytes of every file in range ----------
export function collect(o) {
  const t0 = Date.now(), now = o.now, src = findSources(o), cache = loadCache(o), next = { v: CACHE_VER, files: {} };
  // keep entries of files this run did not look at (other projects, older days) unless they are 60+ days old
  for (const [k, c] of Object.entries(cache.files)) if ((c.mtime || 0) >= now - 60 * D) next.files[k] = c;
  const since = now - (o.days + 7) * D; // 7 extra days so weekly windows that started before the period are measured
  const states = []; let logBytes = 0, bytes = 0, shown = false, skipped = src.skipped;
  const T0 = T[o.lang] || T.en;
  const onBytes = (n) => {
    bytes += n;
    if (!o.quiet && process.stderr.isTTY && Date.now() - t0 > 5000) { process.stderr.write('\r' + T0.progress((bytes / 1e9).toFixed(1)) + '   '); shown = true; }
  };
  for (const f of src.files) {
    let stt; try { stt = fs.statSync(f.fp); } catch { skipped++; continue; }
    const k = keyOf(f.fp), c = cache.files[k];
    if (stt.mtimeMs / 1000 < since) continue;
    logBytes += stt.size;
    let st = c && c.ino === stt.ino && c.size <= stt.size && c.st && c.st.kind === f.kind ? c.st : (f.kind === 'codex' ? newCodexState() : newClaudeState(f.kind));
    if (stt.size > st.off) {
      try {
        const fn = f.kind === 'codex' ? codexLine : claudeLine;
        st.off = readLines(f.fp, st.off, (s) => fn(st, s, now), onBytes);
      } catch { skipped++; continue; }
    }
    next.files[k] = { ino: stt.ino, size: stt.size, mtime: stt.mtimeMs / 1000, st };
    const run = { ...st, fp: f.fp, pd: f.pd };
    if (f.kind === 'sub') {
      try { const m = JSON.parse(fs.readFileSync(f.fp.replace(/\.jsonl$/, '.meta.json'), 'utf8')); run.meta = { agentType: m.agentType, description: m.description, model: m.model }; } catch { run.meta = null; }
    }
    states.push(run);
  }
  if (shown) process.stderr.write('\r' + ' '.repeat(40) + '\r');
  saveCache(o, next);
  return { states, roots: src.roots, skipped, bytes, logBytes, seconds: (Date.now() - t0) / 1000 };
}

// ---------- analyze ----------
function sumBurn(states, a, b) {
  let s = 0;
  for (const st of states) for (const k in st.burn) { const t = +k * BUCKET; if (t >= a && t < b) s += st.burn[k]; }
  return s;
}
function groupWindows(hits) {
  const ws = [];
  for (const h of [...hits].sort((x, y) => x.t - y.t)) {
    if (!h.reset) continue;
    const g = ws.find((w) => w.src === h.src && w.kind === h.kind && Math.abs(w.reset - h.reset) < 600);
    if (g) g.hits++; else ws.push({ src: h.src, kind: h.kind, first: h.t, reset: h.reset, hits: 1, by: h.by });
  }
  for (const w of ws) w.leftHours = r1((w.reset - w.first) / H);
  return ws;
}
// Team label = first word of the sub-agent description (two words split one team into hundreds of groups on real logs).
const teamLabel = (d) => (d || '').trim().split(/\s+/)[0] || '';

export function analyze(data, o) {
  const now = o.now, cut = now - o.days * D;
  const claude = data.states.filter((s) => s.kind !== 'codex'), codex = data.states.filter((s) => s.kind === 'codex');
  const subs = claude.filter((s) => s.kind === 'sub'), leads = claude.filter((s) => s.kind === 'lead');
  // limit windows
  const hits = [];
  for (const st of data.states) for (const [t, kind, reset] of st.hits) if (t >= cut && t <= now) hits.push({ t, kind, reset, src: st.kind === 'codex' ? 'codex' : 'claude', by: st.kind });
  const windows = groupWindows(hits);
  const cw = windows.filter((w) => w.src === 'claude');
  const worst = cw.length ? cw.reduce((a, b) => (b.leftHours > a.leftHours ? b : a)) : null;
  // burn
  const burnOfSt = (st) => sumBurn([st], cut, now + 1);
  const leadBurn = leads.reduce((a, s) => a + burnOfSt(s), 0);
  const runs = subs.map((s) => ({ st: s, w: burnOfSt(s), label: (s.meta && teamLabel(s.meta.description)) || '', model: (s.meta && s.meta.model) || s.model || '?' }))
    .filter((r) => r.w > 0 || (r.st.last !== null && r.st.last >= cut));
  const subBurn = runs.reduce((a, r) => a + r.w, 0), all = subBurn + leadBurn;
  const sorted = [...runs].sort((a, b) => b.w - a.w), topN = Math.max(1, Math.floor(runs.length / 10));
  const topShare = runs.length ? pct(sorted.slice(0, topN).reduce((a, r) => a + r.w, 0), all) : 0;
  const byLabel = new Map();
  for (const r of runs) { const g = byLabel.get(r.label) || { label: r.label, w: 0, runs: 0, models: {} }; g.w += r.w; g.runs++; g.models[r.model] = (g.models[r.model] || 0) + r.w; byLabel.set(r.label, g); }
  const teams = [...byLabel.values()].sort((a, b) => b.w - a.w).map((g) => ({ label: g.label, pct: pct(g.w, all), runs: g.runs, model: Object.entries(g.models).sort((a, b) => b[1] - a[1])[0][0] }));
  const byProj = new Map();
  for (const st of claude) { const k = st.proj || baseName(st.pd || '?'); byProj.set(k, (byProj.get(k) || 0) + burnOfSt(st)); }
  const projects = [...byProj.entries()].filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1]).map(([label, w]) => ({ label, pct: pct(w, all) }));
  // heaviest day
  const days = new Map();
  for (const st of claude) for (const k in st.burn) { const t = +k * BUCKET; if (t < cut || t > now) continue; const dk = dayKey(t); days.set(dk, (days.get(dk) || 0) + st.burn[k]); }
  let peakDay = null;
  if (days.size) { const [dk, w] = [...days.entries()].sort((a, b) => b[1] - a[1])[0]; const avg = all / Math.max(1, o.days); peakDay = { day: dk, x: avg > 0 ? r1(w / avg) : 0 }; }
  // concurrency & idle
  const runIv = clip(subs.filter((s) => s.first !== null && s.last > s.first).map((s) => [s.first, s.last]), cut, now);
  const ev = []; for (const [a, b] of runIv) ev.push([a, 1], [b, -1]);
  ev.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let cur = 0, peak = 0, lastT = null, ge3 = 0;
  for (const [t, d] of ev) { if (lastT !== null && cur >= 3) ge3 += t - lastT; cur += d; peak = Math.max(peak, cur); lastT = t; }
  const work = [];
  for (const st of leads) { work.push(...st.work); if (st.open !== null) work.push([st.open, Math.min(now, st.open + H)]); }
  const busy = union([...union(runIv), ...union(clip(work, cut, now))]);
  const idle = subtract([[cut, now]], busy);
  let idleDay = 0;
  for (const [s, e] of idle) {
    let t = s;
    while (t < e) { const dt = new Date(t * 1000), nx = Math.min(e, Math.floor(t / H) * H + H), hr = dt.getHours(), wd = dt.getDay(); if (wd >= 1 && wd <= 5 && hr >= 9 && hr < 18) idleDay += nx - t; t = nx; }
  }
  const runs7 = subs.filter((s) => s.last !== null && s.last >= now - 7 * D && s.first !== null && s.last > s.first).length;
  const lines = claude.reduce((a, s) => a + s.lines, 0), bad = claude.reduce((a, s) => a + s.bad, 0);
  return {
    tool: NAME, version: VERSION, generatedAt: new Date(now * 1000).toISOString(), days: o.days, masked: o.mask,
    scope: { claudeFiles: claude.length, codexFiles: codex.length, logGigabytes: r1(data.logBytes / 1e9), readGigabytes: r1(data.bytes / 1e9), seconds: r1(data.seconds), skippedFiles: data.skipped, unknownLinePct: pct(bad, lines), found: data.roots },
    limits: {
      windows: cw.length, weekly: cw.filter((w) => w.kind === 'seven_day').length, fiveHour: cw.filter((w) => w.kind === 'five_hour').length,
      codexWindows: windows.length - cw.length, hitsWithoutReset: hits.filter((h) => !h.reset).length,
      list: windows.map((w) => ({ src: w.src, kind: w.kind, firstHit: iso(w.first), reset: iso(w.reset), leftHours: w.leftHours, hits: w.hits, by: w.by })),
      worst: worst && { kind: worst.kind, firstHit: iso(worst.first), leftHours: worst.leftHours },
    },
    burn: { approxTotal: Math.round(all), subPct: pct(subBurn, all), leadPct: pct(leadBurn, all), top10Pct: topShare, runs: runs.length, teams, projects, peakDay },
    concurrency: { peak, ge3Hours: r1(ge3 / H), runs7d: runs7 },
    idle: { hours: r1(total(idle) / H), weekdayDaytimeHours: r1(idleDay / H), pct: pct(total(idle), now - cut) },
    pace: pace(data.states, windows, now),
  };
}
const iso = (t) => (t ? new Date(t * 1000).toISOString() : null);
const dayKey = (t) => { const d = new Date(t * 1000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// pace: Claude has no official % in logs, so the budget is estimated from past hits (burn from window start to the hit).
function pace(states, windows, now) {
  const claude = states.filter((s) => s.kind !== 'codex');
  const out = { claude: {}, codex: {} };
  const rate = Math.max(sumBurn(claude, now - 1800, now + 1) * 2, sumBurn(claude, now - 3 * H, now + 1) / 3); // the less relaxed of 30 min / 3 h
  out.claude.burnPerHour = Math.round(rate);
  out.claude.activeSubagents = claude.filter((s) => s.kind === 'sub' && s.last !== null && s.last >= now - 600).length;
  const cw = windows.filter((w) => w.src === 'claude');
  out.claude.open = cw.filter((w) => w.reset > now).map((w) => ({ kind: w.kind, firstHit: iso(w.first), reset: iso(w.reset) }));
  // Weekly resets on two different clocks = more than one account/plan in the same logs -> a single budget would be wrong.
  const clocks = new Set(cw.filter((w) => w.kind === 'seven_day').map((w) => Math.round((w.reset % WIN.seven_day) / H)));
  out.claude.accountsMixed = clocks.size > 1;
  for (const kind of ['seven_day', 'five_hour']) {
    const L = WIN[kind], ws = cw.filter((w) => w.kind === kind);
    const open = ws.filter((w) => w.reset > now).pop();
    if (open) { out.claude[kind] = { state: 'blocked', reset: iso(open.reset), since: iso(open.first), windows: ws.filter((w) => w.reset > now).map((w) => iso(w.reset)).sort() }; continue; }
    const budgets = ws.map((w) => sumBurn(claude, w.reset - L, w.first)).filter((x) => x > 0);
    const latest = ws[ws.length - 1];
    if (!budgets.length || !latest || out.claude.accountsMixed) { out.claude[kind] = { state: out.claude.accountsMixed && budgets.length ? 'mixed' : 'unknown' }; continue; }
    const budget = median(budgets);
    let reset = latest.reset;
    if (kind === 'seven_day') while (reset <= now) reset += L; else reset = null; // 5-hour windows start at first use: no fixed clock
    const used = sumBurn(claude, reset ? reset - L : now - L, now + 1), estPct = Math.round((100 * used) / budget);
    if (used >= budget) { out.claude[kind] = { state: 'over', estPct, reset: iso(reset), basedOnHits: budgets.length, approx: true }; continue; }
    const exhaustAt = rate > 0 ? now + ((budget - used) / rate) * H : null;
    const tight = exhaustAt !== null && exhaustAt < (reset || now + L);
    out.claude[kind] = {
      state: tight ? 'tight' : 'ok', estPct, reset: iso(reset), exhaustAt: iso(exhaustAt),
      hoursShortOfReset: tight && reset ? r1((reset - exhaustAt) / H) : 0, basedOnHits: budgets.length, approx: true,
    };
  }
  // Codex: official percentages from the newest snapshot; pace from the last 3 hours of snapshots.
  const cx = states.filter((s) => s.kind === 'codex' && s.snap).sort((a, b) => b.snap.t - a.snap.t)[0];
  for (const kind of ['seven_day', 'five_hour']) {
    const v = cx && cx.snap[kind];
    if (!v) { out.codex[kind] = { state: 'unknown' }; continue; }
    const pts = states.filter((s) => s.kind === 'codex').flatMap((s) => (s.series[kind] || [])).filter((p) => p[0] >= now - 3 * H && Math.abs(p[2] - v.reset) < 600).sort((a, b) => a[0] - b[0]);
    let exhaustAt = null;
    if (pts.length >= 2) { const [a, b] = [pts[0], pts[pts.length - 1]]; const slope = (b[1] - a[1]) / Math.max(1, b[0] - a[0]); if (slope > 0) exhaustAt = b[0] + (100 - b[1]) / slope; }
    const tight = exhaustAt !== null && v.reset && exhaustAt < v.reset;
    out.codex[kind] = { state: v.pct >= 100 && v.reset > now ? 'blocked' : tight ? 'tight' : 'ok', pct: Math.round(v.pct), reset: iso(v.reset), exhaustAt: iso(exhaustAt), asOf: iso(cx.snap.t), approx: false };
  }
  const st = [out.claude.seven_day, out.claude.five_hour, out.codex.seven_day, out.codex.five_hour].map((x) => x.state);
  out.verdict = st.includes('blocked') ? 'blocked' : st.includes('tight') || st.includes('over') ? 'tight' : st.includes('ok') ? 'ok' : 'unknown';
  return out;
}

// ---------- masking ----------
export function applyMask(r, lang) {
  const t = T[lang] || T.en, letter = (i) => (i < 26 ? String.fromCharCode(65 + i) : String(i + 1));
  r.burn.teams = r.burn.teams.map((x, i) => ({ ...x, label: `${t.team} ${letter(i)}` }));
  r.burn.projects = r.burn.projects.map((x, i) => ({ ...x, label: `${t.project} ${letter(i)}` }));
  return r;
}

// ---------- rendering ----------
function fmtAt(iso_, lang, withWd) {
  if (!iso_) return '?';
  const d = new Date(iso_), hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  return withWd ? `${md}(${T[lang].wd[d.getDay()]}) ${hm}` : `${md} ${hm}`;
}
const span = (h, t) => (h >= 48 ? `${r1(h / 24)}${t.day}` : `${r1(h)}${t.hour}`);
// The first screen as [label, value] rows; shared by the terminal text and the HTML card.
export function firstRows(r, lang) {
  const t = T[lang], rows = [];
  rows.push([t.windows, t.winVal(r.limits.windows, r.limits.weekly, r.limits.fiveHour, r.limits.codexWindows)]);
  if (r.limits.worst) rows.push([t.worst, t.worstVal(r.limits.worst.kind, span(r.limits.worst.leftHours, t), fmtAt(r.limits.worst.firstHit, lang))]);
  else if (r.burn.peakDay) rows.push([t.peakDay, t.peakVal(r.burn.peakDay.day.slice(5).replace('-', '/'), r.burn.peakDay.x)]);
  rows.push([t.burn, t.burnVal(r.burn.subPct, r.burn.top10Pct)]);
  const top = r.burn.teams.slice(0, 3).map((x, i) => `${t.rank(i + 1)} ${cut(x.label || t.noLabel, 14)} ${x.pct}%`).join('  ');
  if (top) rows.push(['', top]);
  rows.push([t.conc, t.concVal(r.concurrency.peak, r.concurrency.ge3Hours)]);
  rows.push([t.idle, t.idleVal(r.idle.hours, r.idle.weekdayDaytimeHours)]);
  paceLines(r.pace, lang).forEach((line, i) => rows.push([i ? '' : t.pace, line]));
  return rows;
}
export function renderText(r, lang, extra = {}) {
  const t = T[lang], L = 20, out = [t.title(r.days), ''];
  if (!r.scope.claudeFiles && !r.scope.codexFiles) return [t.title(r.days), '', '  ' + t.nothing].join('\n');
  for (const [k, v] of firstRows(r, lang)) out.push('  ' + pad(k, L) + v);
  out.push('');
  out.push('  ' + t.teams);
  const max = Math.max(1, ...r.burn.teams.map((x) => x.pct));
  r.burn.teams.slice(0, 5).forEach((x, i) => {
    const bar = '▓'.repeat(Math.max(1, Math.round((x.pct / max) * 10)));
    out.push(`  ${i + 1}  ${pad(cut(x.label || t.noLabel, 16), 17)}${pad(cut(shortModel(x.model), 8), 9)}${pad(t.runs(x.runs), 8)}${pad(bar, 11)}${x.pct}%`);
  });
  const rest = r.burn.teams.slice(5);
  if (rest.length) out.push(`  …  ${pad(`${t.other} ${rest.length}`, 34)}${pad('', 11)}${r1(rest.reduce((a, x) => a + x.pct, 0))}%`);
  out.push(`     ${pad(t.lead, 34)}${pad('', 11)}${r.burn.leadPct}%`);
  if (r.scope.unknownLinePct > UNKNOWN_WARN * 100) out.push('', '  ' + t.unknownFmt(r.scope.unknownLinePct));
  if (r.scope.skippedFiles) out.push('', '  ' + t.skipped(r.scope.skippedFiles));
  out.push('');
  if (extra.html) out.push('  ' + t.card(extra.html.length > 40 ? path.basename(extra.html) : extra.html, r.masked));
  out.push('  ' + t.tray);
  return out.join('\n');
}
const shortModel = (m) => { const x = (m || '?').toLowerCase().match(/opus|sonnet|haiku|fable|gpt[-\w.]*|o\d/); return x ? x[0][0].toUpperCase() + x[0].slice(1) : (m || '?'); };
export function paceLines(p, lang) {
  const t = T[lang], out = [];
  for (const [kind, name] of [['seven_day', t.week], ['five_hour', t.five]]) {
    const v = p.claude[kind];
    if (!v || v.state === 'unknown') continue;
    if (v.state === 'blocked') for (const r of v.windows || [v.reset]) out.push(t.paceBlocked(name, fmtAt(r, lang, true), p.claude.accountsMixed));
    else if (v.state === 'over') out.push(t.paceOver(name, v.estPct));
    else if (v.state === 'mixed') { if (kind === 'seven_day') out.push(t.paceMixed(name)); }
    else if (v.state === 'tight') out.push(t.paceTight(name, v.estPct, fmtAt(v.exhaustAt, lang, true), fmtAt(v.reset, lang, true)));
    else if (!v.reset) out.push(t.paceRolling(name, v.estPct));
    else out.push(t.paceOk(name, v.estPct, fmtAt(v.reset, lang, true)));
  }
  for (const [kind, name] of [['seven_day', t.week], ['five_hour', t.five]]) {
    const v = p.codex[kind];
    if (v && v.state === 'tight') out.push(t.codexTight(name, v.pct, fmtAt(v.exhaustAt, lang, true)));
    else if (v && v.state !== 'unknown' && (kind === 'seven_day' || v.pct > 0)) out.push(t.codexVal(name, v.pct, fmtAt(v.reset, lang, true)));
  }
  if (!out.length) out.push(t.paceNone);
  return out;
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function renderHtml(r, lang) {
  const t = T[lang], rows = r.scope.claudeFiles || r.scope.codexFiles ? firstRows(r, lang) : [['', t.nothing]];
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${NAME} report</title>
<style>:root{--bg:#f6f4ef;--fg:#1d1d1b;--mut:#6b6a66;--card:#fffdf8;--acc:#b85f12;--line:#e7e2d8}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--fg:#ecebe6;--mut:#a3a29c;--card:#22211e;--acc:#f0a35c;--line:#34322d}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,-apple-system,"Segoe UI","Apple SD Gothic Neo","Malgun Gothic","Hiragino Sans","Microsoft YaHei",sans-serif}
.card{box-sizing:border-box;width:1200px;height:630px;margin:24px auto;padding:44px 56px;background:var(--card);border-radius:20px;overflow:hidden;display:flex;flex-direction:column}
h1{font-size:28px;margin:0 0 22px;color:var(--acc);font-weight:700}
.g{display:grid;grid-template-columns:240px 1fr;column-gap:24px;row-gap:9px;font-size:22px}
.k{color:var(--mut)} .v{font-variant-numeric:tabular-nums;overflow-wrap:anywhere;white-space:pre-wrap}
footer{margin-top:auto;padding-top:14px;border-top:1px solid var(--line);color:var(--mut);font-size:15px}
@media (max-width:1240px){.card{width:auto;height:auto;margin:16px;padding:24px}.g{grid-template-columns:1fr;font-size:16px;row-gap:2px}.k:empty{display:none}.v{margin-bottom:6px}}</style></head>
<body><section class="card"><h1>${esc(t.title(r.days))}</h1><div class="g">${rows.map(([k, v]) => `<div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>`).join('')}</div>
<footer>${esc(NAME)} ${VERSION} · ${esc(r.generatedAt.slice(0, 10))} · local only · masked: ${r.masked ? 'on' : 'off'}</footer></section></body></html>\n`;
}
export function statusObject(r, lang) {
  const lines = paceLines(r.pace, lang);
  return { tool: NAME, version: VERSION, now: r.generatedAt, verdict: r.pace.verdict, line: lines.join(' | '), claude: r.pace.claude, codex: r.pace.codex,
    note: 'Claude percentages are estimates from past limit hits (approx). Codex percentages are the values Codex itself recorded.' };
}

// ---------- CLI ----------
export class UsageError extends Error {}
function sysLang() {
  const l = (process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale || 'en').toLowerCase();
  return LANGS.find((x) => l.startsWith(x)) || 'en';
}
export function parseArgs(argv) {
  const o = { cmd: 'report', days: 30, lang: sysLang(), json: false, html: null, mask: true, cache: true, project: null, claudeDir: null, codexDir: null, now: Date.now() / 1000, quiet: false };
  const need = (i, name) => { if (i >= argv.length || String(argv[i]).startsWith('--')) throw new UsageError(name); return argv[i]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'report' || a === 'status') o.cmd = a;
    else if (a === '--help' || a === '-h') o.cmd = 'help';
    else if (a === '--version') o.cmd = 'version';
    else if (a === '--json') o.json = true;
    else if (a === '--mask') o.mask = true;
    else if (a === '--no-mask') o.mask = false;
    else if (a === '--no-cache') o.cache = false;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--html') o.html = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'fleetpace-report.html';
    else if (a === '--days') { const v = need(++i, 'days'); if (!/^\d+$/.test(v) || +v < 1 || +v > 365) throw new UsageError('days'); o.days = +v; }
    else if (a === '--lang') { const v = need(++i, 'lang'); if (!LANGS.includes(v)) throw new UsageError('lang'); o.lang = v; }
    else if (a === '--project') o.project = path.resolve(need(++i, 'project'));
    else if (a === '--claude-dir') o.claudeDir = path.resolve(need(++i, 'claude-dir'));
    else if (a === '--codex-dir') o.codexDir = path.resolve(need(++i, 'codex-dir'));
    else if (a === '--now') { const v = need(++i, 'now'), n = /^\d+$/.test(v) ? +v : toEpoch(v); if (!n) throw new UsageError('now'); o.now = n; }
    else throw new UsageError('opt:' + a);
  }
  if (o.cmd === 'status' && !argv.includes('--days')) o.days = 7;
  return o;
}
export function run(o) {
  const data = collect(o), r = analyze(data, o);
  if (o.mask) applyMask(r, o.lang);
  return r;
}
export function main(argv, io = { out: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') }) {
  let o;
  try { o = parseArgs(argv); } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    const t = T[sysLang()], m = e.message;
    io.err(m === 'days' ? t.badDays : m === 'lang' ? t.badLang : m.startsWith('opt:') ? t.badOpt(m.slice(4)) : t.badOpt('--' + m));
    return 2;
  }
  if (o.cmd === 'help') { io.out(HELP); return 0; }
  if (o.cmd === 'version') { io.out(`${NAME} ${VERSION}`); return 0; }
  const r = run(o);
  if (o.cmd === 'status') { io.out(o.json ? JSON.stringify(statusObject(r, o.lang)) : statusObject(r, o.lang).line); return 0; }
  if (o.html) { try { fs.writeFileSync(o.html, renderHtml(r, o.lang)); } catch { io.err('cannot write ' + o.html); o.html = null; } }
  io.out(o.json ? JSON.stringify(r, null, 2) : renderText(r, o.lang, { html: o.html }));
  return 0;
}
const self = fileURLToPath(import.meta.url);
if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(self)) process.exitCode = main(process.argv.slice(2));
