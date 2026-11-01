import * as dgram from 'dgram';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { createRequire } from 'module';
import * as path from 'path';
import { findTools } from '../../src/main/render/tools';
import type { SceneHostOptions } from '../../src/main/scene/client';
import type { SceneAdapter, SceneJob } from '../../src/main/scene/protocol';

export const ROOT = path.resolve(__dirname, '..', '..');
export const SCENES = path.join(ROOT, 'tests', 'fixtures', 'scenes');
export const HOST_SCRIPT = path.join(ROOT, 'dist', 'main', 'scene', 'host', 'hostMain.js');
export const ELECTRON = createRequire(__filename)('electron') as unknown as string;
export const TOOLS = findTools({ env: process.env, platform: process.platform, searchDirs: [] });
export const OUT = path.join(ROOT, 'test-results', 'scene');

export function hostOptions(extra: Partial<SceneHostOptions> = {}): SceneHostOptions {
  if (!fs.existsSync(HOST_SCRIPT)) throw new Error('Run `npm run build:main` first (the render host runs compiled).');
  return { electron: ELECTRON, hostScript: HOST_SCRIPT, ...extra };
}

/** A job from a fixture page plus the shared font (paths mirror the fixture tree). */
export function fixtureJob(entry: string, adapter: SceneAdapter, opts: Partial<SceneJob> & { extraFiles?: string[] } = {}): SceneJob {
  const { extraFiles = [], ...rest } = opts;
  const paths = [entry, 'fonts/InterDisplay-ExtraBold.otf', ...extraFiles];
  return {
    entry,
    files: paths.map((p) => ({ path: p, data: fs.readFileSync(path.join(SCENES, p)) })),
    adapter,
    width: 1920,
    height: 1080,
    deviceScale: 1,
    alpha: false,
    seed: 7,
    ...rest,
  };
}

/** Reads the time-code block (top-left 4×4 CSS px; RGB = round(t·100000)). */
export function timeCode(rgba: Uint8Array, width: number, dpr = 1): number {
  const i = (Math.round(2 * dpr) * width + Math.round(2 * dpr)) * 4;
  return ((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]) / 100000;
}

export function px(rgba: Uint8Array, width: number, x: number, y: number): number[] {
  const i = (y * width + x) * 4;
  return [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]];
}

/** Counts every connection or packet that reaches it: HTTP, WebSocket upgrades, proxy CONNECTs, UDP. */
export class Listener {
  hits: string[] = [];
  private server = http.createServer((req, res) => {
    this.hits.push(`http ${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
    res.end('ok');
  });
  private udp = dgram.createSocket('udp4');
  port = 0;
  udpPort = 0;

  async start(): Promise<void> {
    this.server.on('upgrade', (req, socket) => {
      this.hits.push(`upgrade ${req.url}`);
      socket.destroy();
    });
    this.server.on('connect', (req, socket) => {
      this.hits.push(`connect ${req.url}`);
      socket.destroy();
    });
    this.server.on('connection', () => this.hits.push('tcp connection'));
    this.udp.on('message', (m, r) => this.hits.push(`udp ${m.length}B from ${r.address}`));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    await new Promise<void>((r) => this.udp.bind(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
    this.udpPort = (this.udp.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections?.();
    await new Promise<void>((r) => this.server.close(() => r()));
    await new Promise<void>((r) => this.udp.close(() => r()));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
