// Test entry point: points Electron's appData/userData at an isolated folder, then loads the real
// built main process. Refuses to run without EDISSISTANT_TEST_APPDATA so tests can never touch,
// read or migrate the user's real %APPDATA% folders.
const { app } = require('electron');
const path = require('path');

const dir = process.env.EDISSISTANT_TEST_APPDATA;
const realAppData = app.getPath('appData');
if (!dir || path.resolve(dir).toLowerCase().startsWith(path.resolve(realAppData).toLowerCase())) {
  console.error('EDISSISTANT_TEST_APPDATA must be set to an isolated folder outside the real appData.');
  process.exit(1);
}
app.setPath('appData', dir);
app.setPath('userData', path.join(dir, 'edissistant'));

require(path.join(__dirname, '..', '..', 'dist', 'main', 'main.js'));
