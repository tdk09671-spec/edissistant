// Dedicated, authenticated IPC between the app and one render host process.
//
// Why not stdin/stdout: on Windows, Electron 45 closes the child's stdin before the host can read a job
// (B1), and writes stray CRLF bytes to stdout before the first message (B2). stdout/stderr are kept for
// diagnostics only and are never parsed as protocol.
//
// Design (smallest cross-platform option, Node's `net` only):
//  - The app creates the endpoint BEFORE starting the host:
//      Windows: a named pipe \\.\pipe\edissistant-scene-<128-bit random>
//      POSIX:   a Unix socket inside the job's private temp folder (created 0700 by mkdtemp)
//  - The endpoint, a 256-bit secret and the job id are written to <job folder>/ipc.json (0600), which
//    the host reads and deletes at startup. Nothing secret goes in argv or the environment.
//  - Mutual proof before any job data flows: the host sends HMAC(secret, "host"|job|nonce); the app checks
//    it in constant time and answers HMAC(secret, "app"|job|nonce), which the host checks. Clients that
//    fail (or say nothing within 5 s, or send more than 4 KB first) are dropped and receive nothing.
//  - The app accepts exactly ONE authenticated connection and then stops listening, so nothing else can
//    attach to the job later. Every message carries the job id; mismatches are protocol errors.
//  - Framing: magic + length-prefixed JSON + declared binary length, with hard caps on header and binary
//    sizes (bounded buffering). Writers wait for 'drain' (backpressure). Corrupt framing is fatal.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { encodeMessage, MessageReader } from './protocol';

export interface IpcConfig {
  endpoint: string;
  secret: string;
  jobId: string;
}

export const IPC_FILE = 'ipc.json';
const HELLO_TIMEOUT = 5000;
const MAX_HELLO = 4096;

const mac = (secret: string, role: 'host' | 'app', jobId: string, nonce: string) =>
  crypto.createHmac('sha256', Buffer.from(secret, 'hex')).update(`edissistant-scene|${role}|${jobId}|${nonce}`).digest('hex');

const sameHex = (a: unknown, b: string) => {
  if (typeof a !== 'string' || a.length !== b.length || !/^[0-9a-f]+$/.test(a)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
};

/** A fresh endpoint for a job folder. */
export function newIpcConfig(jobDir: string, platform: NodeJS.Platform = process.platform): IpcConfig {
  const rand = crypto.randomBytes(16).toString('hex');
  const endpoint = platform === 'win32' ? `\\\\.\\pipe\\edissistant-scene-${rand}` : path.join(jobDir, 'ipc.sock');
  return { endpoint, secret: crypto.randomBytes(32).toString('hex'), jobId: crypto.randomBytes(8).toString('hex') };
}

/** Writes the host's connection file (owner-only) into the job folder. */
export function writeIpcFile(jobDir: string, config: IpcConfig): void {
  fs.writeFileSync(path.join(jobDir, IPC_FILE), JSON.stringify(config), { mode: 0o600, flag: 'wx' });
}

/** Host side: reads and deletes the connection file. */
export function takeIpcFile(jobDir: string): IpcConfig {
  const file = path.join(jobDir, IPC_FILE);
  const raw = fs.readFileSync(file, 'utf8');
  fs.rmSync(file, { force: true });
  const c = JSON.parse(raw) as IpcConfig;
  if (typeof c.endpoint !== 'string' || !/^[0-9a-f]{64}$/.test(c.secret) || !/^[0-9a-f]{16}$/.test(c.jobId)) throw new Error('Invalid IPC file.');
  return c;
}

/** A framed, size-capped, backpressured connection carrying one job. */
export class IpcChannel {
  private readonly reader: MessageReader;
  private writing: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    readonly socket: net.Socket,
    readonly jobId: string,
    onMessage: (header: Record<string, unknown>, bin: Buffer | null) => void,
    onError: (error: Error) => void,
    limits: { maxHeader: number; maxBinary: number }
  ) {
    this.reader = new MessageReader(limits.maxHeader, limits.maxBinary);
    socket.on('data', (chunk: Buffer) => {
      if (this.closed) return;
      try {
        for (const { header, bin } of this.reader.push(chunk)) {
          if (header.jobId !== this.jobId) throw new Error('Render host protocol error (message for another job).');
          onMessage(header, bin);
        }
      } catch (e) {
        this.closed = true;
        socket.destroy();
        onError(e as Error);
      }
    });
    socket.on('error', (e) => onError(e));
    socket.resume();
  }

  /** Sends one message; resolves once the OS has taken it (waits for 'drain' when the pipe is full). */
  send(header: Record<string, unknown>, bin?: Uint8Array): Promise<void> {
    const parts = encodeMessage({ ...header, jobId: this.jobId }, bin);
    this.writing = this.writing.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (this.socket.destroyed) return reject(new Error('The render host connection is closed.'));
          let i = 0;
          const next = () => {
            while (i < parts.length) {
              if (!this.socket.write(parts[i++])) return void this.socket.once('drain', next);
            }
            resolve();
          };
          next();
        })
    );
    return this.writing;
  }

  close(): void {
    this.closed = true;
    this.socket.end();
  }
}

/** App side: listens, accepts the first client that proves the secret, then stops listening. */
export async function listenForHost(config: IpcConfig, opts: { timeoutMs: number; onRejected?: (reason: string) => void }): Promise<{ server: net.Server; accepted: Promise<net.Socket> }> {
  const server = net.createServer();
  let settle!: { resolve: (s: net.Socket) => void; reject: (e: Error) => void };
  const accepted = new Promise<net.Socket>((resolve, reject) => (settle = { resolve, reject }));
  accepted.catch(() => undefined);
  let done = false;
  const timer = setTimeout(() => {
    if (done) return;
    done = true;
    server.close();
    settle.reject(new Error('The render host did not connect in time.'));
  }, opts.timeoutMs);
  server.maxConnections = 4;
  server.on('connection', (socket) => {
    if (done) return void socket.destroy();
    const reader = new MessageReader(MAX_HELLO, 0);
    const drop = (reason: string) => {
      opts.onRejected?.(reason);
      socket.destroy();
    };
    const helloTimer = setTimeout(() => drop('no hello in time'), HELLO_TIMEOUT);
    const onData = (chunk: Buffer) => {
      let msgs;
      try {
        msgs = reader.push(chunk);
      } catch {
        clearTimeout(helloTimer);
        return drop('malformed hello');
      }
      if (!msgs.length) return;
      clearTimeout(helloTimer);
      socket.off('data', onData);
      socket.pause(); // no data is lost before the channel attaches (it resumes)
      // The handshake strictly alternates: anything after the hello is a protocol violation.
      if (msgs.length > 1 || reader.buffered > 0) return drop('data after hello');
      const h = msgs[0].header as { type?: string; jobId?: string; nonce?: string; proof?: string };
      if (h.type !== 'hello' || h.jobId !== config.jobId || typeof h.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(h.nonce) || !sameHex(h.proof, mac(config.secret, 'host', config.jobId, h.nonce))) {
        return drop('bad proof');
      }
      if (done) return drop('already connected');
      done = true;
      clearTimeout(timer);
      // One job, one connection: nothing else can attach from now on.
      server.close();
      for (const part of encodeMessage({ type: 'welcome', jobId: config.jobId, proof: mac(config.secret, 'app', config.jobId, h.nonce) })) socket.write(part);
      settle.resolve(socket);
    };
    socket.on('data', onData);
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.endpoint, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return { server, accepted };
}

/** Host side: connects and proves the secret; checks the app's answer. */
export function connectToApp(config: IpcConfig, timeoutMs = 10_000): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const nonce = crypto.randomBytes(16).toString('hex');
    const socket = net.connect(config.endpoint);
    const reader = new MessageReader(MAX_HELLO, 0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('The app did not answer the render host in time.'));
    }, timeoutMs);
    socket.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    socket.once('connect', () => {
      for (const part of encodeMessage({ type: 'hello', jobId: config.jobId, nonce, proof: mac(config.secret, 'host', config.jobId, nonce) })) socket.write(part);
    });
    const onData = (chunk: Buffer) => {
      let msgs;
      try {
        msgs = reader.push(chunk);
      } catch (e) {
        clearTimeout(timer);
        socket.destroy();
        return reject(e as Error);
      }
      if (!msgs.length) return;
      socket.off('data', onData);
      socket.pause();
      clearTimeout(timer);
      if (msgs.length > 1 || reader.buffered > 0) {
        socket.destroy();
        return reject(new Error('Render host protocol error (data after welcome).'));
      }
      const w = msgs[0].header as { type?: string; jobId?: string; proof?: string };
      if (w.type !== 'welcome' || w.jobId !== config.jobId || !sameHex(w.proof, mac(config.secret, 'app', config.jobId, nonce))) {
        socket.destroy();
        return reject(new Error('The app could not be verified.'));
      }
      // The host now sends 'ready'; the app sends job commands only after that, so nothing is pipelined.
      resolve(socket);
    };
    socket.on('data', onData);
  });
}
