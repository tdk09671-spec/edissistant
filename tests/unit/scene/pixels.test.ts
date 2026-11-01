import * as zlib from 'zlib';
import { describe, expect, it } from 'vitest';
import { decodePng, encodePng } from '../../../src/main/scene/png';
import { Accumulator, applyCamera, premultiply, subframeTimes } from '../../../src/main/scene/pixels';
import { encodeMessage, MessageReader } from '../../../src/main/scene/protocol';
import { determinismShim } from '../../../src/main/scene/shim';
import { frameTime, frameTotal, sceneFingerprint } from '../../../src/main/scene/service';

const img = (w: number, h: number, f: (x: number, y: number) => [number, number, number, number]) => {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(f(x, y), (y * w + x) * 4);
  return { width: w, height: h, data };
};

describe('PNG codec', () => {
  it('round-trips straight RGBA exactly, including semi-transparent pixels', () => {
    const a = img(37, 11, (x, y) => [x * 7, y * 23, (x * y) % 256, (x * 13 + y) % 256]);
    const b = decodePng(encodePng(a));
    expect(b.width).toBe(37);
    expect(Buffer.from(b.data).equals(Buffer.from(a.data))).toBe(true);
  });

  it('decodes every PNG row filter (as Chromium writes them) and RGB without alpha', () => {
    // Build a PNG by hand with filters 0–4 on successive rows.
    const w = 5, h = 5;
    const rows: Buffer[] = [];
    const px = (x: number, y: number) => [(x * 40 + y) & 255, (y * 50) & 255, (x * y * 9) & 255];
    for (let y = 0; y < h; y++) {
      const filter = y;
      const line = Buffer.alloc(w * 3 + 1);
      line[0] = filter;
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < 3; c++) {
          const v = px(x, y)[c];
          const a = x > 0 ? px(x - 1, y)[c] : 0;
          const b = y > 0 ? px(x, y - 1)[c] : 0;
          const cc = x > 0 && y > 0 ? px(x - 1, y - 1)[c] : 0;
          const pa = Math.abs(b - cc), pb = Math.abs(a - cc), pc = Math.abs(a + b - 2 * cc);
          const pred = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : cc;
          line[1 + x * 3 + c] = (v - pred) & 255;
        }
      }
      rows.push(line);
    }
    const chunk = (type: string, body: Buffer) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
      return Buffer.concat([len, Buffer.from(type, 'latin1'), body, Buffer.alloc(4)]); // CRC isn't checked by the decoder
    };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
    const out = decodePng(png);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) expect([...out.data.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)]).toEqual([...px(x, y), 255]);
  });
});

describe('motion blur accumulation', () => {
  it('averages in premultiplied space: a white edge over transparency stays white, not grey', () => {
    const white = new Uint8Array([255, 255, 255, 255]);
    const clear = new Uint8Array([0, 0, 0, 0]); // transparent black, as Chromium captures empty pixels
    const acc = new Accumulator(1, 1);
    acc.addStraight(white);
    acc.addStraight(clear);
    acc.addStraight(clear);
    acc.addStraight(white);
    expect([...acc.toStraight()]).toEqual([255, 255, 255, 128]);
    // A naive straight average would give grey: (255+0+0+255)/4 = 128 in RGB.
  });

  it('mixes colours by coverage', () => {
    const acc = new Accumulator(1, 1);
    acc.addStraight(new Uint8Array([255, 0, 0, 255]));
    acc.addStraight(new Uint8Array([0, 0, 255, 128]));
    // premultiplied: (255,0,0,255) + (0,0,128,128) → mean (127.5,0,64,191.5) → straight ≈ (170,0,85,192)
    expect([...acc.toStraight()]).toEqual([170, 0, 85, 192]);
  });

  it('subframe times follow render.py: t + (k/n)·shutter/fps, with more samples in heavy windows', () => {
    expect(subframeTimes(1, 1 / 25, { samples: 4, shutter: 0.5 })).toEqual([1, 1.005, 1.01, 1.015]);
    expect(subframeTimes(2, 1 / 30, { samples: 3, shutter: 0.5, heavy: [{ from: 1.9, to: 2.1, samples: 12 }] })).toHaveLength(12);
    expect(subframeTimes(2, 1 / 30, { samples: 1, shutter: 0.5 })).toEqual([2]);
  });
});

describe('post-capture camera', () => {
  it('scale 1 is the identity; a push about the centre is symmetric and sub-pixel smooth', () => {
    const W = 64, H = 32;
    const src = img(W, H, (x) => (x >= 28 && x < 36 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const p = premultiply(src.data);
    expect(applyCamera(p, W, H, { scale: 1 })).toBe(p);
    const centroid = (buf: Float32Array) => {
      let m = 0, s = 0;
      for (let x = 0; x < W; x++) { const v = buf[(16 * W + x) * 4]; m += v * (x + 0.5); s += v; }
      return m / s;
    };
    // The bright bar is centred: zooming about the centre must keep it there, for any scale.
    for (const s of [1.01, 1.023, 1.05]) expect(centroid(applyCamera(p, W, H, { scale: s }))).toBeCloseTo(32, 3);
    // An off-centre bar moves outward by exactly (x − origin)·(s − 1), with sub-pixel precision, so a
    // constant-speed push moves it in even steps (no re-snapping to whole pixels).
    const off = premultiply(img(W, H, (x) => (x >= 12 && x < 16 ? [255, 255, 255, 255] : [0, 0, 0, 255])).data);
    const c0 = centroid(off);
    const scales = [1, 1.01, 1.02, 1.03, 1.04, 1.05];
    const pos = scales.map((s) => centroid(applyCamera(off, W, H, { scale: s })));
    scales.forEach((s, i) => expect(Math.abs(pos[i] - (32 + (c0 - 32) * s))).toBeLessThan(5e-3)); // < 1/200 px
    // After 8-bit output (clamped once), still within a few hundredths of a pixel.
    const acc8 = (s: number) => { const a = new Accumulator(W, H); a.addPremultiplied(applyCamera(off, W, H, { scale: s })); return premultiply(a.toStraight()); };
    scales.forEach((s) => expect(Math.abs(centroid(acc8(s)) - (32 + (c0 - 32) * s))).toBeLessThan(0.06));
  });

  it('the final 8-bit frame has no overshoot halos: empty areas stay fully transparent', () => {
    const W = 32, H = 32;
    // A white square on transparency, far from the edges.
    const src = img(W, H, (x, y) => (x >= 12 && x < 20 && y >= 12 && y < 20 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
    const a = new Accumulator(W, H);
    a.addPremultiplied(applyCamera(premultiply(src.data), W, H, { scale: 1.37, x: 0.4, y: -0.7 }));
    const out = a.toStraight();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (x < 4 || x > 27 || y < 4 || y > 27) expect([...out.subarray(i, i + 4)]).toEqual([0, 0, 0, 0]);
      if (out[i + 3] > 0) expect(out[i]).toBe(255); // edge pixels keep their true colour (white), only alpha varies
    }
  });
});

describe('render host protocol', () => {
  it('frames JSON + binary across arbitrary chunk boundaries', () => {
    const bin = new Uint8Array(100_000).map((_, i) => i & 255);
    const parts = [...encodeMessage({ type: 'frame', id: 3 }, bin), ...encodeMessage({ type: 'ready', pid: 1 })];
    const all = Buffer.concat(parts);
    const r = new MessageReader();
    const got: { header: Record<string, unknown>; bin: Buffer | null }[] = [];
    for (let i = 0; i < all.length; i += 777) got.push(...r.push(all.subarray(i, i + 777)));
    expect(got.map((g) => g.header.type)).toEqual(['frame', 'ready']);
    expect(Buffer.from(got[0].bin!).equals(Buffer.from(bin))).toBe(true);
  });

  it('refuses stray output on the message channel instead of misreading it', () => {
    expect(() => new MessageReader().push(Buffer.from('Some log line\n12345678'))).toThrow(/protocol error/);
  });
});

describe('scene timing and fingerprints', () => {
  it('frame times are exact rationals: 25, 30 and 29.97 (30000/1001)', () => {
    expect(frameTime(25, 25)).toBe(1);
    expect(frameTime(30, 30)).toBe(1);
    expect(frameTime(30000, 29.97)).toBe(1001);
    expect(frameTime(1, 29.97)).toBe(1001 / 30000);
    expect(frameTotal(2, 30)).toBe(60);
    expect(frameTotal(2, 29.97)).toBe(60); // 59.94 → 60 frames, the render.py rule (round(dur·fps))
    expect(frameTotal(4.4 - 2, 25)).toBe(60);
  });

  it('the fingerprint changes when code, assets or settings change, and only then', () => {
    const job = { entry: 'a.html', files: [{ path: 'a.html', data: Buffer.from('x') }], adapter: { kind: 'scene' as const }, width: 1920, height: 1080, deviceScale: 1, alpha: true, seed: 1 };
    const s = { fps: 30, motionBlur: { samples: 3, shutter: 0.5 }, postCamera: false };
    const a = sceneFingerprint(job, s, 'png-mov');
    expect(sceneFingerprint({ ...job, files: [{ path: 'a.html', data: Buffer.from('x') }] }, s, 'png-mov')).toBe(a);
    expect(sceneFingerprint({ ...job, files: [{ path: 'a.html', data: Buffer.from('y') }] }, s, 'png-mov')).not.toBe(a);
    expect(sceneFingerprint(job, { ...s, fps: 25 }, 'png-mov')).not.toBe(a);
    expect(sceneFingerprint(job, s, 'prores-4444')).not.toBe(a);
    expect(sceneFingerprint({ ...job, deviceScale: 2 }, s, 'png-mov')).not.toBe(a);
  });

  it('the determinism shim is a self-contained script with the seed baked in', () => {
    const src = determinismShim(1234);
    expect(src).toContain('1234');
    expect(() => new Function(src)).not.toThrow(); // valid JavaScript
  });
});
