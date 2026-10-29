// The Remote page's link (server/remote.js): one socket that brings the capture core's
// H.264 or HEVC frames and answers, and takes the page's requests, clicks and keys. Frames are
// decoded by the browser's own (hardware) decoder and drawn on a canvas; each one shown
// is acknowledged, and the capture core skips frames while three are unshown, so the picture
// stays current instead of falling behind (as Sill does).
export function remoteSupported() {
  return typeof window !== 'undefined' && 'VideoDecoder' in window && 'EncodedVideoChunk' in window;
}

// Whether this browser decodes HEVC in hardware: the Mac then sends it, sharper for the
// same bits. Asked once; a browser that cannot say is taken as no.
let hevcAnswer = null;
export function hevcDecodes() {
  if (!hevcAnswer) {
    hevcAnswer = remoteSupported() && typeof VideoDecoder.isConfigSupported === 'function'
      ? VideoDecoder.isConfigSupported({ codec: 'hvc1.1.6.L153.B0', optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' }).then((r) => !!r.supported, () => false)
      : Promise.resolve(false);
  }
  return hevcAnswer;
}

// machine: another Mac that joined this one (docs/multi-mac.md), or empty for this Mac.
// onCodecFailed: an HEVC stream this browser would not decode after all; ask for H.264.
export function openRemote({ pass, machine = '', canvas, onMessage = () => {}, onState = () => {}, onStats = () => {}, onCodecFailed = () => {} }) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/remote?pass=${encodeURIComponent(pass)}${machine ? `&machine=${encodeURIComponent(machine)}` : ''}`);
  ws.binaryType = 'arraybuffer';
  let decoder = null, config = null, needKey = true, closed = false, opened = false, shown = false;
  let frames = 0, bytes = 0, statsAt = performance.now();
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  const send = (msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };

  function makeDecoder() {
    try { decoder?.close(); } catch {}
    decoder = new VideoDecoder({
      output(frame) {
        try {
          if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) { canvas.width = frame.displayWidth; canvas.height = frame.displayHeight; }
          ctx.drawImage(frame, 0, 0);
        } finally { frame.close(); }
        frames++;shown = true;
        send({ t: 'ack' });
      },
      error() {
        // HEVC that fails before its first picture: this browser cannot decode it.
        if (hevc() && !shown) { codecFailed();return; }
        needKey = true; send({ t: 'key-frame' }); if (config) { try { makeDecoder(); } catch {} }
      },
    });
    shown = false;
    needKey = true;
    if (!config) return;
    try { decoder.configure({ codec: config.codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' }); }
    catch (e) { if (hevc()) codecFailed();else throw e; }
  }
  const hevc = () => !!config?.codec?.startsWith('hvc1');
  function codecFailed() { const was = config;config = null;try { decoder?.close(); } catch {} decoder = null;if (was) onCodecFailed(); }

  ws.onopen = () => { opened = true; onState('open'); };
  ws.onclose = () => { closed = true; try { decoder?.close(); } catch {} onState(opened ? 'closed' : 'refused'); };
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.t === 'config') { config = msg; makeDecoder(); }
      onMessage(msg);
      return;
    }
    const data = new Uint8Array(e.data);
    if (!decoder || decoder.state !== 'configured' || data.length < 10) { send({ t: 'ack' }); return; }
    const key = (data[0] & 1) === 1;
    if (needKey && !key) { send({ t: 'ack' }); return; }
    needKey = false;
    const view = new DataView(e.data);
    const timestamp = Number(view.getBigUint64(1));
    bytes += data.length;
    try { decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp, data: data.subarray(9) })); }
    catch { needKey = true; send({ t: 'ack' }); send({ t: 'key-frame' }); }
    const now = performance.now();
    if (now - statsAt >= 1000) { onStats({ fps: Math.round(frames * 1000 / (now - statsAt)), mbps: +(bytes * 8 / 1e6 / ((now - statsAt) / 1000)).toFixed(1) }); frames = 0; bytes = 0; statsAt = now; }
  };
  return {
    send,
    get closed() { return closed; },
    close() { closed = true; try { ws.close(); } catch {} try { decoder?.close(); } catch {} },
  };
}

// Where a point on the canvas element falls in the picture, 0…1 each way: the canvas
// is drawn with object-fit: contain, so there may be bars on two sides.
export function pictureRect(canvas) {
  const box = canvas.getBoundingClientRect();
  const vw = canvas.width || 1, vh = canvas.height || 1;
  const scale = Math.min(box.width / vw, box.height / vh);
  const w = vw * scale, h = vh * scale;
  return { left: box.left + (box.width - w) / 2, top: box.top + (box.height - h) / 2, width: w, height: h };
}
export function toPicture(canvas, clientX, clientY) {
  const r = pictureRect(canvas);
  return { x: Math.min(1, Math.max(0, (clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (clientY - r.top) / r.height)), inside: clientX >= r.left && clientX <= r.left + r.width && clientY >= r.top && clientY <= r.top + r.height };
}

// A typed character, for a shortcut held with the keys row's modifiers (⌘ C).
export function codeOfChar(ch) {
  const c = String(ch || '').toLowerCase();
  if (/^[a-z]$/.test(c)) return 'Key' + c.toUpperCase();
  if (/^[0-9]$/.test(c)) return 'Digit' + c;
  return { ' ': 'Space', '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash', ';': 'Semicolon', "'": 'Quote', ',': 'Comma', '.': 'Period', '/': 'Slash', '`': 'Backquote' }[c] || null;
}

// For a 1920 × 1080 picture: the Mac gives a larger one more (Session.scaledBitrate).
export const QUALITY = { low: 2_000_000, standard: 6_000_000, high: 12_000_000, max: 25_000_000 };
export const RESOLUTION = { '1280': 1280, '1920': 1920, '2560': 2560, native: 3840 };
