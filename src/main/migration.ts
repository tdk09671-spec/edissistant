import * as fs from 'fs';
import * as path from 'path';

// Files written by Edissistant itself. Chromium also writes into userData ("Local State", caches, etc.),
// but those alone don't mean the folder holds user data.
export const APP_DATA_FILES = ['presets.json', 'projects.json', 'settings.json', 'secrets.bin'];

/** True if the folder holds any Edissistant data file or its backup. */
export function hasAppData(dir: string): boolean {
  return APP_DATA_FILES.some(
    (file) => fs.existsSync(path.join(dir, file)) || fs.existsSync(path.join(dir, `${file}.bak`)),
  );
}

export type MigrationResult = 'no-legacy' | 'legacy-empty' | 'current-in-use' | 'migrated';

/**
 * Moves the legacy data folder to the current location, whole, so backups and the Chromium
 * "Local State" that secrets.bin depends on travel with it. Never touches a current folder that
 * already holds app data, and never merges, so deleted presets/projects can't come back.
 * Throws if the move fails (e.g. a locked folder); the caller decides how to recover.
 */
export function migrateLegacyFolder(legacy: string, current: string): MigrationResult {
  if (!fs.existsSync(legacy)) return 'no-legacy';
  if (!hasAppData(legacy)) return 'legacy-empty';
  if (hasAppData(current)) return 'current-in-use';
  // Anything left in the current folder is regenerable Chromium state.
  fs.rmSync(current, { recursive: true, force: true });
  fs.renameSync(legacy, current);
  return 'migrated';
}
