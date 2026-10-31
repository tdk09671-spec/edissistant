// Finds FFmpeg and FFprobe. Nothing is downloaded: the binaries come from settings, an environment
// override, the app's data folder or PATH. (PR #1 has a similar locator for transcription; the two
// can be merged once both land.)

import * as fs from 'fs';
import * as path from 'path';
import { runTool } from './process';

export interface Tools {
  ffmpeg: string;
  ffprobe: string;
}

export interface ToolSearch {
  /** settings.ffmpegPath: the executable or the folder containing it. */
  configured?: string;
  searchDirs: string[];
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function exe(name: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${name}.exe` : name;
}

function candidates(search: ToolSearch): string[] {
  const dirs: string[] = [];
  for (const explicit of [search.configured, search.env.EDISSISTANT_FFMPEG_PATH]) {
    const value = explicit?.trim().replace(/^"(.*)"$/, '$1');
    if (!value) continue;
    // A configured file means "this ffmpeg"; its folder is where ffprobe should be too.
    dirs.push(isFile(value) ? path.dirname(value) : value, path.join(isFile(value) ? path.dirname(value) : value, 'bin'));
  }
  dirs.push(...search.searchDirs);
  const PATH = search.env.PATH ?? search.env.Path ?? '';
  dirs.push(...PATH.split(search.platform === 'win32' ? ';' : ':').filter(Boolean));
  if (search.platform === 'darwin') dirs.push('/opt/homebrew/bin', '/usr/local/bin');
  return dirs;
}

export function findTools(search: ToolSearch): Partial<Tools> {
  const found: Partial<Tools> = {};
  const configuredFile = search.configured?.trim().replace(/^"(.*)"$/, '$1');
  if (configuredFile && isFile(configuredFile)) found.ffmpeg = configuredFile;
  for (const dir of candidates(search)) {
    if (!found.ffmpeg && isFile(path.join(dir, exe('ffmpeg', search.platform)))) found.ffmpeg = path.join(dir, exe('ffmpeg', search.platform));
    if (!found.ffprobe && isFile(path.join(dir, exe('ffprobe', search.platform)))) found.ffprobe = path.join(dir, exe('ffprobe', search.platform));
    if (found.ffmpeg && found.ffprobe) break;
  }
  return found;
}

/** Encoders compiled into this FFmpeg build. */
export async function listEncoders(ffmpeg: string): Promise<Set<string>> {
  const { stdout } = await runTool(ffmpeg, ['-hide_banner', '-encoders']);
  const names = new Set<string>();
  for (const line of stdout.toString('utf8').split('\n')) {
    const m = /^\s*[VAS][A-Z.]{5}\s+(\S+)/.exec(line);
    if (m) names.add(m[1]);
  }
  return names;
}

export async function ffmpegVersion(ffmpeg: string): Promise<string | undefined> {
  try {
    const { stdout } = await runTool(ffmpeg, ['-hide_banner', '-version']);
    return /version (\S+)/.exec(stdout.toString('utf8'))?.[1];
  } catch {
    return undefined;
  }
}
