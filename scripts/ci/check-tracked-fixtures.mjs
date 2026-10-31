#!/usr/bin/env node
// Fails when files the tests can read exist on this machine but not in Git: untracked files, or
// files a .gitignore rule hides. That's how tests/fixtures/planning/presets.json went missing (the
// "presets.json" guard for app data matched it): tests passed locally and failed on a clean checkout.
//
// Run it on a developer machine before pushing. In CI the checkout is clean, so this passes
// trivially there; the clean checkout itself is what catches a missing fixture.
//
//   node scripts/ci/check-tracked-fixtures.mjs

import { execFileSync } from 'node:child_process';

const DIRS = ['tests', 'scripts'];
const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).split('\n').filter(Boolean);

let untracked;
let ignored;
try {
  untracked = git(['ls-files', '--others', '--exclude-standard', '--', ...DIRS]);
  ignored = git(['ls-files', '--others', '--ignored', '--exclude-standard', '--', ...DIRS]).filter((f) => !/(^|\/)node_modules\//.test(f));
} catch (error) {
  console.error(`Not a Git checkout or git is unavailable: ${error.message}`);
  process.exit(1);
}

if (untracked.length) console.error(`Untracked files under ${DIRS.join(', ')} (commit them or delete them):\n${untracked.map((f) => `  ${f}`).join('\n')}`);
if (ignored.length) {
  console.error(
    `Files under ${DIRS.join(', ')} that .gitignore hides from Git (a clean checkout won't have them):\n${ignored.map((f) => `  ${f}`).join('\n')}\n` +
      'If a test needs one, add it with `git add -f <file>`; otherwise delete it.'
  );
}
if (untracked.length || ignored.length) process.exit(1);
console.log(`All files under ${DIRS.join(', ')} are tracked in Git.`);
