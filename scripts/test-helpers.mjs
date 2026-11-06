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
  assert.equal(api.purposeOf(at('curl -L -o file.bin https://example.com/x')), 'download');
  assert.equal(api.purposeOf(at('rm -rf dist')), 'cleanup');
  assert.equal(api.purposeOf(at('npm install --frozen-lockfile')), 'install');
  assert.equal(api.purposeOf(at('npm run build')), 'build');
  assert.equal(api.purposeOf(at('npx vitest run')), 'test');
  assert.equal(api.purposeOf(at('python -m http.server 8765')), 'serve');
  assert.equal(api.purposeOf(at('tar -czf out.tar.gz src')), 'archive');
  assert.equal(api.purposeOf(at('rg TODO src')), 'search');
  assert.equal(api.purposeOf(at('git status --short')), 'git');
  assert.equal(api.purposeOf(at('echo hello')), 'other');
  assert.equal(api.purposeOf(at(undefined)), 'other');
  // A specific intent beats a broader one in the same compound command.
  assert.equal(api.purposeOf(at('rm -rf node_modules && npm install')), 'install');
});

test('clampSetting keeps stored limits in range', () => {
  assert.equal(api.clampSetting('', 40, 5, 200), 40, 'empty falls back');
  assert.equal(api.clampSetting(null, 40, 5, 200), 40);
  assert.equal(api.clampSetting('abc', 40, 5, 200), 40, 'garbage falls back');
  assert.equal(api.clampSetting('1', 40, 5, 200), 5, 'clamped up to the floor');
  assert.equal(api.clampSetting('9999', 40, 5, 200), 200, 'clamped down to the ceiling');
  assert.equal(api.clampSetting('12.6', 40, 5, 200), 13, 'rounded');
  assert.equal(api.clampSetting(0, 4, 1, 12), 1, 'zero is not silently accepted');
});

test('summarizeHistory counts outcomes and ranks commands', () => {
  const job = (over) => ({
    id: 'j',
    label: 'npm install',
    status: 'completed',
    outcome: null,
    startedAt: 1000,
    finishedAt: 3000,
    bytes: 10,
    ...over,
  });
  assert.equal(api.summarizeHistory([]).total, 0);

  const summary = api.summarizeHistory([
    job({ id: 'a' }),
    job({ id: 'b', label: 'curl -o x', bytes: 90 }),
    job({ id: 'c', outcome: 'nonzero', status: 'completed' }),
    job({ id: 'd', status: 'failed' }),
  ]);
  assert.equal(summary.total, 4);
  assert.equal(summary.ok, 2, 'a clean exit counts as success');
  assert.equal(summary.abnormal, 2, 'nonzero and failed both count as abnormal');
  assert.equal(summary.bytes, 120);
  assert.equal(summary.averageMs, 2000);
  assert.equal(summary.commands[0].label, 'npm install');
  assert.equal(summary.commands[0].count, 3);
  assert.equal(summary.failures.length, 2);
});

test('appendHistory dedupes by id and keeps the newest first', () => {
  const first = api.appendHistory([], { id: 'a' });
  assert.equal(first.length, 1);
  const again = api.appendHistory(first, { id: 'a' });
  assert.equal(again.length, 1, 'the same job is never recorded twice');
  const next = api.appendHistory(first, { id: 'b' });
  assert.equal(next[0].id, 'b', 'newest first');
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
