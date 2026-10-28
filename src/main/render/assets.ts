import * as fs from 'fs';
import * as path from 'path';
import { RenderError } from '../../shared/animation/errors';
import { FONT_EXTENSIONS, IMAGE_EXTENSIONS } from '../../shared/animation/validate';
import type { AnimationSpec } from '../../shared/animation/types';
import { sha256 } from './cache';

const MAX_ASSET_BYTES = 50 * 1024 * 1024;

const IMAGE_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

export interface LoadedFont {
  family: string;
  weight?: number;
  style?: 'normal' | 'italic';
  data: Uint8Array;
}

export interface LoadedImage {
  id: string;
  mime: string;
  data: Uint8Array;
}

export interface LoadedAssets {
  fonts: LoadedFont[];
  images: LoadedImage[];
  /** Asset path → content hash, part of the render cache key. */
  fingerprints: Record<string, string>;
}

function readAsset(file: string, kind: 'Font' | 'Image', allowed: string[]): Buffer {
  const ext = path.extname(file).toLowerCase();
  if (!allowed.includes(ext)) throw new RenderError('INVALID_SPEC', `${kind} ${file} has an unsupported extension.`);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new RenderError(kind === 'Font' ? 'FONT_NOT_FOUND' : 'MEDIA_NOT_FOUND', `${kind} file not found: ${file}`);
  }
  if (!stat.isFile()) throw new RenderError(kind === 'Font' ? 'FONT_NOT_FOUND' : 'MEDIA_NOT_FOUND', `${kind} path is not a file: ${file}`);
  if (stat.size === 0 || stat.size > MAX_ASSET_BYTES) {
    throw new RenderError('MEDIA_NOT_FOUND', `${kind} file must be between 1 byte and ${MAX_ASSET_BYTES / 1024 / 1024} MB: ${file}`);
  }
  return fs.readFileSync(file);
}

/**
 * Reads the font and image files a validated spec declares. Only these bytes ever reach the render
 * sandbox; it gets no file paths and no file system access.
 */
export function loadAssets(spec: AnimationSpec): LoadedAssets {
  const fingerprints: Record<string, string> = {};
  const fonts = (spec.assets?.fonts ?? []).map((f) => {
    const data = readAsset(f.path, 'Font', FONT_EXTENSIONS);
    fingerprints[`font:${f.family}:${f.weight ?? 400}:${f.style ?? 'normal'}`] = sha256(data);
    return { family: f.family, weight: f.weight, style: f.style, data: new Uint8Array(data) };
  });
  const images = (spec.assets?.images ?? []).map((img) => {
    const data = readAsset(img.path, 'Image', IMAGE_EXTENSIONS);
    fingerprints[`image:${img.id}`] = sha256(data);
    return { id: img.id, mime: IMAGE_MIME[path.extname(img.path).toLowerCase()], data: new Uint8Array(data) };
  });
  return { fonts, images, fingerprints };
}
