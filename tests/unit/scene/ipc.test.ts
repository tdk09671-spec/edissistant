import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectToApp, IpcChannel, listenForHost, newIpcConfig, takeIpcFile, writeIpcFile, type IpcConfig } from '../../../src/main/scene/ipc';
import { encodeMessage } from '../../../src/main/scene/protocol';

// The app ↔ render host channel, without Electron: B1/B2 replacement (no stdin/stdout), mutual proof,
// single connection, framing caps, backpressure.

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edissistant-ipc-test-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A raw client that sends `payload` first and records anything it receives. */
function rawClient(endpoint: string, payload: Buffer | null): Promise<{ received: Buffer; closed: boolean; error?: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const s = net.connect(endpoint);
    s.on('connect', () => payload && s.write(payload));
    s.on('data', (c) => chunks.push(c));
    s.on('error', (e) => resolve({ received: Buffer.concat(chunks), closed: true, error: e.message }));
    s.on('close', () => resolve({ received: Buffer.concat(chunks), closed: true }));
    setTimeout(() => {
      s.destroy();
      resolve({ received: Buffer.concat(chunks), closed: false });
    }, 6500);
  });
}

describe('render host IPC', () => {
  it('connection file: written owner-only, read once and deleted by the host', () => {
    const c = newIpcConfig(dir);
    writeIpcFile(dir, c);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(dir, 'ipc.json')).mode & 0o777).toBe(0o600);
    expect(takeIpcFile(dir)).toEqual(c);
    expect(fs.existsSync(path.join(dir, 'ipc.json'))).toBe(false);
    expect(() => writeIpcFile(dir, c) || writeIpcFile(dir, c)).toThrow(); // never overwrites an existing file
  });

  it('endpoint: a random named pipe on Windows, a socket in the private job folder elsewhere', () => {
    expect(newIpcConfig(dir, 'win32').endpoint).toMatch(/^\\\\\.\\pipe\\edissistant-scene-[0-9a-f]{32}$/);
    expect(newIpcConfig(dir, 'linux').endpoint).toBe(path.join(dir, 'ipc.sock'));
    expect(newIpcConfig(dir).secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it('mutual proof, then framed messages both ways, with job ids', async () => {
    const config = newIpcConfig(dir);
    const { accepted } = await listenForHost(config, { timeoutMs: 5000 });
    const [hostSocket, appSocket] = await Promise.all([connectToApp(config), accepted]);
    const got: { side: string; header: Record<string, unknown>; bin: number }[] = [];
    const host = new IpcChannel(hostSocket, config.jobId, (h, b) => got.push({ side: 'host', header: h, bin: b?.length ?? 0 }), () => undefined, { maxHeader: 1 << 20, maxBinary: 1 << 20 });
    const app = new IpcChannel(appSocket, config.jobId, (h, b) => got.push({ side: 'app', header: h, bin: b?.length ?? 0 }), () => undefined, { maxHeader: 1 << 20, maxBinary: 1 << 20 });
    await host.send({ type: 'ready' });
    await app.send({ type: 'capture', id: 1 }, new Uint8Array(1000));
    await sleep(100);
    expect(got.sort((a, b) => a.side.localeCompare(b.side))).toEqual([
      { side: 'app', header: { type: 'ready', jobId: config.jobId }, bin: 0 },
      { side: 'host', header: { type: 'capture', id: 1, jobId: config.jobId, bin: 1000 }, bin: 1000 },
    ]);
    host.close();
    app.close();
  });

  it('a client without the secret is refused and receives nothing; the real host still gets in', async () => {
    const config = newIpcConfig(dir);
    const rejected: string[] = [];
    const { accepted } = await listenForHost(config, { timeoutMs: 10_000, onRejected: (r) => rejected.push(r) });
    const forged = Buffer.concat(encodeMessage({ type: 'hello', jobId: config.jobId, nonce: crypto.randomBytes(16).toString('hex'), proof: crypto.randomBytes(32).toString('hex') }));
    const intruder = await rawClient(config.endpoint, forged);
    expect(intruder.received.length).toBe(0); // no welcome, no job data
    expect(intruder.closed).toBe(true);
    const silent = await rawClient(config.endpoint, Buffer.from('GET / HTTP/1.1\r\n\r\n'));
    expect(silent.received.length).toBe(0);
    expect(rejected).toEqual(['bad proof', 'malformed hello']);
    const [h] = await Promise.all([connectToApp(config), accepted]);
    h.destroy();
  });

  it('exactly one connection: after the host is in, the endpoint stops accepting', async () => {
    const config = newIpcConfig(dir);
    const { accepted } = await listenForHost(config, { timeoutMs: 5000 });
    const [h, a] = await Promise.all([connectToApp(config), accepted]);
    await sleep(50);
    const late = await rawClient(config.endpoint, null);
    expect(late.received.length).toBe(0);
    expect(late.error ?? 'closed').toMatch(/ENOENT|ECONNREFUSED|closed/);
    await expect(connectToApp(config, 2000)).rejects.toBeTruthy(); // even with the secret
    h.destroy();
    a.destroy();
  });

  it('the host refuses an app that cannot prove the secret (no impostor endpoint)', async () => {
    const real = newIpcConfig(dir);
    const impostor: IpcConfig = { ...real, secret: crypto.randomBytes(32).toString('hex') };
    const { accepted } = await listenForHost(impostor, { timeoutMs: 3000 });
    await expect(connectToApp(real, 3000)).rejects.toBeTruthy();
    await expect(accepted).rejects.toBeTruthy();
  });

  it('pipelined data after the hello is a protocol violation', async () => {
    const config = newIpcConfig(dir);
    const rejected: string[] = [];
    await listenForHost(config, { timeoutMs: 5000, onRejected: (r) => rejected.push(r) });
    const nonce = crypto.randomBytes(16).toString('hex');
    const proof = crypto.createHmac('sha256', Buffer.from(config.secret, 'hex')).update(`edissistant-scene|host|${config.jobId}|${nonce}`).digest('hex');
    const both = Buffer.concat([...encodeMessage({ type: 'hello', jobId: config.jobId, nonce, proof }), ...encodeMessage({ type: 'ready', jobId: config.jobId })]);
    const r = await rawClient(config.endpoint, both);
    expect(r.received.length).toBe(0);
    expect(rejected).toEqual(['data after hello']);
  });

  it('messages for another job, oversized payloads and corrupt framing are fatal, never skipped', async () => {
    const config = newIpcConfig(dir);
    const { accepted } = await listenForHost(config, { timeoutMs: 5000 });
    const [hostSocket, appSocket] = await Promise.all([connectToApp(config), accepted]);
    const errors: string[] = [];
    new IpcChannel(appSocket, config.jobId, () => undefined, (e) => errors.push(e.message), { maxHeader: 4096, maxBinary: 1000 });
    hostSocket.resume();
    hostSocket.write(Buffer.concat(encodeMessage({ type: 'frame', jobId: 'ffffffffffffffff' })));
    await sleep(100);
    expect(errors[0]).toMatch(/another job/);

    const c2 = newIpcConfig(fs.mkdtempSync(path.join(dir, 'b-')));
    const l2 = await listenForHost(c2, { timeoutMs: 5000 });
    const [h2, a2] = await Promise.all([connectToApp(c2), l2.accepted]);
    const errors2: string[] = [];
    new IpcChannel(a2, c2.jobId, () => undefined, (e) => errors2.push(e.message), { maxHeader: 4096, maxBinary: 1000 });
    h2.resume();
    h2.write(Buffer.concat(encodeMessage({ type: 'frame', jobId: c2.jobId }, new Uint8Array(5000))));
    await sleep(100);
    expect(errors2[0]).toMatch(/payload size/);

    const c3 = newIpcConfig(fs.mkdtempSync(path.join(dir, 'c-')));
    const l3 = await listenForHost(c3, { timeoutMs: 5000 });
    const [h3, a3] = await Promise.all([connectToApp(c3), l3.accepted]);
    const errors3: string[] = [];
    new IpcChannel(a3, c3.jobId, () => undefined, (e) => errors3.push(e.message), { maxHeader: 4096, maxBinary: 1000 });
    h3.resume();
    h3.write(Buffer.from('\r\nstray bytes\r\n'));
    await sleep(100);
    expect(errors3[0]).toMatch(/protocol error/);
    for (const s of [hostSocket, appSocket, h2, a2, h3, a3]) s.destroy();
  });

  it('streams a 64 MB frame intact under backpressure', async () => {
    const config = newIpcConfig(dir);
    const { accepted } = await listenForHost(config, { timeoutMs: 5000 });
    const [hostSocket, appSocket] = await Promise.all([connectToApp(config), accepted]);
    const frame = crypto.randomBytes(64 * 1024 * 1024);
    const received = new Promise<Buffer>((resolve) => {
      new IpcChannel(appSocket, config.jobId, (_h, b) => resolve(b!), () => undefined, { maxHeader: 1 << 20, maxBinary: 128 * 1024 * 1024 });
    });
    const host = new IpcChannel(hostSocket, config.jobId, () => undefined, () => undefined, { maxHeader: 1 << 20, maxBinary: 1 });
    await host.send({ type: 'frame', id: 1 }, frame);
    const got = await received;
    expect(crypto.createHash('sha256').update(got).digest('hex')).toBe(crypto.createHash('sha256').update(frame).digest('hex'));
    hostSocket.destroy();
    appSocket.destroy();
  });
});
