// Injected into the scene page, and every frame it creates, before any of its own scripts
// (CDP Page.addScriptToEvaluateOnNewDocument).
// Makes a frame a pure function of scene time:
//  - Date, performance.now and requestAnimationFrame timestamps follow the virtual clock;
//  - setTimeout / setInterval / requestAnimationFrame callbacks run only when a frame is drawn, in a
//    fixed order, at the virtual time they were due;
//  - Math.random is seeded;
//  - CSS animations and Web Animations are paused and pinned to the scene time.
// The host calls `__edissistant.frame(t, draw)`; `draw` is the scene's own render call.

export function determinismShim(seed: number): string {
  return `(() => {
  'use strict';
  const V = { t: 0 };
  const EPOCH = Date.UTC(2026, 0, 1);
  const RealDate = Date;
  class VirtualDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(EPOCH + V.t * 1000); else super(...args); }
    static now() { return EPOCH + V.t * 1000; }
  }
  Object.defineProperty(window, 'Date', { value: VirtualDate, writable: false, configurable: false });
  const perfNow = () => V.t * 1000;
  try { Object.defineProperty(Performance.prototype, 'now', { value: perfNow, writable: false, configurable: false }); } catch (e) {}
  let s = ${seed >>> 0} | 0;
  const random = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  Object.defineProperty(Math, 'random', { value: random, writable: false, configurable: false });
  let nextId = 1;
  const timers = new Map();
  let rafs = [];
  const addTimer = (fn, ms, args, repeat) => {
    const id = nextId++;
    const delay = Math.max(0, Number(ms) || 0) / 1000;
    if (typeof fn === 'function') timers.set(id, { fn, args, due: V.t + delay, every: repeat ? Math.max(delay, 0.001) : 0, seq: id });
    return id;
  };
  const def = (name, value) => Object.defineProperty(window, name, { value, writable: false, configurable: false });
  def('setTimeout', (fn, ms, ...args) => addTimer(fn, ms, args, false));
  def('setInterval', (fn, ms, ...args) => addTimer(fn, ms, args, true));
  def('clearTimeout', (id) => { timers.delete(id); });
  def('clearInterval', (id) => { timers.delete(id); });
  def('requestAnimationFrame', (cb) => { const id = nextId++; rafs.push({ id, cb }); return id; });
  def('cancelAnimationFrame', (id) => { rafs = rafs.filter((r) => r.id !== id); });
  // Idle callbacks run on a real clock in Chromium; here they run when a frame is drawn, like rAF.
  let idles = [];
  def('requestIdleCallback', (cb) => { const id = nextId++; idles.push({ id, cb }); return id; });
  def('cancelIdleCallback', (id) => { idles = idles.filter((r) => r.id !== id); });
  const runTimers = (now) => {
    for (let guard = 0; guard < 10000; guard++) {
      let pick = null;
      for (const [id, tm] of timers) if (tm.due <= V.t + 1e-9 && (!pick || tm.due < pick[1].due || (tm.due === pick[1].due && tm.seq < pick[1].seq))) pick = [id, tm];
      if (!pick) return;
      const [id, tm] = pick;
      const due = tm.due;
      if (tm.every) { tm.due += tm.every; tm.seq = nextId++; } else timers.delete(id);
      // The callback sees the time it was due, not the frame time.
      V.t = Math.max(0, due);
      try { tm.fn(...tm.args); } finally { V.t = now; }
    }
    throw new Error('Too many timers fired in one frame.');
  };
  const api = {
    frame(t, draw) {
      V.t = t;
      runTimers(t);
      const list = rafs; rafs = [];
      for (const r of list) r.cb(t * 1000);
      const idle = idles; idles = [];
      for (const r of idle) r.cb({ didTimeout: false, timeRemaining: () => 0 });
      if (document.getAnimations) for (const a of document.getAnimations()) { a.pause(); a.currentTime = t * 1000; }
      return draw();
    },
    get time() { return V.t; },
  };
  Object.defineProperty(window, '__edissistant', { value: Object.freeze(api), writable: false, configurable: false });
  // Second layer (the first is the host: CSP sandbox, Chromium switches, permission handlers): no printing,
  // no WebRTC, no WebGPU, in this frame and every frame it creates (this script runs in all frames).
  try { def('print', () => undefined); } catch (e) {}
  for (const n of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCIceCandidate', 'RTCSessionDescription', 'RTCRtpSender', 'RTCRtpReceiver', 'RTCRtpTransceiver', 'RTCDtlsTransport', 'RTCIceTransport', 'RTCSctpTransport', 'RTCCertificate', 'RTCEncodedAudioFrame', 'RTCEncodedVideoFrame']) {
    try { Object.defineProperty(window, n, { value: undefined, writable: false, configurable: false }); } catch (e) {}
  }
  try { Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: false }); } catch (e) {}
})();`;
}
