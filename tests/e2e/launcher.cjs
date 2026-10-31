// Test entry point: points Electron's appData/userData at an isolated folder, then loads the real
// built main process. Refuses to run without EDISSISTANT_TEST_APPDATA so tests can never touch,
// read or migrate the user's real %APPDATA% folders.
const { app } = require('electron');
const path = require('path');

const dir = process.env.EDISSISTANT_TEST_APPDATA;
const realAppData = path.resolve(app.getPath('appData'));
// Electron's setPath only accepts absolute paths. Reject relative and Windows drive-relative values
// ("C:dev\\x", e.g. from a shell that dropped the backslashes; path.isAbsolute is false for these on
// Windows) up front with a clear message, rather than resolving them against the working directory.
if (!dir || !path.isAbsolute(dir)) {
  console.error(`EDISSISTANT_TEST_APPDATA must be an absolute path to an isolated folder (got ${JSON.stringify(dir ?? '')}).`);
  process.exit(1);
}
const inside = path.relative(realAppData, path.resolve(dir));
if (inside === '' || (!inside.startsWith('..') && !path.isAbsolute(inside))) {
  console.error('EDISSISTANT_TEST_APPDATA must be set to an isolated folder outside the real appData.');
  process.exit(1);
}
app.setPath('appData', dir);
app.setPath('userData', path.join(dir, 'edissistant'));

require(path.join(__dirname, '..', '..', 'dist', 'main', 'main.js'));
