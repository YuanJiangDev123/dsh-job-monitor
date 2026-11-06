#!/usr/bin/env node
/**
 * Unit tests for the job-monitor's pure helpers.
 *
 * The bundle is a single browser file, so the tests execute it in a VM with a
 * stub module loader and a stub React, then reach the helpers through the
 * `__DSH_JOB_MONITOR_TEST__` surface. No React rendering happens here; these
 * tests cover the formatting, truncation and classification rules that are easy
 * to break and impossible to see in a screenshot.
 *
 * Run with `node --test scripts/`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8');

/** Load the bundle once and return its test surface. */
function loadSurface() {
  let definition;
  const sandbox = {
    console,
    document: {
      createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
      head: { appendChild() {} },
      querySelector: () => null,
    },
    __DSH_JOB_MONITOR_TEST__: true,
  };
  sandbox.window = {
    __ModuleLoader__: {
      load: (candidate) => {
        definition = candidate;
      },
    },
    localStorage: { getItem: () => null, setItem: () => {} },
    navigator: {},
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client.js' });
  assert.equal(definition?.id, 'dsh-job-monitor', 'bundle registers its module id');

  const React = {
    createElement: () => null,
    memo: (component) => component,
    Component: class Component {
      constructor(props) {
        this.props = props;
      }
    },
  };
  const exports = definition.factory((name) => {
    if (name === 'react') return React;
    throw new Error(`unexpected module: ${name}`);
  });
  assert.equal(typeof exports.apply, 'function', 'bundle exports apply');
  assert.ok(exports.__test, 'test surface is exposed under the test flag');
  return exports.__test;
}

const api = loadSurface();
const tZh = (key, params) => {
  const dict = {
    'duration.seconds': '{seconds}秒',
    'duration.minutes': '{minutes}分{seconds}秒',
    'duration.hours': '{hours}小时{minutes}分',
  };
  return dict[key].replace(/\{(\w+)\}/g, (_, name) => String(params[name]));
};

test('stripAnsi removes SGR sequences and keeps plain text untouched', () => {
  assert.equal(api.stripAnsi('\u001b[32mok\u001b[0m done'), 'ok done');
  assert.equal(api.stripAnsi('\u001b[1;31mwarn\u001b[m'), 'warn');
  assert.equal(api.stripAnsi('plain build output'), 'plain build output');
  assert.equal(api.stripAnsi(''), '');
});

test('progressOf reads a percentage only when one is really there', () => {
  const at = (over) => ({ progress: undefined, detail: undefined, ...over });
  assert.equal(api.progressOf(at({})), undefined);
  assert.equal(api.progressOf(at({ detail: 'exit code: 0' })), undefined);

  const half = api.progressOf(at({ progress: 'compiling 3/6' }));
  assert.equal(half.ratio, 0.5);
  assert.equal(half.label, '3/6');

  const percent = api.progressOf(at({ progress: '42% done' }));
  assert.equal(Math.round(percent.ratio * 100), 42);

  assert.equal(api.progressOf(at({ progress: '0/0' })), undefined, 'no denominator means no percentage');
  assert.equal(api.progressOf(at({ progress: '9/6' })), undefined, 'an impossible counter is not progress');
  assert.equal(api.progressOf(at({ progress: '2026/11/05' })), undefined, 'a date is not a counter');
});

test('readProgress refuses dates, clocks and impossible counters', () => {
  assert.equal(api.readProgress('[2026/11/05 12:03:01] building'), undefined);
  assert.equal(api.readProgress('src/lib/monitor.ts'), undefined);
  assert.equal(api.readProgress('v1.2/3'), undefined);
  assert.equal(api.readProgress('step 12/75').ratio, 0.16);
  assert.equal(api.readProgress('step 12/75').label, '12/75');
  assert.equal(api.readProgress('chunk 3 of 9').ratio, 3 / 9);
  assert.equal(api.readProgress('##########  34.4%').ratio, 0.344);
  assert.equal(api.readProgress('100%').ratio, 1);
});

test('tailSlice keeps the newest characters without splitting surrogate pairs', () => {
  const whole = api.tailSlice('short', 10);
  assert.equal(whole.text, 'short');
  assert.equal(whole.clipped, false);
  const cut = api.tailSlice('0123456789', 4);
  assert.equal(cut.text, '6789');
  assert.equal(cut.clipped, true);

  // '😀' is a surrogate pair: a cut inside it must not leave an orphaned half.
  const { text, clipped } = api.tailSlice(`ab😀cd`, 3);
  assert.equal(clipped, true);
  assert.ok(text.length <= 3, 'slice never grows past the budget');
  const first = text.charCodeAt(0);
  assert.ok(!(first >= 0xdc00 && first <= 0xdfff), 'never starts on an orphaned low surrogate');
});

test('formatBytes promotes a rounded 1024 KB instead of printing 1024.0 KB', () => {
  assert.equal(api.formatBytes(0), '0 B');
  assert.equal(api.formatBytes(999), '999 B');
  assert.equal(api.formatBytes(1024), '1.0 KB');
  assert.equal(api.formatBytes(1024 * 1024 - 1), '1.0 MB');
  assert.equal(api.formatBytes(1024 * 1024), '1.0 MB');
  assert.equal(api.formatBytes(5 * 1024 * 1024), '5.0 MB');
});

test('formatDuration switches unit exactly at the boundaries', () => {
  assert.equal(api.formatDuration(0, tZh), '0秒');
  assert.equal(api.formatDuration(59_400, tZh), '59秒');
  assert.equal(api.formatDuration(60_000, tZh), '1分0秒');
  assert.equal(api.formatDuration(3_600_000, tZh), '1小时0分');
  assert.equal(api.formatDuration(-5_000, tZh), '0秒', 'clock skew never goes negative');
});

const job = (over) => ({
  id: 'j',
  kind: 'bash',
  label: 'job',
  status: 'completed',
  startedAt: 1000,
  finishedAt: 2000,
  output: { total: 0, earliest: 0 },
  ...over,
});

test('isLive covers running and stopping only', () => {
  assert.equal(api.isLive(job({ status: 'running' })), true);
  assert.equal(api.isLive(job({ status: 'stopping' })), true);
  assert.equal(api.isLive(job({ status: 'completed' })), false);
  assert.equal(api.isLive(job({ status: 'failed' })), false);
});

test('isObservable survives a job without an output record', () => {
  assert.equal(api.isObservable(job({ status: 'running', output: undefined })), true);
  assert.equal(api.isObservable(job({ status: 'completed', output: undefined })), false);
  assert.equal(api.isObservable(job({ status: 'completed', output: { total: 12, earliest: 0 } })), true);
});

test('abnormalOf separates a real failure from a non-zero exit', () => {
  assert.equal(api.abnormalOf(job({ status: 'failed', detail: 'spawn ENOENT' })), 'failed');
  assert.equal(api.abnormalOf(job({ status: 'completed', detail: 'exit code: 0' })), undefined);
  assert.equal(api.abnormalOf(job({ status: 'completed', detail: 'exit code: 3' })), 'nonzero');
  assert.equal(api.abnormalOf(job({ status: 'completed', detail: 'exit code: -1' })), 'nonzero');
  assert.equal(api.abnormalOf(job({ status: 'completed', detail: 'exit code: 1; sandbox: none' })), 'nonzero');
  assert.equal(api.abnormalOf(job({ status: 'killed', detail: 'signal: SIGTERM' })), undefined);
  assert.equal(api.abnormalOf(job({ status: 'completed', detail: undefined })), undefined);
});

test('progressFromOutput scans back over log noise and stays date-safe', () => {
  const LF = String.fromCharCode(10);

  assert.equal(api.progressFromOutput(''), undefined);
  assert.equal(api.progressFromOutput('building...'), undefined);

  // The newest readable meter wins even when plain log lines follow it.
  assert.equal(api.progressFromOutput('step 1/9 ok' + LF + 'no meter here').label, '1/9');

  // A date line must never become a fraction.
  assert.equal(api.progressFromOutput('[2026/11/05 12:03:01] still working'), undefined);

  // The scan is bounded: a meter buried under 45 newer lines is not used.
  const filler = Array.from({ length: 45 }, (_, i) => `log line ${i}`).join(LF);
  assert.equal(api.progressFromOutput('step 3/10' + LF + filler), undefined);
});

test('estimateRatio grows linearly, then keeps creeping when overdue', () => {
  assert.equal(api.estimateRatio(0, 60000), 0);
  assert.equal(api.estimateRatio(30000, 60000), 0.5);
  assert.equal(api.estimateRatio(60000, 60000), 0.95, 'reaches the soft cap on time');
  assert.equal(api.estimateRatio(-5000, 60000), 0);
  assert.equal(api.estimateRatio(1000, 0), 0.95, 'a zero expectation floors at one second');

  const overdue = api.estimateRatio(120000, 60000);
  assert.ok(overdue > 0.95 && overdue < 0.98, 'still moving after the expectation');
  assert.ok(api.estimateRatio(6000000, 60000) <= 0.99, 'never claims completion');
  assert.ok(api.estimateRatio(600000, 60000) > overdue, 'monotonic while overdue');
});

test('rememberDuration keeps a median for the next estimate', () => {
  assert.equal(api.expectedDuration('cmd-a'), undefined);
  api.rememberDuration('cmd-a', 60000);
  assert.equal(api.expectedDuration('cmd-a'), 60000);
  api.rememberDuration('cmd-a', 20000);
  api.rememberDuration('cmd-a', 100000);
  assert.equal(api.expectedDuration('cmd-a'), 60000, 'median of [20s, 60s, 100s]');
  api.rememberDuration('cmd-a', 0);
  assert.equal(api.expectedDuration('cmd-a'), 60000, 'zero durations are ignored');
});

test('purposeOf names the command intent', () => {
  const at = (label) => ({ label });
  const cases = [
    ['curl -L -o file.bin https://example.com/x', 'download'],
    ['git clone https://github.com/a/b', 'download'],
    ['curl -X POST -d @body.json https://api.example.com/v1', 'network'],
    ['ssh user@host uptime', 'network'],
    ['rsync -a src/ host:/dest/', 'network'],
    ['rm -rf dist', 'cleanup'],
    ['docker rm -f app', 'cleanup'],
    ['npm install --frozen-lockfile', 'install'],
    ['pnpm add -D typescript', 'install'],
    ['npm run build', 'build'],
    ['docker build -t app .', 'build'],
    ['tsc --noEmit', 'lint'],
    ['npx eslint .', 'lint'],
    ['npm run typecheck', 'lint'],
    ['npx vitest run', 'test'],
    ['make test', 'test'],
    ['pytest -q', 'test'],
    ['python -m http.server 8765', 'serve'],
    ['npm run dev', 'serve'],
    ['npm run start', 'serve'],
    ['node scripts/build.js', 'run'],
    ['npm run seed', 'run'],
    ['docker compose up -d', 'container'],
    ['kubectl apply -f deploy.yaml', 'deploy'],
    ['git push origin main', 'deploy'],
    ['npm publish', 'deploy'],
    ['psql -c "select 1"', 'database'],
    ['cp -r a b', 'file'],
    ['mkdir -p out', 'file'],
    ['tar -czf out.tar.gz src', 'archive'],
    ['rg TODO src', 'search'],
    ['git status --short', 'git'],
    ['echo hello', 'other'],
    ['node --version', 'other'],
  ];
  for (const [label, expected] of cases) {
    assert.equal(api.purposeOf(at(label)), expected, label);
  }
  assert.equal(api.purposeOf(at(undefined)), 'other');
});

test('normalizeCommand strips wrappers before matching', () => {
  const at = (label) => ({ label });
  assert.equal(api.purposeOf(at('cd app && npm run build')), 'build');
  assert.equal(api.purposeOf(at('sudo npx eslint .')), 'lint');
  assert.equal(api.purposeOf(at('/usr/local/bin/python -m http.server 8080')), 'serve');
  assert.equal(api.purposeOf(at('cd /tmp; curl -O https://example.com/a')), 'download');
});

test('sortJobs puts live rows in start order and settled rows newest first', () => {
  const rows = [
    job({ id: 'a', status: 'completed', startedAt: 10, finishedAt: 100 }),
    job({ id: 'b', status: 'running', startedAt: 50 }),
    job({ id: 'c', status: 'completed', startedAt: 20, finishedAt: 200 }),
    job({ id: 'd', status: 'running', startedAt: 30 }),
  ];
  // Array.from crosses the VM realm into a host array for comparison.
  assert.deepEqual(Array.from(api.sortJobs(rows), (row) => row.id), ['d', 'b', 'c', 'a']);
});

test('selectCurrentSession picks the main-view session, else nothing', () => {
  assert.equal(
    api.selectCurrentSession({
      byId: {
        s1: { id: 's1', retainedBy: {} },
        s2: { id: 's2', retainedBy: { mainView: 1 } },
      },
    }),
    's2',
  );
  assert.equal(api.selectCurrentSession({ byId: { s1: { id: 's1', retainedBy: {} } } }), undefined);
  assert.equal(api.selectCurrentSession({ byId: {} }), undefined);
});
