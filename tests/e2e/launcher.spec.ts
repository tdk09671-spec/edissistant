import { expect, test } from '@playwright/test';
import { spawnSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';

// The test launcher must refuse unsafe or unusable data folders with a clear message and exit code 1,
// before Electron opens a window. Regression: a drive-relative Windows path ("C:dev\\…", produced when
// a shell drops backslashes) crashed with "Path must be absolute" and left the test waiting 30 s.
const LAUNCHER = path.join(__dirname, 'launcher.cjs');
const ELECTRON = require('electron') as unknown as string;

function runLauncher(appData: string | undefined) {
  const env = { ...process.env };
  delete env.EDISSISTANT_TEST_APPDATA;
  if (appData !== undefined) env.EDISSISTANT_TEST_APPDATA = appData;
  return spawnSync(ELECTRON, [LAUNCHER], { env, encoding: 'utf8', timeout: 20_000 });
}

const realAppData =
  process.platform === 'win32'
    ? process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');

const rejected: Array<[string, string | undefined, RegExp]> = [
  ['unset', undefined, /must be an absolute path/],
  ['relative', path.join('test-results', 'appdata'), /must be an absolute path/],
  ['the real appData', realAppData, /outside the real appData/],
  ['inside the real appData', path.join(realAppData, 'edissistant'), /outside the real appData/],
];
if (process.platform === 'win32') {
  rejected.push(['drive-relative (backslashes dropped)', 'C:devedissistant-tools\\appdata\\x', /must be an absolute path/]);
}

for (const [name, value, message] of rejected) {
  test(`launcher refuses EDISSISTANT_TEST_APPDATA: ${name}`, () => {
    const result = runLauncher(value);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(message);
    expect(result.stderr).not.toMatch(/Path must be absolute/);
  });
}
