// The Remote page's link (server/remote.js): one socket that brings the capture core's
// H.264 frames and answers, and takes the page's requests, clicks and keys. Frames are
// decoded by the browser's own (hardware) decoder and drawn on a canvas; each one shown
// is acknowledged, and the capture core skips frames while three are unshown, so the picture
// stays current instead of falling behind (as Sill does).
export function remoteSupported() {
  return typeof window !== 'undefined' && 'VideoDecoder' in window && 'EncodedVideoChunk' in window;
}

export function openRemote({ pass, canvas, onMessage = () => {}, onState = () => {}, onStats = () => {} }) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/remote?pass=${encodeURIComponent(pass)}`);
  ws.binaryType = 'arraybuffer';
  let decoder = null, config = null, needKey = true, closed = false, opened = false;
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
        frames++;
        send({ t: 'ack' });
      },
      error() { needKey = true; send({ t: 'key-frame' }); if (config) { try { makeDecoder(); } catch {} } },
    });
    if (config) decoder.configure({ codec: config.codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
    needKey = true;
  }

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

export const QUALITY = { low: 2_000_000, standard: 6_000_000, high: 12_000_000, max: 25_000_000 };
export const RESOLUTION = { '1280': 1280, '1920': 1920, '2560': 2560, native: 3840 };
