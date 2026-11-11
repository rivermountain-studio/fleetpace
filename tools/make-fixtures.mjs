#!/usr/bin/env node
// Builds the 13 fake log sets used by both engines' tests. All data is invented.
// Static sets are written to fixtures/<name>/; three sets (big line, symlink loop, unreadable file) are
// only built at test time because git cannot keep 50 MB lines, loops or permissions well.
//   node tools/make-fixtures.mjs            -> (re)write fixtures/ static sets
//   import { build } from './make-fixtures.mjs'; build(dir) -> all 13 into dir
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NOW = Date.UTC(2026, 10, 10, 12, 0, 0) / 1000; // 2026-11-10T12:00:00Z
const iso = (h) => new Date((NOW + h * 3600) * 1000).toISOString();
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const CWD = '/work/alpha';

export function user(h, { side = false, tool = false, meta = false } = {}) {
  const content = tool ? [{ type: 'tool_result', content: 'ok', tool_use_id: 't1' }] : 'hello';
  return JSON.stringify({ parentUuid: null, isSidechain: side, type: 'user', message: { role: 'user', content }, ...(meta ? { isMeta: true } : {}), uuid: uuid(), timestamp: iso(h), cwd: CWD, sessionId: 's1' });
}
export function assistant(h, id, { model = 'claude-opus-x', inp = 0, out = 0, cw = 0, cr = 0, stop = 'end_turn', side = false, text = 'ok' } = {}) {
  return JSON.stringify({
    parentUuid: 'p', isSidechain: side,
    message: { model, id, type: 'message', role: 'assistant', content: [{ type: 'text', text }], stop_reason: stop,
      usage: { input_tokens: inp, cache_creation_input_tokens: cw, cache_read_input_tokens: cr, output_tokens: out } },
    requestId: 'r', type: 'assistant', uuid: uuid(), timestamp: iso(h), cwd: CWD, sessionId: 's1',
  });
}
export function rateLimit(h, kind, resetH) {
  return JSON.stringify({
    parentUuid: 'p', isSidechain: false, type: 'assistant', uuid: uuid(), timestamp: iso(h),
    message: { id: 'synthetic', model: '<synthetic>', role: 'assistant', stop_reason: 'stop_sequence', type: 'message',
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, content: [] },
    quotaLimits: { status: 'rejected', resetsAt: NOW + resetH * 3600, rateLimitType: kind }, error: 'rate_limit', apiErrorStatus: 429,
  });
}
function codexLine(h, p, s) {
  return JSON.stringify({ timestamp: iso(h), type: 'event_msg', payload: { type: 'token_count', info: null,
    rate_limits: { primary: { used_percent: p, window_minutes: 300, resets_at: NOW + 2 * 3600 }, secondary: { used_percent: s, window_minutes: 10080, resets_at: NOW + 100 * 3600 }, rate_limit_reached_type: null } } });
}
const w = (fp, lines, eol = '\n') => { fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp, Array.isArray(lines) ? lines.join(eol) + eol : lines); };
const meta = (fp, description, model) => w(fp.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: 'general-purpose', description, model }));
const small = (root) => w(path.join(root, 'claude/projects/proj/s1.jsonl'), [user(-3), assistant(-2, 'msg_x1', { out: 100 })]);

export const STATIC = {
  normal(root) {
    const pd = path.join(root, 'claude/projects/proj'), sd = path.join(pd, 's1/subagents');
    w(path.join(pd, 's1.jsonl'), [
      user(-50), assistant(-49, 'msg_m1', { inp: 1000, out: 100 }),
      user(-30), assistant(-29.5, 'msg_m2', { out: 200, stop: 'tool_use' }), user(-29.4, { tool: true }), assistant(-29, 'msg_m3', { cw: 800, cr: 10000 }),
      rateLimit(-26, 'seven_day', 24), rateLimit(-25, 'seven_day', 24),
    ]);
    const sub = (name, desc, model, lines) => { const fp = path.join(sd, `agent-${name}.jsonl`); w(fp, lines); meta(fp, desc, model); };
    sub('a1', 'Red build the thing', 'opus', [user(-48, { side: true }), assistant(-46, 'msg_s1', { out: 1000, side: true })]);
    sub('a2', 'Red review it', 'sonnet', [user(-47, { side: true }), assistant(-45, 'msg_s2', { model: 'claude-sonnet-x', out: 1000, side: true })]);
    sub('a3', 'Blue research', 'haiku', [user(-47.5, { side: true }), assistant(-46.5, 'msg_s3', { model: 'claude-haiku-x', inp: 10000, side: true })]);
    sub('a4', 'Green fix', 'opus', [user(-12, { side: true }), assistant(-11, 'msg_s4', { out: 2000, stop: 'tool_use', side: true }),
      assistant(-11, 'msg_s4', { out: 2000, stop: 'tool_use', side: true }), rateLimit(-10, 'five_hour', -8), assistant(-9, 'msg_s4b', { side: true })]);
    sub('a5', 'Solo task', 'opus', [user(-20, { side: true }), assistant(-19, 'msg_s5', { out: 400, side: true })]);
  },
  broken(root) { w(path.join(root, 'claude/projects/proj/s1.jsonl'), [user(-5), 'not json', assistant(-4, 'msg_b1', { out: 100 }), '{"type":"assistant"']); },
  'empty-dir'(root) { fs.mkdirSync(path.join(root, 'claude/projects'), { recursive: true }); },
  'non-utf8'(root) {
    const a = Buffer.from(user(-3) + '\n'), b = Buffer.from(assistant(-2, 'msg_u1', { out: 100, text: 'XX' }) + '\n');
    const i = b.indexOf('XX'); b[i] = 0xff; b[i + 1] = 0xfe;
    w(path.join(root, 'claude/projects/proj/s1.jsonl'), Buffer.concat([a, b]));
  },
  crlf(root) { w(path.join(root, 'claude/projects/proj/s1.jsonl'), [user(-3), assistant(-2, 'msg_c1', { out: 100 })], '\r\n'); },
  'no-meta'(root) { small(root); w(path.join(root, 'claude/projects/proj/s1/subagents/agent-n1.jsonl'), [user(-3, { side: true }), assistant(-2, 'msg_n1', { out: 100, side: true })]); },
  future(root) { w(path.join(root, 'claude/projects/proj/s1.jsonl'), [user(-3), assistant(-2, 'msg_f1', { out: 100 }), assistant(24 * 30, 'msg_f2', { out: 100000 })]); },
  reversed(root) { small(root); const fp = path.join(root, 'claude/projects/proj/s1/subagents/agent-r1.jsonl'); w(fp, [assistant(-2, 'msg_r1', { out: 100, side: true }), user(-5, { side: true })]); meta(fp, 'Back task', 'opus'); },
  'codex-only'(root) { w(path.join(root, 'codex/sessions/2026/11/10/rollout-2026-11-10T09-00-00-x.jsonl'), [codexLine(-3, 50, 80), codexLine(-2, 100, 80), codexLine(-1, 100, 80)]); },
  nothing(root) { fs.mkdirSync(root, { recursive: true }); },
};
export const DYNAMIC = {
  'big-line'(root) {
    const fp = path.join(root, 'claude/projects/proj/s1/subagents/agent-g1.jsonl');
    w(fp, [user(-3, { side: true }), assistant(-2, 'msg_g1', { out: 1000, side: true, text: 'a'.repeat(50 * 1024 * 1024) })]);
    meta(fp, 'Big job', 'opus');
  },
  'symlink-loop'(root) { small(root); fs.symlinkSync('..', path.join(root, 'claude/projects/proj/loop')); fs.symlinkSync('.', path.join(root, 'claude/projects/self')); },
  'no-permission'(root) { small(root); const fp = path.join(root, 'claude/projects/proj/s2.jsonl'); w(fp, [user(-3), assistant(-2, 'msg_p1', { out: 100 })]); fs.chmodSync(fp, 0o000); },
};
export function build(dir, names = [...Object.keys(STATIC), ...Object.keys(DYNAMIC)]) {
  for (const name of names) { n = 0; (STATIC[name] || DYNAMIC[name])(path.join(dir, name)); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
  build(root, Object.keys(STATIC));
  console.log('wrote', Object.keys(STATIC).length, 'static fixture sets to', path.relative(process.cwd(), root));
}
