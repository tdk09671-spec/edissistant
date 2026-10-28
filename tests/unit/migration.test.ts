import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { hasAppData, migrateLegacyFolder } from '../../src/main/migration';

let root: string;
let legacy: string;
let current: string;

function write(dir: string, file: string, content: unknown): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), typeof content === 'string' ? content : JSON.stringify(content));
}

function read(dir: string, file: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'edissistant-migration-'));
  legacy = path.join(root, 'edissisant');
  current = path.join(root, 'edissistant');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('hasAppData', () => {
  it('ignores Chromium-only files', () => {
    write(current, 'Local State', '{}');
    fs.mkdirSync(path.join(current, 'GPUCache'));
    expect(hasAppData(current)).toBe(false);
  });

  it('counts data files and their backups', () => {
    write(current, 'settings.json.bak', {});
    expect(hasAppData(current)).toBe(true);
  });

  it('is false for a missing folder', () => {
    expect(hasAppData(path.join(root, 'nope'))).toBe(false);
  });
});

describe('migrateLegacyFolder', () => {
  it('does nothing without a legacy folder', () => {
    write(current, 'Local State', '{}');
    expect(migrateLegacyFolder(legacy, current)).toBe('no-legacy');
    expect(fs.existsSync(path.join(current, 'Local State'))).toBe(true);
  });

  it('moves legacy data when the current folder does not exist', () => {
    write(legacy, 'presets.json', [{ name: 'Legacy Preset' }]);
    expect(migrateLegacyFolder(legacy, current)).toBe('migrated');
    expect(read(current, 'presets.json')).toEqual([{ name: 'Legacy Preset' }]);
    expect(fs.existsSync(legacy)).toBe(false);
  });

  it('moves legacy data into an empty current folder', () => {
    fs.mkdirSync(current, { recursive: true });
    write(legacy, 'projects.json', [{ name: 'Legacy Project' }]);
    expect(migrateLegacyFolder(legacy, current)).toBe('migrated');
    expect(read(current, 'projects.json')).toEqual([{ name: 'Legacy Project' }]);
  });

  it('regression: "Local State" alone in the current folder does not block migration', () => {
    write(current, 'Local State', '{"current":true}');
    write(legacy, 'projects.json', [{ name: 'Stranded Project' }]);
    write(legacy, 'Local State', '{"legacy":true}');
    expect(migrateLegacyFolder(legacy, current)).toBe('migrated');
    expect(read(current, 'projects.json')).toEqual([{ name: 'Stranded Project' }]);
    // The legacy Local State holds the key secrets.bin was encrypted with, so it must win.
    expect(read(current, 'Local State')).toEqual({ legacy: true });
  });

  it('preserves every legacy file, including backups and secrets', () => {
    write(legacy, 'presets.json', [{ name: 'New' }]);
    write(legacy, 'presets.json.bak', [{ name: 'Old' }]);
    write(legacy, 'projects.json.bak', [{ name: 'Old Project' }]);
    write(legacy, 'settings.json', { autoSave: false });
    write(legacy, 'settings.json.bak', { autoSave: true });
    write(legacy, 'secrets.bin', 'encrypted');
    expect(migrateLegacyFolder(legacy, current)).toBe('migrated');
    expect(read(current, 'presets.json.bak')).toEqual([{ name: 'Old' }]);
    expect(read(current, 'projects.json.bak')).toEqual([{ name: 'Old Project' }]);
    expect(read(current, 'settings.json')).toEqual({ autoSave: false });
    expect(read(current, 'settings.json.bak')).toEqual({ autoSave: true });
    expect(fs.readFileSync(path.join(current, 'secrets.bin'), 'utf-8')).toBe('encrypted');
  });

  it('leaves an empty legacy folder alone', () => {
    fs.mkdirSync(legacy, { recursive: true });
    write(current, 'Local State', '{}');
    expect(migrateLegacyFolder(legacy, current)).toBe('legacy-empty');
    expect(fs.existsSync(legacy)).toBe(true);
    expect(fs.existsSync(path.join(current, 'Local State'))).toBe(true);
  });

  it('leaves a legacy folder holding only Chromium files alone', () => {
    write(legacy, 'Local State', '{}');
    expect(migrateLegacyFolder(legacy, current)).toBe('legacy-empty');
    expect(fs.existsSync(path.join(legacy, 'Local State'))).toBe(true);
  });

  it.each(['presets.json', 'projects.json', 'settings.json', 'secrets.bin'])(
    'never overwrites a current folder holding %s',
    (file) => {
      write(current, file, file === 'secrets.bin' ? 'current-secret' : { current: true });
      write(legacy, file, { legacy: true });
      write(legacy, 'presets.json.bak', [{ name: 'Legacy backup' }]);
      expect(migrateLegacyFolder(legacy, current)).toBe('current-in-use');
      const now = fs.readFileSync(path.join(current, file), 'utf-8');
      expect(now).toBe(file === 'secrets.bin' ? 'current-secret' : '{"current":true}');
      // The legacy folder and its backups are left untouched.
      expect(read(legacy, file)).toEqual({ legacy: true });
      expect(read(legacy, 'presets.json.bak')).toEqual([{ name: 'Legacy backup' }]);
    },
  );

  it('treats a current backup alone as user data and preserves it', () => {
    write(current, 'projects.json.bak', [{ name: 'Current backup' }]);
    write(legacy, 'projects.json', [{ name: 'Legacy' }]);
    expect(migrateLegacyFolder(legacy, current)).toBe('current-in-use');
    expect(read(current, 'projects.json.bak')).toEqual([{ name: 'Current backup' }]);
  });

  it('does not restore presets or projects deleted in the current folder', () => {
    write(current, 'presets.json', []);
    write(current, 'projects.json', []);
    write(legacy, 'presets.json', [{ name: 'Deleted Test Preset' }]);
    write(legacy, 'projects.json', [{ name: 'Deleted Test Project' }]);
    expect(migrateLegacyFolder(legacy, current)).toBe('current-in-use');
    expect(read(current, 'presets.json')).toEqual([]);
    expect(read(current, 'projects.json')).toEqual([]);
  });

  it('runs only once: a second call after migrating is a no-op', () => {
    write(legacy, 'presets.json', [{ name: 'Legacy Preset' }]);
    expect(migrateLegacyFolder(legacy, current)).toBe('migrated');
    expect(migrateLegacyFolder(legacy, current)).toBe('no-legacy');
    expect(read(current, 'presets.json')).toEqual([{ name: 'Legacy Preset' }]);
  });
});
