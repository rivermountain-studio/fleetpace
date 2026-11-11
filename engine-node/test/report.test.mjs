// node --test engine-node/test   (runs in UTC so day boundaries are fixed)
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run, main, renderText, renderHtml, statusObject, width, LANGS, burnOf } from '../fleetpace-report.mjs';
import { build, NOW, STATIC, DYNAMIC } from '../../tools/make-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const ENGINE = path.join(root, 'engine-node/fleetpace-report.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetpace-fx-'));
build(tmp);
const opts = (name, extra = {}) => ({ cmd: 'report', days: 30, lang: 'en', json: true, mask: false, cache: false, quiet: true, now: NOW,
  claudeDir: path.join(tmp, name, 'claude/projects'), codexDir: path.join(tmp, name, 'codex/sessions'), ...extra });
function subset(actual, expected, where = '') {
  if (Array.isArray(expected)) { assert.ok(Array.isArray(actual), where + ' is not a list'); expected.forEach((e, i) => subset(actual[i], e, `${where}[${i}]`)); return; }
  if (expected && typeof expected === 'object') { for (const k of Object.keys(expected)) subset(actual?.[k], expected[k], `${where}.${k}`); return; }
  assert.deepEqual(actual, expected, where);
}

for (const name of [...Object.keys(STATIC), ...Object.keys(DYNAMIC)]) {
  test(`fixture ${name} matches expected/${name}.json`, () => {
    const expected = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/expected', name + '.json'), 'utf8'));
    subset(run(opts(name)), expected, name);
  });
}

test('static fixtures in the repo equal freshly generated ones', () => {
  for (const name of Object.keys(STATIC)) {
    const a = run(opts(name)), b = run({ ...opts(name), claudeDir: path.join(root, 'fixtures', name, 'claude/projects'), codexDir: path.join(root, 'fixtures', name, 'codex/sessions') });
    delete a.scope.seconds; delete b.scope.seconds;
    assert.deepEqual(b, a, name);
  }
});

test('burn weights', () => {
  assert.equal(burnOf({ input: 1000, output: 100, cacheWrite: 800, cacheRead: 10000 }, 'claude-opus-x'), 1000 + 500 + 1000 + 1000);
  assert.equal(burnOf({ input: 0, output: 1000, cacheWrite: 0, cacheRead: 0 }, 'claude-sonnet-x'), 3000);
  assert.equal(burnOf({ input: 10000, output: 0, cacheWrite: 0, cacheRead: 0 }, 'claude-haiku-x'), 2000);
});

test('mask hides team labels and folder names in text, JSON and HTML', () => {
  for (const lang of LANGS) {
    const r = run(opts('normal', { mask: true, lang }));
    const all = renderText(r, lang) + JSON.stringify(r) + renderHtml(r, lang) + JSON.stringify(statusObject(r, lang));
    for (const secret of ['Red', 'Green', 'Blue', 'Solo', 'alpha', '/work', '"proj"']) assert.ok(!all.includes(secret), `${lang}: leaked ${secret}`);
  }
});

test('first screen fits 80 columns in all 4 languages', () => {
  for (const name of ['normal', 'codex-only', 'nothing']) for (const lang of LANGS) {
    const txt = renderText(run(opts(name, { mask: true, lang })), lang, { html: 'fleetpace-report.html' });
    for (const line of txt.split('\n')) assert.ok(width(line) <= 80, `${name}/${lang} ${width(line)}: ${line}`);
  }
});

test('first block is at most 6 metric rows before the pace line', () => {
  const lines = renderText(run(opts('normal', { mask: true })), 'en').split('\n');
  const pace = lines.findIndex((l) => l.includes('Pace now'));
  assert.ok(pace > 0 && pace <= 2 + 6 + 1, 'pace row at ' + pace);
});

test('wrong input: exit 2 with one line, never a crash', () => {
  for (const args of [['--days', '0'], ['--days', 'abc'], ['--days'], ['--lang', 'xx'], ['--bogus']]) {
    const out = [], err = [];
    const code = main(args, { out: (s) => out.push(s), err: (s) => err.push(s) });
    assert.equal(code, 2, args.join(' ')); assert.equal(err.length, 1); assert.equal(out.length, 0);
  }
});

test('missing folders: exit 0 with a guide line', () => {
  const p = spawnSync(process.execPath, [ENGINE, '--claude-dir', path.join(tmp, 'nope/a'), '--codex-dir', path.join(tmp, 'nope/b'), '--lang', 'en', '--no-cache'], { encoding: 'utf8' });
  assert.equal(p.status, 0); assert.match(p.stdout, /No records found/);
});

test('status --json is one object with a verdict', () => {
  const p = spawnSync(process.execPath, [ENGINE, 'status', '--json', '--now', String(NOW), '--no-cache', '--claude-dir', opts('normal').claudeDir, '--codex-dir', opts('normal').codexDir], { encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr);
  const s = JSON.parse(p.stdout);
  assert.equal(s.verdict, 'blocked'); assert.equal(s.claude.seven_day.state, 'blocked');
});

test('cache: second run reads 0 new bytes and gives the same numbers', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetpace-home-'));
  process.env.FLEETPACE_HOME = home;
  const a = run(opts('normal', { cache: true })), b = run(opts('normal', { cache: true }));
  assert.ok(a.scope.readGigabytes >= 0 && b.scope.readGigabytes === 0);
  delete a.scope; delete b.scope;
  assert.deepEqual(b, a);
  // appended line is picked up incrementally
  const f = path.join(opts('normal').claudeDir, 'proj/s1/subagents/agent-a5.jsonl');
  const copy = path.join(tmp, 'append-copy'); fs.cpSync(path.join(tmp, 'normal'), copy, { recursive: true });
  const o = opts('append-copy', { cache: true });
  run(o);
  fs.appendFileSync(path.join(o.claudeDir, 'proj/s1/subagents/agent-a5.jsonl'), JSON.stringify({ message: { model: 'claude-opus-x', id: 'msg_new', role: 'assistant', usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 100 } }, type: 'assistant', uuid: '00000000-0000-4000-8000-999999999999', timestamp: new Date((NOW - 3600) * 1000).toISOString() }) + '\n');
  assert.equal(run(o).burn.approxTotal, 27000);
  assert.ok(fs.existsSync(f));
  delete process.env.FLEETPACE_HOME;
});

test('engine has no network or process modules and stays under 900 lines', () => {
  const src = fs.readFileSync(ENGINE, 'utf8');
  assert.ok(!/node:(http|https|net|dgram|tls|dns|child_process)|fetch\(|XMLHttpRequest/.test(src));
  assert.ok(src.split('\n').length < 900);
});

test('codex: a projected run-out time that already passed is not reported as tight', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetpace-stale-'));
  const iso = (h) => new Date((NOW + h * 3600) * 1000).toISOString();
  const line = (h, p) => JSON.stringify({ timestamp: iso(h), type: 'event_msg', payload: { type: 'token_count', info: null,
    rate_limits: { primary: { used_percent: p, window_minutes: 300, resets_at: NOW + 2 * 3600 }, secondary: { used_percent: 10, window_minutes: 10080, resets_at: NOW + 100 * 3600 }, rate_limit_reached_type: null } } });
  const f = path.join(dir, 'codex/sessions/2026/11/10/rollout-2026-11-10T09-00-00-y.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  // 5% -> 45% in 30 minutes, then silence: at that pace 100% would have come about 41 minutes later, i.e. before NOW
  fs.writeFileSync(f, [line(-2, 5), line(-1.5, 45)].join('\n') + '\n');
  const r = run(opts('x', { claudeDir: path.join(dir, 'none'), codexDir: path.join(dir, 'codex/sessions') }));
  const s = statusObject(r, 'en');
  assert.equal(s.codex.five_hour.pct, 45);
  assert.equal(s.codex.five_hour.state, 'ok');
  assert.equal(s.codex.five_hour.exhaustAt, null);
});
