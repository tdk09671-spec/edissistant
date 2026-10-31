#!/usr/bin/env node
// Reads a Vitest or Playwright JSON report and fails when the run is not trustworthy:
//   - any test failed (or a test file failed to load, or Playwright reported a global error);
//   - no test ran at all;
//   - a test was skipped that scripts/ci/allowed-skips.json doesn't allow for this OS.
// Skipped tests are listed either way, so the log shows exactly what didn't run and why.
//
//   node scripts/ci/verify-skips.mjs --vitest  <report.json> [--os linux|windows]
//   node scripts/ci/verify-skips.mjs --playwright <report.json> [--os linux|windows]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const usage = 'Usage: verify-skips.mjs (--vitest|--playwright) <report.json> [--os linux|windows] [--allowlist <file>]';
const kind = flag('--vitest') ? 'vitest' : flag('--playwright') ? 'playwright' : null;
if (!kind) {
  console.error(usage);
  process.exit(2);
}
const reportPath = flag(`--${kind}`);
const osName = flag('--os') ?? (process.platform === 'win32' ? 'windows' : process.platform);
const here = path.dirname(fileURLToPath(import.meta.url));
const allowlistPath = flag('--allowlist') ?? path.join(here, 'allowed-skips.json');
const repoRoot = path.resolve(here, '..', '..');

if (!fs.existsSync(reportPath)) {
  console.error(`✗ No ${kind} report at ${reportPath}: the test run crashed before writing it, or the reporter isn't configured.`);
  process.exit(1);
}
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const allowed = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'))[kind]?.[osName];
if (!Array.isArray(allowed)) {
  console.error(`✗ ${path.basename(allowlistPath)} has no "${kind}.${osName}" list.`);
  process.exit(2);
}
for (const entry of allowed) {
  if (!entry.file || !entry.reason) {
    console.error(`✗ Every allowlist entry needs "file" and "reason": ${JSON.stringify(entry)}`);
    process.exit(2);
  }
}

// Repo-relative, forward slashes, whatever OS wrote the report.
const rel = (file) => path.relative(repoRoot, path.resolve(repoRoot, file)).split(path.sep).join('/');

/** @type {{file: string, name: string, status: 'passed'|'failed'|'skipped', detail?: string}[]} */
const tests = [];
const fatal = [];

if (kind === 'vitest') {
  for (const file of report.testResults ?? []) {
    const f = rel(file.name);
    // A file that fails to import has status "failed", a message, and no assertion results.
    if (file.status === 'failed' && !(file.assertionResults ?? []).some((a) => a.status === 'failed')) {
      fatal.push(`${f} failed to run: ${String(file.message ?? '').split('\n')[0]}`);
    }
    for (const a of file.assertionResults ?? []) {
      const status = a.status === 'passed' ? 'passed' : a.status === 'failed' ? 'failed' : 'skipped'; // skipped, pending, todo
      tests.push({ file: f, name: a.fullName, status, detail: status === 'failed' ? String(a.failureMessages?.[0] ?? '').split('\n')[0] : undefined });
    }
  }
} else {
  const rootDir = report.config?.rootDir ?? path.join(repoRoot, 'tests', 'e2e');
  for (const e of report.errors ?? []) fatal.push(`Playwright error: ${String(e.message ?? e).split('\n')[0]}`);
  const walk = (suite, titles) => {
    const t = suite.title && !/\.(spec|test)\.[cm]?[jt]sx?$/.test(suite.title) ? [...titles, suite.title] : titles;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        // expected = passed (or failed when marked test.fail), unexpected = failed, flaky = passed on retry.
        const status = test.status === 'skipped' ? 'skipped' : test.status === 'expected' ? 'passed' : 'failed';
        const last = test.results?.[test.results.length - 1];
        const detail = test.status === 'flaky' ? 'flaky: failed, then passed on retry' : last?.error?.message?.split('\n')[0];
        tests.push({ file: rel(path.join(rootDir, spec.file ?? suite.file)), name: [...t, spec.title].join(' › '), status, detail: status === 'failed' ? detail : undefined });
      }
    }
    for (const child of suite.suites ?? []) walk(child, t);
  };
  for (const suite of report.suites ?? []) walk(suite, []);
}

const isAllowed = (t) => allowed.some((e) => e.file === t.file && (e.test === undefined || e.test === t.name.replaceAll(' › ', ' ')));
const reasonFor = (t) => allowed.find((e) => e.file === t.file && (e.test === undefined || e.test === t.name.replaceAll(' › ', ' ')))?.reason;
const passed = tests.filter((t) => t.status === 'passed');
const failed = tests.filter((t) => t.status === 'failed');
const skipped = tests.filter((t) => t.status === 'skipped');
const unexpectedSkips = skipped.filter((t) => !isAllowed(t));

console.log(`${kind} on ${osName}: ${tests.length} tests, ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
if (skipped.length) {
  console.log('\nSkipped:');
  for (const t of skipped) console.log(`  ${isAllowed(t) ? '·' : '✗'} ${t.file} :: ${t.name}${isAllowed(t) ? `\n      ${reasonFor(t)}` : '   <- not in allowed-skips.json'}`);
}

const problems = [...fatal];
for (const t of failed) problems.push(`Failed: ${t.file} :: ${t.name}${t.detail ? `\n      ${t.detail}` : ''}`);
if (unexpectedSkips.length) {
  problems.push(
    `${unexpectedSkips.length} test(s) skipped that aren't allowed on ${osName}. A tool the test needs is probably missing ` +
      `on the runner (see the environment check step), or a skip condition changed. If the skip is intended, add it to ` +
      `scripts/ci/allowed-skips.json with a reason.`
  );
}
if (tests.length === 0 || passed.length === 0) problems.push('No test passed: the run found no tests or everything was skipped.');

if (problems.length) {
  console.error(`\n${problems.map((p) => `✗ ${p}`).join('\n')}`);
  process.exit(1);
}
console.log('\nOK: no failures and every skip is allowed.');
