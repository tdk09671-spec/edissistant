// Locates FFmpeg, the whisper.cpp CLI and installed models. Nothing is downloaded: tools come from
// the user's settings, environment variables, the app's data folder or the system PATH.

import * as fs from 'fs';
import * as path from 'path';
import { TranscriptionError, type InstalledModel } from '../../shared/transcription';

export interface ToolLocations {
  /** settings.ffmpegPath: the executable or the folder containing it. */
  ffmpegPath?: string;
  /** settings.transcription.whisperPath: the executable or the folder containing it. */
  whisperPath?: string;
  modelsDirectory: string;
  /** Extra folders searched before PATH, e.g. <userData>/bin. */
  searchDirs: string[];
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

export const FFMPEG_NAMES = ['ffmpeg'];
// `main` is the pre-2025 name of whisper-cli; Homebrew used to ship `whisper-cpp`.
export const WHISPER_NAMES = ['whisper-cli', 'whisper-cpp', 'main'];

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function executableNames(names: string[], platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? names.map((n) => `${n}.exe`) : names;
}

function pathDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const raw = env.PATH ?? env.Path ?? '';
  const dirs = raw.split(platform === 'win32' ? ';' : ':').filter(Boolean);
  // Apps launched from Finder don't inherit the shell PATH, so add the Homebrew prefixes on macOS.
  if (platform === 'darwin') dirs.push('/opt/homebrew/bin', '/usr/local/bin');
  return dirs;
}

function findIn(dir: string, names: string[], platform: NodeJS.Platform, allowMain: boolean): string | undefined {
  for (const name of executableNames(names, platform)) {
    // A bare "main" on PATH is far too generic to trust; only accept it in folders we were pointed at.
    if (!allowMain && /^main(\.exe)?$/.test(name)) continue;
    const candidate = path.join(dir, name);
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

/** Resolves a tool: configured path → env override → search folders → PATH. */
export function findTool(
  names: string[],
  configured: string | undefined,
  envVar: string,
  locations: Pick<ToolLocations, 'searchDirs' | 'env' | 'platform'>
): string | undefined {
  const { env, platform } = locations;
  for (const explicit of [configured, env[envVar]]) {
    if (!explicit?.trim()) continue;
    const value = explicit.trim().replace(/^"(.*)"$/, '$1');
    if (isFile(value)) return value;
    if (isDir(value)) {
      const found = findIn(value, names, platform, true) ?? findIn(path.join(value, 'bin'), names, platform, true);
      if (found) return found;
    }
  }
  for (const dir of locations.searchDirs) {
    const found = findIn(dir, names, platform, true);
    if (found) return found;
  }
  for (const dir of pathDirs(env, platform)) {
    const found = findIn(dir, names, platform, false);
    if (found) return found;
  }
  return undefined;
}

export function findFfmpeg(locations: ToolLocations): string | undefined {
  return findTool(FFMPEG_NAMES, locations.ffmpegPath, 'EDISSISTANT_FFMPEG_PATH', locations);
}

export function findWhisper(locations: ToolLocations): string | undefined {
  return findTool(WHISPER_NAMES, locations.whisperPath, 'EDISSISTANT_WHISPER_PATH', locations);
}

// --- Models --------------------------------------------------------------------------------------

const MODEL_FILE = /^ggml-(.+)\.bin$/i;
// Files in a models folder that aren't transcription models.
const NOT_A_MODEL = /^(for-tests-|silero|.*-encoder)/i;

export function listModels(modelsDirectory: string): InstalledModel[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(modelsDirectory);
  } catch {
    return [];
  }
  const models: InstalledModel[] = [];
  for (const file of entries) {
    const match = MODEL_FILE.exec(file);
    if (!match || NOT_A_MODEL.test(match[1]) || NOT_A_MODEL.test(file)) continue;
    const full = path.join(modelsDirectory, file);
    try {
      const stat = fs.statSync(full);
      if (stat.isFile() && stat.size > 0) models.push({ name: match[1], file, path: full, size: stat.size });
    } catch {
      // Unreadable entry; skip
    }
  }
  return models.sort((a, b) => b.size - a.size);
}

/** Picks a model: explicit request → configured default → the largest installed model. */
export function resolveModel(models: InstalledModel[], requested: string | undefined, configured: string | undefined): InstalledModel {
  for (const wanted of [requested, configured]) {
    if (!wanted?.trim()) continue;
    const value = wanted.trim();
    if (path.isAbsolute(value)) {
      if (isFile(value)) {
        const file = path.basename(value);
        return { name: MODEL_FILE.exec(file)?.[1] ?? file, file, path: value, size: fs.statSync(value).size };
      }
      throw new TranscriptionError('MODEL_NOT_FOUND', `Model file not found: ${value}`);
    }
    const found = models.find((m) => m.name.toLowerCase() === value.toLowerCase() || m.file.toLowerCase() === value.toLowerCase());
    if (found) return found;
    if (wanted === requested) {
      const installed = models.map((m) => m.name).join(', ') || 'none';
      throw new TranscriptionError('MODEL_NOT_FOUND', `Model "${value}" is not installed (installed: ${installed}).`);
    }
  }
  if (models.length === 0) {
    throw new TranscriptionError('MODEL_NOT_FOUND', 'No Whisper model is installed. Add a ggml-*.bin model to the models folder.');
  }
  return models[0];
}

/**
 * Maps a model name to whisper.cpp's DTW alignment-head preset, or undefined when the architecture
 * can't be told from the name (e.g. plain "large", fine-tunes).
 */
export function dtwPreset(modelName: string): string | undefined {
  const base = modelName.toLowerCase().replace(/-q\d+_\d+$|-q\d+$|-f16$|-f32$/, '');
  const known: Record<string, string> = {
    tiny: 'tiny',
    'tiny.en': 'tiny.en',
    base: 'base',
    'base.en': 'base.en',
    small: 'small',
    'small.en': 'small.en',
    medium: 'medium',
    'medium.en': 'medium.en',
    'large-v1': 'large.v1',
    'large-v2': 'large.v2',
    'large-v3': 'large.v3',
    'large-v3-turbo': 'large.v3.turbo',
  };
  return known[base];
}
